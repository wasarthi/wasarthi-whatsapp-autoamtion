// One-time DB fix script - patches the sql.js database file directly
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'whatsapp.db');

if (!fs.existsSync(dbPath)) {
    console.error('❌ Database file not found at:', dbPath);
    process.exit(1);
}

const goodPrompt = `You are a friendly, natural AI texting on WhatsApp on behalf of the account owner.

Guidelines:
- Talk naturally, casually, and warmly just like a real person texting on WhatsApp.
- Keep replies brief (1-3 sentences max) and conversational.
- Do NOT sound like a robot. Never mention business hours or say you are offline.
- Never say you are an AI assistant.
- If asked something personal you don't know, say you will let the owner know.
- Use occasional emojis naturally.`;

async function fix() {
    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Show current values
    const rows = db.exec("SELECT key, value FROM settings WHERE key IN ('ai_system_prompt','ai_enabled','ai_mode','away_mode')");
    console.log('\n📋 Current settings:');
    if (rows.length > 0) {
        rows[0].values.forEach(([k, v]) => console.log(`  ${k} = ${String(v).substring(0, 100)}`));
    }

    // Fix all values
    db.run("UPDATE settings SET value = ? WHERE key = 'ai_system_prompt'", [goodPrompt]);
    db.run("UPDATE settings SET value = 'true'  WHERE key = 'ai_enabled'");
    db.run("UPDATE settings SET value = 'ai_first' WHERE key = 'ai_mode'");
    db.run("UPDATE settings SET value = 'false' WHERE key = 'away_mode'");
    db.run("UPDATE chatbot_rules SET is_active = 0");

    // Save back to file
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    db.close();

    // Verify
    console.log('\n✅ Fixed! Now your settings are:');
    const SQL2 = await initSqlJs();
    const db2 = new SQL2.Database(fs.readFileSync(dbPath));
    const after = db2.exec("SELECT key, value FROM settings WHERE key IN ('ai_system_prompt','ai_enabled','ai_mode','away_mode')");
    if (after.length > 0) {
        after[0].values.forEach(([k, v]) => console.log(`  ${k} = ${String(v).substring(0, 100)}`));
    }
    db2.close();
    console.log('\n✅ Database patched! Now run: npm start');
}

fix().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
