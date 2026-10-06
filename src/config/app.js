/**
 * app.js — builds the Express application.
 *
 * Split out of server.js so that tests exercise the *real* application —
 * the same middleware order, the same headers, the same error handler — and
 * not a hand-assembled approximation of it. A test suite that builds its own
 * mini-app can pass while the deployed app is broken, which is exactly the
 * false confidence this project needs to avoid.
 *
 * server.js keeps the process concerns: listening, signals, crash policy.
 */
// Only load .env in non-test environments. In test mode, tests/setup.js
// owns the environment: it deletes production-only vars and sets controlled
// values before any module loads. Re-running dotenv.config() here after a
// Jest module-cache reset would overwrite those test values with the
// developer's real .env (including BOOTSTRAP_ADMIN_EMAIL, real API keys,
// etc.), breaking test isolation.
if (process.env.NODE_ENV !== 'test') {
    require('dotenv').config();
}
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const compression = require('compression');
const { nonceMiddleware } = require('../middleware/nonce');
const { requestLogger } = require('../utils/logger');
const apiRoutes                     = require('../routes/api');
const authRoutes                    = require('../routes/auth');
const adminRoutes                   = require('../routes/admin');
const calendarRoutes                = require('../routes/calendar');
const appointmentRoutes             = require('../routes/appointments');
const { requireAuth, requireAdmin, requireSystemAdmin } = require('../middleware/auth');
const { errorHandler }              = require('../utils/errors');
const { addSSEClient, getSessionMetrics } = require('../services/whatsapp-client');
const { getPersistHealth, getSchemaVersion, countUsers, getPublicProductById } = require('../services/database');
const { requestMetrics, snapshot } = require('../utils/metrics');
const { SESSION_SECRET_SOURCE } = require('./auth');
const qrcode = require('qrcode');

function createApp() {
    const app = express();

    app.disable('x-powered-by');

    // ─── Reverse proxy awareness ────────────────────────────────
    // Off by default: with no proxy in front, req.ip is already the real
    // client, and blindly trusting X-Forwarded-For would let anyone spoof
    // their IP and dodge the login/signup rate limiters. Only turn this on
    // (TRUST_PROXY=1) when something you control — Caddy, nginx, Cloudflare —
    // actually sits in front of this process; otherwise every visitor behind
    // that proxy collapses into one IP and the rate limiters stop meaning
    // anything.
    if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
        app.set('trust proxy', 1);
    }

    // ─── HTTPS enforcement ──────────────────────────────────────
    // Only meaningful behind a proxy that terminates TLS and sets
    // X-Forwarded-Proto. Without this, a user who types the bare hostname
    // sends their session cookie over cleartext once before any redirect.
    if (process.env.FORCE_HTTPS === 'true') {
        app.use((req, res, next) => {
            if (req.path === '/health' || req.path === '/ready') return next();
            if (req.secure || req.get('X-Forwarded-Proto') === 'https') return next();
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                return res.status(403).json({ success: false, error: 'HTTPS is required.' });
            }
            return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
        });
    }

    app.use(requestMetrics);

    // ─── Response compression ────────────────────────────────────
    // The dashboard bundle (app.js, chart.umd.min.js) and every JSON API
    // response benefit from this — chart.umd.min.js alone is ~200KB
    // uncompressed. Explicitly skips the QR/status SSE stream: compression
    // buffers output to fill its chunk size before flushing, which would
    // turn a real-time "here's your QR code" push into a delayed one.
    app.use(compression({
        filter: (req, res) => {
            if (req.path === '/api/qr-stream') return false;
            return compression.filter(req, res);
        }
    }));

    // ─── CORS ───────────────────────────────────────────────────
    // This app serves its own frontend from the same origin as the API, so
    // cross-origin *credentialed* requests are never needed for normal use.
    // Reflecting any Origin while credentials:true would let ANY website make
    // authenticated fetch() calls using a logged-in user's session cookie.
    // Only explicitly listed origins get credentialed access; same-origin
    // browser requests are unaffected either way, since browsers don't
    // consult CORS headers for same-origin calls.
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    app.use(cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            return callback(null, false);
        },
        credentials: true,
        maxAge: 600
    }));

