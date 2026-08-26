/**
 * Multi-tenant isolation.
 *
 * This is the suite that matters most for a SaaS: everything else is a bug,
 * but a leak here is the end of the product. The approach is deliberately not
 * "check that the middleware exists" — it enumerates every data-bearing route
 * and, for each one, has tenant B attempt to read, modify, or delete tenant
 * A's specific rows using A's real identifiers.
 *
 * Authentication middleware mounted at a high level proves nothing about
 * isolation: a query missing `WHERE user_id = ?` is perfectly authenticated
 * and still serves the wrong customer's data.
 */
const request = require('supertest');

describe('Multi-tenant isolation', () => {
    let app;
    let admin, alice, bob;

    /** Populates one tenant with a row in every table, returning their ids. */
    async function seed(tenant, tag) {
        const post = (path, body) =>
            request(app).post(path).set('Cookie', tenant.cookie).send(body);

        const contact = await post('/api/contacts', {
            phone: tag.phone, name: `${tag.name} Contact`, label: tag.name, notes: `${tag.name} private notes`
        });
        const rule = await post('/api/chatbot/rules', {
            trigger_keyword: `${tag.name}-secret-keyword`, response_text: `${tag.name} private response`
        });
        const product = await post('/api/products', {
            name: `${tag.name} Product`, price: '999', description: `${tag.name} confidential`
        });
        const scheduled = await post('/api/scheduled', {
            phone: tag.phone, body: `${tag.name} scheduled body`, scheduled_at: '2030-06-01 10:00:00'
        });
        const deal = await post('/api/crm/deals', {
            phone: tag.phone, contact_name: `${tag.name} Deal`, deal_value: 5000, notes: `${tag.name} deal notes`
        });
        const note = await post(`/api/crm/deals/phone/${tag.phone}/notes`, {
            content: `${tag.name} activity note`
        });

        for (const res of [contact, rule, product, scheduled, deal, note]) {
            expect(res.status).toBe(200);
        }

        // Messages have no create route (they come from WhatsApp), so insert
        // directly — the read paths are what we're testing.
        const { logMessage, saveLeadAnalysis } = require('../src/services/database');
        logMessage(tenant.user.id, {
            phone: tag.phone, contactName: `${tag.name} Contact`,
            direction: 'incoming', body: `${tag.name} incoming secret`
        });
        logMessage(tenant.user.id, {
            phone: tag.phone, contactName: `${tag.name} Contact`,
            direction: 'outgoing', body: `${tag.name} outgoing secret`
        });
        saveLeadAnalysis(tenant.user.id, tag.phone, {
            contactName: `${tag.name} Contact`, summary: `${tag.name} lead summary`,
            interestStatus: 'interested', interestScore: 90, priority: 'high', messageCount: 2
        });

        return {
            phone: tag.phone,
            contactId: contact.body.data.id,
            ruleId: rule.body.data.id,
            productId: product.body.data.id,
            scheduledId: scheduled.body.data.id,
            dealId: deal.body.data.id,
            leadId: require('../src/services/database').getLeadAnalysis(tenant.user.id, tag.phone).id
        };
    }

    beforeEach(async () => {
        await freshDatabase();
        app = createTestApp();
        admin = await signup(app, { email: 'admin@iso.test' });
        require('../src/services/database').updateUser(admin.user.id, { role: 'admin' });
        alice = await signup(app, { email: 'alice@iso.test' });
        bob   = await signup(app, { email: 'bob@iso.test' });
        alice.data = await seed(alice, { name: 'alice', phone: '911111111111' });
        bob.data    = await seed(bob,   { name: 'bob',   phone: '922222222222' });
    });

    // ─────────────────────────────────────────────────────────
    describe('List endpoints return only the caller\'s rows', () => {
        const listRoutes = [
            ['/api/contacts', 'alice'],
            ['/api/messages', 'alice'],
            ['/api/chatbot/rules', 'alice'],
            ['/api/scheduled', 'alice'],
            ['/api/products', 'alice'],
            ['/api/crm/deals', 'alice'],
            ['/api/leads', 'alice'],
            ['/api/business', 'alice'],
            ['/api/dashboard/stats', 'alice'],
            ['/api/settings', 'alice'],
            ['/api/crm/analytics', 'alice']
        ];

        test.each(listRoutes)('%s never contains the other tenant\'s data', async (route) => {
            const asBob = await request(app).get(route).set('Cookie', bob.cookie);
            expect(asBob.status).toBe(200);

            const body = JSON.stringify(asBob.body);
            // Alice's marker strings must appear nowhere in Bob's response.
            expect(body).not.toMatch(/alice/i);
            expect(body).not.toContain('911111111111');
        });

        test('each tenant sees exactly their own counts', async () => {
            const aliceContacts = await request(app).get('/api/contacts').set('Cookie', alice.cookie);
            const bobContacts   = await request(app).get('/api/contacts').set('Cookie', bob.cookie);

            expect(aliceContacts.body.data).toHaveLength(1);
            expect(bobContacts.body.data).toHaveLength(1);
            expect(aliceContacts.body.data[0].phone).toBe('911111111111');
            expect(bobContacts.body.data[0].phone).toBe('922222222222');
        });

        test('dashboard statistics are computed per tenant', async () => {
            const { logMessage } = require('../src/services/database');
            for (let i = 0; i < 5; i++) {
                logMessage(alice.user.id, { phone: '911111111111', direction: 'incoming', body: `extra ${i}` });
            }

            const a = await request(app).get('/api/dashboard/stats').set('Cookie', alice.cookie);
            const b = await request(app).get('/api/dashboard/stats').set('Cookie', bob.cookie);

            expect(a.body.data.totalMessages).toBe(7); // 2 seeded + 5
            expect(b.body.data.totalMessages).toBe(2);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Reading another tenant\'s record by id (IDOR / BOLA)', () => {
        // Every one of these must be indistinguishable from "does not exist".
        // Returning 403 instead of 404 would itself confirm the id is real,
        // which leaks the existence of another tenant's records.
        test('GET a deal by the other tenant\'s phone', async () => {
            const res = await request(app)
                .get(`/api/crm/deals/phone/${alice.data.phone}`)
                .set('Cookie', bob.cookie);
            expect(res.status).toBe(404);
            expect(JSON.stringify(res.body)).not.toMatch(/alice/i);
        });

        test('GET a lead analysis by the other tenant\'s phone', async () => {
            const res = await request(app)
                .get(`/api/leads/${alice.data.phone}`)
                .set('Cookie', bob.cookie);
            expect(res.status).toBe(404);
        });

        test('GET a conversation by the other tenant\'s phone returns nothing', async () => {
            const res = await request(app)
                .get(`/api/messages/conversation/${alice.data.phone}`)
                .set('Cookie', bob.cookie);
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
        });

        test('filtering messages by the other tenant\'s phone returns nothing', async () => {
            const res = await request(app)
                .get(`/api/messages?phone=${alice.data.phone}`)
                .set('Cookie', bob.cookie);
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
        });

        test('GET CRM activities for the other tenant\'s phone returns nothing', async () => {
            // Reached through the deal detail route, which 404s first — assert
            // the underlying query is scoped too, not just the wrapper.
            const { getCrmActivities } = require('../src/services/database');
            expect(getCrmActivities(bob.user.id, alice.data.phone)).toEqual([]);
            expect(getCrmActivities(alice.user.id, alice.data.phone).length).toBeGreaterThan(0);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Modifying another tenant\'s record by id', () => {
        test('PUT another tenant\'s chatbot rule does not change it', async () => {
            const res = await request(app)
                .put(`/api/chatbot/rules/${alice.data.ruleId}`)
                .set('Cookie', bob.cookie)
                .send({ response_text: 'HIJACKED' });

            expect(res.status).toBe(404);

            const { getChatbotRules } = require('../src/services/database');
            const rule = getChatbotRules(alice.user.id).find(r => r.id === alice.data.ruleId);
            expect(rule.response_text).toBe('alice private response');
        });

        test('PUT another tenant\'s product does not change it', async () => {
            const res = await request(app)
                .put(`/api/products/${alice.data.productId}`)
                .set('Cookie', bob.cookie)
                .send({ name: 'HIJACKED', price: '0' });

            expect(res.status).toBe(404);

            const { getProducts } = require('../src/services/database');
            const product = getProducts(alice.user.id).find(p => p.id === alice.data.productId);
            expect(product.name).toBe('alice Product');
        });

        test('PUT another tenant\'s CRM deal does not change it', async () => {
            const res = await request(app)
                .put(`/api/crm/deals/${alice.data.dealId}`)
                .set('Cookie', bob.cookie)
                .send({ stage: 'lost', deal_value: 0, notes: 'HIJACKED' });

            expect(res.status).toBe(404);

            const { getCrmDealById } = require('../src/services/database');
            const deal = getCrmDealById(alice.user.id, alice.data.dealId);
            expect(deal.notes).toBe('alice deal notes');
            expect(deal.deal_value).toBe(5000);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Deleting another tenant\'s records', () => {
        // A DELETE scoped only by id would silently destroy another
        // customer's data and report success — the worst outcome in the
        // system, because it is both a breach and unrecoverable.
        const deletions = [
            ['contact',  (d) => `/api/contacts/${d.contactId}`],
            ['rule',     (d) => `/api/chatbot/rules/${d.ruleId}`],
            ['product',  (d) => `/api/products/${d.productId}`],
            ['deal',     (d) => `/api/crm/deals/${d.dealId}`],
            ['lead',     (d) => `/api/leads/${d.leadId}`],
            ['scheduled',(d) => `/api/scheduled/${d.scheduledId}`]
        ];

        test.each(deletions)('DELETE another tenant\'s %s fails and leaves the row intact', async (_label, pathFor) => {
            const res = await request(app)
                .delete(pathFor(alice.data))
                .set('Cookie', bob.cookie);

            expect([404, 409]).toContain(res.status);
            expect(res.body.success).toBe(false);
        });

        test('after all cross-tenant delete attempts, every one of Alice\'s rows still exists', async () => {
            for (const [, pathFor] of deletions) {
                await request(app).delete(pathFor(alice.data)).set('Cookie', bob.cookie);
            }

            const db = require('../src/services/database');
            expect(db.getContacts(alice.user.id)).toHaveLength(1);
            expect(db.getChatbotRules(alice.user.id)).toHaveLength(1);
            expect(db.getProducts(alice.user.id)).toHaveLength(1);
            expect(db.getCrmDeals(alice.user.id)).toHaveLength(1);
            expect(db.getLeadAnalyses(alice.user.id)).toHaveLength(1);
            expect(db.getScheduledMessages(alice.user.id, 'pending')).toHaveLength(1);
        });

        test('clearing message history only clears the caller\'s messages', async () => {
            await request(app).delete('/api/messages').set('Cookie', bob.cookie).expect(200);

            const { countMessages } = require('../src/services/database');
            expect(countMessages(bob.user.id)).toBe(0);
            expect(countMessages(alice.user.id)).toBe(2);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Writes cannot be attributed to another tenant', () => {
        // Mass assignment: the body names a user_id, but the server must use
        // the authenticated session's id and ignore the claim entirely.
        test('a user_id in the body is ignored when creating a contact', async () => {
            const res = await request(app).post('/api/contacts')
                .set('Cookie', bob.cookie)
                .send({ phone: '933333333333', name: 'Planted', user_id: alice.user.id });

            expect(res.status).toBe(200);

            const { getContactByPhone } = require('../src/services/database');
            expect(getContactByPhone(alice.user.id, '933333333333')).toBeNull();
            expect(getContactByPhone(bob.user.id, '933333333333')).not.toBeNull();
        });

        test('a user_id in the body is ignored when creating a deal', async () => {
            await request(app).post('/api/crm/deals')
                .set('Cookie', bob.cookie)
                .send({ phone: '944444444444', user_id: alice.user.id, contact_name: 'Planted' })
                .expect(200);

            const { getCrmDealByPhone } = require('../src/services/database');
            expect(getCrmDealByPhone(alice.user.id, '944444444444')).toBeNull();
            expect(getCrmDealByPhone(bob.user.id, '944444444444')).not.toBeNull();
        });

        test('settings written by one tenant do not appear for another', async () => {
            await request(app).put('/api/settings')
                .set('Cookie', bob.cookie)
                .send({ business_name: 'BOB ONLY', default_reply: 'bob reply' })
                .expect(200);

            const a = await request(app).get('/api/settings').set('Cookie', alice.cookie);
            expect(a.body.data.business_name).not.toBe('BOB ONLY');
            expect(a.body.data.default_reply).not.toBe('bob reply');
        });

        test('two tenants can hold the same phone number independently', async () => {
            // UNIQUE(user_id, phone) — not UNIQUE(phone). A global uniqueness
            // constraint would let one tenant's contact list block another's.
            const shared = '955555555555';
            await request(app).post('/api/contacts').set('Cookie', alice.cookie)
                .send({ phone: shared, name: 'Alice version' }).expect(200);
            await request(app).post('/api/contacts').set('Cookie', bob.cookie)
                .send({ phone: shared, name: 'Bob version' }).expect(200);

            const { getContactByPhone } = require('../src/services/database');
            expect(getContactByPhone(alice.user.id, shared).name).toBe('Alice version');
            expect(getContactByPhone(bob.user.id, shared).name).toBe('Bob version');
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Outreach jobs are owner-scoped', () => {
        test('one tenant cannot poll another tenant\'s job', async () => {
            const { startOutreachJob } = require('../src/services/outreach');
            const { getContacts } = require('../src/services/database');

            // Start a job as Alice directly (the route requires a live
            // WhatsApp connection; the ownership check is what's under test).
            const job = startOutreachJob(alice.user, getContacts(alice.user.id), 'hello {{name}}');

            const asBob = await request(app)
                .get(`/api/contacts/outreach/${job.id}`)
                .set('Cookie', bob.cookie);
            expect(asBob.status).toBe(404);

            const asAlice = await request(app)
                .get(`/api/contacts/outreach/${job.id}`)
                .set('Cookie', alice.cookie);
            expect(asAlice.status).toBe(200);

            require('../src/services/outreach').cancelAllOutreachJobs();
        });

        test('one tenant cannot cancel another tenant\'s job', async () => {
            const { startOutreachJob, getOutreachJob } = require('../src/services/outreach');
            const { getContacts } = require('../src/services/database');
            const job = startOutreachJob(alice.user, getContacts(alice.user.id), 'hi');

            const res = await request(app)
                .post(`/api/contacts/outreach/${job.id}/cancel`)
                .set('Cookie', bob.cookie);
            expect(res.status).toBe(404);
            expect(getOutreachJob(job.id, alice.user.id).cancelRequested).toBe(false);

            require('../src/services/outreach').cancelAllOutreachJobs();
        });

        test('outreach only ever resolves contacts belonging to the caller', async () => {
            const { getContactsByIds } = require('../src/services/database');
            // Bob asks for Alice's contact id explicitly.
            expect(getContactsByIds(bob.user.id, [alice.data.contactId])).toEqual([]);
            expect(getContactsByIds(alice.user.id, [alice.data.contactId])).toHaveLength(1);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('WhatsApp sessions and QR codes are per tenant', () => {
        test('status is reported per account, never shared', async () => {
            const wa = require('../src/services/whatsapp-client');
            const lib = require('whatsapp-web.js');
            lib.__reset();

            wa.initWhatsAppClient(alice.user.id);
            lib.__last().becomeReady('918888888888');

            const aliceStatus = await request(app).get('/api/status').set('Cookie', alice.cookie);
            const bobStatus   = await request(app).get('/api/status').set('Cookie', bob.cookie);

            expect(aliceStatus.body.data.connected).toBe(true);
            expect(aliceStatus.body.data.phone).toBe('918888888888');
            // Bob must see nothing at all — not a false "connected", and
            // certainly not Alice's number.
            expect(bobStatus.body.data.connected).toBe(false);
            expect(bobStatus.body.data.phone).toBeNull();

            await wa.destroyClientForUser(alice.user.id);
        });

        test('each account gets its own auth directory', () => {
            const { authDataPath } = require('../src/services/whatsapp-client');
            expect(authDataPath(alice.user.id)).not.toBe(authDataPath(bob.user.id));
            expect(authDataPath(alice.user.id)).toMatch(new RegExp(`user_${alice.user.id}$`));
        });

        test('a QR code is broadcast only to the owning account\'s listeners', async () => {
            const wa = require('../src/services/whatsapp-client');
            const lib = require('whatsapp-web.js');
            lib.__reset();

            const aliceEvents = [];
            const bobEvents = [];
const fakeRes = (sink) => ({
                setHeader() {}, flushHeaders() {}, status() { return this; }, json() {},
                write(chunk) { sink.push(chunk); }, end() {}, on() {}
            });
            const fakeReq = () => {
                const { EventEmitter } = require('events');
                const req = new EventEmitter();
                req.headers = { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' };
                return req;
            };

            wa.addSSEClient(alice.user.id, fakeReq(), fakeRes(aliceEvents));
            wa.addSSEClient(bob.user.id, fakeReq(), fakeRes(bobEvents));

            // Identify each tenant's client by its auth directory — the same
            // per-account path that keeps the sessions separate on disk.
            const clientFor = (userId) => lib.__instances.find(c =>
                String(c.options.authStrategy.dataPath).endsWith(`user_${userId}`));

            const aliceClient = clientFor(alice.user.id);
            expect(aliceClient).toBeDefined();
            expect(clientFor(bob.user.id)).toBeDefined();

            aliceClient.emitQr('ALICE-QR-PAYLOAD');
            // The handler renders the QR to a PNG data URL, which is async, so
            // poll rather than guess at a fixed delay.
            for (let i = 0; i < 40 && !aliceEvents.join('').includes('"type":"qr"'); i++) {
                await new Promise(r => setTimeout(r, 25));
            }

            const aliceStream = aliceEvents.join('');
            const bobStream = bobEvents.join('');

            expect(aliceStream).toMatch(/"type":"qr"/);
            // A QR code is a credential for attaching a phone to an account.
            // If it reached the wrong listener, one customer could hijack
            // another's WhatsApp.
            expect(bobStream).not.toMatch(/"type":"qr"/);

            await wa.destroyClientForUser(alice.user.id);
            await wa.destroyClientForUser(bob.user.id);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Account deletion affects exactly one tenant', () => {
        test('deleting Alice removes all her rows and none of Bob\'s', async () => {
            const db = require('../src/services/database');

            await request(app).delete(`/api/admin/users/${alice.user.id}`)
                .set('Cookie', admin.cookie)
                .expect(200);

            // Nothing of Alice's survives anywhere...
            const orphans = db.countOrphanedRows(alice.user.id);
            expect(orphans.total).toBe(0);
            expect(db.getUserById(alice.user.id)).toBeNull();

            // ...and Bob is completely untouched.
            expect(db.getContacts(bob.user.id)).toHaveLength(1);
            expect(db.getChatbotRules(bob.user.id)).toHaveLength(1);
            expect(db.getProducts(bob.user.id)).toHaveLength(1);
            expect(db.getCrmDeals(bob.user.id)).toHaveLength(1);
            expect(db.getLeadAnalyses(bob.user.id)).toHaveLength(1);
            expect(db.countMessages(bob.user.id)).toBe(2);
            expect(Object.keys(db.getAllSettings(bob.user.id)).length).toBeGreaterThan(0);
            expect(db.getUserById(bob.user.id)).not.toBeNull();
        });

        test('deleting a tenant tears down only that tenant\'s WhatsApp session', async () => {
            const wa = require('../src/services/whatsapp-client');
            const lib = require('whatsapp-web.js');
            lib.__reset();

            wa.initWhatsAppClient(alice.user.id);
            wa.initWhatsAppClient(bob.user.id);
            for (const c of lib.__instances) c.becomeReady();

            expect(wa.getStatus(alice.user.id).connected).toBe(true);
            expect(wa.getStatus(bob.user.id).connected).toBe(true);

            await request(app).delete(`/api/admin/users/${alice.user.id}`)
                .set('Cookie', admin.cookie).expect(200);

            expect(wa.getStatus(alice.user.id).connected).toBe(false);
            expect(wa.getStatus(bob.user.id).connected).toBe(true);

            await wa.destroyAllClients();
        });

        test('suspending a tenant stops their session but not others', async () => {
            const wa = require('../src/services/whatsapp-client');
            const lib = require('whatsapp-web.js');
            lib.__reset();

            wa.initWhatsAppClient(alice.user.id);
            wa.initWhatsAppClient(bob.user.id);
            for (const c of lib.__instances) c.becomeReady();

            await request(app).patch(`/api/admin/users/${alice.user.id}`)
                .set('Cookie', admin.cookie)
                .send({ status: 'suspended' })
                .expect(200);

            expect(wa.getStatus(alice.user.id).connected).toBe(false);
            expect(wa.getStatus(bob.user.id).connected).toBe(true);

            // And a suspended tenant can no longer reach the API at all.
            const res = await request(app).get('/api/contacts').set('Cookie', alice.cookie);
            expect(res.status).toBe(403);

            await wa.destroyAllClients();
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Isolation holds under concurrency', () => {
        // A leak that only appears under load is still a leak. This drives
        // both tenants' reads and writes simultaneously and checks that no
        // response ever contains the other's marker.
        test('interleaved reads and writes never cross tenants', async () => {
            const operations = [];

            for (let i = 0; i < 25; i++) {
                operations.push(
                    request(app).get('/api/contacts').set('Cookie', alice.cookie)
                        .then(r => ({ owner: 'alice', body: JSON.stringify(r.body) })),
                    request(app).get('/api/contacts').set('Cookie', bob.cookie)
                        .then(r => ({ owner: 'bob', body: JSON.stringify(r.body) })),
                    request(app).get('/api/messages').set('Cookie', alice.cookie)
                        .then(r => ({ owner: 'alice', body: JSON.stringify(r.body) })),
                    request(app).get('/api/messages').set('Cookie', bob.cookie)
                        .then(r => ({ owner: 'bob', body: JSON.stringify(r.body) })),
                    request(app).post('/api/contacts').set('Cookie', alice.cookie)
                        .send({ phone: `9111111${String(i).padStart(5, '0')}`, name: 'alice bulk' })
                        .then(() => ({ owner: 'alice', body: '{}' })),
                    request(app).post('/api/contacts').set('Cookie', bob.cookie)
                        .send({ phone: `9222222${String(i).padStart(5, '0')}`, name: 'bob bulk' })
                        .then(() => ({ owner: 'bob', body: '{}' }))
                );
            }

            const results = await Promise.all(operations);

            for (const { owner, body } of results) {
                if (owner === 'bob') {
                    expect(body).not.toMatch(/alice/i);
                    expect(body).not.toContain('911111111111');
                } else {
                    expect(body).not.toMatch(/\bbob\b/i);
                    expect(body).not.toContain('922222222222');
                }
            }

            // And the final state is correctly partitioned.
            const db = require('../src/services/database');
            const aliceContacts = db.getContacts(alice.user.id);
            const bobContacts = db.getContacts(bob.user.id);
            expect(aliceContacts.every(c => c.phone.startsWith('9111111'))).toBe(true);
            expect(bobContacts.every(c => c.phone.startsWith('9222222'))).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Database-layer invariants', () => {
        // Belt and braces: even if a future route forgets its scoping, these
        // assert the data-access functions themselves are tenant-safe.
        test('every tenant-scoped getter returns nothing for a foreign id', () => {
            const db = require('../src/services/database');
            const a = alice.user.id;
            const b = bob.user.id;

            expect(db.getContactByPhone(b, alice.data.phone)).toBeNull();
            expect(db.getCrmDealByPhone(b, alice.data.phone)).toBeNull();
            expect(db.getCrmDealById(b, alice.data.dealId)).toBeNull();
            expect(db.getLeadAnalysis(b, alice.data.phone)).toBeNull();
            expect(db.getConversation(b, alice.data.phone)).toEqual([]);
            expect(db.getCrmActivities(b, alice.data.phone)).toEqual([]);
            expect(db.getContactsByIds(b, [alice.data.contactId])).toEqual([]);
            expect(db.getMessages(b, { phone: alice.data.phone })).toEqual([]);

            // Sanity: the same calls DO work for the owner, so these
            // assertions aren't passing because the functions are broken.
            expect(db.getContactByPhone(a, alice.data.phone)).not.toBeNull();
            expect(db.getCrmDealByPhone(a, alice.data.phone)).not.toBeNull();
            expect(db.getConversation(a, alice.data.phone).length).toBe(2);
        });

        test('mutation helpers refuse a foreign id', () => {
            const db = require('../src/services/database');
            const b = bob.user.id;

            expect(db.deleteContact(b, alice.data.contactId).changes).toBe(0);
            expect(db.deleteChatbotRule(b, alice.data.ruleId).changes).toBe(0);
            expect(db.deleteProduct(b, alice.data.productId).changes).toBe(0);
            expect(db.deleteCrmDeal(b, alice.data.dealId).changes).toBe(0);
            expect(db.deleteLeadAnalysis(b, alice.data.leadId).changes).toBe(0);
            expect(db.cancelScheduledMessage(b, alice.data.scheduledId).changes).toBe(0);
            expect(db.updateChatbotRule(b, alice.data.ruleId, { response_text: 'x' }).changes).toBe(0);
            expect(db.markContactOutreached(b, alice.data.phone).changes).toBe(0);
        });
    });
});

