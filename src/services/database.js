const initSqlJs = require('sql.js');
const fs = require('fs');

// All persistence paths come from one canonical module so every component
// agrees on the same root — the inconsistency between modules was the root
// cause of sessions disappearing after restart when PERSIST_ROOT was unset.
const { DATA_DIR, DB_PATH: dbPath } = require('../config/paths');

// Ensure data directory exists.
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
let db;
// Set once the database has been deliberately closed. Guards against a
// debounced timer resurrecting a stale in-memory image after the file (or the
// whole directory) has been replaced — see stopPersistence().
let closed = false;

// ─── Low-level helpers (sql.js API wrappers) ────────────────

let persistTimer = null;
const PERSIST_DEBOUNCE_MS = 250;

// Persistence health. sql.js keeps the authoritative database in memory and
// mirrors it to disk; if that mirror write starts failing (disk full, the
// volume went read-only, permissions changed) the API would happily keep
// answering 200 while nothing survives a restart. That is exactly the
// "told the user it worked when it didn't" failure mode, so the failure is
// recorded here, surfaced by /health and /api/health, and — for writes that
// go through assertPersistable() — turned into a 503 instead of a false 200.
const persistHealth = {
    ok: true,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    totalFailures: 0
};

function getPersistHealth() {
    return { ...persistHealth };
}

/** Schedule a debounced persist to coalesce rapid writes */
function schedulePersist() {
    if (closed) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        if (closed) return;
        // A throw here would land in a bare timer callback with nobody to
        // catch it — with server.js's process.exit(1) on unhandledRejection
        // that turns a full disk into a restart loop. Record it instead;
        // the next write that calls assertPersistable() will refuse.
        try {
            doPersist();
        } catch (err) {
            console.error('❌ Database persist failed (data is in memory only):', err.message);
        }
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
}

/**
 * Flush the in-memory database to the file on disk.
 *
 * Ordering matters for crash safety:
 *   1. write the full export to <db>.tmp and fsync it, so the bytes are
 *      really on the platter before anything points at them;
 *   2. copy the current good file to <db>.bak (a rollback target);
 *   3. rename .tmp over the live path — atomic within a filesystem, so a
 *      crash at any instant leaves either the old or the new file, never a
 *      half-written one.
 *
 * Without the fsync, a rename can be durable before the data it points to
 * is, which on power loss yields a zero-length or truncated database — the
 * corruption case tests/database.durability.test.js reproduces.
 */
function doPersist() {
    const data = db.export();
    const tmpPath = dbPath + '.tmp';
    const bakPath = dbPath + '.bak';
    try {
        const fd = fs.openSync(tmpPath, 'w');
        try {
            fs.writeFileSync(fd, Buffer.from(data));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, bakPath);
        }
        fs.renameSync(tmpPath, dbPath);
        persistHealth.ok = true;
        persistHealth.consecutiveFailures = 0;
        persistHealth.lastSuccessAt = new Date().toISOString();
        persistHealth.lastError = null;
    } catch (err) {
        persistHealth.ok = false;
        persistHealth.consecutiveFailures++;
        persistHealth.totalFailures++;
        persistHealth.lastError = err.message;
        persistHealth.lastErrorAt = new Date().toISOString();
        // Don't leave a partial temp file behind to confuse the next run.
        try { if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true }); } catch (_) {}
        throw err;
    }
}

/**
 * Throws if the last disk write failed, so a route can return 503 rather
 * than a 200 for something that will vanish on restart. Called by the
 * write paths where losing the row actually matters (messages, scheduled
 * sends, CRM changes) — not by read paths.
 */
function assertPersistable() {
    if (!persistHealth.ok) {
        const err = new Error(
            'The server cannot currently save data to disk, so this change was not accepted. ' +
            'An administrator has been alerted — please retry shortly.'
        );
        err.status = 503;
        err.code = 'DB_PERSIST_FAILED';
        throw err;
    }
}

/** Run a SELECT and return all matching rows as an array of objects */
function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

/** Run a SELECT and return the first matching row (or null) */
function queryGet(sql, params = []) {
    const rows = queryAll(sql, params);
    return rows[0] || null;
}

/** Run an INSERT / UPDATE / DELETE, persist to disk, return { lastId, changes } */
function runSql(sql, params = []) {
    db.run(sql, params);
    // Read lastId/changes BEFORE persist() — db.export() resets last_insert_rowid()
    const lastId = db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] || 0;
    const changes = db.getRowsModified();
    schedulePersist();
    return { lastId, changes };
}

/** Force an immediate synchronous persist (for shutdown/critical ops) */
function forcePersist() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    doPersist();
}

/**
 * Cancels a pending debounced write and stops accepting new ones.
 *
 * Used by shutdown paths and by the test harness. The `closed` flag is the
 * important half: cancelling the current timer is not enough, because any
 * subsequent write on this module instance would schedule a new one, and a
 * stale in-memory database flushing itself over a fresh file is how a test
 * run ends up seeing the previous run's users.
 */
function stopPersistence() {
    closed = true;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
}

/**
 * Runs `fn` inside a real SQLite transaction, rolling back if it throws.
 *
 * sql.js is a single synchronous SQLite instance, so nothing else can
 * interleave while `fn` runs — but a multi-statement operation that throws
 * halfway (a CHECK constraint rejecting the second INSERT, say) would
 * otherwise leave the first statement committed. Any code doing more than
 * one write that must land together goes through this.
 *
 * Persistence happens once, after COMMIT, rather than per statement.
 */
function transaction(fn) {
    db.run('BEGIN');
    let result;
    try {
        result = fn();
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw err;
    }
    db.run('COMMIT');
    schedulePersist();
    return result;
}

