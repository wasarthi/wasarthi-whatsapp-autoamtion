/**
 * rateLimit.js — request throttling.
 *
 * Two distinct jobs live here:
 *
 *   rateLimit()      — fixed-window request counting (login, signup, writes)
 *   concurrencyGate() — a cap on how many of something can run *at once*
 *
 * Both keep state in process memory. That is a real limitation, stated
 * plainly rather than in a comment claiming it's fine: with two instances
 * behind a load balancer, every limit here is effectively doubled, because
 * neither process can see the other's counters. It is not a security
 * boundary at that point — it is a politeness/cost guard. Anything that
 * must hold globally (the scheduler's job claiming, message idempotency)
 * is enforced in SQLite instead, where a second process *does* see it.
 * Moving these to Redis is the single change required before running more
 * than one instance; see the architecture section of the report.
 */
const buckets = new Map(); // key -> { count, resetAt }

// Bound the map so the limiter itself can't become the memory leak. An
// attacker rotating source IPs (or a large NAT) would otherwise create an
// unbounded number of keys, each held until its window expired.
const MAX_BUCKETS = 50000;

function sweepExpired(now) {
    for (const [key, bucket] of buckets) {
        if (now > bucket.resetAt) buckets.delete(key);
    }
}

function rateLimit({ windowMs, max, keyFn, message, code = 'RATE_LIMITED' }) {
    return (req, res, next) => {
        if (process.env.DISABLE_RATE_LIMITS === 'true') {
            return next();
        }
        
        const now = Date.now();
        const key = keyFn(req);
        let bucket = buckets.get(key);
        if (!bucket || now > bucket.resetAt) {
            bucket = { count: 0, resetAt: now + windowMs };
            if (buckets.size >= MAX_BUCKETS) sweepExpired(now);
            // Still full after a sweep: every bucket is live, which means we
            // are under a distributed flood. Fail closed rather than growing
            // memory without bound.
            if (buckets.size >= MAX_BUCKETS) {
                res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
                return res.status(429).json({
                    success: false,
                    error: 'The server is shedding load right now. Please retry in a moment.',
                    code: 'OVERLOADED'
                });
            }
            buckets.set(key, bucket);
        }
        bucket.count++;
        if (bucket.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                success: false,
                error: message || 'Too many attempts. Please try again later.',
                code
            });
        }
        next();
    };
}

/** Per-authenticated-account limiter. Falls back to IP when unauthenticated. */
function perUser(name, { windowMs, max, message }) {
    return rateLimit({
        windowMs,
        max,
        message,
        keyFn: (req) => `${name}:${req.user ? `u${req.user.id}` : `ip${clientIp(req)}`}`
    });
}

/**
 * Caps concurrent in-flight operations of one kind, globally and per user.
 *
 * Request-rate limiting alone does not bound resource use for slow work: 20
 * requests/minute is a gentle rate, but if each holds an outbound Gemini
 * connection open for 30 seconds, 20 of them are alive simultaneously. This
 * is what keeps one tenant's "analyze all my conversations" from consuming
 * every outbound slot the process has.
 *
 * Returns { tryAcquire(userId), release(userId), inFlight(), inFlightFor(id) }.
 */
function concurrencyGate({ maxGlobal, maxPerUser }) {
    let global = 0;
    const perUserCount = new Map();

    return {
        tryAcquire(userId) {
            if (global >= maxGlobal) return { ok: false, reason: 'global' };
            const mine = perUserCount.get(userId) || 0;
            if (mine >= maxPerUser) return { ok: false, reason: 'user' };
            global++;
            perUserCount.set(userId, mine + 1);
            return { ok: true };
        },
        release(userId) {
            if (global > 0) global--;
            const mine = perUserCount.get(userId) || 0;
            if (mine <= 1) perUserCount.delete(userId);
            else perUserCount.set(userId, mine - 1);
        },
        inFlight() { return global; },
        inFlightFor(userId) { return perUserCount.get(userId) || 0; },
        reset() { global = 0; perUserCount.clear(); }
    };
}

function clearBuckets() {
    buckets.clear();
}

/**
 * Best-effort client IP.
 *
 * req.ip already honours the app's `trust proxy` setting, so this must NOT
 * read X-Forwarded-For itself: doing so would let any client set that header
 * and get a fresh rate-limit bucket per request when no proxy is configured.
 */
function clientIp(req) {
    return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

module.exports = { rateLimit, perUser, concurrencyGate, clientIp, buckets, clearBuckets };
