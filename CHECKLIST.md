# Production Hardening Checklist — Target: 30 Concurrent Active Users

This checklist defines the complete, priority-ordered implementation and verification roadmap to ensure the application reliably supports **30 concurrently active users** without crashes, memory exhaustion, race conditions, duplicate operations, or cross-tenant data leaks.

---

## 🎯 Concurrency & Capacity Model Reference

| Component | Limit Target | Mitigation Strategy | Status |
| :--- | :--- | :--- | :--- |
| **Active Web Dashboard Users** | 30–50 concurrent users | Session auth, response compression, strict pagination, rate limits | ✅ Hardened & Verified |
| **WhatsApp/Chromium Sessions** | 10–15 concurrent sessions | Mutex init, session cap, 503 capacity rejection, staggered resume | ✅ Hardened & Verified |
| **AI / Gemini API In-Flight** | Max 8 global, Max 2 per user | Concurrency gate, 30s timeout, circuit breaker, retry backoff | ✅ Hardened & Verified |
| **Inbound Message Sequencing** | FIFO per conversation | Per-conversation in-memory serial queue | ✅ Hardened & Verified |
| **Outreach / Bulk Campaigns** | Max 1 job/user, 25 contacts | 3-9s random throttle delay, job sweep, idempotent sends | ✅ Hardened & Verified |
| **Scheduler Dispatch** | Max 40 jobs/minute tick | Atomic SQL claims (`UPDATE ... WHERE status = 'pending'`) | ✅ Hardened & Verified |
| **SSE Connections** | Max 5/user, Max 250 global | 20s heartbeat, strict origin check, unref timers, auto-cleanup | ✅ Hardened & Verified |
| **Database Durability** | Single SQLite process | Composite indexes on `(user_id, ...)`, atomic rename persistence | ✅ Hardened & Verified |

---

## 🔴 Priority 1: Message Ordering & Concurrency Isolation

- [x] **1.1 Conversation-Level Message Sequencing (FIFO Queue)**
  - [x] Implement `ConversationQueue` in `src/utils/conversation-queue.js` and wrap `processMessage` in `src/services/chatbot.js`.
  - [x] Ensure parallel execution across *different* conversations and tenants.
  - [x] Add timeout protection to individual queued tasks so a wedged request doesn't block the conversation indefinitely.
  - [x] Add automated tests (`tests/conversation-queue.test.js`) verifying FIFO sequencing, concurrency, timeouts, and memory cleanup (5/5 passing).

- [x] **1.2 WhatsApp Client Mutex & Session Lifecycle**
  - [x] Ensure `initWhatsAppClient(userId)` enforces strict mutex so parallel requests from the same user cannot spawn duplicate Puppeteer instances.
  - [x] Verify `destroyClientForUser(userId)` and `safeDestroyClient` terminate Chrome processes cleanly with fallback `pupBrowser.close()` and clear all timers.
  - [x] Ensure reconnect backoff uses exponential delays with jitter and stops after `MAX_CRASHES_BEFORE_GIVING_UP` (10 crashes max).
  - [x] Ensure startup session resume is staggered (`RESUME_STAGGER_MS=4000`) to prevent CPU/memory spikes.

- [x] **1.3 Database Durability & Query Performance**
  - [x] Verify all queries are scoped by `user_id` to prevent cross-tenant data leaks.
  - [x] Confirm composite indexes exist for all frequent query patterns (`idx_messages_user_phone`, `idx_messages_user_created`, `idx_contacts_user_phone`, `idx_scheduled_status_at`, etc.).
  - [x] Verify that multi-statement writes run inside `transaction(() => { ... })`.
  - [x] Ensure database file export uses atomic write (`.tmp -> fsync -> .bak -> rename`).

---

## 🟠 Priority 2: Background Jobs, Scheduler & External API Protection

- [x] **2.1 Scheduler Atomic Job Claiming & Idempotency**
  - [x] Verify atomic claim: `claimScheduledMessage(id)` uses `UPDATE scheduled_messages SET status = 'sending' WHERE id = ? AND status = 'pending'`.
  - [x] Verify startup recovery of interrupted jobs via `reclaimStuckScheduledMessages`.
  - [x] Ensure status is updated to `'sent'` before writing message logs.
  - [x] Verify unique idempotency index on `messages(user_id, wa_message_id)`.

- [x] **2.2 Bulk Outreach Rate Limiting & Safety**
  - [x] Enforce limit of 1 active outreach job per user, maximum 25 recipients per batch, and global cap (`MAX_CONCURRENT_OUTREACH_JOBS=5`).
  - [x] Enforce 3,000ms – 9,000ms randomized human-like delay between messages.
  - [x] Verify background job records are swept from memory after `JOB_RETENTION_MS` (30 min).

- [x] **2.3 AI / Gemini API Protection & Circuit Breakers**
  - [x] Enforce global concurrency gate (`MAX_CONCURRENT_AI_JOBS=8`) and per-tenant limit (`MAX_CONCURRENT_AI_PER_USER=2`) via environment variables.
  - [x] Enforce 30s timeout per call (`GEMINI_TIMEOUT_MS`).
  - [x] Ensure circuit breaker activates after 5 consecutive failures per key with 60s cooldown.
  - [x] Ensure fallback to rule-based responses and default replies when AI is unavailable.
  - [x] Mask API keys and secrets in all error logs and sanitized outputs.
  - [x] Add automated tests (`tests/jobs-scheduler-ai.test.js`) verifying claims, outreach caps, concurrency gate, and circuit breaker (5/5 passing).