// ─── Migration helpers (single-tenant → multi-tenant) ───────
function tableExists(name) {
    return !!queryGet("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]);
}

function tableHasColumn(table, column) {
    const rows = queryAll(`PRAGMA table_info(${table})`);
    return rows.some(r => r.name === column);
}

/**
 * If a table exists from before multi-tenancy (no user_id column), rename it,
 * let the caller create the fresh-schema table, then copy every old row over
 * assigning user_id = 1 (the first person to sign up always gets id 1, since
 * the users table starts empty — so their existing data waits for them).
 */
function migrateLegacyTable(name, copyColumns) {
    if (!tableExists(name) || tableHasColumn(name, 'user_id')) return null;
    return () => {
        const cols = copyColumns.join(', ');
        runSql(`INSERT INTO ${name} (${cols}, user_id) SELECT ${cols}, 1 FROM ${name}_old_pre_multitenant`);
        db.run(`DROP TABLE ${name}_old_pre_multitenant`);
        console.log(`   🔧 Migrated legacy "${name}" data → user_id 1 (first account to sign up inherits it)`);
    };
}

function prepareLegacyRename(name) {
    if (tableExists(name) && !tableHasColumn(name, 'user_id')) {
        db.run(`ALTER TABLE ${name} RENAME TO ${name}_old_pre_multitenant`);
        return true;
    }
    return false;
}

// ─── Versioned migrations ───────────────────────────────────
/**
 * The schema changes above are all `CREATE TABLE IF NOT EXISTS`, which
 * silently does nothing when the table already exists on disk — so adding
 * a column to an existing install needs an explicit ALTER. The old code
 * did that with ad-hoc `if (!tableHasColumn(...))` checks scattered
 * through initDatabase, which gave no record of what had run, no ordering
 * guarantee, and no way to tell a fresh install from an upgraded one.
 *
 * This is a normal versioned migration list instead: each entry runs at
 * most once, in order, inside a transaction, and is recorded in
 * schema_migrations. Every migration must be idempotent on its own too
 * (checking for the column before adding it), so a database that was
 * upgraded by the old ad-hoc code before this table existed doesn't fail
 * on first boot.
 */
const MIGRATIONS = [
    // ── v8: admin-controlled WhatsApp access flag ─────────────────────────
    {
        version: 8,
        name: 'users.wa_enabled: admin-controlled WhatsApp access',
        up: () => {
            if (!tableHasColumn('users', 'wa_enabled')) {
                db.run('ALTER TABLE users ADD COLUMN wa_enabled INTEGER DEFAULT 0');
            }
        }
    },
    // ── v6: calendar event tenant isolation ───────────────────────────────
    // The old schema had `event_id TEXT PRIMARY KEY` — a global uniqueness
    // constraint across all tenants. Google Calendar event IDs are unique
    // per calendar, not globally, so two tenants could share an ID and one
    // would silently lose their calendar import. This rebuilds the table
    // with PRIMARY KEY(user_id, event_id) and copies existing rows.
    {
        version: 6,
        name: 'google_calendar_synced_events: composite PK (user_id, event_id)',
        up: () => {
            const sql = queryGet(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='google_calendar_synced_events'"
            );
            // If the table doesn't exist yet or already has the correct schema, skip.
            if (!sql || /PRIMARY KEY\s*\(user_id,\s*event_id\)/i.test(sql.sql)) return;
            db.run('ALTER TABLE google_calendar_synced_events RENAME TO google_calendar_synced_events_pre_v6');
            db.run(`
                CREATE TABLE google_calendar_synced_events (
                    user_id INTEGER NOT NULL,
                    event_id TEXT NOT NULL,
                    scheduled_message_id INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY(user_id, event_id)
                )
            `);
            db.run(`
                INSERT OR IGNORE INTO google_calendar_synced_events
                    (user_id, event_id, scheduled_message_id, created_at)
                SELECT user_id, event_id, scheduled_message_id, created_at
                FROM google_calendar_synced_events_pre_v6
            `);
            db.run('DROP TABLE google_calendar_synced_events_pre_v6');
        }
    },
    // ── v7: scheduled_messages.status allows 'unknown' ────────────────────
    // A Promise.race timeout on sendTextMessage does NOT cancel the
    // underlying operation. The message may still be delivered after the
    // timeout. Marking it 'failed' is misleading and enables duplicate
    // sends if the operator retries. 'unknown' means "sent but delivery
    // not confirmed" — the correct state for a transport timeout.
    {
        version: 7,
        name: "scheduled_messages.status allows 'unknown'",
        up: () => {
            const sql = queryGet(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_messages'"
            );
            if (!sql || /'unknown'/.test(sql.sql)) return;
            db.run('ALTER TABLE scheduled_messages RENAME TO scheduled_messages_pre_v7');
            db.run(`
                CREATE TABLE scheduled_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    phone TEXT NOT NULL,
                    body TEXT NOT NULL,
                    scheduled_at DATETIME NOT NULL,
                    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown')),
                    error_message TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    sent_at DATETIME
                )
            `);
            db.run(`
                INSERT INTO scheduled_messages
                    (id, user_id, phone, body, scheduled_at, status, error_message, created_at, sent_at)
                SELECT id, user_id, phone, body, scheduled_at, status, error_message, created_at, sent_at
                FROM scheduled_messages_pre_v7
            `);
            db.run('DROP TABLE scheduled_messages_pre_v7');
        }
    },
    // ── v1–v5: original migrations ────────────────────────────────────────
    {
        version: 1,
        name: 'contacts.last_outreach_at',
        up: () => {
            if (!tableHasColumn('contacts', 'last_outreach_at')) {
                db.run('ALTER TABLE contacts ADD COLUMN last_outreach_at DATETIME');
            }
        }
    },
    {
        version: 2,
        name: 'scheduled_messages.status allows sending',
        up: () => {
            // The CHECK constraint on scheduled_messages.status originally
            // permitted only pending/sent/failed/cancelled. Atomic job
            // claiming needs a 'sending' state, and SQLite cannot alter a
            // CHECK constraint in place — the table has to be rebuilt.
            // A fresh install already has the new constraint (see the
            // CREATE TABLE above), so this only fires on an upgrade.
            const sql = queryGet(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_messages'"
            );
            if (!sql || /'sending'/.test(sql.sql)) return;
            db.run('ALTER TABLE scheduled_messages RENAME TO scheduled_messages_pre_v2');
            db.run(`
                CREATE TABLE scheduled_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    phone TEXT NOT NULL,
                    body TEXT NOT NULL,
                    scheduled_at DATETIME NOT NULL,
                    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
                    error_message TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    sent_at DATETIME
                )
            `);
            db.run(`
                INSERT INTO scheduled_messages
                    (id, user_id, phone, body, scheduled_at, status, error_message, created_at, sent_at)
                SELECT id, user_id, phone, body, scheduled_at, status, error_message, created_at, sent_at
                FROM scheduled_messages_pre_v2
            `);
            db.run('DROP TABLE scheduled_messages_pre_v2');
        }
    },
    {
        version: 3,
        name: 'normalize scheduled_at to SQLite-comparable UTC',
        up: () => {
            db.run(`
                UPDATE scheduled_messages
                   SET scheduled_at = replace(replace(scheduled_at, 'T', ' '), 'Z', '')
                 WHERE scheduled_at LIKE '%T%' OR scheduled_at LIKE '%Z'
            `);
        }
    },
    {
        version: 4,
        name: 'strip WhatsApp JID suffixes from stored phone numbers',
        up: () => {
            for (const table of ['contacts', 'messages', 'crm_deals', 'crm_activities', 'lead_analysis', 'scheduled_messages']) {
                if (!tableExists(table)) continue;
                db.run(`
                    UPDATE ${table}
                       SET phone = substr(phone, 1, instr(phone, '@') - 1)
                     WHERE instr(phone, '@') > 1
                `);
            }
        }
    },
    {
        version: 5,
        name: 'unique index for outgoing-message idempotency keys',
        up: () => {
            db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
                ON messages(user_id, wa_message_id)
                WHERE wa_message_id LIKE 'idem:%'
            `);
        }
    },
    {
        version: 9,
        name: 'add payment_link to products and payment_link_sent_at to crm_deals',
        up: () => {
            if (tableExists('products') && !tableHasColumn('products', 'payment_link')) {
                db.run("ALTER TABLE products ADD COLUMN payment_link TEXT DEFAULT ''");
            }
            if (tableExists('crm_deals') && !tableHasColumn('crm_deals', 'payment_link_sent_at')) {
                db.run('ALTER TABLE crm_deals ADD COLUMN payment_link_sent_at DATETIME');
            }
        }
    },
    {
        version: 10,
        name: 'sync existing upi payment links with product price am parameter',
        up: () => {
            if (!tableExists('products')) return;
            const rows = queryAll("SELECT id, name, price, payment_link FROM products WHERE payment_link LIKE 'upi://%'");
            for (const r of rows) {
                const numPrice = String(r.price || '').replace(/[^\d.]/g, '');
                if (numPrice && !isNaN(numPrice) && parseFloat(numPrice) > 0) {
                    const paMatch = r.payment_link.match(/[?&]pa=([^&]+)/);
                    if (paMatch) {
                        const pa = decodeURIComponent(paMatch[1]);
                        const newLink = `upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(r.name)}&cu=INR&tn=${encodeURIComponent(r.name)}&am=${parseFloat(numPrice).toFixed(2)}`;
                        db.run('UPDATE products SET payment_link = ? WHERE id = ?', [newLink, r.id]);
                    }
                }
            }
        }
    },
    {
        version: 11,
        name: 'add document attachment metadata to messages',
        up: () => {
            if (!tableExists('messages')) return;
            if (!tableHasColumn('messages', 'attachment_name')) db.run("ALTER TABLE messages ADD COLUMN attachment_name TEXT");
            if (!tableHasColumn('messages', 'attachment_mime')) db.run("ALTER TABLE messages ADD COLUMN attachment_mime TEXT");
            if (!tableHasColumn('messages', 'attachment_ref')) db.run("ALTER TABLE messages ADD COLUMN attachment_ref TEXT");
        }
    },
    {
        version: 12,
        name: 'users.business_vertical: account business vertical',
        up: () => {
            if (!tableHasColumn('users', 'business_vertical')) {
                db.run("ALTER TABLE users ADD COLUMN business_vertical TEXT NOT NULL DEFAULT 'general' CHECK(business_vertical IN ('general', 'healthcare'))");
            }
        }
    }
];

function ensureMigrationsTable() {
    db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

function getAppliedMigrations() {
    ensureMigrationsTable();
    return new Set(queryAll('SELECT version FROM schema_migrations').map(r => r.version));
}

/**
 * Applies every migration not yet recorded, in version order.
 *
 * A failing migration throws, which initDatabase() lets propagate so the
 * process refuses to start: running the app against a half-migrated schema
 * produces wrong answers rather than obvious errors, which is worse than
 * downtime. Each migration is wrapped in a transaction so a failure part
 * way through one leaves the schema as it was.
 */
function runMigrations() {
    const applied = getAppliedMigrations();
    const pending = MIGRATIONS.filter(m => !applied.has(m.version)).sort((a, b) => a.version - b.version);
    if (pending.length === 0) return [];

    const ran = [];
    for (const migration of pending) {
        try {
            db.run('BEGIN');
            migration.up();
            db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [migration.version, migration.name]);
            db.run('COMMIT');
            ran.push(migration.version);
            console.log(`   🧱 Migration ${migration.version} applied: ${migration.name}`);
        } catch (err) {
            try { db.run('ROLLBACK'); } catch (_) {}
            const wrapped = new Error(
                `Migration ${migration.version} (${migration.name}) failed: ${err.message}. ` +
                `Refusing to start against a partially migrated database.`
            );
            wrapped.code = 'MIGRATION_FAILED';
            throw wrapped;
        }
    }
    return ran;
}

function getSchemaVersion() {
    ensureMigrationsTable();
    const row = queryGet('SELECT MAX(version) as v FROM schema_migrations');
    return row && row.v ? row.v : 0;
}

// ─── Initialize Database ────────────────────────────────────
/**
 * Opens the database file, or refuses to start.
 *
 * The important case is a corrupted/truncated whatsapp.db. sql.js throws
 * when handed bytes that aren't a valid SQLite image, and the tempting
 * recovery — `catch { db = new SQL.Database() }` — is the worst possible
 * one: the process comes up looking perfectly healthy with zero users, the
 * first signup takes id 1 and inherits nothing, and the next successful
 * persist overwrites the damaged-but-recoverable file with the empty one.
 * That is silent, permanent, total data loss for every tenant.
 *
 * So: try the live file, then the .bak snapshot doPersist() maintains, and
 * if neither opens, quarantine the bad file and throw. A server that won't
 * start is a page at 3am; a server that starts empty is a restore from
 * whatever backup exists, if any.
 */
function openDatabaseFile(SQL) {
    if (!fs.existsSync(dbPath)) {
        console.log('   🆕 No existing database file — creating a fresh one.');
        return new SQL.Database();
    }

    const attempts = [
        { label: 'primary', file: dbPath },
        { label: 'backup', file: dbPath + '.bak' }
    ];

    let firstError = null;
    for (const attempt of attempts) {
        if (!fs.existsSync(attempt.file)) continue;
        try {
            const buffer = fs.readFileSync(attempt.file);
            if (buffer.length === 0) throw new Error('database file is empty (0 bytes)');
            const candidate = new SQL.Database(buffer);
            // Opening alone doesn't prove the pages are readable — sql.js
            // parses lazily. Force a real read so a truncated file fails
            // here rather than on the first user query.
            candidate.exec('PRAGMA quick_check');
            candidate.exec("SELECT name FROM sqlite_master WHERE type='table'");
            if (attempt.label === 'backup') {
                console.warn('⚠️ Primary database was unreadable — recovered from data/whatsapp.db.bak.');
                quarantineFile(dbPath);
            }
            return candidate;
        } catch (err) {
            if (!firstError) firstError = err;
            console.error(`❌ Could not open ${attempt.label} database (${attempt.file}): ${err.message}`);
        }
    }

    const quarantined = quarantineFile(dbPath);
    const err = new Error(
        `Database file at ${dbPath} is corrupt and the .bak snapshot could not be used either ` +
        `(${firstError ? firstError.message : 'unknown error'}). ` +
        `The damaged file has been moved to ${quarantined || 'a .corrupt-* file'} — restore a backup ` +
        `(see scripts/backup-db.sh) and restart. Refusing to start with an empty database, ` +
        `which would look healthy while every tenant's data was gone.`
    );
    err.code = 'DB_CORRUPT';
    throw err;
}

/** Moves a bad database file aside (never deletes it) so it can be examined. */
function quarantineFile(file) {
    try {
        if (!fs.existsSync(file)) return null;
        const dest = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, dest);
        return dest;
    } catch (e) {
        console.error('   ⚠️ Could not quarantine the damaged database file:', e.message);
        return null;
    }
}

