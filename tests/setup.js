/**
 * tests/setup.js — shared test environment.
 *
 * Two rules this file exists to enforce:
 *
 *  1. Tests must never touch the developer's real database, WhatsApp
 *     sessions, or session secret. PERSIST_ROOT is redirected to a
 *     throwaway directory before any module that reads it is loaded.
 *  2. Tests must exercise the real application. helpers here build the app
 *     via src/app.js — the same middleware order, headers and error handler
 *     that ship — rather than assembling a simplified Express app that could
 *     pass while production is broken.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// A unique directory per worker so `jest --maxWorkers` doesn't have two
// processes fighting over one SQLite file.
const TEST_ROOT = path.join(
    os.tmpdir(),
    `wa-tests-${process.pid}-${process.env.JEST_WORKER_ID || '1'}`
);

process.env.NODE_ENV = 'test';
process.env.PERSIST_ROOT = TEST_ROOT;
// Deterministic and long enough to satisfy the production-length check.
process.env.SESSION_SECRET = 'test-session-secret-' + 'x'.repeat(88);
// No real network calls, ever. Any test that needs AI mocks gemini-client.
process.env.GEMINI_API_KEY = '';
process.env.MAX_CONCURRENT_WHATSAPP_SESSIONS = '5';
// Rate limiting is *on* for the tests that assert it and switched off
// elsewhere, so unrelated suites don't fail because a previous test used up
// a bucket. See withRateLimits().
process.env.DISABLE_RATE_LIMITS = 'true';
// bcrypt at production cost (12) would add ~250ms per password operation and
// several minutes across the suite. 4 keeps the code path identical while
// staying fast; the cost factor itself is asserted separately.
process.env.BCRYPT_ROUNDS = '4';

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function rmrf(dir) {
    // Retry briefly: on Windows a directory can be transiently locked (a
    // just-closed file handle, an antivirus scan), and a silently swallowed
    // failure here is dangerous — it leaves the previous test's database in
    // place, which surfaces later as inexplicable 409s from signup and
    // assertions that see users they never created.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            return;
        } catch (e) {
            if (attempt === 4) {
                // Deliberately loud. A leaked directory means test isolation
                // is broken, and a broken isolation guarantee makes every
                // result in the run untrustworthy.
                console.warn(`⚠️ Could not remove test directory ${dir}: ${e.message}`);
            }
        }
    }
}

// Each freshDatabase() call gets its own directory rather than reusing and
// deleting one. Deletion is the fragile part on Windows, and since
// freshDatabase already clears the module cache — so src/database.js and
// src/auth.js re-read PERSIST_ROOT — pointing them somewhere new is both
// simpler and strictly safer than trying to guarantee a wipe succeeded.
let dbGeneration = 0;

/** Wipes all test state and returns a fresh, initialised database. */
async function freshDatabase() {
    // Stop the previous instance's debounced writer BEFORE moving on. This is
    // not housekeeping: the old module instance survives in the timer's
    // closure holding its own in-memory database, and a flush landing after
    // the switch would write stale data into the new location.
    try {
        require('../src/services/database').stopPersistence();
    } catch (e) { /* not loaded yet */ }

    // Tear down anything holding a timer, a socket, or a Chrome stub.
    try { require('../src/services/whatsapp-client').destroyAllClients(); } catch (e) {}
    try { require('../src/services/outreach').cancelAllOutreachJobs(); } catch (e) {}
    try { require('../src/services/lead-analyzer').clearPendingAutoAnalyses(); } catch (e) {}
    try { require('../src/services/scheduler').stopScheduler(); } catch (e) {}
    try { require('whatsapp-web.js').__reset(); } catch (e) {}

    dbGeneration++;
    const root = path.join(TEST_ROOT, `gen${dbGeneration}`);
    ensureDir(path.join(root, 'data'));
    process.env.PERSIST_ROOT = root;

    // Drop every cached module that captured state at require time: the
    // database handle, the auth secret and its secret-file path, rate-limit
    // buckets, session registries. Without this, suite N sees suite N-1's
    // users regardless of where the file lives.
    for (const mod of [
        '../src/database', '../src/auth', '../src/validate',
        '../src/middleware/auth', '../src/middleware/rateLimit', '../src/middleware/errors',
        '../src/routes/auth', '../src/routes/api', '../src/routes/admin',
        '../src/whatsapp-client', '../src/chatbot', '../src/scheduler',
        '../src/outreach', '../src/lead-analyzer', '../src/business',
        '../src/ai', '../src/gemini-client', '../src/metrics', '../src/config/app'
    ]) {
        try { delete require.cache[require.resolve(mod)]; } catch (e) { /* not loaded yet */ }
    }

    const db = require('../src/services/database');
    await db.initDatabase();

    // Assert the isolation the rest of the suite depends on, rather than
    // assuming it. If this ever fails, every subsequent expectation is
    // meaningless, so failing here with a clear message is the point.
    const existing = db.countUsers();
    if (existing !== 0) {
        throw new Error(`Test isolation broken: fresh database already contains ${existing} user(s) at ${root}`);
    }

    return db;
}