// Custom structured request logging with PII masking (replaces morgan)
    app.use(requestLogger);

    // 1MB is generous for JSON here (the largest legitimate body is a CSV
    // import, capped separately at 2MB of text). Express rejects anything
    // larger with a 413 before it is parsed, which is what keeps a 500MB body
    // from being buffered into memory.
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Nonce middleware (must run before security headers for CSP nonce) ───
    app.use(nonceMiddleware);

    // ─── Security headers ───────────────────────────────────────
      app.use((req, res, next) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
          res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          // CSP with per-request nonce — replaces 'unsafe-inline' for scripts/styles.
          // The nonce is generated per-request in nonceMiddleware and available as res.locals.nonce.
          const nonce = res.locals.nonce;
          res.setHeader('Content-Security-Policy', [
              "default-src 'self'",
              `script-src 'self' 'nonce-${nonce}'`,
              "script-src-attr 'none'",
              `style-src 'self' 'nonce-${nonce}'`,
              "img-src 'self' data:",       // data: is required: QR codes are data URLs
              "connect-src 'self'",
              "font-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'"
          ].join('; '));

          if (process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true') {
              res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
          }
          next();
      });

    // Authenticated API responses must never be cached — by the browser, or
    // by any proxy in between. Without this, a shared cache can serve one
    // tenant's dashboard JSON to another.
    app.use('/api', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        next();
    });

    // ─── Static assets — index.html is served explicitly below ──
    const isProd = process.env.NODE_ENV === 'production';
    app.use(express.static(path.join(__dirname, '..', '..', 'public'), {
        index: false,
        maxAge: isProd ? '1h' : 0,
        setHeaders: (res) => {
            if (isProd) {
                res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
            } else {
                res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            }
        }
    }));

    // ─── Health checks ──────────────────────────────────────────
    // Liveness: is the process running at all? Deliberately trivial and
    // dependency-free — a liveness probe that checks dependencies causes a
    // restart loop during a dependency outage, which is the opposite of what
    // you want.
