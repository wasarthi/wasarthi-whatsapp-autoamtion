const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ValidationError } = require('./validate');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const HARD_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = {
    '.pdf': ['application/pdf'],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    '.txt': ['text/plain'],
    '.csv': ['text/csv', 'application/csv']
};

function maxDocumentBytes() {
    const value = Number.parseInt(process.env.MAX_DOCUMENT_BYTES, 10);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, HARD_MAX_BYTES) : DEFAULT_MAX_BYTES;
}

function multipartBody(req, res, next) {
    const type = req.headers['content-type'] || '';
    if (!/^multipart\/form-data/i.test(type)) return next();
    const match = type.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    if (!match || !Buffer.isBuffer(req.body)) return next(new ValidationError('Invalid multipart upload.', 'document'));
    const boundary = `--${match[1] || match[2]}`;
    const fields = {};
    let file = null;
    for (const chunk of req.body.toString('latin1').split(boundary).slice(1, -1)) {
        const part = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
        if (!disposition) continue;
        const name = disposition[1];
        const data = Buffer.from(part.slice(headerEnd + 4), 'latin1');
        if (disposition[2] !== undefined) {
            if (name !== 'document' || file) return next(new ValidationError('Only one document upload is allowed.', 'document'));
            const mime = (headers.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || '';
            file = { originalname: disposition[2], mimetype: mime.trim().toLowerCase(), buffer: data };
        } else if (['phone', 'body', 'idempotencyKey'].includes(name) && fields[name] === undefined) {
            fields[name] = data.toString('utf8');
        }
    }
    req.body = fields;
    req.document = file;
    next();
}

function validateDocument(file) {
    if (!file) return null;
    if (!file.originalname || file.originalname !== path.basename(file.originalname)) throw new ValidationError('Invalid document filename.', 'document');
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED[ext]) throw new ValidationError('This document extension is not allowed.', 'document');
    if (!ALLOWED[ext].includes(file.mimetype)) throw new ValidationError('Document MIME type does not match an allowed type.', 'document');
    if (!file.buffer.length) throw new ValidationError('Document is empty.', 'document');
    if (file.buffer.length > maxDocumentBytes()) throw new ValidationError(`Document exceeds the ${(maxDocumentBytes() / 1024 / 1024).toFixed(0)}MB limit.`, 'document');
    if (ext === '.pdf' && !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new ValidationError('Invalid PDF document.', 'document');
    if (['.docx', '.xlsx', '.pptx'].includes(ext) && !file.buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) throw new ValidationError('Invalid Office document.', 'document');
    return { filename: file.originalname, mimetype: file.mimetype, buffer: file.buffer };
}

function createTemporaryDocument(userId, document) {
    const root = process.env.PERSIST_ROOT || path.join(__dirname, '..', '..');
    const dir = path.join(root, 'tmp-uploads', String(Number(userId)));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${crypto.randomUUID()}.upload`);
    fs.writeFileSync(filePath, document.buffer, { flag: 'wx', mode: 0o600 });
    return { ...document, reference: `doc:${crypto.randomUUID()}`, temporaryPath: filePath };
}

function privateDocumentPath(userId, reference) {
    const match = /^doc:([0-9a-f-]{36})$/i.exec(String(reference || ''));
    if (!match) return null;
    const root = process.env.PERSIST_ROOT || path.join(__dirname, '..', '..');
    return path.join(root, 'documents', String(Number(userId)), `${match[1]}.document`);
}

function persistTemporaryDocument(userId, document) {
    const target = privateDocumentPath(userId, document?.reference);
    if (!target || !document?.temporaryPath) throw new Error('Invalid temporary document');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(document.temporaryPath, target);
    return { ...document, storedPath: target };
}

function cleanupTemporaryDocument(document) {
    if (!document?.temporaryPath) return;
    try { fs.unlinkSync(document.temporaryPath); } catch (_) {}
}

module.exports = { maxDocumentBytes, multipartBody, validateDocument, createTemporaryDocument, persistTemporaryDocument, privateDocumentPath, cleanupTemporaryDocument };