/**
 * Builds the real Express app.
 *
 * whatsapp-web.js is stubbed at the module level: launching real Chrome
 * processes in a test suite is slow, flaky, and would attempt real network
 * connections to WhatsApp. The stub keeps the surface the app uses
 * (initWhatsAppClient/getStatus/sendTextMessage/…) so route behaviour,
 * authorization and tenant scoping are all still exercised for real.
 */
function createTestApp() {
    const { createApp } = require('../src/config/app');
    return createApp();
}

/** Signs up a user through the real HTTP route and returns their cookie. */
async function signup(agentOrApp, { email, password = 'ValidPass123!', businessName, ownerName } = {}) {
    const request = require('supertest');
    const res = await request(agentOrApp)
        .post('/api/auth/signup')
        .send({ email, password, businessName, ownerName });
    if (res.status !== 200) {
        throw new Error(`signup failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return {
        user: res.body.data,
        cookie: res.headers['set-cookie'][0].split(';')[0],
        password
    };
}

/** Creates a user directly in the database (faster; no HTTP round-trip). */
async function createUserDirect(overrides = {}) {
    const { createUser } = require('../src/services/database');
    const { hashPassword, createSessionToken } = require('../src/config/auth');
    const email = overrides.email || `u${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;
    const password = overrides.password || 'ValidPass123!';
    const user = createUser({
        email,
        passwordHash: await hashPassword(password),
        businessName: overrides.businessName || 'Test Business',
        ownerName: overrides.ownerName || 'Test Owner'
    });
    return {
        user,
        password,
        cookie: `wa_session=${encodeURIComponent(createSessionToken(user))}`
    };
}

/** Runs `fn` with the rate limiters actually enabled, then restores. */
async function withRateLimits(fn) {
    const previous = process.env.DISABLE_RATE_LIMITS;
    process.env.DISABLE_RATE_LIMITS = 'false';
    try {
        require('../src/middleware/rateLimit').clearBuckets();
        return await fn();
    } finally {
        process.env.DISABLE_RATE_LIMITS = previous;
        require('../src/middleware/rateLimit').clearBuckets();
    }
}

global.TEST_ROOT = TEST_ROOT;
global.freshDatabase = freshDatabase;
global.createTestApp = createTestApp;
global.signup = signup;
global.createUserDirect = createUserDirect;
global.withRateLimits = withRateLimits;

afterAll(async () => {
    // Same ordering rationale as freshDatabase: stop the debounced writer
    // before removing the directory it writes to, or the run ends with a
    // spurious ENOENT and Jest reports a lingering handle.
    try { require('../src/services/database').stopPersistence(); } catch (e) {}
    try { await require('../src/services/whatsapp-client').destroyAllClients(); } catch (e) {}
    try { require('../src/services/outreach').cancelAllOutreachJobs(); } catch (e) {}
    try { require('../src/services/lead-analyzer').clearPendingAutoAnalyses(); } catch (e) {}
    try { require('../src/services/scheduler').stopScheduler(); } catch (e) {}
    rmrf(TEST_ROOT);
});

jest.setTimeout(30000);