app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    // Readiness: can this process actually serve requests correctly? This
    // fails when the database cannot be written, because at that point the
    // app would accept work it silently cannot keep — a load balancer should
    // stop sending traffic here. Public, so it exposes booleans only, no
    // paths, versions, or error text.
    app.get('/ready', (req, res) => {
        const persist = getPersistHealth();
        let dbReadable = false;
        try { countUsers(); dbReadable = true; } catch (e) { dbReadable = false; }

        const ready = dbReadable && persist.ok;
        // Only return a plain boolean — internal check details (databaseReadable,
        // databaseWritable) would let an unauthenticated caller infer the failure
        // mode and time attacks during degraded states. The 503 is sufficient for
        // a load balancer; a logged-in admin can see specifics via /api/health.
        res.status(ready ? 200 : 503).json({ ready });
    });

    // Detailed metrics are admin-only: session counts, memory, and failure
    // counters are exactly the reconnaissance an attacker wants, and event
    // loop lag tells them when the server is under strain.
    app.get('/api/metrics', requireAdmin, (req, res) => {
        res.json({
            success: true,
            data: {
                ...snapshot(),
                whatsapp: getSessionMetrics(),
                database: { ...getPersistHealth(), schemaVersion: getSchemaVersion() },
                sessionSecretSource: SESSION_SECRET_SOURCE
            }
        });
    });

    // ─── Auth routes (public) ───────────────────────────────────
    app.use('/api/auth', authRoutes);

    // ─── Admin routes (admin-only) ──────────────────────────────
    app.use('/api/admin', requireSystemAdmin, adminRoutes);

    // ─── Per-account SSE stream for QR code / connection status ──
    // req.user.id, never a parameter: the stream is bound to the
    // authenticated account, so there is nothing for a client to tamper with
    // in order to read another tenant's QR code.
    app.get('/api/qr-stream', requireAuth, (req, res) => addSSEClient(req.user.id, req, res));

    // ─── Google Calendar (requires login; the OAuth callback is a normal
    //     top-level browser navigation back to our own origin, so the
    //     session cookie is present there too) ─────────────────────
    app.use('/api/calendar', requireAuth, calendarRoutes);

    // ─── Appointment booking (weekly hours, slot lookup, bookings) ──
    app.use('/api/appointments', requireAuth, appointmentRoutes);

    // ─── Everything else under /api requires a logged-in account ──
    app.use('/api', requireAuth, apiRoutes);

    // ─── Unmatched API routes get a JSON 404, not the HTML redirect below ──
    app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─── Public 1-Tap Short Payment Link (/pay/:id) ────────────
    app.get('/pay/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.redirect('/');
        }

        const product = getPublicProductById(id);
        if (!product || !product.is_active) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Link Inactive</title>
  <style nonce="${res.locals.nonce || ''}">
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.4); }
    h2 { margin: 12px 0 8px; font-size: 1.3rem; color: #f1f5f9; }
    p { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 40px;">⚠️</div>
    <h2>Product or Service Not Found</h2>
    <p>This payment link is inactive or no longer available. Please reply on WhatsApp for an updated link.</p>
  </div>
</body>
</html>`);
        }

        const paymentLink = (product.payment_link || product.url || '').trim();
        if (!paymentLink) {
            return res.status(404).send('No payment link configured for this product.');
        }

        // External HTTP/HTTPS payment gateway links (e.g. Stripe, Razorpay, Instamojo)
        if (paymentLink.startsWith('http://') || paymentLink.startsWith('https://')) {
            return res.redirect(302, paymentLink);
        }

        // UPI Intent payment flow
        const numPrice = String(product.price || '').replace(/[^\d.]/g, '');
        const formattedAmount = (numPrice && !isNaN(numPrice) && parseFloat(numPrice) > 0)
            ? parseFloat(numPrice).toFixed(2)
            : '';

        const paMatch = paymentLink.match(/[?&]pa=([^&]+)/);
        const upiId = paMatch ? decodeURIComponent(paMatch[1]).replace(/%40/g, '@').trim() : '';

        const payeeName = (product.name || 'Payment').trim().slice(0, 50);
        let upiUri = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&cu=INR&tn=${encodeURIComponent(payeeName)}`;
        if (formattedAmount) {
            upiUri += `&am=${formattedAmount}`;
        }

        let qrDataUrl = '';
        try {
            qrDataUrl = await qrcode.toDataURL(upiUri, {
                width: 260,
                margin: 2,
                color: {
                    dark: '#0f172a',
                    light: '#ffffff'
                }
            });
        } catch (qrErr) {
            console.warn('Failed to generate QR for /pay/:id', qrErr.message);
        }

        const nonce = res.locals.nonce || '';
        const displayPrice = formattedAmount ? `₹${Number(formattedAmount).toLocaleString('en-IN')}` : (product.price ? `₹${product.price}` : 'Pay via UPI');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Pay ${escapeHtml(displayPrice)} for ${escapeHtml(product.name)}</title>
  <style nonce="${nonce}">
    :root {
      --primary: #10b981;
      --primary-hover: #059669;
      --bg: #0b1120;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .pay-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      max-width: 420px;
      width: 100%;
      padding: 28px 24px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6);
      position: relative;
      overflow: hidden;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 0.78rem;
      font-weight: 600;
      margin-bottom: 14px;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 6px;
      line-height: 1.3;
    }
    .desc {
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-bottom: 18px;
      line-height: 1.4;
    }
    .amount-box {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(6, 78, 59, 0.2));
      border: 1px solid rgba(16, 185, 129, 0.35);
      border-radius: 14px;
      padding: 16px 12px;
      margin-bottom: 22px;
    }
    .amount-label {
      font-size: 0.75rem;
      color: #a7f3d0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
    .amount-val {
      font-size: 2.2rem;
      font-weight: 800;
      color: #34d399;
      letter-spacing: -0.02em;
    }
    .btn-pay {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      background: var(--primary);
      color: #ffffff;
      padding: 15px 20px;
      border-radius: 12px;
      font-size: 1.05rem;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      box-shadow: 0 10px 15px -3px rgba(16, 185, 129, 0.3);
    }
    .btn-pay:hover, .btn-pay:active {
      background: var(--primary-hover);
      transform: translateY(-1px);
    }
    .apps-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin: 12px 0 20px;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .divider {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #64748b;
      font-size: 0.75rem;
      margin: 20px 0 16px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .divider::before, .divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: #334155;
    }
    .qr-frame {
      background: #ffffff;
      padding: 12px;
      border-radius: 12px;
      display: inline-block;
      margin-bottom: 12px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3);
    }
    .qr-frame img {
      display: block;
      width: 180px;
      height: 180px;
    }
    .vpa-box {
      background: rgba(15, 23, 42, 0.6);
      border: 1px dashed #475569;
      border-radius: 10px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 14px;
    }
    .vpa-text {
      font-family: monospace;
      font-size: 0.85rem;
      color: #cbd5e1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-copy {
      background: #334155;
      color: #f8fafc;
      border: none;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      margin-left: 8px;
    }
    .btn-copy:hover { background: #475569; }
    .footer-note {
      font-size: 0.72rem;
      color: #64748b;
      margin-top: 18px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="pay-container">
    <div class="badge">🔒 Verified Instant Payment</div>
    <h1>${escapeHtml(product.name)}</h1>
    ${product.description ? `<p class="desc">${escapeHtml(product.description)}</p>` : ''}

    <div class="amount-box">
      <div class="amount-label">Exact Payable Amount</div>
      <div class="amount-val">${escapeHtml(displayPrice)}</div>
    </div>

    <a href="${escapeHtml(upiUri)}" class="btn-pay" id="payBtn">
      <span>📱 Pay with UPI App</span>
    </a>
    <div class="apps-row">
      <span>Google Pay</span> • <span>PhonePe</span> • <span>Paytm</span> • <span>BHIM</span>
    </div>

    ${qrDataUrl ? `
    <div class="divider">Or Scan to Pay</div>
    <div class="qr-frame">
      <img src="${qrDataUrl}" alt="UPI QR Code for ${escapeHtml(displayPrice)}" />
    </div>
    <div style="font-size: 0.78rem; color: var(--text-muted);">
      Scan with any UPI App from another phone
    </div>
    ` : ''}

    ${upiId ? `
    <div class="vpa-box">
      <span class="vpa-text" id="vpaText">${escapeHtml(upiId)}</span>
      <button type="button" class="btn-copy" id="copyBtn">Copy</button>
    </div>
    ` : ''}

    <div class="footer-note">
      Direct payment to merchant. Zero platform surcharge.<br>
      Pre-configured for exact amount of ${escapeHtml(displayPrice)}.
    </div>
  </div>

  <script nonce="${nonce}">
    const upiUri = ${JSON.stringify(upiUri)};
    const upiId = ${JSON.stringify(upiId)};
    // On mobile devices, automatically trigger the UPI app chooser
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      setTimeout(() => {
        window.location.href = upiUri;
      }, 300);
    }
    const copyBtn = document.getElementById('copyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(upiId).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        });
      });
    }
  </script>
