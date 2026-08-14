const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists.
// PERSIST_ROOT lets a deploy host that only gives you ONE persistent disk at
// ONE mount path (Render is the case this exists for) put every stateful
// folder — this one, plus .wwebjs_auth/.wwebjs_cache in whatsapp-client.js —
// under that single path. Unset (the default, e.g. Docker Compose on a VPS,
// which already mounts three separate named volumes), this resolves to
// exactly what it always has: <project root>/data.
const persistRoot = process.env.PERSIST_ROOT || path.join(__dirname, '..');
const dataDir = path.join(persistRoot, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'whatsapp.db');
let db;

// ─── Low-level helpers (sql.js API wrappers) ────────────────

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
    persist();
    return { lastId, changes };
}

/** Flush the in-memory database to the file on disk */
function persist() {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
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

// ─── Initialize Database ────────────────────────────────────
async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing DB file or create a fresh one
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

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
            role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
            plan TEXT DEFAULT 'free',
            message_limit INTEGER DEFAULT 0,
            rule_limit INTEGER DEFAULT 0,
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
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'cancelled')),
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

    // Indexes (CREATE INDEX IF NOT EXISTS is safe to repeat)
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_phone ON messages(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction)");
    db.run("CREATE INDEX IF NOT EXISTS idx_scheduled_user_status ON scheduled_messages(user_id, status, scheduled_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_chatbot_rules_user ON chatbot_rules(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_lead_analysis_user_phone ON lead_analysis(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_lead_analysis_priority ON lead_analysis(user_id, priority)");
    db.run("CREATE INDEX IF NOT EXISTS idx_crm_deals_user_phone ON crm_deals(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_crm_deals_user_stage ON crm_deals(user_id, stage)");
    db.run("CREATE INDEX IF NOT EXISTS idx_crm_activities_user_phone ON crm_activities(user_id, phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");

    persist();
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
    persist();
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

function createUser({ email, passwordHash, businessName = '', ownerName = '' }) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const isFirstUser = countUsers() === 0;
    const { lastId } = runSql(
        `INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan)
         VALUES (?, ?, ?, ?, ?, 'active', 'free')`,
        [normalizedEmail, passwordHash, businessName, ownerName, isFirstUser ? 'admin' : 'user']
    );
    ensureDefaultSettings(lastId);
    // If this is the first account and legacy data was migrated to user_id 1,
    // reflect the business/owner name they just chose without clobbering a
    // richer business_name/owner_name already carried over from settings.
    const user = getUserById(lastId);
    return user;
}

function touchLastLogin(id) {
    return runSql('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

function listUsers() {
    return queryAll('SELECT id, email, business_name, owner_name, role, status, plan, message_limit, rule_limit, created_at, last_login_at FROM users ORDER BY created_at DESC');
}

function updateUser(id, fields) {
    const allowed = ['business_name', 'owner_name', 'status', 'plan', 'message_limit', 'rule_limit', 'role', 'password_hash'];
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

/** Wipes every row belonging to a user across all tenant tables, then the user itself. */
function deleteUserCascade(id) {
    const tables = ['contacts', 'messages', 'chatbot_rules', 'scheduled_messages', 'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis'];
    for (const t of tables) {
        db.run(`DELETE FROM ${t} WHERE user_id = ?`, [id]);
    }
    return runSql('DELETE FROM users WHERE id = ?', [id]);
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
function getContacts(userId, search = '', label = '') {
    let sql = 'SELECT * FROM contacts WHERE user_id = ?';
    const params = [userId];
    if (search) {
        sql += ' AND (name LIKE ? OR phone LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    if (label) {
        sql += ' AND label = ?';
        params.push(label);
    }
    sql += ' ORDER BY updated_at DESC';
    return queryAll(sql, params);
}

function getContactByPhone(userId, phone) {
    return queryGet('SELECT * FROM contacts WHERE user_id = ? AND phone = ?', [userId, phone]);
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

// ─── Message Helpers ────────────────────────────────────────
function logMessage(userId, { waMessageId, phone, contactName, direction, messageType, body, status, templateName }) {
    return runSql(
        `INSERT INTO messages (user_id, wa_message_id, phone, contact_name, direction, message_type, body, status, template_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, waMessageId || null, phone, contactName || '', direction, messageType || 'text', body || '', status || 'sent', templateName || null]
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

function getConversation(userId, phone) {
    return queryAll('SELECT * FROM messages WHERE user_id = ? AND phone = ? ORDER BY created_at ASC', [userId, phone]);
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

function createProduct(userId, { name, description = '', price = '', category = '', url = '' }) {
    const { lastId } = runSql(
        'INSERT INTO products (user_id, name, description, price, category, url) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, name, description, price, category, url]
    );
    return queryGet('SELECT * FROM products WHERE id = ?', [lastId]);
}

function updateProduct(userId, id, fields) {
    const allowed = ['name', 'description', 'price', 'category', 'url', 'is_active'];
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

// ─── Dashboard Stats ────────────────────────────────────────
function getDashboardStats(userId) {
    const totalMessages   = queryGet('SELECT COUNT(*) as count FROM messages WHERE user_id = ?', [userId]).count;
    const messagesToday   = queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND date(created_at) = date('now')", [userId]).count;
    const sentToday       = queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND direction = 'outgoing' AND date(created_at) = date('now')", [userId]).count;
    const receivedToday   = queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND direction = 'incoming' AND date(created_at) = date('now')", [userId]).count;
    const totalContacts   = queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = ?', [userId]).count;
    const activeRules     = queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = ? AND is_active = 1', [userId]).count;
    const pendingScheduled = queryGet("SELECT COUNT(*) as count FROM scheduled_messages WHERE user_id = ? AND status = 'pending'", [userId]).count;

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
        recentMessages,
        messagesByDay
    };
}

module.exports = {
    initDatabase,
    getDb,
    // Users / accounts
    getUserByEmail,
    getUserById,
    countUsers,
    createUser,
    touchLastLogin,
    listUsers,
    updateUser,
    deleteUserCascade,
    deleteUserAccountOnly,
    getUserStats,
    getPlatformStats,
    getMonthlyOutgoingCount,
    countChatbotRules,
    ensureDefaultSettings,
    // Tenant data
    getContacts,
    getContactByPhone,
    upsertContact,
    deleteContact,
    logMessage,
    getMessages,
    clearMessages,
    getConversation,
    getChatbotRules,
    createChatbotRule,
    updateChatbotRule,
    deleteChatbotRule,
    incrementRuleHitCount,
    getScheduledMessages,
    createScheduledMessage,
    updateScheduledMessageStatus,
    getPendingScheduledMessages,
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
    createProduct,
    updateProduct,
    deleteProduct,
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
    getCrmActivities
};
