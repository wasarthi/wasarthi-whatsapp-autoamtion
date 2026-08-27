/**
 * gemini-client.js — the single place this codebase talks to Gemini.
 *
 * Before this existed, four modules (ai.js, lead-analyzer.js, business.js,
 * and this file) each constructed their own GoogleGenAI client and each
 * looped over the same six model names with their own retry rules. That
 * meant a Gemini outage was retried four different ways, none of them
 * coordinated: a 429 caused every module to walk all six models, three
 * times each, all at once — turning a rate limit into a self-inflicted
 * retry storm that burned quota and held sockets open.
 *
 * Consolidated here with three specific protections:
 *
 *   1. a real timeout on every call, so a hung request cannot pin a slot
 *      forever;
 *   2. bounded retries with exponential backoff and jitter, and retries
 *      ONLY for errors that can plausibly succeed on a second attempt (a
 *      400 or a 401 cannot, and retrying them just wastes quota);
 *   3. a circuit breaker per API key, so once Gemini is clearly down we
 *      stop calling it for a cooldown instead of amplifying the outage.
 */
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');

// Ordered by preference. Fewer entries than before on purpose: walking six
// models on every failure multiplies the cost of an outage by six, and the
// 1.5 generation is retired for new keys anyway.
const MODELS_TO_TRY = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
];

const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS, 10) || 30000;
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;

// ─── Circuit breaker ────────────────────────────────────────────
// Keyed by a hash of the API key, so one tenant's exhausted quota or revoked
// key doesn't open the circuit for everyone else — and so the key itself is
// never used as a map key that might be logged.
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60 * 1000;
const circuits = new Map(); // keyHash -> { failures, openedAt }

function keyFingerprint(apiKey) {
    return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function circuitFor(apiKey) {
    const id = keyFingerprint(apiKey);
    let c = circuits.get(id);
    if (!c) {
        c = { failures: 0, openedAt: 0 };
        circuits.set(id, c);
    }
    return c;
}

function isCircuitOpen(apiKey) {
    const c = circuitFor(apiKey);
    if (!c.openedAt) return false;
    if (Date.now() - c.openedAt > CIRCUIT_COOLDOWN_MS) {
        // Half-open: let the next call through. If it fails, recordFailure
        // re-opens immediately.
        c.openedAt = 0;
        c.failures = CIRCUIT_FAILURE_THRESHOLD - 1;
        return false;
    }
    return true;
}

function recordFailure(apiKey) {
    const c = circuitFor(apiKey);
    c.failures++;
    if (c.failures >= CIRCUIT_FAILURE_THRESHOLD) c.openedAt = Date.now();
}

function recordSuccess(apiKey) {
    const c = circuitFor(apiKey);
    c.failures = 0;
    c.openedAt = 0;
}

function resetCircuits() {
    circuits.clear();
}

function createGeminiClient(apiKey) {
    return new GoogleGenAI({ apiKey: String(apiKey).trim() });
}

/**
 * The tenant's own key if set, otherwise the platform's.
 *
 * The fallback is a real cost decision, not an oversight: with
 * GEMINI_API_KEY set, every tenant who hasn't configured a key spends the
 * operator's quota. That is why the per-account and global concurrency
 * limits in routes/api.js exist.
 */
function getApiKey(userId) {
    const { getSetting } = require('./database');
    const apiKey = getSetting(userId, 'gemini_api_key') || process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'your_gemini_api_key_here' && String(apiKey).trim() !== '') {
        return String(apiKey).trim();
    }
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Only errors a retry could plausibly fix.
 *
 * Retrying a 400 (bad request) or 401/403 (bad key) can never succeed — it
 * just multiplies latency and quota burn. Note 429 IS retried, but with
 * backoff and a hard cap, because a short rate-limit window often clears.
 */
function isRetryableError(err) {
    const msg = String(err?.message || err);
    if (/\b(400|401|403|404)\b/.test(msg)) return false;
    return (
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        err?.code === 'ENOTFOUND' ||
        err?.code === 'EAI_AGAIN' ||
        /\b(429|500|502|503|504)\b/.test(msg) ||
        /timed out|timeout|socket hang up|network|ECONNREFUSED/i.test(msg)
    );
}

/** True when the error means "this key cannot be used", so stop immediately. */
function isFatalKeyError(err) {
    const msg = String(err?.message || err);
    return /\b(401|403)\b/.test(msg) || /API key not valid|permission denied/i.test(msg);
}

async function withTimeout(promise, ms, label = 'operation') {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            })
        ]);
    } finally {
        // Without this the timer keeps the event loop referenced for up to
        // 30s after a fast success — harmless individually, but it delays
        // graceful shutdown and shows up as phantom handles under load.
        clearTimeout(timer);
    }
}

