/**
 * Minimal in-memory fixed-window rate limiter — no external dependency,
 * consistent with this project's hand-rolled auth/session approach.
 *
 * NOTE: state lives in process memory, so this only protects a single
 * Node process. That's the right tradeoff for this app (one server
 * process per install) — it is not meant to survive a multi-instance /
 * clustered deployment.
 */
const buckets = new Map(); // key -> { count, resetAt }

function rateLimit({ windowMs, max, keyFn, message }) {
    return (req, res, next) => {
        const key = keyFn(req);
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || now > bucket.resetAt) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count++;
        if (bucket.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                success: false,
                error: message || 'Too many attempts. Please try again later.'
            });
        }
        next();
    };
}

// Periodic cleanup so the map doesn't grow unbounded under sustained traffic.
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now > bucket.resetAt) buckets.delete(key);
    }
}, 5 * 60 * 1000);
cleanupTimer.unref?.();

/** Best-effort client IP — falls back gracefully if req.ip isn't populated. */
function clientIp(req) {
    return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

module.exports = { rateLimit, clientIp };
