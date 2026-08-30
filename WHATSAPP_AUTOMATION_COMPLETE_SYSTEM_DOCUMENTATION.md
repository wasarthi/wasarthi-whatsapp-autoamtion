# WhatsApp Automation — Complete System Documentation

> **Read-only analysis. No code was modified, refactored, or deleted.**
> All descriptions are verified directly against the source files.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What the Product Does](#2-what-the-product-does)
3. [Technology Stack](#3-technology-stack)
4. [High-Level Architecture](#4-high-level-architecture)
5. [File & Directory Structure](#5-file--directory-structure)
6. [Server Boot Sequence](#6-server-boot-sequence)
7. [Database Design](#7-database-design)
8. [Authentication & Session Management](#8-authentication--session-management)
9. [Security Architecture](#9-security-architecture)
10. [WhatsApp Integration Layer](#10-whatsapp-integration-layer)
11. [Chatbot Engine — How Auto-Replies Work](#11-chatbot-engine--how-auto-replies-work)
12. [AI Engine (Gemini Integration)](#12-ai-engine-gemini-integration)
13. [Lead Analysis & CRM Auto-Population](#13-lead-analysis--crm-auto-population)
14. [Business Profile & Product Catalog](#14-business-profile--product-catalog)
15. [CRM Module](#15-crm-module)
16. [Scheduled Messages](#16-scheduled-messages)
17. [Bulk Outreach Campaigns](#17-bulk-outreach-campaigns)
18. [Appointment Booking System](#18-appointment-booking-system)
19. [Google Calendar Integration](#19-google-calendar-integration)
20. [Contact Management](#20-contact-management)
21. [Message Logging](#21-message-logging)
22. [Settings System](#22-settings-system)
23. [Admin Panel](#23-admin-panel)
24. [Rate Limiting & Throttling](#24-rate-limiting--throttling)
25. [API Reference — Auth Endpoints](#25-api-reference--auth-endpoints)
26. [API Reference — Operational Endpoints](#26-api-reference--operational-endpoints)
27. [API Reference — Calendar Endpoints](#27-api-reference--calendar-endpoints)
28. [API Reference — Appointment Endpoints](#28-api-reference--appointment-endpoints)
29. [API Reference — Admin Endpoints](#29-api-reference--admin-endpoints)
30. [Multi-Tenancy Model](#30-multi-tenancy-model)
31. [Database Migrations](#31-database-migrations)
32. [Persistence & Crash Safety](#32-persistence--crash-safety)
33. [Environment Variables Reference](#33-environment-variables-reference)
34. [User Journey — Getting Started](#34-user-journey--getting-started)
35. [User Journey — Setting Up AI Replies](#35-user-journey--setting-up-ai-replies)
36. [User Journey — Running an Outreach Campaign](#36-user-journey--running-an-outreach-campaign)
37. [User Journey — Booking an Appointment via Chat](#37-user-journey--booking-an-appointment-via-chat)
38. [Known Design Decisions & Trade-offs](#38-known-design-decisions--trade-offs)

---

## 1. Executive Summary

WhatsApp Automation is a **multi-tenant SaaS-style Node.js application** that lets multiple business owners each connect their own WhatsApp number and:

- **Auto-reply** to incoming messages using keyword rules, an away message, or a fully conversational Gemini AI persona.
- **Analyze leads** automatically — after 3 minutes of quiet, the AI reads the conversation and classifies the contact's interest level, sentiment, issues, and suggested CRM stage.
- **Manage a CRM pipeline** of deals with stages (new → won/lost), deal values, follow-up dates, and activity logs.
- **Send messages in bulk** (outreach campaigns) to a chosen list of contacts, with human-like delays to reduce bot detection risk.
- **Schedule future messages** for specific date/times, fired by a background cron every minute.
- **Book appointments** via a conversational AI flow — the chatbot can offer real slots, and book one when the contact confirms.
- **Sync with Google Calendar** — schedule WhatsApp messages directly from calendar events, and optionally log every sent message as a calendar record.

Each business owner's data is **completely isolated** from every other account. There is no shared data between tenants except system-wide rate limits.

---

## 2. What the Product Does

### For the Business Owner (Dashboard User)

| Feature | Summary |
|---|---|
| Connect WhatsApp | Scan a QR code to link their personal/business WhatsApp number to the platform |
| Auto-Reply Chatbot | Incoming messages get automatic replies based on keyword rules or AI |
| AI Persona | The AI replies as the business owner, naturally and conversationally |
| Lead Analysis | Every conversation is analyzed for sales intent, sentiment, and priority |
| CRM | A Kanban-style pipeline tracks every prospect from "new" to "won" or "lost" |
| Scheduled Messages | Set a future date/time and a message body; the system sends it automatically |
| Outreach Campaigns | Send a custom message to up to 25 contacts at once, with randomized delays |
| Appointment Booking | Customers can book time slots via WhatsApp chat; the AI handles the negotiation |
| Google Calendar | Sync sent messages as calendar events; schedule messages from calendar events |
| Product Catalog | List products/services so the AI can answer pricing and catalog questions |
| Business Profile AI | Generate a strategic sales brief from the business description and catalog |
| Settings | Control every behavior: chatbot on/off, away mode, AI model instructions, currency |

### For the Platform Administrator

| Feature | Summary |
|---|---|
| User List | See all accounts with contact/message counts and WhatsApp status |
| Account Management | Suspend/activate accounts, change plans, set message limits, change roles |
| Delete Account | Cascade-delete all data for a user |
| Platform Stats | See total counts across the whole platform |

---

## 3. Technology Stack

| Layer | Technology | Version/Notes |
|---|---|---|
| Runtime | Node.js | Express framework |
| HTTP Framework | Express.js | With JSON body parser, cookie-parser |
| WhatsApp Library | `whatsapp-web.js` | Puppeteer-based headless Chrome automation |
| Headless Browser | Puppeteer / Chromium | One instance per connected WhatsApp account |
| Database | SQLite via `sql.js` | In-memory, flushed to disk with fsync |
| AI / LLM | Google Gemini (`@google/genai`) | Models: `gemini-2.5-flash`, `2.0-flash`, `2.0-flash-lite` |
| Google Calendar | `googleapis` | OAuth2, calendar v3 API |
| Password Hashing | `bcryptjs` | Cost factor default (bcrypt) |
| Session Tokens | HMAC-SHA256 (custom) | No JWT library — bespoke implementation |
| Scheduler | `node-cron` | Runs every minute |
| QR Code Generation | `qrcode` | Converts WhatsApp QR to data URL |
| Real-time Events | Server-Sent Events (SSE) | For QR display and connection status |
| Security Headers | Custom middleware | CSP with per-request nonces |
| Rate Limiting | Custom in-memory limiter | Per-user and per-IP, per-endpoint |

---

## 4. High-Level Architecture

```
Browser / Dashboard
       |
       | HTTPS
       v
+----------------------------------------------------------+
|  Express App  (src/config/app.js)                        |
|  +-------------+  +-------------+  +----------------+   |
|  |  /auth/*    |  |  /api/*     |  |  /admin/*      |   |
|  |  (public)   |  | (requireAuth|  | (requireAdmin) |   |
|  +-------------+  +-------------+  +----------------+   |
|         |                |                   |           |
|         v                v                   v           |
|  +------------------------------------------------------+|
|  |            Services Layer                            ||
|  |  chatbot.js -> ai.js -> gemini-client.js             ||
|  |  lead-analyzer.js -> gemini-client.js               ||
|  |  business.js -> gemini-client.js                    ||
|  |  outreach.js -> whatsapp-client.js                  ||
|  |  scheduler.js -> whatsapp-client.js                 ||
|  |  availability.js -> google-calendar.js              ||
|  |  database.js (all services read/write here)         ||
|  +------------------------------------------------------+|
+----------------------------------------------------------+
                |                         |
                v                         v
   +-------------------+    +------------------------+
   |  SQLite (sql.js)  |    |  Headless Chrome x N   |
   |  data/whatsapp.db |    |  (whatsapp-web.js)     |
   |  + .bak snapshot  |    |  One per user account  |
   +-------------------+    +------------------------+
                                          |
                                          v
                                    WhatsApp Web
                                    (web.whatsapp.com)
```

**Data flow for an incoming WhatsApp message:**

```
WhatsApp -> Puppeteer/wwebjs -> client.on('message') event
  -> chatbot.js:processMessage (serialized per contact via conversationQueue)
    -> logMessage (save incoming to DB)
    -> scheduleAutoAnalysis (debounced, runs after 3 min of quiet)
    -> isRateLimited? -> skip if > 10 messages/min from same sender
    -> isOverPlanLimit? -> skip if monthly cap hit
    -> chatbotEnabled? -> proceed
    -> AI-first mode? -> generateReply via Gemini -> safeReply -> logMessage
    -> away mode? -> send away message -> logMessage
    -> keyword rules? -> find first match -> safeReply -> logMessage
    -> AI fallback? -> generateReply via Gemini -> safeReply -> logMessage
    -> default reply? -> send static text -> logMessage
```

---

## 5. File & Directory Structure

```
/  (project root / PERSIST_ROOT by default)
|-- server.js                   # Process entry point, boot sequence, graceful shutdown
|-- package.json                # Dependencies & scripts
|-- data/
|   |-- whatsapp.db             # SQLite database (primary)
|   |-- whatsapp.db.bak         # Automatic backup (pre-write snapshot)
|   `-- .session_secret         # HMAC key for session tokens
|-- .wwebjs_auth/
|   `-- user_<id>/              # Per-user WhatsApp session (Puppeteer LocalAuth)
|-- .wwebjs_cache/              # WhatsApp Web asset cache
`-- src/
    |-- config/
    |   |-- app.js              # Express app setup: middleware, routes, error handlers
    |   |-- auth.js             # Session tokens, password hashing, revocation
    |   `-- paths.js            # Single source of truth for all file paths
    |-- middleware/
    |   |-- auth.js             # requireAuth / requireAdmin guards
    |   `-- rateLimit.js        # In-memory rate limiting (per-IP, per-user)
    |-- routes/
    |   |-- api.js              # Main operational API (contacts, messages, CRM, etc.)
    |   |-- auth.js             # Login, signup, logout, change-password
    |   |-- admin.js            # Admin-only endpoints
    |   |-- calendar.js         # Google Calendar OAuth + sync
    |   `-- appointments.js     # Appointment availability + CRUD
    |-- services/
    |   |-- database.js         # All database access, schema init, migrations
    |   |-- whatsapp-client.js  # Per-user WhatsApp client lifecycle + SSE
    |   |-- chatbot.js          # Incoming message dispatch pipeline
    |   |-- ai.js               # Gemini reply generation (with booking tools)
    |   |-- lead-analyzer.js    # AI lead analysis + auto CRM population
    |   |-- gemini-client.js    # Shared Gemini API client (retry, circuit breaker)
    |   |-- business.js         # Business context builder + AI business analysis
    |   |-- scheduler.js        # Cron-based scheduled message sender
    |   |-- outreach.js         # Bulk send job manager
    |   |-- availability.js     # Appointment slot generation + booking logic
    |   `-- google-calendar.js  # Google Calendar API integration
    `-- utils/
        |-- validate.js         # Input validation, sanitization, LIMITS constants
        |-- errors.js           # asyncHandler wrapper, error classes
        |-- tz.js               # Timezone math (no date library dependency)
        `-- conversation-queue.js # Serializes message processing per contact
```

---

## 6. Server Boot Sequence

**File:** `server.js`

When Node.js starts the server, the following sequence runs in order:

1. **`assertPersistRootWritable()`** — Verifies the data directory exists and is writable. Refuses to start if not (prevents the "looks healthy but loses all data" failure).

2. **`initDatabase()`** — Opens `data/whatsapp.db`. If the file is corrupt, tries `whatsapp.db.bak`. If both fail, quarantines the corrupt file and throws (refuses to start with an empty database, which would look healthy while destroying all tenant data).

3. **Schema creation** — All tables are created with `CREATE TABLE IF NOT EXISTS`, safe to re-run.

4. **Legacy migration** — If tables exist without a `user_id` column (pre-multi-tenant install), they are renamed, fresh tables created, and all rows copied in with `user_id = 1`.

5. **Versioned migrations** — All pending migrations in `MIGRATIONS[]` are applied in order.

6. **`ensureBootstrapAdmin()`** — If `BOOTSTRAP_ADMIN_EMAIL` is set, creates or promotes that account to `role = 'admin'`.

7. **`initScheduler()`** — Starts the cron job that fires every minute to send due scheduled messages.

8. **Google Calendar background sync** — Starts a `setInterval` that runs `syncEventsToScheduledMessages` every 5 minutes for all connected users.

9. **`resumeExistingSessions()`** — Reads the filesystem for existing `user_<id>` auth directories. For each found, calls `initWhatsAppClient(userId)` to reconnect the WhatsApp session automatically without the user having to scan the QR again.

10. **Express app starts listening** — The HTTP server binds to the port (`PORT` env or 3000).

**Graceful shutdown** (on `SIGTERM` or `SIGINT`):
- Cancels all in-flight outreach jobs.
- Stops the scheduler.
- Destroys all WhatsApp Chrome sessions (with 8s destroy timeout each).
- Waits for any in-flight scheduler tick to finish.
- Force-persists the database to disk.
- Exits with code 0.

**Crash safety** (on `uncaughtException` / `unhandledRejection`):
- Force-persists the database.
- Exits with code 1.

---

## 7. Database Design

**Engine:** SQLite, loaded into memory via `sql.js`, written back to disk on every write (debounced 250ms, with fsync for crash safety).

**Location:** `data/whatsapp.db`

---

### Table: `users`
The accounts / tenants table.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | Tenant ID used to scope all other tables |
| `email` | TEXT UNIQUE | Normalized to lowercase |
| `password_hash` | TEXT | bcrypt hash |
| `business_name` | TEXT | Display name for admin panel |
| `owner_name` | TEXT | Used in AI prompts ("Replying on behalf of...") |
| `role` | TEXT | `'admin'` or `'user'` |
| `status` | TEXT | `'active'` or `'suspended'` |
| `plan` | TEXT | Free-form plan label (used for display/admin tracking) |
| `message_limit` | INTEGER | Monthly outgoing cap (0 = unlimited) |
| `rule_limit` | INTEGER | Max chatbot rules (0 = unlimited) |
| `created_at` | DATETIME | |
| `last_login_at` | DATETIME | Updated on every successful login |

---

### Table: `contacts`
One row per WhatsApp number seen by an account.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `phone` | TEXT | Digits only (e.g. `919876543210`) |
| `name` | TEXT | Contact's WhatsApp display name |
| `label` | TEXT | Owner-assigned label or AI-assigned (e.g. `Hot Lead`) |
| `notes` | TEXT | Free-form notes |
| `last_outreach_at` | DATETIME | Last time this contact was sent an outreach message |
| `created_at` / `updated_at` | DATETIME | |
| UNIQUE | `(user_id, phone)` | |

---

### Table: `messages`
All incoming and outgoing WhatsApp messages.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `wa_message_id` | TEXT | WhatsApp's own message ID (used for idempotency) |
| `phone` | TEXT | The other party's phone number |
| `contact_name` | TEXT | Name at time of message |
| `direction` | TEXT | `'incoming'` or `'outgoing'` |
| `message_type` | TEXT | `'text'` (currently) |
| `body` | TEXT | Message content |
| `status` | TEXT | `'sent'`, `'failed'`, etc. |
| `template_name` | TEXT | Name of template if applicable |
| `created_at` | DATETIME | |

---

### Table: `chatbot_rules`
Keyword-based auto-reply rules.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `trigger_keyword` | TEXT | The keyword or regex pattern |
| `match_type` | TEXT | `'exact'`, `'contains'`, `'startswith'`, `'regex'` |
| `response_text` | TEXT | The reply to send. Supports `{name}` and `{phone}` tokens |
| `priority` | INTEGER | Lower = higher priority. Rules are sorted ascending |
| `is_active` | INTEGER | 1 = active, 0 = disabled |
| `hit_count` | INTEGER | How many times this rule has matched |
| `created_at` / `updated_at` | DATETIME | |

---

### Table: `scheduled_messages`
Messages queued for future delivery.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `phone` | TEXT | Destination phone number |
| `body` | TEXT | Message content |
| `scheduled_at` | DATETIME | When to send (UTC) |
| `status` | TEXT | `'pending'`, `'sending'`, `'sent'`, `'failed'`, `'cancelled'`, `'unknown'` |
| `error_message` | TEXT | Set on failure |
| `created_at` | DATETIME | |
| `sent_at` | DATETIME | Set on successful delivery |

**Status `'unknown'`** means: the send was attempted but timed out before confirmation. The message may or may not have been delivered. Do not re-send without checking with the recipient.

---

### Table: `settings`
Key-value store for per-user configuration.

| Column | Type | Notes |
|---|---|---|
| `user_id` | INTEGER | Tenant FK |
| `key` | TEXT | Setting name |
| `value` | TEXT | Setting value (always stored as string) |
| PRIMARY KEY | `(user_id, key)` | |

**Default setting keys:**

| Key | Default Value | Purpose |
|---|---|---|
| `chatbot_enabled` | `'true'` | Master on/off for auto-replies |
| `default_reply` | `'Thank you...'` | Static fallback when no rule matches and AI is off |
| `business_name` | `''` | Business name shown to AI |
| `owner_name` | `''` | Owner name shown to AI |
| `ai_mode` | `'ai_first'` | `'ai_first'` (AI replies always) or `'rules_first'` (rules first, AI fallback) |
| `away_message` | `'I am currently away...'` | Message sent in away mode |
| `away_mode` | `'false'` | When `'true'`, replies with the away message |
| `ai_enabled` | `'true'` | Enable/disable AI replies |
| `ai_system_prompt` | (long default) | Custom instructions for the AI persona |
| `gemini_api_key` | `''` | Per-user Gemini API key |
| `business_website` | `''` | Business website URL |
| `business_description` | `''` | What the business does |
| `business_industry` | `''` | Industry category |
| `business_target_customers` | `''` | Who the business sells to |
| `business_offers` | `''` | Current promotions or special offers |
| `business_currency` | `'Rs'` | Currency symbol for CRM deal values |
| `business_ai_profile` | `''` | JSON blob from AI business analysis |

---

### Table: `products`
Product/service catalog for the business.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `name` | TEXT | Product name |
| `description` | TEXT | Product description |
| `price` | TEXT | Free-form price string |
| `category` | TEXT | Product category |
| `url` | TEXT | Link to product page |
| `is_active` | INTEGER | 1 = included in AI context, 0 = excluded |
| `created_at` / `updated_at` | DATETIME | |

---

### Table: `crm_deals`
Sales pipeline deals, one per contact per tenant.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `phone` | TEXT | Linked to a contact phone |
| `contact_name` | TEXT | |
| `stage` | TEXT | `new`, `contacted`, `qualified`, `proposal`, `negotiation`, `won`, `lost` |
| `deal_value` | REAL | Owner-set deal value |
| `product_interest` | TEXT | Products the contact is interested in |
| `source` | TEXT | `'manual'` or `'whatsapp'` |
| `notes` | TEXT | Free-form notes |
| `next_followup_at` | DATETIME | When to next follow up |
| `ai_suggested_stage` | TEXT | What the AI recommends |
| `ai_estimated_value` | REAL | AI's estimated deal value |
| `stage_changed_at` | DATETIME | When stage last changed |
| `created_at` / `updated_at` | DATETIME | |
| UNIQUE | `(user_id, phone)` | One deal per contact per tenant |

---

### Table: `crm_activities`
Activity log entries for CRM deals.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `phone` | TEXT | |
| `type` | TEXT | `'note'`, `'stage'`, `'system'` |
| `content` | TEXT | Activity content |
| `created_at` | DATETIME | |

---

### Table: `lead_analysis`
AI analysis results for each conversation.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `phone` | TEXT | |
| `contact_name` | TEXT | |
| `summary` | TEXT | 2-4 sentence conversation summary |
| `interest_status` | TEXT | `interested`, `not_interested`, `neutral`, `unclear` |
| `interest_score` | INTEGER | 0-100 |
| `sentiment` | TEXT | `positive`, `neutral`, `negative`, `frustrated` |
| `issue_category` | TEXT | e.g. `pricing`, `complaint`, `general inquiry` |
| `issues` | TEXT | JSON array of specific issues raised |
| `priority` | TEXT | `high`, `medium`, `low` |
| `priority_reason` | TEXT | Why this priority |
| `next_action` | TEXT | Recommended follow-up action |
| `message_count` | INTEGER | Messages in conversation at analysis time |
| `last_analyzed_at` / `created_at` | DATETIME | |
| UNIQUE | `(user_id, phone)` | One analysis per contact per tenant (upserted) |

---

### Table: `availability_settings`
Weekly working hours configuration for appointment booking.

| Column | Type | Notes |
|---|---|---|
| `user_id` | INTEGER PK | One row per tenant |
| `working_days` | TEXT | Comma-separated weekday numbers (`1,2,3,4,5` = Mon-Fri) |
| `start_time` | TEXT | `'09:00'` |
| `end_time` | TEXT | `'18:00'` |
| `slot_duration_minutes` | INTEGER | Default 30 |
| `buffer_minutes` | INTEGER | Gap between slots. Default 0 |
| `timezone` | TEXT | IANA timezone, default `'Asia/Kolkata'` |
| `booking_enabled` | INTEGER | 0 = chatbot will not offer booking |
| `updated_at` | DATETIME | |

---

### Table: `appointments`
Booked appointments.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER | Tenant FK |
| `phone` | TEXT | Customer's phone |
| `contact_name` | TEXT | |
| `start_at` | DATETIME | UTC start |
| `end_at` | DATETIME | UTC end |
| `status` | TEXT | `'confirmed'` or `'cancelled'` |
| `source` | TEXT | `'chatbot'` or `'dashboard'` |
| `notes` | TEXT | |
| `calendar_event_id` | TEXT | Google Calendar event ID if mirrored |
| `created_at` | DATETIME | |

---

### Table: `google_calendar_accounts`
OAuth tokens for each tenant's connected Google Calendar.

| Column | Type | Notes |
|---|---|---|
| `user_id` | INTEGER PK | One row per tenant |
| `access_token` | TEXT | |
| `refresh_token` | TEXT | Used to silently refresh expired access tokens |
| `scope` | TEXT | |
| `token_type` | TEXT | |
| `expiry_date` | INTEGER | Unix timestamp ms |
| `calendar_id` | TEXT | Default `'primary'` |
| `check_availability` | INTEGER | 0/1 — skip outreach sends while owner is busy |
| `connected_at` / `last_sync_at` | DATETIME | |

---

### Table: `google_calendar_synced_events`
Tracks which Google Calendar events have been imported as scheduled messages.

| Column | Type | Notes |
|---|---|---|
| `user_id` | INTEGER | Part of composite PK |
| `event_id` | TEXT | Google Calendar event ID |
| `scheduled_message_id` | INTEGER | Linked scheduled_messages row |
| `created_at` | DATETIME | |
| PRIMARY KEY | `(user_id, event_id)` | Prevents re-import across sync ticks |

---

### Table: `schema_migrations`
Tracks which versioned migrations have run.

| Column | Type | Notes |
|---|---|---|
| `version` | INTEGER PK | Migration version number |
| `name` | TEXT | Human-readable migration name |
| `applied_at` | DATETIME | |

---

## 8. Authentication & Session Management

**File:** `src/config/auth.js`

### How Sessions Work

- Sessions use a **custom HMAC-SHA256 token** — no JWT library.
- The HMAC secret is a 64-byte random key stored at `data/.session_secret` and loaded once on boot.
- A token encodes: `userId`, `role`, `email`, `issuedAt`, and a `nonce` (random bytes for uniqueness).
- The token is signed with HMAC-SHA256 and base64url encoded.
- The token is delivered to the browser as an **HttpOnly, SameSite=Lax cookie** (`session`).

### Token Validation (on every protected request)

1. Cookie is parsed and decoded.
2. HMAC signature is verified.
3. Token is checked against the **in-memory blacklist** (`tokenBlacklist` Set).
4. User's `tokenEpoch` is checked — if the token's `issuedAt` is before the epoch, it's invalid (covers "revoke all sessions" scenarios).
5. The live user row is fetched from the database — if the account is suspended, request is rejected with 403.
6. `req.user` is set to the live database row (not just token payload), so role changes take effect immediately.

### Password Hashing

- **bcrypt** via `bcryptjs`.
- `burnPasswordVerification()` — a dummy bcrypt.compare call performed when a login attempt uses an unknown email, so the response time is identical to a failed-password attempt. This prevents timing-based account enumeration.

### Revocation

| Scenario | Mechanism |
|---|---|
| Logout | Token added to `tokenBlacklist` (in-memory) |
| Password change | `userTokenEpoch[userId]` set to current timestamp, voiding all pre-existing tokens |
| Admin suspends account | Status check on every request blocks login; WhatsApp session destroyed |
| Admin changes role | `revokeAllSessionsForUser(id)` called |
| Admin deletes account | `revokeAllSessionsForUser(id)` + `destroyClientForUser(id)` |

### Session Cookie Properties

| Property | Value |
|---|---|
| Name | `session` |
| HttpOnly | Yes |
| SameSite | `Lax` |
| Secure | Yes (in production) |
| Path | `/` |
| MaxAge | 30 days |

---

## 9. Security Architecture

### Input Validation

All user-supplied input is validated through `src/utils/validate.js` before reaching business logic or the database:

- **`requireString(val, name, opts)`** — throws `ValidationError` if not a string or outside length bounds.
- **`normalizePhone(val)`** — strips all non-digits; throws if result is not 7-15 digits.
- **`requireEnum(val, allowed, name)`** — throws if value is not in the allowed set.
- **`sanitizeSpreadsheetCell(val)`** — removes CSV-injection prefixes (`=`, `+`, `-`, `@`).
- **`assertSafeRegexSource(pattern)`** — runs the pattern against ReDoS-vulnerable inputs to detect catastrophic backtracking before saving.
- **`LIMITS`** constants cap text lengths for every user-supplied field.

### SQL Injection Prevention

All database queries use parameterized statements via `sql.js`'s `db.prepare(sql).bind(params)` / `db.run(sql, params)`. No string concatenation is used for query construction.

### CSRF Protection

- Cookies are `SameSite=Lax` — cross-site POST requests do not carry cookies.
- SSE endpoint (`/api/qr-stream`) validates `Origin` header against `ALLOWED_ORIGINS` and rejects requests with `Sec-Fetch-Site: cross-site`.
- Google Calendar OAuth callback uses an anti-CSRF state token (short-lived, in-memory, tied to `userId`).

### Content Security Policy

A per-request CSP nonce is generated for each response. Script tags in OAuth callback HTML include the nonce. CSP is set in `src/config/app.js`.

### Security Headers Applied on Every Response

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
X-XSS-Protection: 1; mode=block
Permissions-Policy: (restrictive)
Content-Security-Policy: (with per-request nonce)
```

### Prompt Injection Defense

In `src/services/ai.js`:
- Incoming message text from untrusted senders **only appears in the `contents` (user turn)**; it is never interpolated into the `systemInstruction`.
- Contact names are stripped of newlines (`sanitizeLabel`) before inclusion in the system instruction, preventing newline-injection of fake directive lines.
- The system instruction explicitly tells the model to ignore any instructions that appear in messages.
- No secrets (API keys, other tenant data) exist in the prompt for anything to leak.

### Rate Limiting

All sensitive endpoints are rate-limited. See Section 24.

---

## 10. WhatsApp Integration Layer

**File:** `src/services/whatsapp-client.js`

### Session Model

- Each signed-up account gets its own **isolated `whatsapp-web.js` Client** instance.
- Each client runs its own **headless Chromium process** (~150-250MB RAM each).
- Maximum concurrent sessions: 5 by default (configurable via `MAX_CONCURRENT_WHATSAPP_SESSIONS`).
- Session auth data is stored at `.wwebjs_auth/user_<id>/` — separated per user so sessions survive server restarts.

### Session State Object

Each user's session tracks:
- `client` — the `whatsapp-web.js` Client instance
- `currentQR` — the QR code as a data URL (for display in dashboard)
- `isConnected` — whether WhatsApp is ready to send/receive
- `isInitializing` — whether the session is starting up
- `sseClients` — array of active SSE connections for this user
- `crashCount` / `lastCrashTime` — for exponential backoff
- `destroyed` — prevents auto-resurrection when deliberately torn down
- `userDisconnected` — set on explicit disconnect

### Connection Lifecycle

1. **Connect** — `initWhatsAppClient(userId)` is called (from dashboard, session resumption, or backoff restart).
2. **QR Phase** — `client.on('qr')` fires; QR is converted to a data URL and broadcast via SSE to the user's dashboard tabs.
3. **Authenticated** — `client.on('authenticated')` fires; QR cleared.
4. **Ready** — `client.on('ready')` fires; `isConnected = true`; keep-alive and watchdog timers start.
5. **Keep-alive** — Every 30 seconds, `client.getState()` is called. If state is not `'CONNECTED'`, a reconnect is scheduled.
6. **Watchdog** — Every 90 seconds, checks if the session is not connected and not restarting. If so, forces a restart.
7. **Disconnect** — `client.on('disconnected')` fires; exponential backoff restart scheduled.
8. **Crash recovery** — Up to 10 consecutive crashes before giving up; delays: 8s, 16s, 32s, up to 5 min (with jitter).

### Stale Lock File Cleanup

If Chromium crashes, it leaves `SingletonLock`, `SingletonCookie`, `SingletonSocket`, `DevToolsActivePort` files in the auth directory. These block the next launch. The service recursively removes them before each `client.initialize()`.

### Server-Sent Events (SSE)

- Each dashboard tab opens `/api/qr-stream` — an SSE connection that receives real-time WhatsApp status events.
- Events emitted: `loading`, `qr` (with data URL), `ready` (with phone number), `disconnected`, `error`.
- Heartbeat sent every 20 seconds to keep the connection alive through proxies.
- Max 5 SSE connections per user, max 250 total across the platform.
- Heartbeat capped at 180 beats (1 hour) per connection, then closed.

### Sending Messages

`sendTextMessage(userId, phone, text)`:
- Validates that the session is connected.
- Strips all non-digit characters from phone, validates 7-15 digits.
- Sends via `client.sendMessage('{digits}@c.us', text)`.

### Explicit Disconnect

`destroyClientForUser(userId)`:
- Sets `destroyed = true` (prevents auto-restart).
- Calls `client.logout()` (4s timeout).
- Destroys the Chromium process.
- Deletes the auth directory (next connect will be a fresh QR scan).

---

## 11. Chatbot Engine — How Auto-Replies Work

**File:** `src/services/chatbot.js`

### Message Processing Pipeline

Every incoming WhatsApp message runs through the following ordered steps. **The first step that produces a reply wins.**

```
Incoming message
    |
    |-> Log message to database (always)
    |-> Schedule debounced lead analysis (always)
    |
    |-> [Rate limit check] > 10 messages/min from this sender? -> SKIP
    |-> [Plan limit check] Monthly outgoing cap hit? -> SKIP
    |-> [Chatbot enabled?] chatbot_enabled != 'true'? -> SKIP
    |
    |-> [AI-FIRST mode] ai_enabled='true' AND ai_mode='ai_first'
    |       -> generateReply (Gemini) -> send -> log -> DONE
    |       (if Gemini fails, falls through to rules)
    |
    |-> [AWAY MODE] away_mode='true'
    |       -> send away_message -> log -> DONE
    |
    |-> [KEYWORD RULES] getChatbotRules (sorted by priority ASC)
    |       -> for each rule: does it match? -> send response -> log -> increment hit count -> DONE
    |
    |-> [AI FALLBACK] ai_enabled='true' (rules_first mode, nothing matched)
    |       -> generateReply (Gemini) -> send -> log -> DONE
    |
    `-> [DEFAULT REPLY] default_reply setting is set?
            -> send default_reply -> log -> DONE
```

### Serialization

Messages from the same `(userId, phone)` pair are **serialized** through `conversationQueue` — one message is fully processed before the next begins. This prevents a rapid burst from the same sender from triggering duplicate AI calls or overlapping rule evaluations.

### Rule Matching

| Match Type | Logic |
|---|---|
| `exact` | Lowercased message must equal lowercased keyword |
| `contains` | Lowercased keyword is a substring of lowercased message |
| `startswith` | Lowercased message starts with lowercased keyword |
| `regex` | Pattern tested via `safeRegexTest` (bounded input length) |

### Template Variables in Rules

Rule `response_text` supports two substitution tokens:
- `{name}` — replaced with the contact's WhatsApp display name (or `'there'` if unknown)
- `{phone}` — replaced with the contact's phone number

### Human-Like Reply Behavior

`safeReply(client, phone, responseText, msg)`:
1. Shows the **typing indicator** in WhatsApp (cosmetic).
2. Waits a **random delay** of 1.5-3 seconds (to feel human).
3. Sends the message using `msg.reply()` first (avoids WhatsApp LID format issues), falling back to `client.sendMessage()`.

### Inbound Message Filters

Incoming messages are **ignored** if:
- They are from a group (from address ends with `@g.us`)
- They are a status update
- They are a broadcast
- The body is empty
- The message is from the account owner themselves
- The phone number does not match the pattern 7-15 digits

---

## 12. AI Engine (Gemini Integration)

### Gemini Client (`src/services/gemini-client.js`)

Single point of contact for all Gemini API calls. Provides:

**Model fallback chain:** `gemini-2.5-flash` -> `gemini-2.0-flash` -> `gemini-2.0-flash-lite`

**Retry logic:** Up to 2 retries per model, with exponential backoff and jitter. Only retries on transient errors (429, 500, 502, 503, 504, network errors). Never retries on 400, 401, 403, 404.

**Circuit breaker:** Keyed by an SHA-256 fingerprint of the API key (the key itself is never stored as a map key). Opens after 5 consecutive failures; half-opens after a 60-second cooldown.

**API Key Resolution:** Uses the tenant's own `gemini_api_key` setting if set; falls back to the platform-wide `GEMINI_API_KEY` environment variable.

**Timeouts:** Every call is wrapped in a `Promise.race` with a `GEMINI_TIMEOUT_MS` (default 30 seconds) timeout.

---

### AI Reply Generation (`src/services/ai.js`)

`generateReply(userId, systemPrompt, conversationHistory, contactName, phone)`:

**System instruction is built from:**
- Owner's custom `ai_system_prompt` (from settings)
- Hardcoded security guardrails (can't be overridden by user input)
- Context block: contact name/phone, owner name, business name
- Business knowledge block (products, description, offers — from `getBusinessContext`)
- Appointment booking instructions (if `bookingEnabled = true`)

**Conversation history:**
- Last 10 messages are used
- Each message is capped at 2,000 characters
- Untrusted text **only** appears in `role: 'user'` turns, never in `systemInstruction`
- History must start with a `role: 'user'` turn (Gemini API requirement)

**Output:**
- Clamped to 4,000 characters
- Max output tokens: 800

---

### AI Appointment Booking Mode

When `bookingEnabled = true`, `generateReply` uses `generateReplyWithBooking`, which enables **Gemini function calling** with two tools:

**`check_availability`:**
- Arguments: `daysAhead` (1-14, default 7)
- Returns: array of `{ start_iso, label }` for free slots, or empty with a message

**`book_appointment`:**
- Arguments: `start_iso` (exact value from a previous `check_availability` result), `notes`
- Calls `bookAppointment(userId, ...)` in `availability.js`
- Returns: `{ booked: true, start_at, end_at }` or `{ booked: false, error }`

**Tool loop limit:** Max 3 function-call rounds per message (prevents infinite tool loops).

---

## 13. Lead Analysis & CRM Auto-Population

**File:** `src/services/lead-analyzer.js`

### How Lead Analysis is Triggered

**Automatically (debounced):** When an incoming message arrives, `scheduleAutoAnalysis(userId, phone)` sets a 3-minute timer for that `(userId, phone)` pair. If another message arrives before the timer fires, the timer resets. When the conversation goes quiet for 3 minutes, the full analysis runs.

**Manually:** Via `POST /api/contacts/:phone/analyze` or `POST /api/contacts/analyze-all`.

### What the Analysis Does

1. Fetches the last 80 messages of the conversation.
2. Builds a readable transcript, bounded at 60,000 total characters.
3. Sends transcript to Gemini with a structured analysis prompt.
4. Receives a JSON object with:

| Field | Type | Meaning |
|---|---|---|
| `summary` | string | 2-4 sentence summary |
| `interest_status` | enum | `interested`, `not_interested`, `neutral`, `unclear` |
| `interest_score` | 0-100 | Likelihood of conversion |
| `sentiment` | enum | `positive`, `neutral`, `negative`, `frustrated` |
| `issue_category` | string | e.g. `pricing`, `complaint`, `support/technical issue` |
| `issues` | array | Specific objections or problems raised |
| `priority` | enum | `high`, `medium`, `low` |
| `priority_reason` | string | Why this priority was assigned |
| `next_action` | string | Recommended follow-up action |
| `product_interest` | string | Products/services the contact is interested in |
| `estimated_value` | number | Estimated deal value in business currency |
| `suggested_stage` | enum | CRM stage recommendation |
| `is_sales_conversation` | boolean | False for personal chats, spam |

5. Normalizes and clamps all fields.
6. Saves to `lead_analysis` table (upsert — one row per contact per tenant).
7. **Auto-labels the contact:** `Hot Lead` (interested + high priority), `Interested`, `Not Interested`, `Needs Support`.
8. **Auto-populates CRM deal** (if `is_sales_conversation = true` and not a personal chat or spam): Creates or updates a `crm_deals` row with AI-suggested stage and estimated value. **Never overwrites a manually-set stage or value** — AI fields (`ai_suggested_stage`, `ai_estimated_value`) are separate columns.

### Batch Analysis

`analyzeAllConversations(userId, onlyStale)`:
- Processes up to 25 conversations per run.
- Skips conversations where `message_count` has not changed since last analysis (when `onlyStale = true`).
- Stops early after 3 consecutive failures.
- Has a 120-second absolute deadline.

---

## 14. Business Profile & Product Catalog

**File:** `src/services/business.js`

### Business Information

Owners fill out the following in Settings:
- **Business Name** — shown in admin panel and injected into AI prompts
- **Owner Name** — the AI says "Replying on behalf of [Owner Name]"
- **Website** — included in business context for AI
- **Industry** — e.g. "Retail", "Software", "Healthcare"
- **Description** — what the business does
- **Target Customers** — who the ideal customers are
- **Current Offers** — promotions, discounts, deals

### Product Catalog

Each product/service has: name, description, price, category, URL, and an `is_active` flag. Active products (up to 40) are included in AI prompts so the AI can accurately answer pricing and catalog questions without inventing details.

### AI Business Profile Analysis

`analyzeBusinessProfile(userId)`:
- Sends the full business info and product catalog to Gemini.
- Returns a structured JSON profile with:
  - `profile_summary` — positioning in 2-3 sentences
  - `selling_points` — 3-6 concrete points
  - `ideal_customer` — who to target
  - `sales_pitch` — WhatsApp-friendly pitch message
  - `objection_handling` — objections + suggested replies
  - `faq` — expected Q&As
  - `improvement_tips` — practical WhatsApp conversion tips
- Saved to `settings` as `business_ai_profile` (JSON).
- Included automatically in future AI prompts via `getBusinessContext`.

---

## 15. CRM Module

### Deal Stages

`new` -> `contacted` -> `qualified` -> `proposal` -> `negotiation` -> `won` / `lost`

Stages are validated against this exact enum at write time.

### What Gets Tracked per Deal

- **Contact** (phone + name)
- **Stage** (current pipeline position)
- **Deal Value** (manually set)
- **Product Interest** (free text)
- **Source** (`'manual'` or `'whatsapp'`)
- **Notes** (free text)
- **Next Follow-up Date**
- **AI Suggested Stage** (from lead analysis — display only)
- **AI Estimated Value** (from lead analysis — display only)
- **Activity Log** (stage changes, notes, system events)

### CRM Analytics

`GET /api/crm/analytics` returns:
- Count of deals per stage
- Total pipeline value (sum of all `deal_value` fields)
- Total AI estimated value
- Currency symbol from settings

### How Deals Are Created

1. **Manually** — owner clicks "Add Deal" in the CRM tab.
2. **Automatically via lead analysis** — when `analyzeConversation` determines it's a sales conversation, `aiUpsertCrmDeal` creates a deal if one does not exist, or updates AI fields if one does. It never overwrites the owner's manually-set stage or deal value.

### Activity Log

Every stage change auto-logs an activity (e.g. "Stage changed: contacted -> qualified").
Owners can manually add notes to a deal's activity log via `POST /api/crm/deals/phone/:phone/notes`.

---

## 16. Scheduled Messages

**File:** `src/services/scheduler.js`

### How Scheduling Works

1. Owner creates a scheduled message via `POST /api/messages/schedule` with a phone number, message body, and `scheduled_at` datetime.
2. Row is inserted into `scheduled_messages` with `status = 'pending'`.
3. Every minute, the scheduler cron fires and queries for rows where `status = 'pending'` AND `scheduled_at <= now`.
4. For each due row, an **atomic claim** is attempted: `UPDATE scheduled_messages SET status='sending' WHERE id=? AND status='pending'`. If `changes === 0`, another process already claimed it — skipped.
5. The claiming process checks if the account is suspended or deleted — cancels the message if so.
6. `sendTextMessage` is called with a 20-second timeout.
7. On success: `status = 'sent'`, message logged to `messages` table.
8. On timeout: `status = 'unknown'` (message may or may not have been delivered — do not re-send without checking).
9. On other failure: `status = 'failed'` with a truncated error reason.

### Why the Atomic Claim Matters

Without the atomic claim, two server instances running simultaneously (rolling deploy, multi-process) would both see the same `'pending'` row and both send it. The customer receives the message twice. SQLite serializes the UPDATE, so the claim is safe even across processes.

### Stuck Message Recovery

On every boot, `reclaimStuckScheduledMessages(15)` is called — any messages stuck in `status = 'sending'` for more than 15 minutes are marked `status = 'failed'`.

### Anti-Spam Delay

1.2 seconds between each scheduled message send.

### Batch Size

Max 40 messages per tick. Overflow waits for the next tick (up to 1 minute later).

---

## 17. Bulk Outreach Campaigns

**File:** `src/services/outreach.js`

### Overview

An outreach job sends a personalized message to a list of contacts in the background. The route returns immediately with a `jobId`; the dashboard polls for progress.

### Job Limits

| Limit | Default | Override Env Var |
|---|---|---|
| Max recipients per job | 25 | `MAX_OUTREACH_RECIPIENTS_PER_JOB` |
| Max concurrent jobs total | 5 | `MAX_CONCURRENT_OUTREACH_JOBS` |
| Max concurrent jobs per user | 1 | `MAX_CONCURRENT_OUTREACH_PER_USER` |
| Min delay between sends | 3,000ms | (hardcoded) |
| Max delay between sends | 9,000ms | (hardcoded) |

Delays are randomized between 3s and 9s to reduce bot-pattern detection.

### Per-Send Safety Checks (re-evaluated every iteration)

1. **Cancel requested** — stops the job immediately.
2. **Account suspended** — stops remaining sends.
3. **Monthly message limit** — stops remaining sends.
4. **Google Calendar busy check** — skips individual send if owner is in a meeting (fail-open: if Calendar check fails, send proceeds).
5. **Phone validation** — marks individual contact failed if phone is invalid.

### Message Personalization

Template: `{{name}}` is replaced with the contact's name (or `'there'` if blank) before sending.

### Job State

Tracked in-memory (does not survive restarts). Finished jobs are purged after 30 minutes. Each job tracks:
- `total` / `sent` / `failed` / `skipped`
- `status`: `running` | `done` | `cancelled`
- `results[]` — per-contact outcome

---

## 18. Appointment Booking System

**Files:** `src/services/availability.js`, `src/routes/appointments.js`

### Configuration (Dashboard -> Appointments -> Settings)

| Setting | Default |
|---|---|
| Working days | Monday-Friday |
| Start time | 09:00 |
| End time | 18:00 |
| Slot duration | 30 minutes |
| Buffer between slots | 0 minutes |
| Timezone | Asia/Kolkata |
| Booking enabled | Off (must be explicitly enabled) |

### Slot Generation

`getAvailableSlots(userId, { daysAhead, maxResults })`:

1. Generates all candidate slot start/end times for the next `daysAhead` days (default 7, max 30) based on working hours configuration.
2. Filters out slots with less than 15 minutes lead time.
3. Queries the internal `appointments` table for already-booked confirmed slots in the range.
4. (If Google Calendar connected) Queries Calendar's freebusy API for busy blocks.
5. Returns only slots not overlapping with booked or busy periods.
6. Returns up to `maxResults` slots (default 8).

### Booking Flow

`bookAppointment(userId, { phone, contactName, startIso, notes, source })`:

1. Validates `startIso` parses to a valid date.
2. Checks the slot is not in the past.
3. **Validates the slot lands on a valid slot boundary** — must match the exact working-hours grid.
4. Checks per-tenant appointment row cap.
5. Pre-checks for conflicting appointments (fast path).
6. Checks Google Calendar busy blocks.
7. Attempts to create a Google Calendar event (best-effort — failure does not block booking).
8. Calls `createAppointment()` in the database — an **atomic INSERT** with a `UNIQUE(user_id, start_at)` constraint.
9. If insert returned null (slot taken in race): deletes the calendar event just created and throws `SLOT_TAKEN`.
10. Returns the saved appointment row.

### Cancellation

Dashboard can cancel any appointment via `DELETE /api/appointments/:id`. Best-effort deletes the associated Google Calendar event.

### Chatbot Integration

When `bookingEnabled = true`, the AI chatbot automatically gains booking capability via Gemini function calling. The AI presents real slots, and after the customer picks one, calls `book_appointment` — which goes through the same `bookAppointment()` function with all the same safety checks.

---

## 19. Google Calendar Integration

**File:** `src/services/google-calendar.js`, `src/routes/calendar.js`

### Prerequisites (admin must configure)

Three environment variables must be set:
- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REDIRECT_URI`

### OAuth2 Connect Flow

1. User clicks "Connect Google Calendar" in Settings.
2. Dashboard calls `GET /api/calendar/connect` — server generates an anti-CSRF state token and returns the Google OAuth consent URL.
3. User is redirected to Google's consent page.
4. Google redirects back to `GET /api/calendar/oauth/callback?code=...&state=...`.
5. Server validates the state token (tied to the logged-in user's session).
6. Exchanges the authorization code for access + refresh tokens via Google.
7. Saves tokens to `google_calendar_accounts` table.
8. Immediately runs a first calendar sync.

### Feature 1: Outreach Event Logging

After every successful outreach or scheduled message send, `logOutreachEvent()` creates a 5-minute calendar event titled `"WhatsApp sent: [name]"`. This is **best-effort** — a Calendar failure does not affect the WhatsApp send outcome.

### Feature 2: Calendar-to-WhatsApp Scheduling

Background sync runs every 5 minutes. `syncEventsToScheduledMessages(userId)` scans upcoming events titled `"WhatsApp: +919876543210 [Optional Name]"`, creates `scheduled_messages` rows, and marks events as synced to prevent re-import.

**Calendar event format for scheduling:**
```
Title:       WhatsApp: +919876543210 [Optional Contact Name]
Description: The message to send
```

### Feature 3: Availability Check During Outreach

If `checkAvailability` is enabled, the outreach job checks whether the owner is busy before each send. If busy, that contact is skipped (not failed).

---

## 20. Contact Management

### Contact Records

A contact row is created/updated whenever a message is logged. `upsertContact(userId, phone, name, label, notes)` uses `INSERT OR REPLACE` to keep the record current.

### Contact Labels

Labels can be:
- **Manually set** by the owner (free text).
- **Auto-assigned by AI** after lead analysis: `Hot Lead`, `Interested`, `Not Interested`, `Needs Support`.

### Contact Import

Contacts can be imported in bulk via `POST /api/contacts/import`. Accepted formats:
- **CSV** with `phone` and optionally `name`, `label` columns.
- **JSON** array of `{ phone, name, label }` objects.

### Contact Export

`GET /api/contacts/export` returns all contacts as a CSV download.

### Contact Search & Filtering

`GET /api/contacts` supports:
- `?search=` — filter by name or phone
- `?label=` — filter by label
- `?page=` / `?limit=` — pagination

---

## 21. Message Logging

Every outgoing message is logged to `messages` with direction `'outgoing'`.
Every incoming message is logged to `messages` with direction `'incoming'`.

### Idempotency

A unique index on `(user_id, wa_message_id) WHERE wa_message_id LIKE 'idem:%'` prevents duplicate outgoing messages from being double-logged when idempotency keys are used.

### Monthly Outgoing Count

`getMonthlyOutgoingCount(userId)` counts outgoing messages in the current calendar month. Used to enforce `message_limit` on the account.

---

## 22. Settings System

**Key behavior:** The `GET /api/settings` endpoint returns all settings **except** `gemini_api_key`. Instead, it returns `gemini_api_key_set: true/false`. This prevents the API key from ever leaving the server.

**Write allow-list:** `PUT /api/settings` only accepts a curated list of setting keys with per-key length caps. Any unknown key is rejected and listed in the response `meta.ignored` array.

**Allowed editable settings via `/api/settings`:**
`chatbot_enabled`, `default_reply`, `business_name`, `owner_name`, `ai_mode`, `away_message`, `away_mode`, `ai_enabled`, `ai_system_prompt`, `gemini_api_key`, `business_website`, `business_description`, `business_industry`, `business_target_customers`, `business_offers`, `business_currency`, `lead_analysis_auto`.

---

## 23. Admin Panel

**Route file:** `src/routes/admin.js`
**Access:** `role = 'admin'` only

### Admin Capabilities

| Endpoint | What it does |
|---|---|
| `GET /admin/stats` | Platform-wide totals: users, messages, contacts, deals, appointments |
| `GET /admin/users` | All accounts with usage stats and WhatsApp status |
| `GET /admin/users/:id` | Single account detail |
| `PATCH /admin/users/:id` | Suspend/activate, change role, set plan/message limit/rule limit |
| `DELETE /admin/users/:id` | Cascade-delete account and all its data |

### Admin Safety Rules

- Admin cannot suspend or demote their own account.
- Admin cannot delete their own account.
- Deleting an account verifies zero orphaned rows remain; if cleanup failed, returns 500.

### Bootstrap Admin

Set `BOOTSTRAP_ADMIN_EMAIL` environment variable. On every boot the account is created or promoted to admin.

### Suspension Side Effects

When an account is suspended:
- Every subsequent API request from their session gets a 403 (`ACCOUNT_SUSPENDED` code).
- Their live WhatsApp session (Chrome + SSE) is immediately destroyed.

---

## 24. Rate Limiting & Throttling

**File:** `src/middleware/rateLimit.js`

All rate limiters are **in-memory** (reset on server restart). They use a sliding window per key.

### Login & Auth

| Endpoint | Key | Window | Max |
|---|---|---|---|
| `POST /auth/login` | `login-acct:{ip}:{email}` | 15 min | 8 attempts |
| `POST /auth/login` | `login-ip:{ip}` | 15 min | 40 attempts |
| `POST /auth/signup` | `signup:{ip}` | 1 hour | 10 attempts |
| `POST /auth/change-password` | `pwchange:{userId}` | 15 min | 10 attempts |

### API Write Operations

| Operation | Key | Window | Max |
|---|---|---|---|
| Contact writes | `contacts-write:{userId}` | 60s | 60 |
| Message writes | `messages-write:{userId}` | 60s | 60 |
| CRM writes | `crm-write:{userId}` | 60s | 60 |
| Appointment writes | `appointments-write:{userId}` | 60s | 60 |

### AI Operations

| Operation | Key | Window | Max |
|---|---|---|---|
| Manual AI analysis | `ai-analysis:{userId}` | 60s | 5 |
| Analyze all conversations | `ai-analyze-all:{userId}` | 15 min | 3 |
| AI chatbot test | `chatbot-test:{userId}` | 60s | 10 |
| Business analysis | `business-analysis:{userId}` | 60s | 3 |

### Anti-Bot (Chatbot Level)

In `chatbot.js`:
- Max 10 incoming messages per minute from the same `(userId, phone)` pair.
- Excess messages are silently dropped (not replied to) to prevent WhatsApp ban triggers.

---

## 25. API Reference — Auth Endpoints

Base path: `/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/signup` | No | Create a new account. Body: `{ email, password, businessName?, ownerName? }` |
| `POST` | `/auth/login` | No | Log in. Body: `{ email, password }`. Sets session cookie. |
| `POST` | `/auth/logout` | No | Log out. Revokes session cookie. |
| `POST` | `/auth/change-password` | Yes | Change password. Body: `{ currentPassword, newPassword }`. Revokes all other sessions. |
| `GET` | `/auth/me` | Yes | Returns the current user's profile (without password hash). |

---

## 26. API Reference — Operational Endpoints

Base path: `/api` — all require valid session cookie.

### WhatsApp / Connection

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/qr-stream` | SSE stream for QR code and connection status events |
| `GET` | `/api/status` | JSON status: `{ connected, phone, started, initializing, error, qr }` |
| `POST` | `/api/connect` | Start WhatsApp connection / trigger QR display |
| `POST` | `/api/disconnect` | Disconnect and destroy session (next connect = fresh QR) |
| `GET` | `/api/health` | System health: DB persist status, session metrics, scheduler status |

### Contacts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts. Query: `?search=`, `?label=`, `?page=`, `?limit=` |
| `POST` | `/api/contacts` | Create a contact. Body: `{ phone, name?, label?, notes? }` |
| `PUT` | `/api/contacts/:phone` | Update a contact |
| `DELETE` | `/api/contacts/:phone` | Delete a contact |
| `POST` | `/api/contacts/import` | Bulk import (CSV or JSON) |
| `GET` | `/api/contacts/export` | Download all contacts as CSV |

### Messages

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/messages` | List recent conversations (one row per contact, latest message) |
| `GET` | `/api/messages/:phone` | Full conversation history for one contact |
| `POST` | `/api/messages/send` | Send a message immediately. Body: `{ phone, message }` |
| `POST` | `/api/messages/schedule` | Schedule a future message. Body: `{ phone, message, scheduledAt }` |
| `GET` | `/api/messages/scheduled` | List all scheduled messages for this user |
| `DELETE` | `/api/messages/scheduled/:id` | Cancel a pending scheduled message |

### Chatbot Rules

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/chatbot/rules` | List all rules |
| `POST` | `/api/chatbot/rules` | Create a rule. Body: `{ triggerKeyword, matchType, responseText, priority?, isActive? }` |
| `PUT` | `/api/chatbot/rules/:id` | Update a rule |
| `DELETE` | `/api/chatbot/rules/:id` | Delete a rule |
| `POST` | `/api/chatbot/test` | Test a message against rules (no message sent). Body: `{ message }` |

### AI & Lead Analysis

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/contacts/:phone/analyze` | Run lead analysis for one contact |
| `POST` | `/api/contacts/analyze-all` | Batch analyze all stale conversations |
| `POST` | `/api/ai/reply` | Generate an AI reply preview. Body: `{ phone, message }` |

### CRM

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/crm/deals` | List all deals. Query: `?stage=`, `?search=` |
| `POST` | `/api/crm/deals` | Create a deal manually |
| `PUT` | `/api/crm/deals/:id` | Update a deal |
| `DELETE` | `/api/crm/deals/:id` | Delete a deal |
| `GET` | `/api/crm/deals/phone/:phone` | Get deal + lead analysis + activity log for one contact |
| `POST` | `/api/crm/deals/phone/:phone/notes` | Add a note to the activity log. Body: `{ content }` |
| `GET` | `/api/crm/analytics` | Pipeline analytics (counts per stage, total value) |

### Products / Catalog

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/products` | List products |
| `POST` | `/api/products` | Create a product |
| `PUT` | `/api/products/:id` | Update a product |
| `DELETE` | `/api/products/:id` | Delete a product |

### Business Profile

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/business/analyze` | Run AI business analysis. Returns profile JSON. |

### Outreach

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/outreach/start` | Start a bulk send job. Body: `{ contacts: [...], message }` |
| `GET` | `/api/outreach/:jobId` | Poll job status |
| `POST` | `/api/outreach/:jobId/cancel` | Cancel a running job |

### Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Get all settings (Gemini API key returned as boolean only) |
| `PUT` | `/api/settings` | Update settings. Body: `{ key: value, ... }` (allow-listed keys only) |

---

## 27. API Reference — Calendar Endpoints

Base path: `/api/calendar` — all require valid session cookie.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/calendar/status` | Check if Calendar is configured and connected |
| `GET` | `/api/calendar/connect` | Get the OAuth consent URL to start connection |
| `GET` | `/api/calendar/oauth/callback` | OAuth callback (Google redirects here). Returns HTML page. |
| `POST` | `/api/calendar/disconnect` | Disconnect Google Calendar |
| `PUT` | `/api/calendar/settings` | Update calendar settings. Body: `{ checkAvailability: bool }` |
| `POST` | `/api/calendar/sync` | Manually trigger a calendar sync ("import events now") |

---

## 28. API Reference — Appointment Endpoints

Base path: `/api/appointments` — all require valid session cookie.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/appointments/settings` | Get working hours / booking configuration |
| `PUT` | `/api/appointments/settings` | Update booking configuration |
| `GET` | `/api/appointments/slots` | Preview available slots. Query: `?daysAhead=`, `?maxResults=` |
| `GET` | `/api/appointments` | List appointments. Query: `?status=confirmed/cancelled` |
| `POST` | `/api/appointments` | Book a slot manually. Body: `{ phone, contactName?, startIso, notes? }` |
| `DELETE` | `/api/appointments/:id` | Cancel an appointment |

---

## 29. API Reference — Admin Endpoints

Base path: `/admin` — requires `role = 'admin'`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/stats` | Platform-wide statistics |
| `GET` | `/admin/users` | All users with stats and WhatsApp status |
| `GET` | `/admin/users/:id` | Single user detail |
| `PATCH` | `/admin/users/:id` | Update user. Body: `{ status?, role?, plan?, message_limit?, rule_limit?, business_name?, owner_name? }` |
| `DELETE` | `/admin/users/:id` | Cascade-delete user and all data |

---

## 30. Multi-Tenancy Model

Every database table (except `users` and `schema_migrations`) has a `user_id` column. **Every query includes `WHERE user_id = ?`** — there is no shared data across tenants.

Specifically:
- Contacts, messages, rules, scheduled messages, products, CRM deals, CRM activities, lead analyses, appointments, availability settings, calendar accounts, and calendar synced events are all per-user.
- Settings are per-user via `PRIMARY KEY (user_id, key)`.
- WhatsApp sessions are per-user — separate Chrome processes, separate auth directories.
- SSE streams are per-user — a QR code is only broadcast to the user who triggered it.
- Outreach jobs are per-user — job IDs include the user ID, and ownership is checked before returning job state.
- AI context (business info, product catalog, conversation history) is loaded only for the requesting user's `userId`.

### WhatsApp Session Isolation

Each user's WhatsApp authentication is stored at `.wwebjs_auth/user_<id>/`. The `authDataPath()` function validates the ID is a positive integer before constructing the path — preventing path traversal attacks.

---

## 31. Database Migrations

**File:** `src/services/database.js` (the `MIGRATIONS` array)

Migrations run at startup, in version order, each in a transaction. A failing migration throws and prevents the server from starting.

| Version | Name | What it does |
|---|---|---|
| 1 | `contacts.last_outreach_at` | Adds `last_outreach_at` column to contacts |
| 2 | `scheduled_messages.status allows sending` | Rebuilds scheduled_messages table to add `'sending'` to CHECK constraint |
| 3 | `normalize scheduled_at to SQLite-comparable UTC` | Replaces `T` and `Z` in timestamps for proper SQLite datetime comparison |
| 4 | `strip WhatsApp JID suffixes from stored phone numbers` | Removes `@c.us` and similar suffixes from phone numbers in all tables |
| 5 | `unique index for outgoing-message idempotency keys` | Adds unique index on `(user_id, wa_message_id)` for idempotency-keyed messages |
| 6 | `google_calendar_synced_events: composite PK (user_id, event_id)` | Rebuilds the synced events table to fix a tenant-isolation bug where event_id was globally unique |
| 7 | `scheduled_messages.status allows 'unknown'` | Rebuilds scheduled_messages to add `'unknown'` status for timed-out sends |

---

## 32. Persistence & Crash Safety

### Write Safety

Every write to the database calls `schedulePersist()`, which debounces a `doPersist()` call by 250ms. `doPersist()` uses a 3-step atomic replace:

1. Write the full database export to `whatsapp.db.tmp` and `fsync`.
2. Copy `whatsapp.db` to `whatsapp.db.bak`.
3. `rename(whatsapp.db.tmp, whatsapp.db)` — atomic at the filesystem level.

This ensures a crash at any point leaves either the old file or the new file, never a partial write.

### Read Safety

On startup, `openDatabaseFile()`:
1. Tries the primary file (`whatsapp.db`).
2. If corrupt or empty, tries the backup (`whatsapp.db.bak`).
3. If both fail, quarantines the corrupt file (renames it to `.corrupt-<timestamp>`) and throws — refusing to start with an empty database.

### Persistence Health

`persistHealth` tracks whether the last disk write succeeded. Write endpoints that call `assertPersistable()` return HTTP 503 if the disk is unhealthy, rather than a false HTTP 200 that would lose data on restart.

### Graceful Shutdown

On SIGTERM/SIGINT, `forcePersist()` is called synchronously before exit — ensuring in-memory changes are flushed even if the debounce has not fired yet.

---

## 33. Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port to listen on |
| `NODE_ENV` | No | — | Set to `'production'` to enable secure cookies and stricter checks |
| `PERSIST_ROOT` | No | Project root | Directory for `data/`, `.wwebjs_auth/`, `.wwebjs_cache/` |
| `BOOTSTRAP_ADMIN_EMAIL` | No | — | Email to create/promote as the platform admin on boot |
| `GEMINI_API_KEY` | No | — | Platform-wide Gemini API key (tenants can override with their own) |
| `GEMINI_TIMEOUT_MS` | No | `30000` | Timeout for each Gemini API call |
| `MAX_CONCURRENT_WHATSAPP_SESSIONS` | No | `5` | Max simultaneous headless Chrome processes |
| `MAX_SSE_CLIENTS_PER_USER` | No | `5` | Max SSE connections per user account |
| `MAX_SSE_CLIENTS_TOTAL` | No | `250` | Max SSE connections platform-wide |
| `MAX_OUTREACH_RECIPIENTS_PER_JOB` | No | `25` | Max contacts per outreach job |
| `MAX_CONCURRENT_OUTREACH_JOBS` | No | `5` | Max simultaneous outreach jobs platform-wide |
| `MAX_CONCURRENT_OUTREACH_PER_USER` | No | `1` | Max simultaneous outreach jobs per user |
| `ALLOWED_ORIGINS` | Recommended in prod | — | Comma-separated allowed origins for SSE stream |
| `GOOGLE_CALENDAR_CLIENT_ID` | No | — | Required to enable Google Calendar integration |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | No | — | Required to enable Google Calendar integration |
| `GOOGLE_CALENDAR_REDIRECT_URI` | No | — | OAuth callback URL |
| `PUPPETEER_EXECUTABLE_PATH` | No | Auto-detect | Path to Chromium/Chrome binary |

---

## 34. User Journey — Getting Started

### Step 1: Create an Account

1. Open the application URL in a browser.
2. Click **Sign Up**.
3. Enter email, password (8+ characters), business name, and owner name.
4. Account is created and you are logged in automatically.

### Step 2: Connect WhatsApp

1. Navigate to **Settings -> WhatsApp Connection**.
2. Click **Connect WhatsApp**.
3. A QR code appears. Open WhatsApp on your phone -> three dots -> Linked Devices -> Link a Device.
4. Scan the QR code.
5. The dashboard shows **"Connected"** with your phone number.

### Step 3: Configure Your Chatbot

1. Navigate to **Settings -> Chatbot**.
2. Enable the chatbot toggle.
3. Set a **Default Reply** (what to send when no rule matches and AI is off).
4. Add keyword rules in **Settings -> Chatbot Rules**: set a trigger keyword, match type, and response text.

### Step 4: Enable AI Replies (Optional)

1. Navigate to **Settings -> AI Behavior**.
2. Toggle **AI Enabled**.
3. Enter your Gemini API key.
4. Choose **AI Mode**: AI First (AI always replies) or Rules First (rules first, AI as fallback).
5. Customize the **System Prompt** to define your AI persona.

---

## 35. User Journey — Setting Up AI Replies

### Configure Business Context (Recommended)

1. **Settings -> Business Profile**: Fill in business name, website, industry, description, target customers, current offers.
2. **Settings -> Products**: Add your product/service catalog with names, prices, descriptions.
3. (Optional) Click **Analyze Business** to generate an AI sales brief.

### Set the AI System Prompt

In **Settings -> AI Behavior -> System Prompt**, write instructions for the AI persona. Example:
```
You are Priya, a friendly customer service representative for TechStore.
Always be warm and helpful. If asked about pricing, check the catalog.
Never promise discounts without mentioning it requires manager approval.
```

### Test Your Setup

1. In **Settings -> Chatbot**, use the **Test Message** box.
2. Type a message and click **Test**.
3. The system shows which rule or AI mode would respond and what the response would be.

### Away Mode

When you do not want any automated replies:
1. Toggle **Away Mode** in Settings.
2. Set your away message.
3. All incoming messages get the away message regardless of other settings.

---

## 36. User Journey — Running an Outreach Campaign

1. Navigate to **Outreach**.
2. **Select Contacts**: Choose from your contacts list (max 25 per campaign).
3. **Write Your Message**: Use `{{name}}` to personalize with the contact's name.
4. **Review the warning**: The product displays a banner reminding you that bulk messaging carries WhatsApp ban risk.
5. Click **Send Campaign**.
6. The dashboard returns immediately with a progress tracker.
7. Watch live progress: sent / failed / skipped counts update as the job runs.
8. The job runs with 3-9 second randomized delays between sends.
9. When complete, review the results showing each contact's outcome.
10. All successful sends appear in the **Messages** tab under each contact's conversation.

### Stopping a Campaign

Click **Cancel** at any time. Already-sent messages are not recalled. The job status changes to `cancelled` and all unsent contacts show as `skipped`.

---

## 37. User Journey — Booking an Appointment via Chat

### Admin Setup

1. Navigate to **Appointments -> Settings**.
2. Set your working days, hours, slot duration, buffer time, and timezone.
3. Toggle **Booking Enabled** to `On`.
4. (Optional) Connect Google Calendar to also block times from existing calendar events.

### Customer Experience (via WhatsApp)

A customer texts your WhatsApp number and expresses interest in booking:

> "Can I book a consultation?"

The AI chatbot detects this intent and calls `check_availability` internally. It replies:

> "Sure! I have openings on Wed 26 Aug at 10:00am or 2:30pm, and Thu 27 Aug at 11:00am. Which works for you?"

Customer responds:

> "Thursday 11am works"

The AI calls `book_appointment` with that slot. Confirms:

> "Done! I've booked your consultation for Thursday, 27 August at 11:00 AM. See you then!"

### Owner Dashboard

1. Navigate to **Appointments**.
2. See all confirmed appointments with contact name, phone, time, and source (chatbot/dashboard).
3. Cancel any appointment — best-effort removes it from Google Calendar.
4. Book walk-in appointments manually from the dashboard using the same slot grid.

---

## 38. Known Design Decisions & Trade-offs

### In-Memory Database (sql.js)

**Decision:** SQLite is loaded entirely into memory and flushed to disk on writes.

**Benefits:** Extremely fast reads (no disk I/O per query); simple single-file deployment; easy backup.

**Trade-offs:** Memory usage grows with data volume; not suitable for multiple write-heavy processes; the entire database must fit in RAM. The debounced disk write means at most ~250ms of writes could be lost on a sudden crash (mitigated by `forcePersist` on graceful shutdown and `assertPersistable` on writes).

---

### Single Server Architecture

**Decision:** The scheduler, outreach jobs, and WhatsApp sessions all run in a single Node.js process.

**Benefits:** Simple deployment; no coordination layer needed; fast inter-service communication.

**Trade-offs:** Cannot scale horizontally without coordination changes; a restart disrupts all in-flight operations.

---

### Per-User Chrome Processes

**Decision:** Each WhatsApp session runs in its own headless Chromium process.

**Benefits:** True session isolation; one crash does not affect others.

**Trade-offs:** High memory per session (~150-250MB); bounded by `MAX_CONCURRENT_WHATSAPP_SESSIONS` (default 5); large deployments need significant RAM.

---

### No Email Verification

**Decision:** Signup does not send a verification email. Accounts are immediately active.

**Benefits:** Zero friction onboarding.

**Trade-offs:** Anyone can sign up with any email address; admin must manually manage account cleanup.

---

### WhatsApp TOS Risk

**Decision:** The product documents the WhatsApp ban risk for outreach but implements throttling to reduce detection.

**Trade-offs:** Bulk messaging violates WhatsApp's Terms of Service. The throttling (3-9s random delays, 25 recipient cap per job) reduces risk but cannot eliminate it. Users are warned in the UI.

---

### Gemini API Key Ownership

**Decision:** Each tenant can provide their own Gemini API key; the platform can also set a global fallback key.

**Trade-offs:** With the global `GEMINI_API_KEY` set, every tenant without their own key spends the operator's quota. Rate limiting per user is the mechanism that prevents any single user from exhausting the shared key.

---

### Appointment Booking Atomicity

**Decision:** Slot booking uses a database `UNIQUE(user_id, start_at)` constraint as the final race guard, not just application-level pre-checks.

**Benefit:** Correct even under concurrent requests (two customers book the same slot simultaneously). The first INSERT wins; the second gets a `SLOT_TAKEN` error.

**Trade-off:** Any Google Calendar event created for the losing booking must be cleaned up — this is done best-effort in `cancelAppointmentEvent`.

---

*End of documentation. All descriptions are sourced directly from the codebase as it existed at the time of this analysis. No code was modified.*
