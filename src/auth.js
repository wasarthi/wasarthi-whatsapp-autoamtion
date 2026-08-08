const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Session secret (persisted so restarts don't log everyone out) ──
const secretPath = path.join(__dirname, '..', 'data', '.session_secret');
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
    try {
        if (fs.existsSync(secretPath)) {
            SESSION_SECRET = fs.readFileSync(secretPath, 'utf8').trim();
        }
    } catch (e) { /* ignore */ }
    if (!SESSION_SECRET) {
        SESSION_SECRET = crypto.randomBytes(48).toString('hex');
        try {
            const dir = path.dirname(secretPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(secretPath, SESSION_SECRET, { mode: 0o600 });
        } catch (e) {
            console.warn('⚠️ Could not persist session secret (sessions will reset on restart):', e.message);
        }
    }
}

const COOKIE_NAME = 'wa_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
    input = input.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    return Buffer.from(input, 'base64').toString('utf8');
}

// ─── Password hashing ────────────────────────────────────────
async function hashPassword(plainText) {
    return bcrypt.hash(plainText, 10);
}

async function verifyPassword(plainText, hash) {
    return bcrypt.compare(plainText, hash);
}

// ─── Lightweight signed session token (no external JWT dependency) ──
function createSessionToken(user) {
    const payload = { id: user.id, role: user.role, exp: Date.now() + SESSION_TTL_MS };
    const encoded = base64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('hex');
    return `${encoded}.${sig}`;
}

function verifySessionToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [encoded, sig] = token.split('.');
    if (!encoded || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    } catch (e) {
        return null; // length mismatch etc.
    }
    let payload;
    try {
        payload = JSON.parse(base64urlDecode(encoded));
    } catch (e) {
        return null;
    }
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
}

// ─── Cookie helpers (avoid pulling in cookie-parser) ─────────
function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        out[key] = decodeURIComponent(val);
    });
    return out;
}

function setSessionCookie(res, token) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function getTokenFromRequest(req) {
    const cookies = parseCookies(req);
    return cookies[COOKIE_NAME] || null;
}

// ─── Validation ───────────────────────────────────────────────
function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPassword(password) {
    return typeof password === 'string' && password.length >= 6;
}

module.exports = {
    hashPassword,
    verifyPassword,
    createSessionToken,
    verifySessionToken,
    setSessionCookie,
    clearSessionCookie,
    getTokenFromRequest,
    isValidEmail,
    isValidPassword,
    COOKIE_NAME
};
