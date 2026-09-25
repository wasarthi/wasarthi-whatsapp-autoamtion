const request = require('supertest');
const fs = require('fs');
const path = require('path');

async function readyUser(email, { vertical = 'general', documentSendEnabled = 1 } = {}) {
    const user = await createUserDirect({ email });
    require('../src/services/database').updateUser(user.user.id, {
        business_vertical: vertical,
        document_send_enabled: documentSendEnabled
    });
    const wa = require('../src/services/whatsapp-client');
    const lib = require('whatsapp-web.js');
    wa.initWhatsAppClient(user.user.id);
    lib.__last().becomeReady();
    return user;
}

function send(app, user, file, fields = {}) {
    const req = request(app).post('/api/messages/send').set('Cookie', user.cookie).field('phone', '919876543210');
    if (fields.idempotencyKey) req.set('Idempotency-Key', fields.idempotencyKey);
    if (fields.body !== undefined) req.field('body', fields.body);
    if (file) req.attach('document', file.data, { filename: file.name, contentType: file.type });
    return req;
}

describe('Quick Send documents', () => {
    let app;
    beforeEach(async () => { await freshDatabase(); app = createTestApp(); });

    test('keeps text-only sends working', async () => {
        const user = await readyUser('text@example.com', { documentSendEnabled: 0 });
        const res = await request(app).post('/api/messages/send').set('Cookie', user.cookie).send({ phone: '919876543210', body: 'hello' });
        expect(res.status).toBe(200);
        expect(require('whatsapp-web.js').__last().sent[0].text).toBe('hello');
    });

    test('healthcare user can send PDF even when document flag is off', async () => {
        const user = await readyUser('healthcare-doc@example.com', { vertical: 'healthcare', documentSendEnabled: 0 });
        const res = await send(app, user, { name: 'care.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 care') });
        expect(res.status).toBe(200);
        expect(require('../src/services/database').getMessages(user.user.id)[0].message_type).toBe('document');
    });

    test('healthcare user can send normal text', async () => {
        const user = await readyUser('healthcare-text@example.com', { vertical: 'healthcare', documentSendEnabled: 0 });
        const res = await request(app).post('/api/messages/send').set('Cookie', user.cookie).send({ phone: '919876543210', body: 'hello clinic' });
        expect(res.status).toBe(200);
        expect(require('whatsapp-web.js').__last().sent[0].text).toBe('hello clinic');
    });

    test('sales user with document permission ON can send PDF', async () => {
        const user = await readyUser('sales-doc-on@example.com', { documentSendEnabled: 1 });
        const res = await send(app, user, { name: 'sales.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 sales') });
        expect(res.status).toBe(200);
        expect(require('whatsapp-web.js').__last().sent).toHaveLength(1);
    });

    test('sales user with document permission OFF cannot send PDF', async () => {
        const user = await readyUser('sales-doc-off@example.com', { documentSendEnabled: 0 });
        const res = await send(app, user, { name: 'blocked.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 blocked') });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('DOCUMENT_SEND_DISABLED');
        expect(require('whatsapp-web.js').__last().sent).toHaveLength(0);
    });

    test('sales user with document permission OFF can still send text', async () => {
        const user = await readyUser('sales-text-off@example.com', { documentSendEnabled: 0 });
        const res = await request(app).post('/api/messages/send').set('Cookie', user.cookie).send({ phone: '919876543210', body: 'text only' });
        expect(res.status).toBe(200);
        expect(require('whatsapp-web.js').__last().sent[0].text).toBe('text only');
    });

    test('admin can enable and disable document sending', async () => {
        const db = require('../src/services/database');
        const admin = await createUserDirect({ email: 'admin-docs@example.com' });
        const user = await createUserDirect({ email: 'managed-docs@example.com' });
        db.updateUser(admin.user.id, { role: 'admin' });

        const enabled = await request(app)
            .patch(`/api/admin/users/${user.user.id}`)
            .set('Cookie', admin.cookie)
            .send({ document_send_enabled: 1 });
        expect(enabled.status).toBe(200);
        expect(enabled.body.data.document_send_enabled).toBe(1);

        const disabled = await request(app)
            .patch(`/api/admin/users/${user.user.id}`)
            .set('Cookie', admin.cookie)
            .send({ document_send_enabled: 0 });
        expect(disabled.status).toBe(200);
        expect(disabled.body.data.document_send_enabled).toBe(0);
    });

    test('non-admin cannot modify another user document permission', async () => {
        const actor = await createUserDirect({ email: 'not-admin-docs@example.com' });
        const target = await createUserDirect({ email: 'target-docs@example.com' });
        const res = await request(app)
            .patch(`/api/admin/users/${target.user.id}`)
            .set('Cookie', actor.cookie)
            .send({ document_send_enabled: 1 });
        expect(res.status).toBe(403);
        expect(require('../src/services/database').getUserById(target.user.id).document_send_enabled).toBe(0);
    });

    test('frontend hides and disables document upload when permission is OFF', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
        expect(html).toContain('id="quickSendDocumentField"');
        expect(js).toContain('function canCurrentUserSendDocuments()');
        expect(js).toContain("field.style.display = allowed ? '' : 'none'");
        expect(js).toContain('input.disabled = !allowed');
        expect(js).toContain('Document sending is not enabled for your account.');
    });

    test('sends a document alone and records safe metadata', async () => {
        const user = await readyUser('doc@example.com');
        const res = await send(app, user, { name: 'quote.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 test') });
        expect(res.status).toBe(200);
        const row = require('../src/services/database').getMessages(user.user.id)[0];
        expect(row).toMatchObject({ message_type: 'document', attachment_name: 'quote.pdf', attachment_mime: 'application/pdf', status: 'sent' });
        expect(row.attachment_ref).toMatch(/^doc:/);
    });

    test('sends a document with its caption', async () => {
        const user = await readyUser('caption@example.com');
        const res = await send(app, user, { name: 'quote.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 test') }, { body: 'Please review' });
        expect(res.status).toBe(200);
        expect(require('whatsapp-web.js').__last().sent[0].options).toEqual({ caption: 'Please review' });
    });

    test.each([
        ['invalid MIME type', { name: 'bad.pdf', type: 'text/plain', data: Buffer.from('%PDF-1.7') }],
        ['invalid extension', { name: 'bad.exe', type: 'application/pdf', data: Buffer.from('%PDF-1.7') }]
    ])('rejects %s', async (_, file) => {
        const user = await readyUser(`reject-${Date.now()}@example.com`);
        expect((await send(app, user, file)).status).toBe(400);
    });

    test('rejects an oversized upload', async () => {
        process.env.MAX_DOCUMENT_BYTES = '8';
        const user = await readyUser('large@example.com');
        expect((await send(app, user, { name: 'large.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 too large') })).status).toBe(400);
        delete process.env.MAX_DOCUMENT_BYTES;
    });

    test('rejects a request with neither text nor file', async () => {
        const user = await readyUser('missing@example.com');
        expect((await send(app, user, null)).status).toBe(400);
    });

    test('does not expose a tenant document record to another tenant', async () => {
        const alice = await readyUser('alice-doc@example.com');
        const bob = await readyUser('bob-doc@example.com');
        expect((await send(app, alice, { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') })).status).toBe(200);
        expect(require('../src/services/database').getMessages(bob.user.id)).toEqual([]);
    });

    test('serves a sent document only to its owning tenant', async () => {
        const alice = await readyUser('alice-access@example.com');
        const bob = await readyUser('bob-access@example.com');
        await send(app, alice, { name: 'private.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7 private') });
        const row = require('../src/services/database').getMessages(alice.user.id)[0];
        const own = await request(app).get(`/api/documents/${encodeURIComponent(row.attachment_ref)}`).set('Cookie', alice.cookie);
        const other = await request(app).get(`/api/documents/${encodeURIComponent(row.attachment_ref)}`).set('Cookie', bob.cookie);
        const anonymous = await request(app).get(`/api/documents/${encodeURIComponent(row.attachment_ref)}`);
        expect(own.status).toBe(200);
        expect(own.headers['content-type']).toContain('application/pdf');
        expect(own.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(own.headers['content-security-policy']).toContain("frame-ancestors 'self'");
        expect(other.status).toBe(404);
        expect(anonymous.status).toBe(401);
        expect(JSON.stringify(row)).not.toContain('documents\\');
    });

    test('counts only successfully sent documents in dashboard statistics', async () => {
        const user = await readyUser('stats@example.com');
        await send(app, user, { name: 'sent.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') });
        require('whatsapp-web.js').__setSendError('send failed');
        await send(app, user, { name: 'failed.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') });
        const stats = await request(app).get('/api/dashboard/stats').set('Cookie', user.cookie);
        expect(stats.body.data.documentsShared).toBe(1);
    });

    test('rejects path traversal filenames', async () => {
        const user = await readyUser('path@example.com');
        const boundary = 'test-boundary';
        const payload = `--${boundary}\r\nContent-Disposition: form-data; name="phone"\r\n\r\n919876543210\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="../bad.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\r\n--${boundary}--\r\n`;
        expect((await request(app).post('/api/messages/send').set('Cookie', user.cookie).set('Content-Type', `multipart/form-data; boundary=${boundary}`).send(payload)).status).toBe(400);
    });

    test('records WhatsApp document-send failure and cleans the temporary file', async () => {
        const user = await readyUser('fail@example.com');
        require('whatsapp-web.js').__setSendError('send failed');
        expect((await send(app, user, { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') }, { body: 'x' })).status).toBe(502);
        const tempDir = path.join(process.env.PERSIST_ROOT, 'tmp-uploads', String(user.user.id));
        expect(!fs.existsSync(tempDir) || fs.readdirSync(tempDir)).toEqual(!fs.existsSync(tempDir) ? true : []);
    });

    test('does not send a document twice when the same idempotency key is retried', async () => {
        const user = await readyUser('duplicate@example.com');
        const file = { name: 'once.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') };
        const first = await send(app, user, file, { idempotencyKey: 'document-retry-1' });
        const retry = await send(app, user, file, { idempotencyKey: 'document-retry-1' });
        expect(first.status).toBe(200);
        expect(retry.status).toBe(200);
        expect(retry.body.data.duplicate).toBe(true);
        expect(require('whatsapp-web.js').__last().sent).toHaveLength(1);
        expect(require('../src/services/database').getMessages(user.user.id)).toHaveLength(1);
    });

    test('does not report a failed idempotent document send as successful', async () => {
        const user = await readyUser('duplicate-failure@example.com');
        const file = { name: 'failed-once.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.7') };
        require('whatsapp-web.js').__setSendError('send failed');
        const first = await send(app, user, file, { idempotencyKey: 'document-failure-1' });
        const retry = await send(app, user, file, { idempotencyKey: 'document-failure-1' });
        expect(first.status).toBe(502);
        expect(retry.status).toBe(409);
        expect(retry.body.code).toBe('IDEMPOTENT_SEND_FAILED');
    });
});