async function initDatabase() {
    const SQL = await initSqlJs();

    // A fresh init reopens the file, so this instance is live again.
    closed = false;

    db = openDatabaseFile(SQL);

    db.run("PRAGMA foreign_keys = ON");

    // ── Rename any pre-multi-tenant tables out of the way first ──
    const legacyTables = ['contacts', 'messages', 'chatbot_rules', 'scheduled_messages', 'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis'];
    const legacyFlags = {};
    for (const t of legacyTables) legacyFlags[t] = prepareLegacyRename(t);

    // ── Users (accounts / tenants) ────────────────────────────
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            business_name TEXT DEFAULT '',
            owner_name TEXT DEFAULT '',
            business_vertical TEXT NOT NULL DEFAULT 'general' CHECK(business_vertical IN ('general', 'healthcare')),
            role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
            plan TEXT DEFAULT 'free',
            message_limit INTEGER DEFAULT 0,
            rule_limit INTEGER DEFAULT 0,
            wa_enabled INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login_at DATETIME
        )
    `);

    // ── Tenant tables ──────────────────────────────────────────
    db.run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            name TEXT DEFAULT '',
            label TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, phone)
        )
    `);
    // `last_outreach_at` is added by migration 1 (see MIGRATIONS above)
    // rather than inline here, so that upgrading an existing install is
    // recorded in schema_migrations instead of being invisible.

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            wa_message_id TEXT,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
            message_type TEXT DEFAULT 'text',
            body TEXT DEFAULT '',
            status TEXT DEFAULT 'sent',
            template_name TEXT,
            attachment_name TEXT,
            attachment_mime TEXT,
            attachment_ref TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS chatbot_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            trigger_keyword TEXT NOT NULL,
            match_type TEXT DEFAULT 'contains' CHECK(match_type IN ('exact', 'contains', 'startswith', 'regex')),
            response_text TEXT NOT NULL,
            priority INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            hit_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            body TEXT NOT NULL,
            scheduled_at DATETIME NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_at DATETIME
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            price TEXT DEFAULT '',
            category TEXT DEFAULT '',
            url TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS crm_deals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            stage TEXT DEFAULT 'new' CHECK(stage IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
            deal_value REAL DEFAULT 0,
            product_interest TEXT DEFAULT '',
            source TEXT DEFAULT 'whatsapp',
            notes TEXT DEFAULT '',
            next_followup_at DATETIME,
            ai_suggested_stage TEXT DEFAULT '',
            ai_estimated_value REAL DEFAULT 0,
            stage_changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, phone)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS crm_activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            type TEXT DEFAULT 'note',
            content TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS lead_analysis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            interest_status TEXT DEFAULT 'unclear' CHECK(interest_status IN ('interested', 'not_interested', 'neutral', 'unclear')),
            interest_score INTEGER DEFAULT 0,
            sentiment TEXT DEFAULT 'neutral',
            issue_category TEXT DEFAULT '',
            issues TEXT DEFAULT '[]',
            priority TEXT DEFAULT 'low' CHECK(priority IN ('high', 'medium', 'low')),
            priority_reason TEXT DEFAULT '',
            next_action TEXT DEFAULT '',
            message_count INTEGER DEFAULT 0,
            last_analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, phone)
        )
    `);

    // ── Google Calendar integration ─────────────────────────────
    // One row per connected account. Tokens are stored as-is (this project
    // has no field-level encryption layer for the SQLite file already, same
    // as the WhatsApp session cookie secret and Gemini key stored in
    // `settings`) — protecting them is the job of protecting data/whatsapp.db
    // itself (filesystem permissions, backups) rather than the app layer.
    // New table, so a plain CREATE TABLE IF NOT EXISTS is enough for both a
    // fresh install and an upgrade — no ALTER-based migration needed.
    db.run(`
        CREATE TABLE IF NOT EXISTS google_calendar_accounts (
            user_id INTEGER PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            token_type TEXT,
            expiry_date INTEGER,
            calendar_id TEXT DEFAULT 'primary',
            check_availability INTEGER DEFAULT 0,
            connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_sync_at DATETIME
        )
    `);

    // Records which Google Calendar events have already been turned into a
    // scheduled_messages row, so a sync tick that runs every few minutes
    // over a rolling look-ahead window doesn't re-import the same event
    // twice as the same event keeps showing up in each poll.
    //
    // IMPORTANT: PRIMARY KEY is (user_id, event_id), NOT event_id alone.
    // Google Calendar event IDs are unique per-calendar, not globally —
    // two tenants sharing an event ID is not hypothetical (Google reuses
    // short IDs). An event_id-only PK causes one tenant's mark to be seen
    // by another tenant as already synced, silently preventing their event
    // from firing. Migration v6 rebuilds this table if it has the old schema.
    db.run(`
        CREATE TABLE IF NOT EXISTS google_calendar_synced_events (
            user_id INTEGER NOT NULL,
            event_id TEXT NOT NULL,
            scheduled_message_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(user_id, event_id)
        )
    `);

    // ── Appointment booking ─────────────────────────────────────
    // One row per account: the weekly working-hours template the "book an
    // appointment" chatbot flow (and the dashboard's own manual-booking
    // form) generates candidate slots from. A missing row means "use the
    // built-in defaults" (see services/availability.js) rather than
    // "booking is broken" — a fresh account should be bookable immediately.
    db.run(`
        CREATE TABLE IF NOT EXISTS availability_settings (
            user_id INTEGER PRIMARY KEY,
            working_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
            start_time TEXT NOT NULL DEFAULT '09:00',
            end_time TEXT NOT NULL DEFAULT '18:00',
            slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
            buffer_minutes INTEGER NOT NULL DEFAULT 0,
            timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
            booking_enabled INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Every booked appointment, whether made by the chatbot on a customer's
    // behalf or by the owner from the dashboard. This is the source of
    // truth for "is this slot free" even when Google Calendar isn't
    // connected — the calendar sync (calendar_event_id) is a best-effort
    // mirror on top, never a dependency.
    db.run(`
        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            start_at DATETIME NOT NULL,
            end_at DATETIME NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled')),
            source TEXT NOT NULL DEFAULT 'chatbot' CHECK(source IN ('chatbot', 'dashboard')),
            notes TEXT DEFAULT '',
            calendar_event_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ── Copy legacy rows into the fresh tables (user_id = 1) ────
    const legacyCopyColumns = {
        contacts: ['phone', 'name', 'label', 'notes', 'created_at', 'updated_at'],
        messages: ['wa_message_id', 'phone', 'contact_name', 'direction', 'message_type', 'body', 'status', 'template_name', 'created_at'],
        chatbot_rules: ['trigger_keyword', 'match_type', 'response_text', 'priority', 'is_active', 'hit_count', 'created_at', 'updated_at'],
        scheduled_messages: ['phone', 'body', 'scheduled_at', 'status', 'error_message', 'created_at', 'sent_at'],
        settings: ['key', 'value'],
        products: ['name', 'description', 'price', 'category', 'url', 'is_active', 'created_at', 'updated_at'],
        crm_deals: ['phone', 'contact_name', 'stage', 'deal_value', 'product_interest', 'source', 'notes', 'next_followup_at', 'ai_suggested_stage', 'ai_estimated_value', 'stage_changed_at', 'created_at', 'updated_at'],
        crm_activities: ['phone', 'type', 'content', 'created_at'],
        lead_analysis: ['phone', 'contact_name', 'summary', 'interest_status', 'interest_score', 'sentiment', 'issue_category', 'issues', 'priority', 'priority_reason', 'next_action', 'message_count', 'last_analyzed_at', 'created_at']
    };
    for (const t of legacyTables) {
        if (legacyFlags[t]) {
            const cols = legacyCopyColumns[t].join(', ');
            runSql(`INSERT INTO ${t} (${cols}, user_id) SELECT ${cols}, 1 FROM ${t}_old_pre_multitenant`);
            db.run(`DROP TABLE ${t}_old_pre_multitenant`);
            console.log(`   🔧 Migrated legacy "${t}" data → user_id 1 (first account to sign up inherits it)`);
        }
    }

    // ── Versioned migrations ───────────────────────────────────
    runMigrations();

    // ── Indexes ────────────────────────────────────────────────
    // CREATE INDEX IF NOT EXISTS is safe to repeat on every boot.
    //
    // Every one of these leads with user_id because every query in this
    // file is tenant-scoped — an index on (created_at) alone can't answer
    // "this tenant's recent messages" without scanning other tenants' rows,
    // which is both slower and gets worse as unrelated customers sign up.
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_phone ON messages(user_id, phone)");
    // Composite (user_id, created_at) serves the dashboard's "recent
    // messages", the per-day aggregations, and the monthly outgoing count.
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_dir_created ON messages(user_id, direction, created_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_scheduled_user_status ON scheduled_messages(user_id, status, scheduled_at)");
    // The scheduler's due-jobs query filters by status across ALL tenants,
    // so this one is intentionally not user-scoped.
    db.run("CREATE INDEX IF NOT EXISTS idx_scheduled_status_at ON scheduled_messages(status, scheduled_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_user_updated ON contacts(user_id, updated_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_chatbot_rules_user ON chatbot_rules(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_chatbot_rules_user_active ON chatbot_rules(user_id, is_active, priority)");
    db.run("CREATE INDEX IF NOT EXISTS idx_lead_analysis_user_phone ON lead_analysis(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_lead_analysis_priority ON lead_analysis(user_id, priority)");
    db.run("CREATE INDEX IF NOT EXISTS idx_crm_deals_user_phone ON crm_deals(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_crm_deals_user_stage ON crm_deals(user_id, stage)");
    db.run("CREATE INDEX IF NOT EXISTS idx_crm_activities_user_phone ON crm_activities(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appointments_user_start ON appointments(user_id, start_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_appointments_user_status ON appointments(user_id, status)");

    // Provision the bootstrap admin on every boot. Idempotent: if the
    // account already exists and already has role='admin', this is a no-op.
    // Must be called after all migrations have run so the users table is
    // guaranteed to exist with the current schema.
    ensureBootstrapAdmin();

    forcePersist();
    return db;
}

// ─── Getter ─────────────────────────────────────────────────
function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}

// ─── Default per-user settings ──────────────────────────────
const DEFAULT_SETTINGS = {
    chatbot_enabled: 'true',
    default_reply: 'Thank you for your message! I will get back to you shortly. 🙏',
    business_name: '',
    owner_name: '',
    ai_mode: 'ai_first',
    away_message: 'I am currently away from my phone right now. I will catch up and reply to you as soon as I am back!',
    away_mode: 'false',
    ai_enabled: 'true',
    ai_system_prompt: 'You are an intelligent AI replying on WhatsApp on behalf of your owner.\n\nGuidelines:\n- Talk naturally, casually, and helpfully just like a real person chatting on WhatsApp.\n- Keep replies brief (1-3 sentences max) and conversational.\n- Do NOT sound like a rigid corporate robot.\n- If asked personal questions or specific plans you don\'t know, politely say you\'ll pass the message to the owner.',
    gemini_api_key: '',
    business_website: '',
    business_description: '',
    business_industry: '',
    business_target_customers: '',
    business_offers: '',
    business_currency: '₹',
    business_ai_profile: ''
};

function ensureDefaultSettings(userId) {
    const existing = queryAll('SELECT key FROM settings WHERE user_id = ?', [userId]);
    if (existing.length > 0) return; // already has settings (fresh signup or migrated legacy user)
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        db.run('INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)', [userId, key, value]);
    }
    forcePersist();
}

// ─── User / Account Helpers ─────────────────────────────────
function getUserByEmail(email) {
    return queryGet('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
}

function getUserById(id) {
    return queryGet('SELECT * FROM users WHERE id = ?', [id]);
}

function countUsers() {
    return queryGet('SELECT COUNT(*) as count FROM users').count;
}

/**
 * Creates a new account. Role is always 'user' regardless of how many
 * accounts exist — the old "first signup becomes admin" behaviour was a
 * security vulnerability: any database reset allowed an attacker who signed
 * up first to claim admin access. Admin promotion is now exclusively via
 * ensureBootstrapAdmin() (BOOTSTRAP_ADMIN_EMAIL env var, called on boot)
 * or via the admin panel (an existing admin promoting another account).
 */
function createUser({ email, passwordHash, businessName = '', ownerName = '' }) {
    const normalizedEmail = String(email).trim().toLowerCase();
    return transaction(() => {
        db.run(
            `INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan)
             VALUES (?, ?, ?, ?, 'user', 'active', 'free')`,
            [normalizedEmail, passwordHash, businessName, ownerName]
        );
        const lastId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || 0;
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            db.run('INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)', [lastId, key, value]);
        }
        return getUserById(lastId);
    });
}

/**
 * Promotes or creates the designated bootstrap admin account.
 *
 * Called once from initDatabase() — never from a signup route.
 *
 * If BOOTSTRAP_ADMIN_EMAIL is set:
 *   - If that account already exists with role 'admin', do nothing.
 *   - If that account exists with role 'user', promote it. This handles the
 *     case where an admin re-deploys and the existing account needs to be
 *     elevated back, without wiping data.
 *   - If the account does not exist, create it with a random placeholder
 *     password and role 'admin'. The operator must change the password
 *     via the change-password API or by setting a known hash directly.
 *
 * The env var is checked at boot so its value is the source of truth
 * rather than whatever state the database happens to be in.
 */
function ensureBootstrapAdmin() {
    const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
    if (!bootstrapEmail) return; // not configured — nothing to do

    const existing = getUserByEmail(bootstrapEmail);
    if (existing) {
        if (existing.role !== 'admin') {
            runSql('UPDATE users SET role = \'admin\' WHERE id = ?', [existing.id]);
            console.log(`[bootstrap] Promoted ${bootstrapEmail} to admin (id=${existing.id}).`);
        }
        return;
    }

    // Account doesn't exist yet — create it with an unusable placeholder
    // password (60 random bytes, never a valid bcrypt hash). The operator
    // must set a real password before the account is useful.
    const { randomBytes } = require('crypto');
    const placeholder = '$bootstrap$' + randomBytes(30).toString('hex');
    transaction(() => {
        db.run(
            `INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan)
             VALUES (?, ?, 'Admin', 'Admin', 'admin', 'active', 'free')`,
            [bootstrapEmail, placeholder]
        );
        const lastId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || 0;
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            db.run('INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)', [lastId, key, value]);
        }
    });
    console.log(`[bootstrap] Created admin account for ${bootstrapEmail}. ` +
        `Set a password via the change-password API or by updating the password_hash directly.`);
}

/** True if an error from createUser is the UNIQUE(email) collision (→ HTTP 409, not 500). */
function isDuplicateEmailError(err) {
    const msg = String(err && err.message || '');
    return /UNIQUE constraint failed: users\.email/i.test(msg);
}

function touchLastLogin(id) {
    return runSql('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

function listUsers() {
    return queryAll('SELECT id, email, business_name, owner_name, business_vertical, role, status, plan, message_limit, rule_limit, wa_enabled, created_at, last_login_at FROM users ORDER BY created_at DESC');
}

function updateUser(id, fields) {
    const allowed = ['business_name', 'owner_name', 'status', 'plan', 'message_limit', 'rule_limit', 'role', 'password_hash', 'wa_enabled', 'business_vertical'];
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            sets.push(`${key} = ?`);
            params.push(value);
        }
    }
    if (sets.length === 0) return getUserById(id);
    params.push(id);
    runSql(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    return getUserById(id);
}

/**
 * Wipes every row belonging to a user across all tenant tables, then the
 * user itself — in one transaction.
 *
 * Without the transaction, a failure partway through (a disk error, a
 * constraint) left the account row deleted but its messages/contacts/deals
 * orphaned under a user_id nobody owns: invisible to the UI, still counted
 * in platform stats, and inherited by whoever eventually gets that id back.
 * All-or-nothing is the only correct behaviour here.
 */
function deleteUserCascade(id) {
    // IMPORTANT: google_calendar_accounts and google_calendar_synced_events
    // MUST be included — they hold OAuth access/refresh tokens. Omitting
    // them means deleting a user leaves their Google credentials in the DB.
    const tables = [
        'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
        'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
        'appointments', 'availability_settings',
        'google_calendar_synced_events', 'google_calendar_accounts'
    ];
    return transaction(() => {
        for (const t of tables) {
            db.run(`DELETE FROM ${t} WHERE user_id = ?`, [id]);
        }
        db.run('DELETE FROM users WHERE id = ?', [id]);
        return { changes: db.getRowsModified() };
    });
}

/** Rows still referencing a user id — used by tests to prove no orphans remain. */
function countOrphanedRows(userId) {
    const tables = [
        'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
        'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
        'appointments', 'availability_settings',
        'google_calendar_synced_events', 'google_calendar_accounts'
    ];
    let total = 0;
    const byTable = {};
    for (const t of tables) {
        const n = queryGet(`SELECT COUNT(*) as count FROM ${t} WHERE user_id = ?`, [userId]).count;
        byTable[t] = n;
        total += n;
    }
    return { total, byTable };
}

/**
 * Deletes only the account row (email/password/role) and leaves every other
 * table untouched — used by the reset-accounts.js maintenance script when
 * the operator wants a fresh set of logins without losing existing tenant
 * data (it just becomes orphaned until reassigned). Not used by any API route.
 */
function deleteUserAccountOnly(id) {
    return runSql('DELETE FROM users WHERE id = ?', [id]);
}

function getUserStats(userId) {
    const messages     = queryGet('SELECT COUNT(*) as count FROM messages WHERE user_id = ?', [userId]).count;
    const messagesThisMonth = queryGet(
        "SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND direction = 'outgoing' AND created_at >= datetime('now', 'start of month')",
        [userId]
    ).count;
    const contacts      = queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = ?', [userId]).count;
    const leads         = queryGet('SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = ?', [userId]).count;
    const activeRules   = queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = ? AND is_active = 1', [userId]).count;
    const openDeals     = queryGet(`SELECT COUNT(*) as count FROM crm_deals WHERE user_id = ? AND stage IN ('new','contacted','qualified','proposal','negotiation')`, [userId]).count;
    const pipelineValue = queryGet(`SELECT COALESCE(SUM(deal_value),0) as total FROM crm_deals WHERE user_id = ? AND stage IN ('new','contacted','qualified','proposal','negotiation')`, [userId]).total;
    return { messages, messagesThisMonth, contacts, leads, activeRules, openDeals, pipelineValue };
}

function getPlatformStats() {
    const totalUsers     = queryGet('SELECT COUNT(*) as count FROM users').count;
    const activeUsers    = queryGet("SELECT COUNT(*) as count FROM users WHERE status = 'active'").count;
    const suspendedUsers = queryGet("SELECT COUNT(*) as count FROM users WHERE status = 'suspended'").count;
    const totalMessages  = queryGet('SELECT COUNT(*) as count FROM messages').count;
    const totalContacts  = queryGet('SELECT COUNT(*) as count FROM contacts').count;
    const totalDeals     = queryGet('SELECT COUNT(*) as count FROM crm_deals').count;
    const signupsByDay = queryAll(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM users
        WHERE created_at >= datetime('now', '-30 days')
        GROUP BY date(created_at)
        ORDER BY day ASC
    `);
    return { totalUsers, activeUsers, suspendedUsers, totalMessages, totalContacts, totalDeals, signupsByDay };
}