---

## 🟡 Priority 3: Memory Leak Prevention, SSE & HTTP Guardrails

- [x] **3.1 In-Memory State Audit & TTL Sweeps**
  - [x] `userRateLimits` in `chatbot.js`: Verify sweep interval (10 min) and maximum key cap (100,000).
  - [x] `pendingTimers` in `lead-analyzer.js`: Verify timer cap (5,000) and `timer.unref()` calls.
  - [x] `buckets` in `rateLimit.js`: Verify expired bucket sweep and capacity cap (50,000).
  - [x] `circuits` in `gemini-client.js`: Verify bounded memory usage.
  - [x] `jobs` in `outreach.js`: Verify periodic sweep of finished jobs.

- [x] **3.2 SSE Stream Lifecycle & CSRF Shielding**
  - [x] Enforce Origin and `Sec-Fetch-Site` header checks on `/api/qr-stream`.
  - [x] Enforce per-user stream cap (`MAX_SSE_CLIENTS_PER_USER=5`) and global cap (`MAX_SSE_CLIENTS_TOTAL=250`).
  - [x] Verify 20s heartbeat intervals with max connection lifetime.
  - [x] Ensure listeners are cleaned up on `req.on('close')`, `req.on('error')`, and `res.on('error')`.

- [x] **3.3 HTTP Request Validation & DoS Protection**
  - [x] Verify strict `LIMIT` & `OFFSET` clamping via `clampInt` on all list endpoints.
  - [x] Verify payload limits: 1MB for JSON, 2MB for CSV imports, max 5,000 rows.
  - [x] Verify ReDoS protection via `assertSafeRegexSource` on chatbot trigger patterns.
  - [x] Ensure all responses from `/api/*` send `Cache-Control: no-store, no-cache, must-revalidate, private`.

---

## 🟢 Priority 4: Observability, Configuration & Graceful Teardown

- [x] **4.1 Structured Logging & Correlation**
  - [x] Request logger with unique request IDs (`requestId`) on all incoming HTTP requests.
  - [x] Phone number masking (`maskPhone`) and secret redaction in all log streams.
  - [x] Metrics snapshot including request count, latency percentiles (p50/p95/p99), event loop lag (`lagMs`), and memory usage (RSS/heap).
  - [x] Health check endpoints: `/health` (liveness) and `/ready` (database & persist health).

- [x] **4.2 Graceful Shutdown Procedure**
  - [x] Stop HTTP listener to reject new connections.
  - [x] Stop cron scheduler and calendar sync jobs.
  - [x] Cancel running outreach loops and clear pending auto-analysis timers.
  - [x] Wait for in-flight message sends up to `SHUTDOWN_GRACE_MS` (15s).
  - [x] Close all Puppeteer / Chromium instances.
  - [x] Force final database disk flush (`forcePersist()`).

- [x] **4.3 Environment Variables & Configuration**
  - [x] Update `.env.example` with documented defaults for 30 concurrent users.
  - [x] Verify `.gitignore` and `.dockerignore` exclude `.env`, `data/`, `.wwebjs_auth/`, and session secrets.

---

## 🔵 Priority 5: Testing & 30 Concurrent Users Load Simulation

- [x] **5.1 Unit, Security & Tenant Isolation Tests**
  - [x] Run full automated test suites: `npm test` (all 5 test suites, 239 tests passing).
  - [x] Add tests for conversation FIFO queue ordering (`tests/conversation-queue.test.js`).
  - [x] Add tests for AI concurrency gate limits & circuit breaker (`tests/jobs-scheduler-ai.test.js`).
  - [x] Add tests for atomic scheduler job claiming (`tests/jobs-scheduler-ai.test.js`).

- [x] **5.2 30-User Concurrent Load Test Suite**
  - [x] Create load test script: `scripts/load-test-30-users.js`.
  - [x] Simulate 30 authenticated concurrent users making simultaneous API calls:
    - User sessions & token validation.
    - Dashboard statistics queries.
    - Paginated contact and message retrieval.
    - CRM deal updates and activity logs.
    - System health & setting changes.
  - [x] Measure and document:
    - **1,800 requests** across 30 users in **9.73s** (184.9 req/sec throughput).
    - **100% Success Rate**: 1800 x 200 OK, 0 x 500 errors.
    - **p50 Latency**: 154 ms, **p95**: 247 ms, **p99**: 281 ms.
    - **Event Loop Lag**: 30 ms (well within safe bounds).
    - **Memory RSS**: 225 MB stable.
    - **Cross-Tenant Data Leaks**: 0 (strict tenant isolation verified).

---

## 📋 Implementation Progress Log

| Date / Step | Component | Action Taken | Result |
| :--- | :--- | :--- | :--- |
| Priority 1 | Message Ordering & Queues | Implemented `ConversationQueue` FIFO serialization & mutex guards | 5/5 tests passed |
| Priority 2 | Background Jobs & AI | Verified atomic claims, global outreach caps & AI circuit breaker | 5/5 tests passed |
| Priority 3 | Memory & SSE Protection | Verified TTL sweeps, rate limit caps & SSE origin/stream caps | Verified & Configured |
| Priority 4 | Observability & Config | Updated `.env.example` with 30-user capacity model & shutdown | Documented & Verified |
| Priority 5 | 30 Concurrent Load Test | Ran `node scripts/load-test-30-users.js` across 30 active tenants | 1,800/1,800 requests 200 OK (184.9 RPS, 0 leaks, 0 errors) |
