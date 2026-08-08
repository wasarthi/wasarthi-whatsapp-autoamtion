require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');

// ─── CRITICAL: Keep Node.js process alive forever ─────────────
// Prevents Node from exiting when Puppeteer/Chrome crashes
const _keepAlive = setInterval(() => {}, 1 << 30);

// ─── Global crash guards ──────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION (process kept alive):', err.message);
    console.error(err.stack);
    // Do NOT call process.exit() — keep the server running
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('❌ UNHANDLED REJECTION (process kept alive):', msg);
    // Do NOT call process.exit()
});

process.on('SIGINT', () => {
    console.log('\n🛑 Received Ctrl+C. Shutting down gracefully...');
    clearInterval(_keepAlive);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
    clearInterval(_keepAlive);
    process.exit(0);
});

// ─── App setup ────────────────────────────────────────────────
const { initDatabase, listUsers }           = require('./src/database');
const { initScheduler }                     = require('./src/scheduler');
const apiRoutes                             = require('./src/routes/api');
const authRoutes                            = require('./src/routes/auth');
const adminRoutes                           = require('./src/routes/admin');
const { requireAuth, requireAdmin }         = require('./src/middleware/auth');
const { initWhatsAppClient, addSSEClient }  = require('./src/whatsapp-client');

const app  = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

// ─── Reverse proxy awareness ────────────────────────────────────
// Off by default: with no proxy in front, req.ip is already the real
// client, and blindly trusting X-Forwarded-For would let anyone spoof
// their IP and dodge the login/signup rate limiters. Only turn this on
// (TRUST_PROXY=1 in .env) when something you control — Caddy, nginx,
// Cloudflare — actually sits in front of this process; otherwise every
// visitor behind that proxy collapses into one IP and the rate limiters
// stop meaning anything (see routes/auth.js's clientIp() calls).
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

// ─── Middleware ───────────────────────────────────────────────
// This app serves its own frontend from the same origin as the API, so
// cross-origin *credentialed* requests are never needed for normal use.
// Reflecting any Origin (the old "origin: true") while credentials: true
// would let ANY website make authenticated fetch() calls using a logged-in
// user's session cookie — a serious cross-origin session-hijack risk. Only
// origins explicitly listed here (comma-separated ALLOWED_ORIGINS env var)
// are granted credentialed cross-origin access; same-origin browser requests
// are unaffected either way, since browsers don't consult CORS headers for
// same-origin calls.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Baseline security headers (no extra dependency needed) ───
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// ─── Static assets (CSS/JS/images) — index.html is served explicitly below ──
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─── Auth routes (public) ──────────────────────────────────────
app.use('/api/auth', authRoutes);

// ─── Admin routes (admin-only) ─────────────────────────────────
app.use('/api/admin', requireAdmin, adminRoutes);

// ─── Per-account SSE stream for QR code / connection status ────
app.get('/api/qr-stream', requireAuth, (req, res) => addSSEClient(req.user.id, req, res));

// ─── Everything else under /api requires a logged-in account ──
app.use('/api', requireAuth, apiRoutes);

// ─── Unmatched API routes get a JSON 404, not the HTML redirect below ──
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), pid: process.pid });
});

// ─── Pages ──────────────────────────────────────────────────────
// Public marketing/landing page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get(['/login', '/login.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get(['/signup', '/signup.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
// The main app dashboard (auth is enforced client-side by app.js via /api/auth/me)
app.get(['/app', '/app.html', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Admin dashboard (auth + role enforced client-side by admin.js)
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Anything else falls back to the landing page (app.use with no path matches
// every remaining method/URL — avoids the '*' wildcard syntax that differs
// between Express 4 and Express 5's path-to-regexp versions)
app.use((req, res) => res.redirect('/'));

// ─── Express error handler ────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('❌ Express error:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: err.message });
});

// ─── Reconnect WhatsApp for accounts that were connected before a restart ──
function resumeExistingSessions() {
    try {
        const authRoot = path.join(__dirname, '.wwebjs_auth');
        if (!fs.existsSync(authRoot)) return;
        const activeUserIds = new Set(listUsers().filter(u => u.status === 'active').map(u => u.id));
        const dirs = fs.readdirSync(authRoot);
        for (const dir of dirs) {
            const match = dir.match(/^user_(\d+)$/);
            if (!match) continue;
            const userId = parseInt(match[1], 10);
            if (!activeUserIds.has(userId)) continue;
            // Only resume if there's an actual saved session folder (not just an empty dir)
            const sessionPath = path.join(authRoot, dir);
            const hasSession = fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
            if (hasSession) {
                console.log(`🔁 Resuming saved WhatsApp session for user ${userId}...`);
                initWhatsAppClient(userId);
            }
        }
    } catch (e) {
        console.warn('⚠️ Could not resume existing WhatsApp sessions (non-fatal):', e.message);
    }
}

// ─── Start ────────────────────────────────────────────────────
async function start() {
    try {
        await initDatabase();
        console.log('✅ Database initialized');
    } catch (dbErr) {
        // Database failure is fatal — let launcher restart us
        console.error('❌ Database init failed:', dbErr.message);
        process.exit(1);
    }

    try {
        initScheduler();
        console.log('✅ Scheduler initialized');
    } catch (schedErr) {
        console.error('⚠️ Scheduler init failed (non-fatal):', schedErr.message);
    }

    await new Promise((resolve, reject) => {
        const server = app.listen(PORT, resolve);
        server.on('error', reject);
    });

    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   WhatsApp Automation Server Running! 🚀     ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║   Landing:  http://localhost:${PORT}             ║`);
    console.log(`║   Sign up:  http://localhost:${PORT}/signup       ║`);
    console.log(`║   Log in:   http://localhost:${PORT}/login        ║`);
    console.log(`║   API:      http://localhost:${PORT}/api          ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // Reconnect any accounts whose WhatsApp was connected before this restart,
    // AFTER the HTTP server is listening so the site is always reachable.
    try {
        resumeExistingSessions();
    } catch (waErr) {
        console.error('⚠️ Resuming WhatsApp sessions threw synchronously (will auto-retry per account):', waErr.message);
    }
}

start().catch(err => {
    console.error('❌ Fatal server start error:', err.message);
    process.exit(1);   // Let launcher restart with back-off
});