/** Outgoing messages sent this calendar month — used to enforce plan limits. */
function getMonthlyOutgoingCount(userId) {
    return queryGet(
        "SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND direction = 'outgoing' AND created_at >= datetime('now', 'start of month')",
        [userId]
    ).count;
}

// ─── Contact Helpers ────────────────────────────────────────
function getContacts(userId, search = '', label = '', { limit = null, offset = 0 } = {}) {
    let sql = 'SELECT * FROM contacts WHERE user_id = ?';
    const params = [userId];
    if (search) {
        // LIKE with the user's text as a *bound parameter* — the % wrappers
        // are ours, so a search for "100%" or "_" is matched as a wildcard
        // but can never alter the statement itself.
        sql += ' AND (name LIKE ? OR phone LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    if (label) {
        sql += ' AND label = ?';
        params.push(label);
    }
    sql += ' ORDER BY updated_at DESC';
    if (limit !== null) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);
    }
    return queryAll(sql, params);
}

function countContacts(userId) {
    return queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = ?', [userId]).count;
}

function getContactByPhone(userId, phone) {
    return queryGet('SELECT * FROM contacts WHERE user_id = ? AND phone = ?', [userId, phone]);
}

/**
 * Fetches contacts by id, scoped to one user — used by bulk outreach to
 * resolve a selection.
 *
 * The ids are coerced to integers here and the count is bounded, because
 * this builds an IN (?,?,?…) list: an array of 100k ids from a malicious
 * client would otherwise construct a 100k-placeholder SQL string and hand
 * it to the parser. Non-numeric entries are dropped rather than bound,
 * since a bound non-integer silently matches nothing anyway.
 */
