const { initDatabase, getDb, stopPersistence, createUser, createScheduledMessage, claimScheduledMessage, updateScheduledMessageStatus } = require('../src/services/database');
const { concurrencyGate } = require('../src/middleware/rateLimit');
const { isCircuitOpen, recordFailure, recordSuccess, resetCircuits } = require('../src/services/gemini-client');
const { startOutreachJob, cancelOutreachJob, getOutreachJob, countRunningJobsForUser } = require('../src/services/outreach');

describe('Priority 2: Background Jobs, Scheduler & AI Protections', () => {
    let db;
    let testUser;

    beforeAll(async () => {
        process.env.PERSIST_ROOT = require('path').join(__dirname, '..', 'data', 'test_p2');
        db = await initDatabase();
        testUser = createUser({
            email: 'p2_tester@example.com',
            passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890',
            businessName: 'Test Biz',
            ownerName: 'Test Owner'
        });
    });

    afterAll(() => {
        stopPersistence();
    });

    beforeEach(() => {
        resetCircuits();
    });

    describe('2.1 Scheduler Atomic Job Claiming', () => {
        test('atomic claim prevents duplicate job execution by parallel workers', () => {
            const res = createScheduledMessage(testUser.id, '919876543210', 'Test atomic claim', '2020-01-01 10:00:00');
            const msgId = res.id;

            // Worker 1 claims
            const claimed1 = claimScheduledMessage(msgId);
            expect(claimed1).toBe(true);

            // Worker 2 attempts to claim same job -> fails
            const claimed2 = claimScheduledMessage(msgId);
            expect(claimed2).toBe(false);

            // Mark as sent
            updateScheduledMessageStatus(msgId, 'sent');
        });
    });

    describe('2.2 Bulk Outreach Rate Limiting & Safety', () => {
        test('rejects batch larger than maximum recipients per job', () => {
            const contacts = Array.from({ length: 30 }, (_, i) => ({
                phone: `9198765432${i.toString().padStart(2, '0')}`,
                name: `User ${i}`
            }));

            expect(() => {
                startOutreachJob(testUser, contacts, 'Hello {{name}}');
            }).toThrow(/capped at 25/);
        });

        test('prevents user from starting multiple simultaneous outreach jobs', () => {
            const contacts = [{ phone: '919876543210', name: 'Test' }];

            const job = startOutreachJob(testUser, contacts, 'Hello {{name}}');
            expect(job.status).toBe('running');

            expect(() => {
                startOutreachJob(testUser, contacts, 'Hello again {{name}}');
            }).toThrow(/already have an outreach send in progress/);

            cancelOutreachJob(job.id, testUser.id);
        });
    });

    describe('2.3 AI Concurrency Gate & Circuit Breaker', () => {
        test('concurrency gate enforces global and per-user limits', () => {
            const gate = concurrencyGate({ maxGlobal: 3, maxPerUser: 2 });

            // User 1 acquires slot 1 & 2
            expect(gate.tryAcquire(1)).toEqual({ ok: true });
            expect(gate.tryAcquire(1)).toEqual({ ok: true });
            // User 1 attempts slot 3 -> rejected by user limit
            expect(gate.tryAcquire(1)).toEqual({ ok: false, reason: 'user' });

            // User 2 acquires slot 3 -> ok
            expect(gate.tryAcquire(2)).toEqual({ ok: true });
            // User 2 attempts slot 4 -> rejected by global limit
            expect(gate.tryAcquire(2)).toEqual({ ok: false, reason: 'global' });

            // User 1 releases slot 1
            gate.release(1);
            // Now User 2 can acquire
            expect(gate.tryAcquire(2)).toEqual({ ok: true });

            // Clean up
            gate.release(1);
            gate.release(2);
            gate.release(2);
        });

        test('circuit breaker trips after consecutive failures and recovers on success', () => {
            const apiKey = 'test_key_ai_12345';

            expect(isCircuitOpen(apiKey)).toBe(false);

            // Record 4 failures -> still closed
            for (let i = 0; i < 4; i++) recordFailure(apiKey);
            expect(isCircuitOpen(apiKey)).toBe(false);

            // 5th failure -> trips open
            recordFailure(apiKey);
            expect(isCircuitOpen(apiKey)).toBe(true);

            // Successful call restores
            recordSuccess(apiKey);
            expect(isCircuitOpen(apiKey)).toBe(false);
        });
    });
});
