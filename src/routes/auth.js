const express = require('express');
const router = express.Router();

const {
    hashPassword, verifyPassword, createSessionToken,
    setSessionCookie, clearSessionCookie, isValidEmail, isValidPassword
} = require('../auth');
const { getUserByEmail, createUser, touchLastLogin, getUserById } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, clientIp } = require('../middleware/rateLimit');

function publicUser(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return rest;
}

// Blunt brute-force login attempts and spam signups. Generous enough that a
// real user mistyping their password a few times never notices.
//
// Two layers, not one: a per-(IP, account) limiter stops someone brute-forcing
// one specific account, and a looser per-IP limiter stops one IP from spraying
// attempts across many accounts. An IP-only limiter alone would lock out an
// entire office/NAT/mobile-carrier IP for everyone behind it after one person's
// typos or one attacker's attempt against a single account — that's the bug a
// same-origin login-flood test in this project's own test suite caught.
const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    keyFn: (req) => `login-acct:${clientIp(req)}:${String(req.body?.email || '').trim().toLowerCase()}`,
    message: 'Too many login attempts for this account. Please wait a few minutes and try again.'
});
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    keyFn: (req) => `login-ip:${clientIp(req)}`,
    message: 'Too many login attempts from this location. Please wait a few minutes and try again.'
});
const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyFn: (req) => `signup:${clientIp(req)}`,
    message: 'Too many signup attempts from this location. Please try again later.'
});

// ─── Sign up ──────────────────────────────────────────────────
router.post('/signup', signupLimiter, async (req, res) => {
    try {
        const { email, password, businessName, ownerName } = req.body || {};

        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
        }
        if (!isValidPassword(password)) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
        }

        const existing = getUserByEmail(email);
        if (existing) {
            return res.status(409).json({ success: false, error: 'An account with this email already exists. Try logging in instead.' });
        }

        const passwordHash = await hashPassword(password);
        const user = createUser({
            email,
            passwordHash,
            businessName: (businessName || '').trim(),
            ownerName: (ownerName || '').trim()
        });
        touchLastLogin(user.id);

        const token = createSessionToken(user);
        setSessionCookie(res, token);

        res.json({ success: true, data: publicUser(getUserById(user.id)) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Log in ───────────────────────────────────────────────────
router.post('/login', loginIpLimiter, loginAccountLimiter, async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required.' });
        }

        const user = getUserByEmail(email);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({ success: false, error: 'Your account has been suspended. Contact your administrator.' });
        }

        touchLastLogin(user.id);
        const token = createSessionToken(user);
        setSessionCookie(res, token);

        res.json({ success: true, data: publicUser(getUserById(user.id)) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Log out ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ success: true });
});

// ─── Current session ────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    res.json({ success: true, data: publicUser(req.user) });
});

module.exports = router;