function getContactsByIds(userId, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const clean = [];
    for (const raw of ids) {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (Number.isSafeInteger(n) && n > 0) clean.push(n);
        if (clean.length >= 1000) break; // hard bound on statement size
    }
    if (clean.length === 0) return [];
    const unique = [...new Set(clean)];
    const placeholders = unique.map(() => '?').join(',');
    return queryAll(`SELECT * FROM contacts WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...unique]);
}

function upsertContact(userId, phone, name = '', label = '', notes = '') {
    const existing = getContactByPhone(userId, phone);
    if (existing) {
        runSql(
            `UPDATE contacts SET
                name  = COALESCE(NULLIF(?, ''), name),
                label = COALESCE(NULLIF(?, ''), label),
                notes = COALESCE(NULLIF(?, ''), notes),
                updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND phone = ?`,
            [name, label, notes, userId, phone]
        );
        return getContactByPhone(userId, phone);
    } else {
        const { lastId } = runSql(
            'INSERT INTO contacts (user_id, phone, name, label, notes) VALUES (?, ?, ?, ?, ?)',
            [userId, phone, name, label, notes]
        );
        return { id: lastId, phone, name, label, notes };
    }
}

function deleteContact(userId, id) {
    return runSql('DELETE FROM contacts WHERE user_id = ? AND id = ?', [userId, id]);
}

/**
 * Stamps a contact as having received a bulk outreach send just now. Called
 * once per successful send from the outreach job (src/outreach.js) — not
 * batched like bulkUpsertContacts, because outreach sends are already
 * throttled several seconds apart, so one extra persist() per send is free
 * compared to the send itself, and marking in real time (rather than at the
 * very end of the whole job) means the "Reached" column in the UI updates
 * correctly even if the job gets interrupted partway through.
 */
function markContactOutreached(userId, phone) {
    return runSql(
        'UPDATE contacts SET last_outreach_at = CURRENT_TIMESTAMP WHERE user_id = ? AND phone = ?',
        [userId, phone]
    );
}

/**
 * Bulk-upsert contacts (CSV import). Deliberately NOT a loop of upsertContact
 * calls: upsertContact goes through runSql, which calls persist() after every
 * single statement — and persist() does a full db.export() of the *entire*
 * database, not just the contacts table. For a one-row add that's invisible;
 * for a several-hundred-row CSV import it means exporting and rewriting the
 * whole (and growing, as messages accumulate) database file hundreds of
 * times in a row. This runs every row against `db` directly inside one
 * transaction and persists once at the end — same dedup-by-phone behavior
 * as upsertContact, one disk write instead of N.
 *
 * Three correctness details beyond the batching:
 *
 *  - Phone numbers go through validate.normalizePhone, the same function
 *    the API and the send path use. The old inline `replace(/[^\d]/g,'')`
 *    accepted "abc123456789" (letters silently stripped) and anything up
 *    to any length, so an import could create contacts the send path would
 *    then reject — or, worse, addresses it wouldn't.
 *  - Text fields are run through sanitizeSpreadsheetCell, so a name like
 *    `=HYPERLINK(...)` can't execute when the owner later exports their
 *    contacts and opens the file in Excel.
 *  - The per-tenant contact cap is enforced against the *current* row
 *    count, so repeated imports can't be used to grow one tenant's data
 *    without bound in a database every other tenant shares.
 *
 * `rows` is an array of { phone, name, label, notes } (all strings; phone
 * required). Returns { imported, updated, skipped, errors: [{row, reason}] }
 * — row is the 1-based position in the input array, not counting a header.
 */
function bulkUpsertContacts(userId, rows) {
    const { tryNormalizePhone, sanitizeSpreadsheetCell, LIMITS } = require('../utils/validate');
    let imported = 0, updated = 0, skipped = 0;
    const errors = [];
    const pushError = (row, reason) => {
        // Cap the error list: a 5000-row file of bad numbers would otherwise
        // produce a 5000-entry JSON response.
        if (errors.length < 100) errors.push({ row, reason });
    };

    return transaction(() => {
        let existingCount = countContacts(userId);
        const seenInThisFile = new Set();

        rows.forEach((r, idx) => {
            const rowNum = idx + 1;
            const rawPhone = (r.phone === undefined || r.phone === null) ? '' : String(r.phone).trim();
            if (!rawPhone) {
                skipped++;
                pushError(rowNum, 'Missing phone number');
                return;
            }

            const cleanPhone = tryNormalizePhone(rawPhone);
            if (!cleanPhone) {
                skipped++;
                pushError(rowNum, `"${rawPhone.slice(0, 40)}" is not a valid phone number`);
                return;
            }

            // Duplicate rows inside one file shouldn't count twice toward
            // the cap, nor produce two UPDATEs for the same contact.
            const isRepeatInFile = seenInThisFile.has(cleanPhone);
            seenInThisFile.add(cleanPhone);

            const name  = sanitizeSpreadsheetCell(String(r.name  ?? '').trim().slice(0, LIMITS.CONTACT_NAME));
            const label = sanitizeSpreadsheetCell(String(r.label ?? '').trim().slice(0, LIMITS.CONTACT_LABEL));
            const notes = sanitizeSpreadsheetCell(String(r.notes ?? '').trim().slice(0, LIMITS.CONTACT_NOTES));

            const existing = getContactByPhone(userId, cleanPhone);
            if (existing) {
                db.run(
                    `UPDATE contacts SET
                        name  = COALESCE(NULLIF(?, ''), name),
                        label = COALESCE(NULLIF(?, ''), label),
                        notes = COALESCE(NULLIF(?, ''), notes),
                        updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND phone = ?`,
                    [name, label, notes, userId, cleanPhone]
                );
                if (!isRepeatInFile) updated++;
            } else {
                if (existingCount >= LIMITS.MAX_CONTACTS_PER_USER) {
                    skipped++;
                    pushError(rowNum, `Contact limit reached (${LIMITS.MAX_CONTACTS_PER_USER}). Delete some contacts first.`);
                    return;
                }
                db.run(
                    'INSERT INTO contacts (user_id, phone, name, label, notes) VALUES (?, ?, ?, ?, ?)',
                    [userId, cleanPhone, name, label, notes]
                );
                existingCount++;
                imported++;
            }
        });

        return { imported, updated, skipped, errors, total: rows.length };
    });
}

// ─── Message Helpers ────────────────────────────────────────
function logMessage(userId, { waMessageId, phone, contactName, direction, messageType, body, status, templateName, attachmentName, attachmentMime, attachmentRef }) {
    return runSql(
        `INSERT INTO messages (user_id, wa_message_id, phone, contact_name, direction, message_type, body, status, template_name, attachment_name, attachment_mime, attachment_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, waMessageId || null, phone, contactName || '', direction, messageType || 'text', body || '', status || 'sent', templateName || null, attachmentName || null, attachmentMime || null, attachmentRef || null]
    );
}

/**
 * Records an outgoing message exactly once per (user, idempotency key).
 *
 * The problem this solves is a distributed-systems one, not a UI one: the
 * browser sends POST /messages/send, WhatsApp accepts the message, and the
 * HTTP response is lost (proxy timeout, laptop lid closed, mobile network
 * hiccup). Any retry — the user pressing Send again, a fetch retry, a
 * double click that beat the disabled-button — reaches a server with no way
 * to know it already did the work, so the recipient gets the message twice
 * and the log shows two rows.
 *
 * A client-supplied key makes the write idempotent: the UNIQUE index on
 * (user_id, wa_message_id) turns the second attempt into a no-op, and the
 * route can return the original result instead of sending again. Keys are
 * namespaced with 'idem:' so they can never collide with a real WhatsApp
 * message id stored in the same column.
 *
 * Returns { created: boolean, row } — created=false means this exact
 * request was already processed.
 */
