const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
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
    persist();
    const lastId = db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] || 0;
    const changes = db.getRowsModified();
    return { lastId, changes };
}

/** Flush the in-memory database to the file on disk */
function persist() {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
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

    // Create tables
    db.run("PRAGMA foreign_keys = ON");

    db.run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT DEFAULT '',
            label TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // Indexes (CREATE INDEX IF NOT EXISTS is safe to repeat)
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction)");
    db.run("CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_messages(status, scheduled_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)");

    // Insert default settings if not exist
    const defaults = {
        chatbot_enabled: 'true',
        default_reply: 'Thank you for your message! I will get back to you shortly. 🙏',
        business_name: 'Personal Assistant',
        owner_name: '',
        ai_mode: 'ai_first', // 'ai_first' gives Gemini full conversational intelligence
        away_message: 'I am currently away from my phone right now. I will catch up and reply to you as soon as I am back!',
        away_mode: 'false',
        ai_enabled: 'true',
        ai_system_prompt: 'You are an intelligent AI replying on WhatsApp on behalf of your owner.\n\nGuidelines:\n- Talk naturally, casually, and helpfully just like a real person chatting on WhatsApp.\n- Keep replies brief (1-3 sentences max) and conversational.\n- Do NOT sound like a rigid corporate robot.\n- If asked personal questions or specific plans you don\'t know, politely say you\'ll pass the message to the owner.'
    };

    for (const [key, value] of Object.entries(defaults)) {
        db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }

    persist();
    return db;
}

// ─── Getter ─────────────────────────────────────────────────
function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}

// ─── Contact Helpers ────────────────────────────────────────
function getContacts(search = '', label = '') {
    let sql = 'SELECT * FROM contacts WHERE 1=1';
    const params = [];
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

function getContactByPhone(phone) {
    return queryGet('SELECT * FROM contacts WHERE phone = ?', [phone]);
}

function upsertContact(phone, name = '', label = '', notes = '') {
    const existing = getContactByPhone(phone);
    if (existing) {
        runSql(
            `UPDATE contacts SET
                name  = COALESCE(NULLIF(?, ''), name),
                label = COALESCE(NULLIF(?, ''), label),
                notes = COALESCE(NULLIF(?, ''), notes),
                updated_at = CURRENT_TIMESTAMP
             WHERE phone = ?`,
            [name, label, notes, phone]
        );
        return getContactByPhone(phone);
    } else {
        const { lastId } = runSql(
            'INSERT INTO contacts (phone, name, label, notes) VALUES (?, ?, ?, ?)',
            [phone, name, label, notes]
        );
        return { id: lastId, phone, name, label, notes };
    }
}

function deleteContact(id) {
    return runSql('DELETE FROM contacts WHERE id = ?', [id]);
}

// ─── Message Helpers ────────────────────────────────────────
function logMessage({ waMessageId, phone, contactName, direction, messageType, body, status, templateName }) {
    return runSql(
        `INSERT INTO messages (wa_message_id, phone, contact_name, direction, message_type, body, status, template_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [waMessageId || null, phone, contactName || '', direction, messageType || 'text', body || '', status || 'sent', templateName || null]
    );
}

function getMessages({ phone, direction, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM messages WHERE 1=1';
    const params = [];
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

function getConversation(phone) {
    return queryAll('SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC', [phone]);
}

// ─── Chatbot Rule Helpers ───────────────────────────────────
function getChatbotRules(activeOnly = false) {
    let sql = 'SELECT * FROM chatbot_rules';
    if (activeOnly) sql += ' WHERE is_active = 1';
    sql += ' ORDER BY priority DESC, id ASC';
    return queryAll(sql);
}

function createChatbotRule(triggerKeyword, matchType, responseText, priority = 0) {
    const { lastId } = runSql(
        'INSERT INTO chatbot_rules (trigger_keyword, match_type, response_text, priority) VALUES (?, ?, ?, ?)',
        [triggerKeyword, matchType, responseText, priority]
    );
    return { id: lastId, triggerKeyword, matchType, responseText, priority };
}

function updateChatbotRule(id, fields) {
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
    params.push(id);
    return runSql(`UPDATE chatbot_rules SET ${sets.join(', ')} WHERE id = ?`, params);
}

function deleteChatbotRule(id) {
    return runSql('DELETE FROM chatbot_rules WHERE id = ?', [id]);
}

function incrementRuleHitCount(id) {
    return runSql('UPDATE chatbot_rules SET hit_count = hit_count + 1 WHERE id = ?', [id]);
}

// ─── Scheduled Message Helpers ──────────────────────────────
function getScheduledMessages(status = null) {
    let sql = 'SELECT * FROM scheduled_messages';
    const params = [];
    if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
    }
    sql += ' ORDER BY scheduled_at ASC';
    return queryAll(sql, params);
}

function createScheduledMessage(phone, body, scheduledAt) {
    const { lastId } = runSql(
        'INSERT INTO scheduled_messages (phone, body, scheduled_at) VALUES (?, ?, ?)',
        [phone, body, scheduledAt]
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

function getPendingScheduledMessages() {
    return queryAll(
        `SELECT * FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_at <= datetime('now')
         ORDER BY scheduled_at ASC`
    );
}

function cancelScheduledMessage(id) {
    return runSql(
        "UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        [id]
    );
}

// ─── Settings Helpers ───────────────────────────────────────
function getSetting(key) {
    const row = queryGet('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : null;
}

function setSetting(key, value) {
    return runSql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

function getAllSettings() {
    const rows = queryAll('SELECT * FROM settings');
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

// ─── Dashboard Stats ────────────────────────────────────────
function getDashboardStats() {
    const totalMessages   = queryGet('SELECT COUNT(*) as count FROM messages').count;
    const messagesToday   = queryGet("SELECT COUNT(*) as count FROM messages WHERE date(created_at) = date('now')").count;
    const sentToday       = queryGet("SELECT COUNT(*) as count FROM messages WHERE direction = 'outgoing' AND date(created_at) = date('now')").count;
    const receivedToday   = queryGet("SELECT COUNT(*) as count FROM messages WHERE direction = 'incoming' AND date(created_at) = date('now')").count;
    const totalContacts   = queryGet('SELECT COUNT(*) as count FROM contacts').count;
    const activeRules     = queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE is_active = 1').count;
    const pendingScheduled = queryGet("SELECT COUNT(*) as count FROM scheduled_messages WHERE status = 'pending'").count;

    const recentMessages = queryAll('SELECT * FROM messages ORDER BY created_at DESC LIMIT 10');

    const messagesByDay = queryAll(`
        SELECT date(created_at) as day,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
               SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing
        FROM messages
        WHERE created_at >= datetime('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY day ASC
    `);

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
    getContacts,
    getContactByPhone,
    upsertContact,
    deleteContact,
    logMessage,
    getMessages,
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
    getDashboardStats
};
