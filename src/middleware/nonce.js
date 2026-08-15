/**
 * nonce.js — per-request CSP nonce generator.
 *
 * Generates a cryptographically random nonce for each request and attaches it
 * to res.locals.nonce. The CSP header then uses this nonce to allow only
 * scripts/styles with the matching nonce attribute, replacing 'unsafe-inline'.
 *
 * The nonce is 32 bytes (256 bits), base64url-encoded — unguessable and
 * compliant with CSP Level 3.
 */
const crypto = require('crypto');

function nonceMiddleware(req, res, next) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    res.locals.nonce = nonce;
    next();
}

module.exports = { nonceMiddleware };