function logOutgoingMessageIdempotent(userId, idempotencyKey, fields) {
    const key = `idem:${idempotencyKey}`;
    const existing = queryGet(
        'SELECT * FROM messages WHERE user_id = ? AND wa_message_id = ?',
        [userId, key]
    );
    if (existing) return { created: false, row: existing };
    try {
        const { lastId } = runSql(
            `INSERT INTO messages (user_id, wa_message_id, phone, contact_name, direction, message_type, body, status, template_name, attachment_name, attachment_mime, attachment_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId, key, fields.phone, fields.contactName || '',
                fields.direction || 'outgoing', fields.messageType || 'text',
                fields.body || '', fields.status || 'sent', fields.templateName || null,
                fields.attachmentName || null, fields.attachmentMime || null, fields.attachmentRef || null
            ]
        );
        return { created: true, row: queryGet('SELECT * FROM messages WHERE id = ?', [lastId]) };
    } catch (err) {
        // Lost the race against a concurrent identical request — the other
        // one won, so treat this as a duplicate rather than an error.
        if (/UNIQUE constraint failed/i.test(String(err.message))) {
            const row = queryGet('SELECT * FROM messages WHERE user_id = ? AND wa_message_id = ?', [userId, key]);
            if (row) return { created: false, row };
        }
        throw err;
    }
}

/** True if this (user, idempotency key) has already been recorded. */
function findMessageByIdempotencyKey(userId, idempotencyKey) {
    return queryGet(
        'SELECT * FROM messages WHERE user_id = ? AND wa_message_id = ?',
        [userId, `idem:${idempotencyKey}`]
    );
}

/** Permanently deletes every logged message for one account (Danger Zone → Clear Message History). */
function clearMessages(userId) {
    return runSql('DELETE FROM messages WHERE user_id = ?', [userId]);
}

function getMessages(userId, { phone, direction, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM messages WHERE user_id = ?';
    const params = [userId];
    if (phone) {
        sql += ' AND phone = ?';
        params.push(phone);
    }
    if (direction) {
        sql += ' AND direction = ?';
        params.push(direction);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return queryAll(sql, params);
}

function getDocumentMessageByRef(userId, reference) {
    return queryGet(
        "SELECT * FROM messages WHERE user_id = ? AND attachment_ref = ? AND message_type = 'document' AND status = 'sent'",
        [userId, reference]
    );
}

function countMessages(userId, { phone, direction } = {}) {
    let sql = 'SELECT COUNT(*) as count FROM messages WHERE user_id = ?';
    const params = [userId];
    if (phone)     { sql += ' AND phone = ?';     params.push(phone); }
    if (direction) { sql += ' AND direction = ?'; params.push(direction); }
    return queryGet(sql, params).count;
}

/**
 * A conversation, newest-last, with a bound on how much is returned.
 *
 * The unbounded version was called by the chatbot on *every* incoming
 * message (to build AI context) and by the lead analyzer. A long-running
 * customer chat with 50k messages therefore materialised 50k rows into
 * JavaScript objects on the shared event loop, per message received —
 * quietly turning one busy tenant into a latency problem for everyone.
 * Callers that only need recent context pass a small limit.
 */
function getConversation(userId, phone, { limit = null } = {}) {
    if (limit === null) {
        return queryAll(
            'SELECT * FROM messages WHERE user_id = ? AND phone = ? ORDER BY created_at ASC',
            [userId, phone]
        );
    }
    // Take the newest `limit` rows, then flip back to chronological order so
    // callers still see oldest-first.
    const rows = queryAll(
        'SELECT * FROM messages WHERE user_id = ? AND phone = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        [userId, phone, limit]
    );
    return rows.reverse();
}

// ─── Chatbot Rule Helpers ───────────────────────────────────
function getChatbotRules(userId, activeOnly = false) {
    let sql = 'SELECT * FROM chatbot_rules WHERE user_id = ?';
    const params = [userId];
    if (activeOnly) sql += ' AND is_active = 1';
    sql += ' ORDER BY priority DESC, id ASC';
    return queryAll(sql, params);
}

function countChatbotRules(userId) {
    return queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = ?', [userId]).count;
}

function createChatbotRule(userId, triggerKeyword, matchType, responseText, priority = 0) {
    const { lastId } = runSql(
        'INSERT INTO chatbot_rules (user_id, trigger_keyword, match_type, response_text, priority) VALUES (?, ?, ?, ?, ?)',
        [userId, triggerKeyword, matchType, responseText, priority]
    );
    return { id: lastId, triggerKeyword, matchType, responseText, priority };
}

function updateChatbotRule(userId, id, fields) {
    const allowed = ['trigger_keyword', 'match_type', 'response_text', 'priority', 'is_active'];
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            sets.push(`${key} = ?`);
            params.push(value);
        }
    }
    if (sets.length === 0) return null;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    return runSql(`UPDATE chatbot_rules SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, params);
}

function deleteChatbotRule(userId, id) {
    return runSql('DELETE FROM chatbot_rules WHERE user_id = ? AND id = ?', [userId, id]);
}

function incrementRuleHitCount(userId, id) {
    return runSql('UPDATE chatbot_rules SET hit_count = hit_count + 1 WHERE user_id = ? AND id = ?', [userId, id]);
}

// ─── Scheduled Message Helpers ──────────────────────────────
function getScheduledMessages(userId, status = null) {
    let sql = 'SELECT * FROM scheduled_messages WHERE user_id = ?';
    const params = [userId];
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    sql += ' ORDER BY scheduled_at ASC';
    return queryAll(sql, params);
}

function createScheduledMessage(userId, phone, body, scheduledAt) {
    const { lastId } = runSql(
        'INSERT INTO scheduled_messages (user_id, phone, body, scheduled_at) VALUES (?, ?, ?, ?)',
        [userId, phone, body, scheduledAt]
    );
    return { id: lastId, phone, body, scheduledAt, status: 'pending' };
}

function countPendingScheduledMessages(userId) {
    return queryGet(
        "SELECT COUNT(*) as count FROM scheduled_messages WHERE user_id = ? AND status = 'pending'",
        [userId]
    ).count;
}

function updateScheduledMessageStatus(id, status, errorMessage = null) {
    return runSql(
        `UPDATE scheduled_messages SET status = ?, error_message = ?,
            sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END
         WHERE id = ?`,
        [status, errorMessage, status, id]
    );
}

/** Every pending, due scheduled message across ALL users (the scheduler dispatches per-user). */
function getPendingScheduledMessages() {
    return queryAll(
        `SELECT * FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_at <= datetime('now')
         ORDER BY scheduled_at ASC`
    );
}

/**
 * Atomically takes ownership of one pending job, returning true only for
 * the caller that won it.
 *
 * The scheduler previously guarded against double-sending with an
 * in-process `isRunning` boolean. That holds for exactly one process: run
 * two instances (or restart while a tick is mid-flight, or scale to a
 * second container) and both read the same `status = 'pending'` row and
 * both send the message. A customer gets the same WhatsApp message twice,
 * and WhatsApp's spam heuristics notice.
 *
 * `UPDATE ... WHERE id = ? AND status = 'pending'` is a compare-and-swap:
 * SQLite serialises it, so exactly one caller sees changes === 1. The
 * 'sending' state also means a crash mid-send leaves a row that is
 * visibly stuck rather than silently re-sent on the next tick —
 * reclaimStuckScheduledMessages() decides what happens to those.
 */
function claimScheduledMessage(id) {
    const { changes } = runSql(
        "UPDATE scheduled_messages SET status = 'sending' WHERE id = ? AND status = 'pending'",
        [id]
    );
    return changes === 1;
}

/**
 * Jobs stuck in 'sending' because the process died mid-send.
 *
 * These are deliberately marked 'failed' rather than returned to
 * 'pending': we cannot know whether WhatsApp accepted the message before
 * the crash, and re-sending a message someone already received is worse
 * than surfacing a failure the owner can act on. The error text says so
 * explicitly so it isn't mistaken for a delivery error.
 */
function reclaimStuckScheduledMessages(olderThanMinutes = 15) {
    const rows = queryAll(
        `SELECT id, user_id, phone FROM scheduled_messages
         WHERE status = 'sending'
           AND scheduled_at <= datetime('now', '-' || ? || ' minutes')`,
        [olderThanMinutes]
    );
    if (rows.length === 0) return [];
    runSql(
        `UPDATE scheduled_messages
            SET status = 'failed',
                error_message = 'Interrupted while sending (server restarted). Delivery is unconfirmed — check WhatsApp before resending.'
          WHERE status = 'sending'
            AND scheduled_at <= datetime('now', '-' || ? || ' minutes')`,
        [olderThanMinutes]
    );
    return rows;
}

function cancelScheduledMessage(userId, id) {
    return runSql(
        "UPDATE scheduled_messages SET status = 'cancelled' WHERE user_id = ? AND id = ? AND status = 'pending'",
        [userId, id]
    );
}

// ─── Product / Catalog Helpers ──────────────────────────────
function getProducts(userId, activeOnly = false) {
    let sql = 'SELECT * FROM products WHERE user_id = ?';
    const params = [userId];
    if (activeOnly) sql += ' AND is_active = 1';
    sql += ' ORDER BY category ASC, name ASC';
    return queryAll(sql, params);
}

function countProducts(userId) {
    return queryGet('SELECT COUNT(*) as count FROM products WHERE user_id = ?', [userId]).count;
}

function getProduct(userId, id) {
    return queryGet('SELECT * FROM products WHERE id = ? AND user_id = ?', [id, userId]);
}

function getPublicProductById(id) {
    const numId = Number(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) return null;
    return queryGet('SELECT id, user_id, name, description, price, category, url, payment_link, is_active FROM products WHERE id = ? AND is_active = 1', [numId]);
}

function createProduct(userId, { name, description = '', price = '', category = '', url = '', payment_link = '' }) {
    const { lastId } = runSql(
        'INSERT INTO products (user_id, name, description, price, category, url, payment_link) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, name, description, price, category, url, payment_link]
    );
    return queryGet('SELECT * FROM products WHERE id = ?', [lastId]);
}

function updateProduct(userId, id, fields) {
    const allowed = ['name', 'description', 'price', 'category', 'url', 'payment_link', 'is_active'];
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            sets.push(`${key} = ?`);
            params.push(value);
        }
    }
    if (sets.length === 0) return queryGet('SELECT * FROM products WHERE id = ? AND user_id = ?', [id, userId]);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    runSql(`UPDATE products SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, params);
    return queryGet('SELECT * FROM products WHERE id = ? AND user_id = ?', [id, userId]);
}

function deleteProduct(userId, id) {
    return runSql('DELETE FROM products WHERE user_id = ? AND id = ?', [userId, id]);
}

/**
 * Fuzzy-match a product by name for the AI payment-link tool.
 *
 * Tries exact match first (case-insensitive), then falls back to a LIKE
 * prefix search. Only returns active products that have a payment_link.
 */
function getProductByName(userId, name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed === '') return null;

    // 1. Exact case-insensitive match (most reliable)
    let row = queryGet(
        'SELECT * FROM products WHERE user_id = ? AND is_active = 1 AND LOWER(name) = LOWER(?) LIMIT 1',
        [userId, trimmed]
    );
    if (row) return row;

    // 2. LIKE prefix — "SEO" matches "SEO Package"
    row = queryGet(
        'SELECT * FROM products WHERE user_id = ? AND is_active = 1 AND LOWER(name) LIKE LOWER(?) LIMIT 1',
        [userId, `%${trimmed}%`]
    );
    return row || null;
}

/**
 * Records that the AI sent a payment link to a customer.
 *
 * Upserts the CRM deal: sets stage to at least 'proposal' (does not
 * downgrade a deal already in 'negotiation' or 'won'), fills in
 * deal_value from the product price, marks payment_link_sent_at, and
 * logs a CRM activity.
 */
function recordPaymentLinkSent(userId, phone, { contactName = '', productName = '', price = 0 }) {
    const existing = getCrmDealByPhone(userId, phone);
    const numericPrice = parseFloat(price) || 0;

    // Stages that are "further along" than proposal — don't downgrade them.
    const advancedStages = ['negotiation', 'won'];

    if (!existing) {
        const deal = createCrmDeal(userId, {
            phone,
            contactName,
            stage: 'proposal',
            dealValue: numericPrice,
            productInterest: productName,
            source: 'whatsapp (AI)'
        });
        runSql(
            'UPDATE crm_deals SET payment_link_sent_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?',
            [userId, deal.id]
        );
    } else {
        const newStage = advancedStages.includes(existing.stage) ? existing.stage : 'proposal';
        const updates = {
            stage: newStage,
            product_interest: productName || existing.product_interest,
        };
        // Only fill deal_value if it's currently 0
        if ((existing.deal_value === 0 || !existing.deal_value) && numericPrice > 0) {
            updates.deal_value = numericPrice;
        }
        if (contactName && !existing.contact_name) {
            updates.contact_name = contactName;
        }
        updateCrmDeal(userId, existing.id, updates);
        runSql(
            'UPDATE crm_deals SET payment_link_sent_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?',
            [userId, existing.id]
        );
    }

    addCrmActivity(
        userId, phone, 'ai',
        `AI sent payment link for ${productName}${numericPrice ? ` (${numericPrice})` : ''}`
    );
}

/**
 * Returns true if this tenant has at least one active product with a
 * non-empty payment_link. Used to decide whether to offer the
 * send_payment_link tool to the AI.
 */
function hasPaymentLinks(userId) {
    const row = queryGet(
        "SELECT COUNT(*) as count FROM products WHERE user_id = ? AND is_active = 1 AND payment_link != ''",
        [userId]
    );
    return (row && row.count > 0);
}

// ─── CRM Deal Helpers ───────────────────────────────────────
const CRM_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

function getCrmDeals(userId, { stage = '' } = {}) {
    let sql = `
        SELECT cd.*,
               la.interest_status, la.interest_score, la.priority, la.summary,
               la.issue_category, la.next_action, la.sentiment
        FROM crm_deals cd
        LEFT JOIN lead_analysis la ON la.phone = cd.phone AND la.user_id = cd.user_id
        WHERE cd.user_id = ?`;
    const params = [userId];
    if (stage) {
        sql += ' AND cd.stage = ?';
        params.push(stage);
    }
    sql += ' ORDER BY cd.deal_value DESC, cd.updated_at DESC';
    return queryAll(sql, params);
}

function getCrmDealByPhone(userId, phone) {
    return queryGet('SELECT * FROM crm_deals WHERE user_id = ? AND phone = ?', [userId, phone]);
}

function getCrmDealById(userId, id) {
    return queryGet('SELECT * FROM crm_deals WHERE user_id = ? AND id = ?', [userId, id]);
}

function createCrmDeal(userId, { phone, contactName = '', stage = 'new', dealValue = 0, productInterest = '', source = 'whatsapp', notes = '', nextFollowupAt = null }) {
    if (!CRM_STAGES.includes(stage)) stage = 'new';
    const { lastId } = runSql(
        `INSERT INTO crm_deals (user_id, phone, contact_name, stage, deal_value, product_interest, source, notes, next_followup_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, phone, contactName, stage, dealValue, productInterest, source, notes, nextFollowupAt]
    );
    return getCrmDealById(userId, lastId);
}

