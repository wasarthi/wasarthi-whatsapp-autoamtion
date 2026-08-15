/**
 * metrics.js — in-process counters for the health/metrics endpoints.
 *
 * Deliberately not Prometheus: adding a metrics library and an exposition
 * format to a single-process app that has no scraper in front of it buys
 * nothing. What this does buy is the ability to answer, during an incident,
 * "is the database still writing, how many WhatsApp sessions are up, how
 * many requests are failing, and is the event loop blocked" — from a URL,
 * without attaching a debugger.
 *
 * Counters are cumulative since boot. Latency is tracked as a bounded
 * reservoir rather than every sample, so memory use stays flat regardless of
 * traffic.
 */

const MAX_LATENCY_SAMPLES = 1000;

const state = {
    startedAt: Date.now(),
    requests: { total: 0, byStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } },
    auth: { logins: 0, loginFailures: 0, signups: 0, rateLimited: 0 },
    messages: { sent: 0, failed: 0, received: 0, duplicateSuppressed: 0 },
    scheduler: { ticks: 0, claimed: 0, sent: 0, failed: 0, lostRaces: 0 },
    ai: { requests: 0, failures: 0, circuitOpen: 0 },
    db: { writeErrors: 0 },
    latency: []           // recent request durations in ms
};

function recordRequest(statusCode, durationMs) {
    state.requests.total++;
    const cls = `${Math.floor(statusCode / 100)}xx`;
    if (state.requests.byStatusClass[cls] !== undefined) state.requests.byStatusClass[cls]++;
    if (statusCode === 429) state.auth.rateLimited++;

    if (Number.isFinite(durationMs)) {
        // Reservoir: overwrite oldest once full, so this array never grows.
        if (state.latency.length < MAX_LATENCY_SAMPLES) state.latency.push(durationMs);
        else state.latency[state.requests.total % MAX_LATENCY_SAMPLES] = durationMs;
    }
}

function inc(path, n = 1) {
    const parts = path.split('.');
    let node = state;
    for (let i = 0; i < parts.length - 1; i++) {
        node = node[parts[i]];
        if (!node) return;
    }
    const leaf = parts[parts.length - 1];
    if (typeof node[leaf] === 'number') node[leaf] += n;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx]);
}

/**
 * Event-loop lag: how late a timer scheduled for "immediately" actually
 * fires. This is the single most useful number for this application, because
 * the database is synchronous — a slow full-database export or a pathological
 * regex shows up here as multi-hundred-millisecond lag, and every tenant
 * feels it as latency.
 */
let lagMs = 0;
const lagTimer = setInterval(() => {
    const expected = Date.now();
    setImmediate(() => {
        const drift = Date.now() - expected;
        // Smooth so one GC pause doesn't look like sustained blocking.
        lagMs = Math.round(lagMs * 0.7 + Math.max(0, drift) * 0.3);
    });
}, 500);
lagTimer.unref?.();

function snapshot() {
    const sorted = [...state.latency].sort((a, b) => a - b);
    const mem = process.memoryUsage();
    return {
        uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
        requests: {
            total: state.requests.total,
            ...state.requests.byStatusClass
        },
        latencyMs: {
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
            samples: sorted.length
        },
        eventLoopLagMs: lagMs,
        memoryMb: {
            rss: Math.round(mem.rss / 1048576),
            heapUsed: Math.round(mem.heapUsed / 1048576),
            heapTotal: Math.round(mem.heapTotal / 1048576)
        },
        auth: { ...state.auth },
        messages: { ...state.messages },
        scheduler: { ...state.scheduler },
        ai: { ...state.ai },
        db: { ...state.db }
    };
}

/**
 * Express middleware. Records status class and duration for every request.
 *
 * Uses res.on('finish') rather than wrapping res.end, so it also counts
 * responses produced by error handlers and by static file serving.
 */
function requestMetrics(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        recordRequest(res.statusCode, durationMs);
    });
    next();
}

function reset() {
    state.requests = { total: 0, byStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } };
    state.auth = { logins: 0, loginFailures: 0, signups: 0, rateLimited: 0 };
    state.messages = { sent: 0, failed: 0, received: 0, duplicateSuppressed: 0 };
    state.scheduler = { ticks: 0, claimed: 0, sent: 0, failed: 0, lostRaces: 0 };
    state.ai = { requests: 0, failures: 0, circuitOpen: 0 };
    state.db = { writeErrors: 0 };
    state.latency = [];
}

module.exports = { requestMetrics, recordRequest, inc, snapshot, reset };