/**
 * Calls Gemini with timeout, bounded retry, model fallback, and circuit
 * breaking. `requestFn(client, model)` performs the actual request.
 *
 * Throws on failure rather than returning null, so callers must decide what
 * a failed AI call means for their feature (the chatbot falls back to
 * keyword rules; lead analysis surfaces an error).
 */
async function callGeminiWithRetry(userId, requestFn, label = 'Gemini call') {
    const apiKey = getApiKey(userId);
    if (!apiKey) {
        const err = new Error('No Gemini API key is configured. Add one in Settings → AI Behavior.');
        err.code = 'NO_API_KEY';
        err.status = 400;
        throw err;
    }

    if (isCircuitOpen(apiKey)) {
        const err = new Error('AI is temporarily unavailable after repeated failures. Please try again in a minute.');
        err.code = 'AI_CIRCUIT_OPEN';
        err.status = 503;
        throw err;
    }

    const client = createGeminiClient(apiKey);
    let lastError = null;

    for (const model of MODELS_TO_TRY) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const result = await withTimeout(requestFn(client, model), GEMINI_TIMEOUT_MS, `${label} (${model})`);
                recordSuccess(apiKey);
                return result;
            } catch (err) {
                lastError = err;
                // Never log the error object wholesale — a Gemini transport
                // error can carry the request URL, which contains the key.
                console.log(`   ⚠️ ${label}: ${model} attempt ${attempt + 1} failed - ${sanitizeError(err)}`);

                if (isFatalKeyError(err)) {
                    recordFailure(apiKey);
                    const e = new Error('The configured Gemini API key was rejected. Check it in Settings → AI Behavior.');
                    e.code = 'BAD_API_KEY';
                    e.status = 400;
                    throw e;
                }

                if (attempt < MAX_RETRIES && isRetryableError(err)) {
                    // Exponential backoff with jitter. The jitter matters when
                    // several tenants hit the same 429 window: without it they
                    // all retry in lockstep and re-trigger it together.
                    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
                    await sleep(delay);
                    continue;
                }
                break; // move to the next model
            }
        }
    }

    recordFailure(apiKey);
    const err = new Error(`AI request failed: ${sanitizeError(lastError)}`);
    err.code = 'AI_FAILED';
    err.status = 502;
    throw err;
}

/** Error text with anything credential-shaped stripped out. */
function sanitizeError(err) {
    const raw = String(err?.message || err || 'unknown error').split('\n')[0];
    return raw
        .replace(/key=[\w-]+/gi, 'key=[redacted]')
        .replace(/AIza[\w-]{10,}/g, '[redacted]')
        .slice(0, 300);
}

function extractText(response) {
    return response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text;
}

/**
 * Parses a JSON object out of a model response.
 *
 * Bounded before parsing: a model can be induced to emit a very large
 * response, and JSON.parse on multiple megabytes blocks the event loop for
 * every tenant. Anything beyond the cap is treated as unparseable.
 */
const MAX_JSON_RESPONSE_CHARS = 200000;

function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_JSON_RESPONSE_CHARS) return null;
    let cleaned = text.trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);
    try {
        const parsed = JSON.parse(cleaned);
        // Reject arrays/primitives: every caller expects an object and would
        // otherwise read properties off something unexpected.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

module.exports = {
    MODELS_TO_TRY,
    getApiKey,
    callGeminiWithRetry,
    extractText,
    parseJsonResponse,
    sanitizeError,
    isRetryableError,
    isFatalKeyError,
    isCircuitOpen,
    recordFailure,
    recordSuccess,
    resetCircuits,
    GEMINI_TIMEOUT_MS,
    MAX_RETRIES,
    CIRCUIT_FAILURE_THRESHOLD,
    CIRCUIT_COOLDOWN_MS
};


