const {
    verifySessionToken, getTokenFromRequest, shouldRotateToken,
    createSessionToken, setSessionCookie, clearSessionCookie
} = require('../config/auth');
const { getUserById } = require('../services/database');

/**
 * Resolves the caller's account from the session cookie.
 *
 * The signed token is only half the check. Role and status are re-read from
 * the database on every request rather than trusted from the token, because
 * a token is issued once and lives for days: an admin demoted to user, or an
 * account suspended or deleted, must lose access immediately, not whenever
 * their cookie happens to expire. This is why a forged-but-validly-signed
 * token claiming role:"admin" gains nothing.
 *
 * Returns { user } | { error } — never throws.
 */
function resolveSession(req) {
    const token = getTokenFromRequest(req);
    if (!token) return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Not authenticated' } };

    const payload = verifySessionToken(token);
    if (!payload) return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Your session has expired. Please log in again.' } };

    let user;
    try {
        user = getUserById(payload.id);
    } catch (e) {
        // The database is unavailable. Answering 401 here would silently log
        // everyone out and invite a stampede of re-logins against an already
        // struggling process; 503 tells the client to retry.
        return { error: { status: 503, code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable. Please retry.' } };
    }

    if (!user) return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Account no longer exists' } };
    if (user.status === 'suspended') {
        return {
            error: {
                status: 403,
                code: 'ACCOUNT_SUSPENDED',
                message: 'Your account has been suspended. Contact your administrator.'
            }
        };
    }
    return { user, payload };
}

function sendAuthError(res, error, clearCookie) {
    // Clear a cookie that can never work again, so the browser stops
    // sending it and the user lands on the login page instead of looping.
    if (clearCookie) clearSessionCookie(res);
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
}

/** Attaches req.user if a valid session cookie is present; otherwise 401/403. */
function requireAuth(req, res, next) {
    const { user, payload, error } = resolveSession(req);
    if (error) {
        // Only clear on "this token is dead" outcomes, never on 503.
        const dead = error.status === 401;
        return sendAuthError(res, error, dead);
    }

    // Sliding expiry: refresh the cookie for an actively used session so
    // regular users are never logged out mid-work, while an idle session
    // still ages out. Skipped for SSE, where headers are already committed
    // to the event stream.
    if (shouldRotateToken(payload) && !res.headersSent) {
        try { setSessionCookie(res, createSessionToken(user)); } catch (e) { /* non-fatal */ }
    }

    req.user = user;
    req.session = payload;
    next();
}

/** Like requireAuth, but also requires role === 'admin' (read from the database). */
function requireAdmin(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (!req.user || req.user.role !== 'admin') {
            // Deliberately the same shape as any other 403 and with no hint
            // about whether the route exists — an ordinary user probing
            // /api/admin/* learns nothing beyond "not for you".
            return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
        }
        next();
    });
}

/** Semantic platform-administration guard; currently the existing admin role. */
function requireSystemAdmin(req, res, next) {
    return requireAdmin(req, res, next);
}

/** Best-effort — attaches req.user if a valid session exists, but never blocks. */
function optionalAuth(req, res, next) {
    const { user, payload } = resolveSession(req);
    if (user) {
        req.user = user;
        req.session = payload;
    }
    next();
}

module.exports = { requireAuth, requireAdmin, requireSystemAdmin, optionalAuth, resolveSession };



