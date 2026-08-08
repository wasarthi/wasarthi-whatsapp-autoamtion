const { verifySessionToken, getTokenFromRequest } = require('../auth');
const { getUserById } = require('../database');

/** Attaches req.user if a valid session cookie is present; otherwise 401. */
function requireAuth(req, res, next) {
    const token = getTokenFromRequest(req);
    const payload = token ? verifySessionToken(token) : null;
    if (!payload) {
        return res.status(401).json({ success: false, error: 'Not authenticated', code: 'AUTH_REQUIRED' });
    }
    const user = getUserById(payload.id);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Account no longer exists', code: 'AUTH_REQUIRED' });
    }
    if (user.status === 'suspended') {
        return res.status(403).json({ success: false, error: 'Your account has been suspended. Contact your administrator.', code: 'ACCOUNT_SUSPENDED' });
    }
    req.user = user;
    next();
}

/** Like requireAuth, but also requires role === 'admin'. */
function requireAdmin(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        next();
    });
}

/** Best-effort — attaches req.user if a valid session exists, but never blocks. */
function optionalAuth(req, res, next) {
    const token = getTokenFromRequest(req);
    const payload = token ? verifySessionToken(token) : null;
    if (payload) {
        const user = getUserById(payload.id);
        if (user && user.status !== 'suspended') req.user = user;
    }
    next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth };
