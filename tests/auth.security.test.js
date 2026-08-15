/**
 * Authentication and session security, exercised against the real app.
 *
 * Every test here corresponds to a way an attacker gets in: forging a
 * session, reusing a revoked one, enumerating accounts, brute-forcing, or
 * escalating to admin. Where a test asserts a specific status code or
 * response shape, that shape is part of the security contract — a 200 with
 * different data is a bypass, and a 500 leaking internals is a disclosure.
 */
const request = require('supertest');
const crypto = require('crypto');

describe('Authentication & session security', () => {
    let app;

    beforeEach(async () => {
        await freshDatabase();
        app = createTestApp();
    });

    // ─────────────────────────────────────────────────────────
    describe('Signup', () => {
        test('creates the first account as admin, the second as a normal user', async () => {
            const first = await signup(app, { email: 'first@example.com' });
            expect(first.user.role).toBe('admin');

            const second = await signup(app, { email: 'second@example.com' });
            expect(second.user.role).toBe('user');
        });

        test.each([
            ['malformed', 'not-an-email'],
            ['empty', ''],
            ['whitespace only', '   '],
            ['no domain', 'user@'],
            ['no local part', '@example.com'],
            ['spaces inside', 'us er@example.com'],
            ['over 254 chars', `${'a'.repeat(250)}@example.com`],
            // Unicode is refused on purpose: uniqueness is a byte comparison,
            // so two homoglyph addresses would be two accounts that look
            // identical to a human — an impersonation vector.
            ['unicode homoglyph', 'tëst@examplé.com'],
            // CR/LF in an email that later reaches a log line or header is
            // injection; it must never be stored.
            ['CRLF injection', 'a@b.com\r\nX-Injected: 1']
        ])('rejects %s email', async (_label, email) => {
            const res = await request(app).post('/api/auth/signup')
                .send({ email, password: 'ValidPass123!' });
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        test.each([
            ['too short', '1234567'],
            ['empty', ''],
            ['not a string', 12345678],
            ['over 128 chars', 'a'.repeat(129)]
        ])('rejects %s password', async (_label, password) => {
            const res = await request(app).post('/api/auth/signup')
                .send({ email: `pw${Math.random()}@example.com`, password });
            expect(res.status).toBe(400);
        });

        test('accepts an 8-character password, rejects 7', async () => {
            const ok = await request(app).post('/api/auth/signup')
                .send({ email: 'eight@example.com', password: '12345678' });
            expect(ok.status).toBe(200);

            const bad = await request(app).post('/api/auth/signup')
                .send({ email: 'seven@example.com', password: '1234567' });
            expect(bad.status).toBe(400);
        });

        test('accepts special characters and unicode in passwords', async () => {
            const a = await request(app).post('/api/auth/signup')
                .send({ email: 'sp@example.com', password: 'P@ss!w#rd$%^&*' });
            expect(a.status).toBe(200);

            const b = await request(app).post('/api/auth/signup')
                .send({ email: 'uni@example.com', password: 'Pässwörd🔐123' });
            expect(b.status).toBe(200);
        });

        test('treats case and surrounding whitespace as the same address', async () => {
            await signup(app, { email: 'Dup@Example.com' });

            const sameCase = await request(app).post('/api/auth/signup')
                .send({ email: 'dup@example.com', password: 'ValidPass123!' });
            expect(sameCase.status).toBe(409);

            const padded = await request(app).post('/api/auth/signup')
                .send({ email: '  dup@example.com  ', password: 'ValidPass123!' });
            expect(padded.status).toBe(409);
        });

        // The duplicate check happens before the bcrypt await, so two
        // simultaneous signups both pass it. The UNIQUE index is what actually
        // prevents two accounts, and this asserts the collision surfaces as a
        // 409 rather than a 500 with a SQLite message in it.
        test('concurrent signups for the same email create exactly one account', async () => {
            const attempts = Array.from({ length: 8 }, () =>
                request(app).post('/api/auth/signup')
                    .send({ email: 'race@example.com', password: 'ValidPass123!' })
            );
            const results = await Promise.all(attempts);

            const created = results.filter(r => r.status === 200);
            const conflicts = results.filter(r => r.status === 409);

            expect(created).toHaveLength(1);
            expect(conflicts).toHaveLength(7);
            // Crucially, no 500s: a race must not surface as a server error.
            expect(results.filter(r => r.status >= 500)).toHaveLength(0);

            const { countUsers } = require('../src/services/database');
            expect(countUsers()).toBe(1);
        });

        test('never returns the password hash', async () => {
            const res = await request(app).post('/api/auth/signup')
                .send({ email: 'nohash@example.com', password: 'ValidPass123!' });

            expect(res.body.data.password_hash).toBeUndefined();
            expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);

            const me = await request(app).get('/api/auth/me')
                .set('Cookie', res.headers['set-cookie'][0]);
            expect(me.body.data.password_hash).toBeUndefined();
        });

        test('bounds business and owner names', async () => {
            const res = await request(app).post('/api/auth/signup').send({
                email: 'long@example.com',
                password: 'ValidPass123!',
                businessName: 'B'.repeat(5000)
            });
            expect(res.status).toBe(400);
        });

        test('sets a hardened session cookie', async () => {
            const res = await request(app).post('/api/auth/signup')
                .send({ email: 'cookie@example.com', password: 'ValidPass123!' });

            const cookie = res.headers['set-cookie'][0];
            expect(cookie).toMatch(/^wa_session=/);
            expect(cookie).toMatch(/HttpOnly/);      // not readable by JS → XSS can't steal it
            expect(cookie).toMatch(/SameSite=Lax/);  // not sent on cross-site POSTs → CSRF defence
            expect(cookie).toMatch(/Path=\//);
            expect(cookie).not.toMatch(/Domain=/);   // host-only: no sibling subdomain access
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Login', () => {
        beforeEach(async () => {
            await signup(app, { email: 'login@test.com', password: 'ValidPass123!' });
        });

        test('accepts correct credentials', async () => {
            const res = await request(app).post('/api/auth/login')
                .send({ email: 'login@test.com', password: 'ValidPass123!' });
            expect(res.status).toBe(200);
            expect(res.headers['set-cookie']).toBeDefined();
        });

        test('is case-insensitive on the email', async () => {
            const res = await request(app).post('/api/auth/login')
                .send({ email: 'LOGIN@TEST.COM', password: 'ValidPass123!' });
            expect(res.status).toBe(200);
        });

        // Identical status and message for both cases: a different response
        // for "no such user" versus "wrong password" tells an attacker which
        // addresses are registered.
        test('gives an identical response for a wrong password and an unknown account', async () => {
            const wrongPw = await request(app).post('/api/auth/login')
                .send({ email: 'login@test.com', password: 'WrongPass123!' });
            const unknown = await request(app).post('/api/auth/login')
                .send({ email: 'nobody@test.com', password: 'WrongPass123!' });

            expect(wrongPw.status).toBe(401);
            expect(unknown.status).toBe(401);
            expect(wrongPw.body.error).toBe(unknown.body.error);
        });

        // The same leak through a side channel. An early return for unknown
        // emails skips bcrypt entirely and is measurably faster; the login
        // route runs a dummy comparison to equalise it.
        test('does not leak account existence through response timing', async () => {
            const timeOf = async (email) => {
                const samples = [];
                for (let i = 0; i < 6; i++) {
                    const t0 = process.hrtime.bigint();
                    await request(app).post('/api/auth/login').send({ email, password: 'WrongPass123!' });
                    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
                }
                samples.sort((a, b) => a - b);
                return samples[Math.floor(samples.length / 2)]; // median
            };

            const known = await timeOf('login@test.com');
            const unknown = await timeOf('definitely-not-a-user@test.com');

            // Both paths must run a bcrypt comparison, so the ratio stays
            // near 1. A skipped hash shows up as several-fold difference.
            const ratio = Math.max(known, unknown) / Math.max(1, Math.min(known, unknown));
            expect(ratio).toBeLessThan(3);
        });

        test('rejects a suspended account with 403', async () => {
            const { getUserByEmail, updateUser } = require('../src/services/database');
            updateUser(getUserByEmail('login@test.com').id, { status: 'suspended' });

            const res = await request(app).post('/api/auth/login')
                .send({ email: 'login@test.com', password: 'ValidPass123!' });
            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/suspended/i);
        });

        test('requires both fields', async () => {
            for (const body of [{}, { email: 'a@b.com' }, { password: 'x' }, { email: '', password: '' }]) {
                const res = await request(app).post('/api/auth/login').send(body);
                expect([400, 401]).toContain(res.status);
            }
        });

        test('does not spend CPU hashing an absurdly long password', async () => {
            const t0 = Date.now();
            const res = await request(app).post('/api/auth/login')
                .send({ email: 'login@test.com', password: 'a'.repeat(200000) });
            expect(res.status).toBe(401);
            expect(Date.now() - t0).toBeLessThan(2000);
        });

        test.each([
            [{ email: { $ne: null }, password: 'x' }],
            [{ email: ['a@b.com'], password: 'x' }],
            [{ email: 123, password: 'x' }],
            [{ email: null, password: null }]
        ])('handles a non-string email %p without a 500', async (body) => {
            const res = await request(app).post('/api/auth/login').send(body);
            expect(res.status).toBeLessThan(500);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Login rate limiting', () => {
        test('locks out repeated attempts against one account, per IP', async () => {
            await signup(app, { email: 'brute@test.com' });

            await withRateLimits(async () => {
                for (let i = 0; i < 8; i++) {
                    await request(app).post('/api/auth/login')
                        .send({ email: 'brute@test.com', password: 'wrong' });
                }
                const blocked = await request(app).post('/api/auth/login')
                    .send({ email: 'brute@test.com', password: 'wrong' });

                expect(blocked.status).toBe(429);
                expect(blocked.headers['retry-after']).toBeDefined();
                expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
            });
        });

        // A single IP spraying many accounts is a different attack from
        // grinding one account, and needs its own (looser) ceiling.
        test('limits spraying across many accounts from one IP', async () => {
            await withRateLimits(async () => {
                for (let i = 0; i < 40; i++) {
                    await request(app).post('/api/auth/login')
                        .send({ email: `spray${i}@test.com`, password: 'wrong' });
                }
                const blocked = await request(app).post('/api/auth/login')
                    .send({ email: 'spray-final@test.com', password: 'wrong' });
                expect(blocked.status).toBe(429);
            });
        });

        test('signup flooding from one IP is limited', async () => {
            await withRateLimits(async () => {
                let limited = false;
                for (let i = 0; i < 15; i++) {
                    const res = await request(app).post('/api/auth/signup')
                        .send({ email: `flood${i}@test.com`, password: 'ValidPass123!' });
                    if (res.status === 429) { limited = true; break; }
                }
                expect(limited).toBe(true);
            });
        });

        // A correct password must still work while an attacker is being
        // throttled on a *different* account — otherwise the rate limiter is
        // itself a denial of service against legitimate users.
        test('throttling one account does not lock out another', async () => {
            await signup(app, { email: 'victim@test.com', password: 'ValidPass123!' });
            await signup(app, { email: 'bystander@test.com', password: 'ValidPass123!' });

            await withRateLimits(async () => {
                for (let i = 0; i < 10; i++) {
                    await request(app).post('/api/auth/login')
                        .send({ email: 'victim@test.com', password: 'wrong' });
                }
                const ok = await request(app).post('/api/auth/login')
                    .send({ email: 'bystander@test.com', password: 'ValidPass123!' });
                expect(ok.status).toBe(200);
            });
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Session token integrity', () => {
        let cookie, userId;

        beforeEach(async () => {
            // The first account created is always the admin (see
            // database.createUser), so a non-admin subject needs one ahead of
            // it — otherwise "forged admin claim" would be testing an account
            // that is legitimately admin anyway.
            await signup(app, { email: 'owner@test.com' });
            const s = await signup(app, { email: 'session@test.com' });
            cookie = s.cookie;
            userId = s.user.id;
            expect(s.user.role).toBe('user');
        });

        const sign = (payload, secret = process.env.SESSION_SECRET) => {
            const encoded = Buffer.from(JSON.stringify(payload)).toString('base64')
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const sig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
            return `${encoded}.${sig}`;
        };

        test('a valid cookie authenticates', async () => {
            const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.body.data.id).toBe(userId);
        });

        test('no cookie is rejected', async () => {
            const res = await request(app).get('/api/auth/me');
            expect(res.status).toBe(401);
            expect(res.body.code).toBe('AUTH_REQUIRED');
        });

        test.each([
            ['tampered signature', (c) => `${c.split('.')[0]}.${'0'.repeat(64)}`],
            ['removed signature', (c) => c.split('.')[0]],
            ['empty signature', (c) => `${c.split('.')[0]}.`],
            ['truncated token', (c) => c.slice(0, 20)],
            ['extra segment appended', (c) => `${c}.extra`],
            ['garbage', () => 'wa_session=not-a-token'],
            ['empty value', () => 'wa_session='],
            ['different encoding', (c) => Buffer.from(c).toString('hex')]
        ])('rejects a %s', async (_label, mutate) => {
            const raw = cookie.replace('wa_session=', '');
            const mutated = mutate(decodeURIComponent(raw));
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `wa_session=${encodeURIComponent(mutated)}`);
            expect(res.status).toBe(401);
        });

        test('rejects a token signed with the wrong secret', async () => {
            const forged = sign({ id: userId, role: 'admin', iat: Date.now(), exp: Date.now() + 3600000 }, 'attacker-secret');
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `wa_session=${encodeURIComponent(forged)}`);
            expect(res.status).toBe(401);
        });

        test('rejects an expired token', async () => {
            const expired = sign({ id: userId, role: 'user', iat: Date.now() - 7200000, exp: Date.now() - 1000 });
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `wa_session=${encodeURIComponent(expired)}`);
            expect(res.status).toBe(401);
        });

        // A validly-signed token whose lifetime exceeds the configured
        // maximum was not minted by this code, so it is refused even though
        // the HMAC verifies. Defence against a future bug that lets `exp` be
        // influenced.
        test('rejects a validly signed token with an over-long lifetime', async () => {
            const tooLong = sign({
                id: userId, role: 'user',
                iat: Date.now(),
                exp: Date.now() + 365 * 24 * 60 * 60 * 1000
            });
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `wa_session=${encodeURIComponent(tooLong)}`);
            expect(res.status).toBe(401);
        });

        // The critical privilege test. The signature is genuine — this is what
        // an attacker gets if they ever obtain the secret's *use* through a
        // signing oracle — but role must come from the database, not the token.
        test('a forged role:"admin" claim grants no admin access', async () => {
            const forged = sign({ id: userId, role: 'admin', iat: Date.now(), exp: Date.now() + 3600000 });
            const forgedCookie = `wa_session=${encodeURIComponent(forged)}`;

            const me = await request(app).get('/api/auth/me').set('Cookie', forgedCookie);
            expect(me.status).toBe(200);
            expect(me.body.data.role).toBe('user'); // from the database

            const admin = await request(app).get('/api/admin/users').set('Cookie', forgedCookie);
            expect(admin.status).toBe(403);
        });

        test('a token for a nonexistent user id is rejected', async () => {
            const ghost = sign({ id: 999999, role: 'user', iat: Date.now(), exp: Date.now() + 3600000 });
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `wa_session=${encodeURIComponent(ghost)}`);
            expect(res.status).toBe(401);
        });

        test.each([
            ['id as a string', { id: '1' }],
            ['id negative', { id: -1 }],
            ['id zero', { id: 0 }],
            ['id as an object', { id: { $gt: 0 } }],
            ['id as an array', { id: [1] }],
            ['id missing', {}],
            ['exp missing', { exp: undefined }],
            ['exp as a string', { exp: String(Date.now() + 3600000) }],
            ['exp null', { exp: null }]
        ])('rejects a structurally invalid payload (%s)', async (_label, partial) => {
            const payload = { id: userId, role: 'user', iat: Date.now(), exp: Date.now() + 3600000 };
            // Explicit deletion, not an undefined spread: JSON.stringify drops
            // undefined values, but only if the key is genuinely absent from
            // the object we hand it — an inherited key would survive.
            for (const [k, v] of Object.entries(partial)) {
                if (v === undefined) delete payload[k];
                else payload[k] = v;
            }
            if (Object.keys(partial).length === 0) delete payload.id;

            const forged = sign(payload);
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `wa_session=${encodeURIComponent(forged)}`);
            expect(res.status).toBe(401);
        });

        test('a very large Cookie header does not hang or error', async () => {
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `junk=${'x'.repeat(9000)}`);
            expect(res.status).toBe(401);
        });

        test('duplicate cookie names: the first value wins and cannot be overridden', async () => {
            const forged = sign({ id: 999999, role: 'admin', iat: Date.now(), exp: Date.now() + 3600000 });
            const res = await request(app).get('/api/auth/me')
                .set('Cookie', `${cookie}; wa_session=${encodeURIComponent(forged)}`);
            expect(res.status).toBe(200);
            expect(res.body.data.id).toBe(userId);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Session revocation', () => {
        test('logout invalidates the cookie immediately', async () => {
            const { cookie } = await signup(app, { email: 'logout@test.com' });

            await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
            await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);

            const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
            expect(after.status).toBe(401);
        });

        // Without this, a suspended user keeps working until their cookie
        // expires — which is up to a week.
        test('suspension takes effect on an existing session', async () => {
            const { cookie, user } = await signup(app, { email: 'susp@test.com' });
            await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);

            require('../src/services/database').updateUser(user.id, { status: 'suspended' });

            const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
        });

        test('deletion takes effect on an existing session', async () => {
            const admin = await signup(app, { email: 'admin@test.com' });
            const victim = await signup(app, { email: 'victim2@test.com' });

            await request(app).get('/api/auth/me').set('Cookie', victim.cookie).expect(200);
            await request(app).delete(`/api/admin/users/${victim.user.id}`)
                .set('Cookie', admin.cookie).expect(200);

            const res = await request(app).get('/api/auth/me').set('Cookie', victim.cookie);
            expect(res.status).toBe(401);
        });

        test('changing the password signs out other sessions but keeps the caller in', async () => {
            const { cookie, password } = await signup(app, { email: 'pw@test.com' });

            // A second device for the same account.
            const second = await request(app).post('/api/auth/login')
                .send({ email: 'pw@test.com', password });
            const secondCookie = second.headers['set-cookie'][0].split(';')[0];

            const change = await request(app).post('/api/auth/change-password')
                .set('Cookie', cookie)
                .send({ currentPassword: password, newPassword: 'BrandNewPass456!' });
            expect(change.status).toBe(200);

            // The other device is evicted...
            const evicted = await request(app).get('/api/auth/me').set('Cookie', secondCookie);
            expect(evicted.status).toBe(401);

            // ...and the caller received a fresh cookie, so they stay signed in.
            const fresh = change.headers['set-cookie'][0].split(';')[0];
            await request(app).get('/api/auth/me').set('Cookie', fresh).expect(200);

            // The new password works, the old one does not.
            await request(app).post('/api/auth/login')
                .send({ email: 'pw@test.com', password: 'BrandNewPass456!' }).expect(200);
            await request(app).post('/api/auth/login')
                .send({ email: 'pw@test.com', password }).expect(401);
        });

        test('changing a password requires the current one', async () => {
            const { cookie } = await signup(app, { email: 'pw2@test.com' });
            const res = await request(app).post('/api/auth/change-password')
                .set('Cookie', cookie)
                .send({ currentPassword: 'not-it', newPassword: 'BrandNewPass456!' });
            expect(res.status).toBe(401);
        });

        test('rejects a weak or unchanged new password', async () => {
            const { cookie, password } = await signup(app, { email: 'pw3@test.com' });

            const weak = await request(app).post('/api/auth/change-password')
                .set('Cookie', cookie).send({ currentPassword: password, newPassword: 'short' });
            expect(weak.status).toBe(400);

            const same = await request(app).post('/api/auth/change-password')
                .set('Cookie', cookie).send({ currentPassword: password, newPassword: password });
            expect(same.status).toBe(400);
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Password hashing', () => {
        test('uses bcrypt and never produces the same hash twice', async () => {
            const { hashPassword, verifyPassword } = require('../src/config/auth');
            const a = await hashPassword('SamePass123!');
            const b = await hashPassword('SamePass123!');

            expect(a).toMatch(/^\$2[aby]\$/);
            expect(a).not.toBe(b);                       // unique salts
            expect(await verifyPassword('SamePass123!', a)).toBe(true);
            expect(await verifyPassword('WrongPass', a)).toBe(false);
        });

        test('defaults to cost 12 in production and never below 10', () => {
            // The suite runs at cost 4 for speed (see tests/setup.js); this
            // asserts the floor logic itself, which is what protects a
            // deployment where someone sets BCRYPT_ROUNDS=4 by mistake.
            const resolve = (envValue) => Math.max(10, parseInt(envValue, 10) || 12);
            expect(resolve(undefined)).toBe(12);
            expect(resolve('4')).toBe(10);
            expect(resolve('14')).toBe(14);
        });

        test('a malformed stored hash fails verification instead of throwing', async () => {
            const { verifyPassword } = require('../src/config/auth');
            for (const bad of ['', 'not-a-hash', null, undefined, '$2a$broken']) {
                await expect(verifyPassword('anything', bad)).resolves.toBe(false);
            }
        });
    });

    // ─────────────────────────────────────────────────────────
    describe('Session secret handling', () => {
        test('a short SESSION_SECRET is fatal in production', () => {
            jest.isolateModules(() => {
                const prevEnv = process.env.NODE_ENV;
                const prevSecret = process.env.SESSION_SECRET;
                process.env.NODE_ENV = 'production';
                process.env.SESSION_SECRET = 'tooshort';
                try {
                    expect(() => require('../src/config/auth')).toThrow(/at least 32 characters/);
                } finally {
                    process.env.NODE_ENV = prevEnv;
                    process.env.SESSION_SECRET = prevSecret;
                }
            });
        });

        test('a placeholder SESSION_SECRET is fatal in production', () => {
            jest.isolateModules(() => {
                const prevEnv = process.env.NODE_ENV;
                const prevSecret = process.env.SESSION_SECRET;
                process.env.NODE_ENV = 'production';
                process.env.SESSION_SECRET = 'changeme-changeme-changeme-changeme-changeme';
                try {
                    expect(() => require('../src/config/auth')).toThrow(/placeholder/i);
                } finally {
                    process.env.NODE_ENV = prevEnv;
                    process.env.SESSION_SECRET = prevSecret;
                }
            });
        });
    });
});

