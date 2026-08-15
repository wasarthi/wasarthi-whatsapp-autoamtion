/**
 * logger.js — structured JSON logging with PII masking.
 *
 * Replaces morgan('dev') which logs full URLs (including phone numbers in
 * paths like /api/messages/conversation/:phone) to stdout. This logger:
 *   - Outputs structured JSON (timestamp, level, message, context)
 *   - Masks phone numbers, emails, API keys, and other PII
 *   - Uses console.log for stdout (works with Docker log drivers)
 *   - Zero dependencies
 */

const PII_PATTERNS = [
    // Phone numbers in URLs: /api/messages/conversation/919876543210
    /\/api\/messages\/conversation\/(\d+)/gi,
    // Phone numbers in URLs: /api/leads/analyze/919876543210
    /\/api\/leads\/analyze\/(\d+)/gi,
    // Phone numbers in URLs: /api/crm/deals/phone/919876543210
    /\/api\/crm\/deals\/phone\/(\d+)/gi,
    // Phone numbers in URLs: /api/contacts/outreach/
    /\/api\/contacts\/outreach\/[^/]+\/cancel/gi,
    // Phone numbers in query params: ?phone=919876543210
    /[?&]phone=(\d+)/gi,
    // Phone numbers in request bodies: "phone":"919876543210"
    /"phone"\s*:\s*"(\d+)"/gi,
    // Email addresses
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    // API keys (Google AI key shape)
    /AIza[\w-]{10,}/g,
    // Generic secret key shape
    /sk-[A-Za-z0-9]{10,}/g,
    // Bearer tokens
    /Bearer\s+\S+/gi,
    // Authorization headers
    /Authorization:\s*\S+/gi,
    // Cookie headers
    /Cookie:\s*\S+/gi,
];

/**
 * Masks PII in a log message.
 * @param {string} msg - The log message
 * @returns {string} Masked message
 */
function maskPII(msg) {
    let out = String(msg);
    for (const re of PII_PATTERNS) {
        out = out.replace(re, (match) => {
            // For phone numbers, keep first 3 and last 3 digits
            if (/^\d{7,}$/.test(match.replace(/\D/g, ''))) {
                const digits = match.replace(/\D/g, '');
                if (digits.length > 6) {
                    return match.replace(digits, digits.slice(0, 3) + '***'.repeat(Math.ceil((digits.length - 6) / 3)) + digits.slice(-3));
                }
                return match.replace(digits, '***'.repeat(digits.length));
            }
            // For emails, mask the local part
            if (/@/.test(match)) {
                const [local, domain] = match.split('@');
                return `${local.slice(0, 2)}***@${domain}`;
            }
            // For API keys and tokens, fully redact
            return '[REDACTED]';
        });
    }
    return out;
}

/**
 * Logs a message at the specified level with structured context.
 * @param {'info'|'warn'|'error'|'debug'} level - Log level
 * @param {string} msg - Log message (will be PII-masked)
 * @param {Object} [meta] - Additional context (will be JSON-stringified and masked)
 */
function log(level, msg, meta = {}) {
    const timestamp = new Date().toISOString();
    const maskedMsg = maskPII(msg);
    const maskedMeta = maskPII(JSON.stringify(meta));

    const entry = {
        ts: timestamp,
        level,
        msg: maskedMsg,
        ...JSON.parse(maskedMeta || '{}')
    };

    console.log(JSON.stringify(entry));
}

function info(msg, meta) { log('info', msg, meta); }
function warn(msg, meta) { log('warn', msg, meta); }
function error(msg, meta) { log('error', msg, meta); }
function debug(msg, meta) { log('debug', msg, meta); }

// HTTP request logging middleware (replaces morgan)
function requestLogger(req, res, next) {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(2, 10);

    // Log request start (minimal info, no PII)
    info('http_request_start', {
        requestId,
        method: req.method,
        path: maskPII(req.originalUrl),
        ip: req.ip
    });

    res.on('finish', () => {
        const duration = Date.now() - start;
        info('http_request_complete', {
            requestId,
            method: req.method,
            path: maskPII(req.originalUrl),
            statusCode: res.statusCode,
            durationMs: duration
        });
    });

    next();
}

module.exports = {
    maskPII,
    log,
    info,
    warn,
    error,
    debug,
    requestLogger,
    PII_PATTERNS
};