function updateCrmDeal(userId, id, fields) {
    const allowed = ['contact_name', 'stage', 'deal_value', 'product_interest', 'notes', 'next_followup_at'];
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        if (!allowed.includes(key)) continue;
        if (key === 'stage') {
            if (!CRM_STAGES.includes(value)) continue;
            sets.push('stage = ?', "stage_changed_at = CURRENT_TIMESTAMP");
            params.push(value);
            continue;
        }
        sets.push(`${key} = ?`);
        params.push(value);
    }
    if (sets.length === 0) return getCrmDealById(userId, id);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    runSql(`UPDATE crm_deals SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, params);
    return getCrmDealById(userId, id);
}

function deleteCrmDeal(userId, id) {
    return runSql('DELETE FROM crm_deals WHERE user_id = ? AND id = ?', [userId, id]);
}

/**
 * Called by the AI lead analyzer. Creates a deal for new sales conversations,
 * or refreshes the AI fields on an existing deal WITHOUT overriding the
 * stage/value the owner set manually (value is only filled if still 0).
 */
function aiUpsertCrmDeal(userId, phone, { contactName = '', suggestedStage = 'new', estimatedValue = 0, productInterest = '' }) {
    if (!CRM_STAGES.includes(suggestedStage)) suggestedStage = 'new';
    const existing = getCrmDealByPhone(userId, phone);

    if (!existing) {
        const deal = createCrmDeal(userId, {
            phone,
            contactName,
            stage: suggestedStage,
            dealValue: estimatedValue || 0,
            productInterest,
            source: 'whatsapp (AI)'
        });
        runSql('UPDATE crm_deals SET ai_suggested_stage = ?, ai_estimated_value = ? WHERE user_id = ? AND id = ?',
            [suggestedStage, estimatedValue || 0, userId, deal.id]);
        addCrmActivity(userId, phone, 'ai', `AI created this deal — suggested stage: ${suggestedStage}${estimatedValue ? `, estimated value: ${estimatedValue}` : ''}${productInterest ? `, product: ${productInterest}` : ''}`);
        return getCrmDealById(userId, deal.id);
    }

    runSql(
        `UPDATE crm_deals SET
            contact_name       = COALESCE(NULLIF(?, ''), contact_name),
            product_interest   = COALESCE(NULLIF(?, ''), product_interest),
            ai_suggested_stage = ?,
            ai_estimated_value = ?,
            deal_value         = CASE WHEN deal_value = 0 AND ? > 0 THEN ? ELSE deal_value END,
            updated_at         = CURRENT_TIMESTAMP
         WHERE user_id = ? AND phone = ?`,
        [contactName, productInterest, suggestedStage, estimatedValue || 0, estimatedValue || 0, estimatedValue || 0, userId, phone]
    );
    return getCrmDealByPhone(userId, phone);
}

function getCrmStats(userId) {
    const openStages = "('new', 'contacted', 'qualified', 'proposal', 'negotiation')";
    const openDeals     = queryGet(`SELECT COUNT(*) as count FROM crm_deals WHERE user_id = ? AND stage IN ${openStages}`, [userId]).count;
    const pipelineValue = queryGet(`SELECT COALESCE(SUM(deal_value), 0) as total FROM crm_deals WHERE user_id = ? AND stage IN ${openStages}`, [userId]).total;
    const wonDeals      = queryGet("SELECT COUNT(*) as count FROM crm_deals WHERE user_id = ? AND stage = 'won'", [userId]).count;
    const wonValue      = queryGet("SELECT COALESCE(SUM(deal_value), 0) as total FROM crm_deals WHERE user_id = ? AND stage = 'won'", [userId]).total;
    const followupsDue  = queryGet(`SELECT COUNT(*) as count FROM crm_deals
                                    WHERE user_id = ? AND next_followup_at IS NOT NULL
                                      AND next_followup_at <= datetime('now')
                                      AND stage IN ${openStages}`, [userId]).count;
    return { openDeals, pipelineValue, wonDeals, wonValue, followupsDue };
}

/** Aggregates for the CRM analytics charts */
function getCrmAnalytics(userId) {
    const stageBreakdown = queryAll(`
        SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as value
        FROM crm_deals
        WHERE user_id = ?
        GROUP BY stage
    `, [userId]);
    const interestMix = queryAll(`
        SELECT interest_status, COUNT(*) as count
        FROM lead_analysis
        WHERE user_id = ?
        GROUP BY interest_status
    `, [userId]);
    const messagesByDay = queryAll(`
        SELECT date(created_at) as day,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
               SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing
        FROM messages
        WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY day ASC
    `, [userId]);
    return { stageBreakdown, interestMix, messagesByDay };
}

// ─── CRM Activity Helpers ───────────────────────────────────
function addCrmActivity(userId, phone, type, content) {
    const { lastId } = runSql(
        'INSERT INTO crm_activities (user_id, phone, type, content) VALUES (?, ?, ?, ?)',
        [userId, phone, type || 'note', content || '']
    );
    return queryGet('SELECT * FROM crm_activities WHERE id = ?', [lastId]);
}

function getCrmActivities(userId, phone, limit = 50) {
    return queryAll(
        'SELECT * FROM crm_activities WHERE user_id = ? AND phone = ? ORDER BY created_at DESC LIMIT ?',
        [userId, phone, limit]
    );
}

// ─── Lead Analysis Helpers ──────────────────────────────────
function saveLeadAnalysis(userId, phone, analysis) {
    const {
        contactName = '', summary = '', interestStatus = 'unclear', interestScore = 0,
        sentiment = 'neutral', issueCategory = '', issues = [], priority = 'low',
        priorityReason = '', nextAction = '', messageCount = 0
    } = analysis;

    runSql(
        `INSERT INTO lead_analysis
            (user_id, phone, contact_name, summary, interest_status, interest_score, sentiment,
             issue_category, issues, priority, priority_reason, next_action, message_count, last_analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, phone) DO UPDATE SET
            contact_name     = excluded.contact_name,
            summary          = excluded.summary,
            interest_status  = excluded.interest_status,
            interest_score   = excluded.interest_score,
            sentiment        = excluded.sentiment,
            issue_category   = excluded.issue_category,
            issues           = excluded.issues,
            priority         = excluded.priority,
            priority_reason  = excluded.priority_reason,
            next_action      = excluded.next_action,
            message_count    = excluded.message_count,
            last_analyzed_at = CURRENT_TIMESTAMP`,
        [userId, phone, contactName, summary, interestStatus, interestScore, sentiment,
         issueCategory, JSON.stringify(issues), priority, priorityReason, nextAction, messageCount]
    );
    return getLeadAnalysis(userId, phone);
}

function getLeadAnalysis(userId, phone) {
    return queryGet('SELECT * FROM lead_analysis WHERE user_id = ? AND phone = ?', [userId, phone]);
}

function getLeadAnalyses(userId, { interestStatus = '', priority = '' } = {}) {
    let sql = `
        SELECT la.*,
               cd.stage as crm_stage,
               cd.deal_value as crm_value,
               cd.product_interest as crm_product
        FROM lead_analysis la
        LEFT JOIN crm_deals cd ON cd.phone = la.phone AND cd.user_id = la.user_id
        WHERE la.user_id = ?`;
    const params = [userId];
    if (interestStatus) {
        sql += ' AND la.interest_status = ?';
        params.push(interestStatus);
    }
    if (priority) {
        sql += ' AND la.priority = ?';
        params.push(priority);
    }
    sql += ` ORDER BY
        CASE la.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        la.interest_score DESC,
        la.last_analyzed_at DESC`;
    return queryAll(sql, params);
}

function deleteLeadAnalysis(userId, id) {
    return runSql('DELETE FROM lead_analysis WHERE user_id = ? AND id = ?', [userId, id]);
}

/** Distinct phones that have at least one incoming message (i.e. real conversations) */
function getConversationPhones(userId) {
    return queryAll(`
        SELECT phone,
               MAX(contact_name) as contact_name,
               COUNT(*) as message_count,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming_count,
               MAX(created_at) as last_message_at
        FROM messages
        WHERE user_id = ?
        GROUP BY phone
        HAVING incoming_count > 0
        ORDER BY last_message_at DESC
    `, [userId]);
}

function getLeadStats(userId) {
    const total       = queryGet('SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = ?', [userId]).count;
    const interested  = queryGet("SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = ? AND interest_status = 'interested'", [userId]).count;
    const notInterested = queryGet("SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = ? AND interest_status = 'not_interested'", [userId]).count;
    const highPriority = queryGet("SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = ? AND priority = 'high'", [userId]).count;
    return { total, interested, notInterested, highPriority };
}

// ─── Settings Helpers ───────────────────────────────────────
function getSetting(userId, key) {
    const row = queryGet('SELECT value FROM settings WHERE user_id = ? AND key = ?', [userId, key]);
    return row ? row.value : null;
}

function setSetting(userId, key, value) {
    return runSql('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)', [userId, key, value]);
}

function getAllSettings(userId) {
    const rows = queryAll('SELECT * FROM settings WHERE user_id = ?', [userId]);
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

// ─── Google Calendar Helpers ────────────────────────────────
/** Upserts the connected account's tokens. Called on initial connect and again whenever the OAuth client refreshes an access token. */
function saveGoogleCalendarTokens(userId, tokens) {
    const existing = queryGet('SELECT calendar_id, check_availability FROM google_calendar_accounts WHERE user_id = ?', [userId]);
    return runSql(
        `INSERT INTO google_calendar_accounts (user_id, access_token, refresh_token, scope, token_type, expiry_date, calendar_id, check_availability)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
            access_token = excluded.access_token,
            -- A token refresh response from Google usually omits refresh_token
            -- (it's only issued once, on first consent). Falling back to the
            -- stored value instead of overwriting with NULL is what keeps
            -- refreshes working after the first one.
            refresh_token = COALESCE(excluded.refresh_token, google_calendar_accounts.refresh_token),
            scope = excluded.scope,
            token_type = excluded.token_type,
            expiry_date = excluded.expiry_date`,
        [
            userId, tokens.access_token, tokens.refresh_token || null, tokens.scope || null,
            tokens.token_type || null, tokens.expiry_date || null,
            existing ? existing.calendar_id : 'primary',
            existing ? existing.check_availability : 0
        ]
    );
}

function getGoogleCalendarAccount(userId) {
    return queryGet('SELECT * FROM google_calendar_accounts WHERE user_id = ?', [userId]);
}

function getAllConnectedCalendarUserIds() {
    return queryAll('SELECT user_id FROM google_calendar_accounts').map(r => r.user_id);
}

function deleteGoogleCalendarAccount(userId) {
    runSql('DELETE FROM google_calendar_synced_events WHERE user_id = ?', [userId]);
    return runSql('DELETE FROM google_calendar_accounts WHERE user_id = ?', [userId]);
}

function setCalendarAvailabilityCheck(userId, enabled) {
    return runSql('UPDATE google_calendar_accounts SET check_availability = ? WHERE user_id = ?', [enabled ? 1 : 0, userId]);
}

function touchCalendarLastSync(userId) {
    return runSql('UPDATE google_calendar_accounts SET last_sync_at = CURRENT_TIMESTAMP WHERE user_id = ?', [userId]);
}

/**
 * True if this (userId, eventId) pair has already been turned into a
 * scheduled message. userId is REQUIRED — without it a match in tenant A
 * would block tenant B from importing their own event with the same ID.
 * Google event IDs are only unique per calendar, not globally.
 */
function isCalendarEventSynced(userId, eventId) {
    return !!queryGet(
        'SELECT 1 FROM google_calendar_synced_events WHERE user_id = ? AND event_id = ?',
        [userId, eventId]
    );
}

/** Records that a calendar event has been turned into a scheduled message, so the next sync tick skips it. */
function markCalendarEventSynced(eventId, userId, scheduledMessageId) {
    return runSql(
        'INSERT OR IGNORE INTO google_calendar_synced_events (user_id, event_id, scheduled_message_id) VALUES (?, ?, ?)',
        [userId, eventId, scheduledMessageId]
    );
}

// ─── Appointment booking ────────────────────────────────────
/** Returns the raw stored row, or null if the account has never saved custom hours (caller applies defaults — see availability.js). */
function getAvailabilitySettings(userId) {
    return queryGet('SELECT * FROM availability_settings WHERE user_id = ?', [userId]);
}

function saveAvailabilitySettings(userId, { workingDays, startTime, endTime, slotDurationMinutes, bufferMinutes, timezone, bookingEnabled }) {
    return runSql(
        `INSERT INTO availability_settings (user_id, working_days, start_time, end_time, slot_duration_minutes, buffer_minutes, timezone, booking_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
            working_days = excluded.working_days,
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            slot_duration_minutes = excluded.slot_duration_minutes,
            buffer_minutes = excluded.buffer_minutes,
            timezone = excluded.timezone,
            booking_enabled = excluded.booking_enabled,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, workingDays, startTime, endTime, slotDurationMinutes, bufferMinutes, timezone, bookingEnabled ? 1 : 0]
    );
}