</body>
</html>`);
    });

    // ─── Pages ──────────────────────────────────────────────────
    const page = (name) => (req, res) => {
        // For HTML files, inject CSP nonce into inline scripts/styles
        if (name.endsWith('.html')) {
            // __dirname is src/config, so project root is ../../
            const filePath = path.join(__dirname, '..', '..', 'public', name);
            fs.readFile(filePath, 'utf8', (err, content) => {
                if (err) return res.status(404).send('Not found');
                const nonce = res.locals.nonce || '';
                // Inject nonce into inline <script> and <style> tags
                const withNonce = content
                    .replace(/<script(\s[^>]*)?>/gi, `<script$1 nonce="${nonce}">`)
                    .replace(/<style(\s[^>]*)?>/gi, `<style$1 nonce="${nonce}">`);
                res.setHeader('Content-Type', 'text/html');
                res.send(withNonce);
            });
        } else {
            res.sendFile(path.join(__dirname, '..', '..', 'public', name));
        }
    };
    app.get('/', page('landing.html'));
    app.get(['/login', '/login.html'], page('login.html'));
    app.get(['/signup', '/signup.html'], page('signup.html'));
    // The dashboard shell is public HTML; every byte of data in it comes from
    // /api/* calls that enforce auth server-side. Client-side redirects here
    // are UX, not a security boundary.
    app.get(['/app', '/app.html', '/index.html'], page('index.html'));
    app.get(['/admin', '/admin.html'], requireAuth, (req, res, next) => {
        if (req.user.role !== 'admin') return res.redirect('/app');
        page('admin.html')(req, res, next);
    });

    // Anything else falls back to the landing page.
    app.use((req, res) => res.redirect('/'));

    // ─── Error handler (must be last) ───────────────────────────
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };








