const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Session secret lives in the same PERSIST_ROOT as the database — see
// src/config/paths.js for the resolution order.
const { SECRET_PATH: secretPath } = require('./paths');


const MIN_SECRET_LENGTH = 32;

function loadSessionSecret() {
    const fromEnv = (process.env.SESSION_SECRET || '').trim();
    if (fromEnv) {
        // A short or placeholder secret in production is worse than no
        // secret at all, because it looks configured. HMAC-SHA256 with a
        // guessable key means anyone can forge a session for any account,
        // including admin — so this is a hard startup failure, not a warning
        // someone scrolls past in the logs.
        if (process.env.NODE_ENV === 'production') {
            if (fromEnv.length < MIN_SECRET_LENGTH) {
                throw new Error(
                    `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production ` +
                    `(got ${fromEnv.length}). Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
                );
            }
            if (/^(changeme|secret|password|test|dev|example)/i.test(fromEnv)) {
                throw new Error('SESSION_SECRET looks like a placeholder value. Set a real random secret in production.');
            }
        }
        return { secret: fromEnv, source: 'env' };
    }

    try {
        if (fs.existsSync(secretPath)) {
            const fromFile = fs.readFileSync(secretPath, 'utf8').trim();
            if (fromFile.length >= MIN_SECRET_LENGTH) return { secret: fromFile, source: 'file' };
        }
    } catch (e) { /* fall through to generating one */ }

    const generated = crypto.randomBytes(48).toString('hex');
    try {
        const dir = path.dirname(secretPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(secretPath, generated, { mode: 0o600 });
        return { secret: generated, source: 'generated-persisted' };
    } catch (e) {
        // In production this means sessions silently reset on every restart
        // (and would differ between instances), so say so loudly.
        const msg = `Could not persist session secret to ${secretPath}: ${e.message}`;
        if (process.env.NODE_ENV === 'production') {
            throw new Error(
                `${msg}. In production the secret must be stable — set SESSION_SECRET explicitly ` +
                `or make the data directory writable, otherwise every restart logs out every user.`
            );
        }
        console.warn(`⚠️ ${msg} (sessions will reset on restart)`);
        return { secret: generated, source: 'generated-ephemeral' };
    }
}

const { secret: SESSION_SECRET, source: SESSION_SECRET_SOURCE } = loadSessionSecret();

const COOKIE_NAME = 'wa_session';
// Shortened from 30 days. A stolen cookie is a full account takeover with
// no second factor available, and this app has no way to notice one being
// used from a new location — so the window in which a leaked cookie stays
// valid is the main lever available. Seven days with rotation on use keeps
// active users logged in indefinitely without leaving month-old tokens live.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Re-issue a cookie once it is more than a day old, so an active session
// keeps sliding forward while an abandoned one actually expires.
const SESSION_ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;

// ─── Revocation ─────────────────────────────────────────────────
// Two mechanisms, because they answer different questions:
//
//   tokenBlacklist  — "this exact token was logged out"
//   userTokenEpoch  — "every token issued to this user before T is void"
//
// The second is what makes suspension, deletion, role changes and password
// changes take effect immediately for sessions that already exist. Without
// it, a suspended user's existing cookie stays cryptographically valid and
// only the per-request database lookup stops them — fine for that lookup,
// but it means a demoted admin keeps admin claims in a token that other
// code might trust, and a password change doesn't kick out whoever stole
// the old cookie.
//
// Both live in process memory, which is honest for a single-instance
// deployment and is called out as a scaling constraint: with two instances,
// a logout on one is not seen by the other until the token expires. The
// per-request database check (status/role) is the part that does hold
// across instances.
const tokenBlacklist = new Map(); // token signature -> expiry timestamp
const userTokenEpoch = new Map(); // userId -> ms timestamp; tokens issued before this are void

function blacklistToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return;
    const [, sig] = token.split('.');
    if (sig) {
        tokenBlacklist.set(sig, Date.now() + SESSION_TTL_MS);
    }
}

function isTokenBlacklisted(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return false;
    const [, sig] = token.split('.');
    if (!sig) return false;
    const expiry = tokenBlacklist.get(sig);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        tokenBlacklist.delete(sig);
        return false;
    }
    return true;
}

/**
 * Invalidates every session token already issued to one account.
 *
 * Called on suspend, delete, role change, and password change. The epoch is
 * stamped 1ms into the future so that a token minted in the same
 * millisecond as the change (issued-at === now) is also rejected.
 */
function revokeAllSessionsForUser(userId) {
    userTokenEpoch.set(Number(userId), Date.now() + 1);
}

function getUserTokenEpoch(userId) {
    return userTokenEpoch.get(Number(userId)) || 0;
}

// Periodic cleanup of both maps.
const blacklistCleanup = setInterval(() => {
    const now = Date.now();
    for (const [sig, expiry] of tokenBlacklist) {
        if (now > expiry) tokenBlacklist.delete(sig);
    }
    // An epoch older than the maximum token lifetime can no longer void
    // anything, since every token issued before it has expired on its own.
    for (const [userId, at] of userTokenEpoch) {
        if (now - at > SESSION_TTL_MS) userTokenEpoch.delete(userId);
    }
}, 60 * 60 * 1000);
blacklistCleanup.unref?.();

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
    input = input.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    return Buffer.from(input, 'base64').toString('utf8');
}

// ─── Password hashing ────────────────────────────────────────
// bcrypt cost 12 rather than 10: ~4x the work per attempt (roughly 250ms on
// a typical server vs ~60ms), which is the difference between an offline
// attacker testing millions of candidate passwords per hour and hundreds of
// thousands, should the hashes ever leak. Configurable because the right
// number depends on the box, but the floor is 10 — a lower value in an env
// var shouldn't quietly weaken every new password.
const BCRYPT_ROUNDS = Math.max(10, parseInt(process.env.BCRYPT_ROUNDS, 10) || 12);

async function hashPassword(plainText) {
    return bcrypt.hash(plainText, BCRYPT_ROUNDS);
}

async function verifyPassword(plainText, hash) {
    // bcrypt.compare rejects (rather than returns false) on a malformed
    // hash — e.g. a user row written by an older script, or a NULL. A
    // rejection here would surface as a 500 on the login route and, worse,
    // as an unhandledRejection; a wrong password is the correct answer.
    if (typeof plainText !== 'string' || typeof hash !== 'string' || hash === '') return false;
    try {
        return await bcrypt.compare(plainText, hash);
    } catch (e) {
        return false;
    }
}

/**
 * A dummy verification with the same cost as a real one.
 *
 * Login must take about the same time whether or not the email exists,
 * otherwise response timing tells an attacker which addresses are
 * registered — useful for targeting, and a privacy leak in itself (it
 * reveals who is a customer). Returning early for an unknown email is
 * ~250ms faster than for a known one, which is easily measurable over a
 * handful of requests.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-equalization-placeholder', BCRYPT_ROUNDS);
async function burnPasswordVerification() {
    try {
        await bcrypt.compare('timing-equalization-placeholder-x', DUMMY_HASH);
    } catch (e) { /* nothing to do */ }
    return false;
}

// ─── Lightweight signed session token (no external JWT dependency) ──
/**
 * Token layout: base64url(payload) + "." + hex HMAC-SHA256.
 *
 * `iat` (issued-at) exists so revokeAllSessionsForUser can void tokens
 * minted before a suspension/role change, and so verify can decide when a
 * token is old enough to rotate. The role is carried for convenience only —
 * middleware/auth.js re-reads role and status from the database on every
 * request, so a forged role claim in a validly signed token grants nothing.
 */
function createSessionToken(user) {
    // iat must never predate the account's revocation epoch, or a token
    // minted immediately after a password change / role change would be
    // rejected by its own revocation check — the two happen within the same
    // millisecond, and the epoch is deliberately stamped 1ms ahead to void
    // same-millisecond stragglers. Clamping here keeps "revoke everything,
    // then issue a fresh session" working without widening that window.
    const now = Math.max(Date.now(), getUserTokenEpoch(user.id));
    const payload = { id: user.id, role: user.role, iat: now, exp: now + SESSION_TTL_MS };
    const encoded = base64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('hex');
    return `${encoded}.${sig}`;
}

function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    // Exactly one separator: "a.b.c" must not be accepted by taking the
    // first two parts, or a token could be extended with arbitrary trailing
    // data that some other component might parse differently.
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    if (!encoded || !sig) return null;
    if (isTokenBlacklisted(token)) return null;

    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('hex');
    // timingSafeEqual throws on length mismatch, so compare lengths first —
    // and compare as fixed-length hex buffers, which they always are.
    if (sig.length !== expectedSig.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))) return null;
    } catch (e) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(base64urlDecode(encoded));
    } catch (e) {
        return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.id !== 'number' || !Number.isSafeInteger(payload.id) || payload.id <= 0) return null;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    // A token whose lifetime exceeds the configured maximum was not minted
    // by this code — reject it even though the signature checks out, so a
    // future bug that lets an attacker influence `exp` can't grant a
    // decade-long session.
    const iat = typeof payload.iat === 'number' ? payload.iat : payload.exp - SESSION_TTL_MS;
    if (payload.exp - iat > SESSION_TTL_MS + 60000) return null;
    if (iat < getUserTokenEpoch(payload.id)) return null;

    payload.iat = iat;
    return payload;
}

/** True once a token is old enough that it should be re-issued. */
function shouldRotateToken(payload) {
    if (!payload || typeof payload.iat !== 'number') return false;
    return Date.now() - payload.iat > SESSION_ROTATE_AFTER_MS;
}

// ─── Cookie helpers (avoid pulling in cookie-parser) ─────────
function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    // Bound the work: a client can send a very large Cookie header, and
    // splitting/decoding an unbounded number of pairs on every request is
    // free CPU for an attacker.
    if (header.length > 8192) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (!key || Object.prototype.hasOwnProperty.call(out, key)) return; // first wins
        try {
            out[key] = decodeURIComponent(val);
        } catch (e) {
            out[key] = val; // malformed percent-encoding: keep it raw, don't throw
        }
    });
    return out;
}

/**
 * Sets the session cookie.
 *
 * SameSite=Lax is the CSRF defence for this app: the browser will not attach
 * this cookie to a cross-site POST/PUT/DELETE, which is every state-changing
 * route here. Secure is forced in production — without it the cookie travels
 * in cleartext on any accidental http:// request and can be stolen off the
 * wire. Path=/ and no Domain attribute keep it host-only, so a sibling
 * subdomain cannot read or set it.
 */
function setSessionCookie(res, token) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    const secure = isProductionCookieMode() ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`
    );
}

function isProductionCookieMode() {
    return process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_COOKIES !== 'true';
}

function clearSessionCookie(res) {
    const secure = isProductionCookieMode() ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`);
}

function revokeSession(req, res) {
    const token = getTokenFromRequest(req);
    if (token) {
        blacklistToken(token);
    }
    clearSessionCookie(res);
}

function getTokenFromRequest(req) {
    const cookies = parseCookies(req);
    return cookies[COOKIE_NAME] || null;
}

// ─── Validation ───────────────────────────────────────────────
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;
// 8 rather than 6. Six characters is inside the range an offline attacker
// brute-forces exhaustively regardless of hashing cost; eight with no
// composition rules is both stronger and less likely to push people toward
// "Passw0rd!" than mandatory-symbol policies.
const MIN_PASSWORD_LENGTH = 8;

function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    const trimmed = email.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
    // Reject non-ASCII deliberately: two visually identical addresses that
    // differ only in a homoglyph would be two accounts, and our uniqueness
    // check is a byte comparison. Better to refuse than to allow
    // impersonation via lookalike domains.
    if (/[\u0080-\uFFFF]/.test(trimmed)) return false;
    // Control characters (including CR/LF) must never reach a header or log line.
    if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
    return true;
}

function isValidPassword(password) {
    return typeof password === 'string' &&
           password.length >= MIN_PASSWORD_LENGTH &&
           password.length <= MAX_PASSWORD_LENGTH;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

module.exports = {
    hashPassword,
    verifyPassword,
    burnPasswordVerification,
    createSessionToken,
    verifySessionToken,
    shouldRotateToken,
    setSessionCookie,
    clearSessionCookie,
    revokeSession,
    revokeAllSessionsForUser,
    getUserTokenEpoch,
    getTokenFromRequest,
    parseCookies,
    isValidEmail,
    isValidPassword,
    normalizeEmail,
    COOKIE_NAME,
    // SESSION_SECRET is intentionally NOT exported. It is only used inside this
    // module to sign and verify tokens. Exporting it would make it accessible
    // to every require() caller, increasing the risk of accidental log leakage.
    SESSION_SECRET_SOURCE,
    SESSION_TTL_MS,
    SESSION_ROTATE_AFTER_MS,
    BCRYPT_ROUNDS,
    MAX_EMAIL_LENGTH,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH
};