/**
 * Appointments overlapping [startAt, endAt) for this user, excluding
 * cancelled ones — the check every booking (chatbot or dashboard) must pass
 * before it's allowed to claim a slot.
 */
function countOverlappingAppointments(userId, startAt, endAt, excludeId = null) {
    let sql = `SELECT COUNT(*) as count FROM appointments
               WHERE user_id = ? AND status = 'confirmed' AND start_at < ? AND end_at > ?`;
    const params = [userId, endAt, startAt];
    if (excludeId) {
        sql += ' AND id != ?';
        params.push(excludeId);
    }
    return queryGet(sql, params).count;
}

function listAppointments(userId, { status = null, fromAt = null, toAt = null, limit = 500 } = {}) {
    let sql = 'SELECT * FROM appointments WHERE user_id = ?';
    const params = [userId];
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    if (fromAt) {
        sql += ' AND end_at >= ?';
        params.push(fromAt);
    }
    if (toAt) {
        sql += ' AND start_at <= ?';
        params.push(toAt);
    }
    sql += ' ORDER BY start_at ASC LIMIT ?';
    params.push(limit);
    return queryAll(sql, params);
}

function countAppointments(userId) {
    return queryGet("SELECT COUNT(*) as count FROM appointments WHERE user_id = ? AND status = 'confirmed'", [userId]).count;
}

/**
 * Atomically checks for an overlap and inserts, inside one transaction —
 * returns the new row, or null if something else claimed an overlapping
 * slot first.
 *
 * This is the actual race guard, not countOverlappingAppointments on its
 * own. availability.bookAppointment does its own pre-checks (including an
 * async Google Calendar lookup) before calling this, purely to fail fast
 * and avoid creating a calendar event for a slot that's obviously already
 * taken — but those checks happen before `await`s, which yield the event
 * loop, so two concurrent bookings for the same slot could both sail past
 * them. This function's check-then-insert never yields (sql.js is
 * synchronous, and `transaction()` wraps both statements in one BEGIN/COMMIT
 * with no `await` in between) — a second caller's INSERT literally cannot
 * run until this one's transaction has committed, so it will see the first
 * booking's row and correctly self-reject.
 */
function createAppointment(userId, { phone, contactName = '', startAt, endAt, source = 'chatbot', notes = '', calendarEventId = null }) {
    return transaction(() => {
        const conflict = queryGet(
            `SELECT COUNT(*) as count FROM appointments
             WHERE user_id = ? AND status = 'confirmed' AND start_at < ? AND end_at > ?`,
            [userId, endAt, startAt]
        ).count;
        if (conflict > 0) return null;

        const { lastId } = runSql(
            `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, source, notes, calendar_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, phone, contactName, startAt, endAt, source, notes, calendarEventId]
        );
        return queryGet('SELECT * FROM appointments WHERE id = ?', [lastId]);
    });
}

function getAppointmentById(userId, id) {
    return queryGet('SELECT * FROM appointments WHERE id = ? AND user_id = ?', [id, userId]);
}

/** Marks an appointment cancelled. Returns the row as it was *before* cancelling (so the caller can still clean up its calendar event), or null if it didn't exist / already was. */
function cancelAppointment(userId, id) {
    const row = queryGet("SELECT * FROM appointments WHERE id = ? AND user_id = ? AND status = 'confirmed'", [id, userId]);
    if (!row) return null;
    runSql("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND user_id = ?", [id, userId]);
    return row;
}

// ─── Dashboard Stats ────────────────────────────────────────
function getDashboardStats(userId) {
    const totalMessages   = queryGet('SELECT COUNT(*) as count FROM messages WHERE user_id = ?', [userId]).count;
    const messagesToday   = queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND date(created_at) = date('now')", [userId]).count;
    const sentToday       = queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND direction = 'outgoing' AND date(created_at) = date('now')", [userId]).count;
    const receivedToday   = queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND direction = 'incoming' AND date(created_at) = date('now')", [userId]).count;
    const totalContacts   = queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = ?', [userId]).count;
    const activeRules     = queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = ? AND is_active = 1', [userId]).count;
    const pendingScheduled = queryGet("SELECT COUNT(*) as count FROM scheduled_messages WHERE user_id = ? AND status = 'pending'", [userId]).count;
    const documentsShared = queryGet(
        "SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND message_type = 'document' AND status = 'sent'",
        [userId]
    ).count;
    const upcomingAppointments = queryGet(
        "SELECT COUNT(*) as count FROM appointments WHERE user_id = ? AND status = 'confirmed' AND start_at >= datetime('now')",
        [userId]
    ).count;

    const recentMessages = queryAll('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [userId]);

    const messagesByDay = queryAll(`
        SELECT date(created_at) as day,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
               SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing
        FROM messages
        WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY day ASC
    `, [userId]);

    return {
        totalMessages,
        messagesToday,
        sentToday,
        receivedToday,
        totalContacts,
        activeRules,
        pendingScheduled,
        documentsShared,
        upcomingAppointments,
        recentMessages,
        messagesByDay
    };
}

module.exports = {
    initDatabase,
    getDb,
    // Schema / durability
    runMigrations,
    getSchemaVersion,
    MIGRATIONS,
    getPersistHealth,
    assertPersistable,
    stopPersistence,
    transaction,
    // Users / accounts
    getUserByEmail,
    getUserById,
    countUsers,
    createUser,
    ensureBootstrapAdmin,
    isDuplicateEmailError,
    touchLastLogin,
    listUsers,
    updateUser,
    deleteUserCascade,
    deleteUserAccountOnly,
    countOrphanedRows,
    getUserStats,
    getPlatformStats,
    getMonthlyOutgoingCount,
    countChatbotRules,
    ensureDefaultSettings,
    // Tenant data
    getContacts,
    countContacts,
    getContactByPhone,
    getContactsByIds,
    upsertContact,
    bulkUpsertContacts,
    markContactOutreached,
    deleteContact,
    logMessage,
    logOutgoingMessageIdempotent,
    findMessageByIdempotencyKey,
    getMessages,
    getDocumentMessageByRef,
    countMessages,
    clearMessages,
    getConversation,
    getChatbotRules,
    createChatbotRule,
    updateChatbotRule,
    deleteChatbotRule,
    incrementRuleHitCount,
    getScheduledMessages,
    createScheduledMessage,
    countPendingScheduledMessages,
    updateScheduledMessageStatus,
    getPendingScheduledMessages,
    claimScheduledMessage,
    reclaimStuckScheduledMessages,
    cancelScheduledMessage,
    getSetting,
    setSetting,
    getAllSettings,
    getDashboardStats,
    saveLeadAnalysis,
    getLeadAnalysis,
    getLeadAnalyses,
    deleteLeadAnalysis,
    getConversationPhones,
    getLeadStats,
    getProducts,
    getProduct,
    getPublicProductById,
    countProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    getProductByName,
    recordPaymentLinkSent,
    hasPaymentLinks,
    CRM_STAGES,
    getCrmDeals,
    getCrmDealByPhone,
    getCrmDealById,
    createCrmDeal,
    updateCrmDeal,
    deleteCrmDeal,
    aiUpsertCrmDeal,
    getCrmStats,
    getCrmAnalytics,
    addCrmActivity,
    getCrmActivities,
    forcePersist,
    // Google Calendar
    saveGoogleCalendarTokens,
    getGoogleCalendarAccount,
    getAllConnectedCalendarUserIds,
    deleteGoogleCalendarAccount,
    setCalendarAvailabilityCheck,
    touchCalendarLastSync,
    isCalendarEventSynced,
    markCalendarEventSynced,
    // Appointment booking
    getAvailabilitySettings,
    saveAvailabilitySettings,
    countOverlappingAppointments,
    listAppointments,
    countAppointments,
    createAppointment,
    getAppointmentById,
    cancelAppointment
};



