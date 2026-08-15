/**
 * middleware/errors.js — one place that decides what a client is told when
 * something goes wrong, and what gets written to the log instead.
 *
 * Every route in this project used to end with:
 *
 *     catch (error) { res.status(500).json({ error: error.message }) }
 *
 * which is three separate problems in one line. It reports a validation
 * mistake (the client's fault) as a server failure, so monitoring can't
 * tell a bad request from a broken deploy. It leaks internals — SQLite
 * messages name tables and columns, fs errors contain absolute filesystem
 * paths, and a thrown Gemini error can carry a URL with the API key in the
 * query string. And it hides the stack trace from the operator, who needs
 * it more than the attacker does.
 */

const { ValidationError } = require('./validate');

/** Never let these substrings reach a client response body. */
const SENSITIVE_PATTERNS = [
    /key=[\w-]+/gi,
    /apikey[=:]\s*\S+/gi,
    /AIza[\w-]{10,}/g,          // Google API key shape
    /sk-[A-Za-z0-9]{10,}/g,     // generic secret-key shape
    /Bearer\s+\S+/gi
];

function redact(message) {
    let out = String(message == null ? '' : message);
    for (const pattern of SENSITIVE_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
}

/**
 * Wraps an async route handler so a rejected promise reaches Express's
 * error handler instead of hanging the request.
 *
 * Express 4 does not await handlers: an async function that throws produces
 * an unhandled rejection, the client never gets a response, and (because
 * server.js exits on unhandledRejection) the whole process restarts —
 * every other tenant's request dropped because one route threw.
 */
function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Terminal error handler.
 *
 * Client errors (validation, 4xx set explicitly by a route) keep their
 * message, because it's actionable and contains only what the caller sent.
 * Anything else becomes a generic 500 with a short correlation id; the real
 * message and stack go to the log where an operator can find it by that id.
 */
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || (err instanceof ValidationError ? 400 : 500);
    const isClientError = status >= 400 && status < 500;

    if (isClientError) {
        const body = { success: false, error: redact(err.message) };
        if (err.code) body.code = err.code;
        if (err.field) body.field = err.field;
        return res.status(status).json(body);
    }

    const ref = Math.random().toString(36).slice(2, 10);
    console.error(`❌ [${ref}] ${req.method} ${req.originalUrl} failed:`, err.message);
    if (err.stack) console.error(err.stack);

    res.status(status).json({
        success: false,
        error: 'Something went wrong on our side. Please try again.',
        ref
    });
}

module.exports = { asyncHandler, errorHandler, redact };

