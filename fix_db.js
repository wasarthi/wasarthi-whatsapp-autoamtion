/**
 * fix_db.js — resets one account's AI reply settings to sane defaults
 * (a good system prompt, AI-first mode on, away-mode off, all chatbot
 * keyword rules disabled so they don't fight with the AI).
 *
 * IMPORTANT: this now requires an account email and only touches that one
 * account. The database is multi-tenant — every account has its own copy
 * of these settings (`settings` is keyed by (user_id, key), not just
 * `key`). An earlier version of this script updated rows by key alone,
 * which on this schema would have silently overwritten EVERY account's AI
 * settings and disabled EVERY account's chatbot rules in one run. That bug
 * is fixed by requiring you to name the exact account.
 *
 * You can also just do this from the dashboard itself — Settings → AI
 * Behavior — this script exists for when the UI isn't reachable for some
 * reason.
 *
 * Usage (from the project root):
 *   node fix_db.js you@example.com
 */
const path = require('path');
const db = require(path.join(__dirname, 'src', 'database'));

const goodPrompt = `You are a friendly, natural AI texting on WhatsApp on behalf of the account owner.

Guidelines:
- Talk naturally, casually, and warmly just like a real person texting on WhatsApp.
- Keep replies brief (1-3 sentences max) and conversational.
- Do NOT sound like a robot. Never mention business hours or say you are offline.
- Never say you are an AI assistant.
- If asked something personal you don't know, say you will let the owner know.
- Use occasional emojis naturally.`;

(async () => {
    const email = (process.argv[2] || '').trim().toLowerCase();
    if (!email) {
        console.error('Usage: node fix_db.js you@example.com');
        process.exit(1);
    }

    await db.initDatabase();

    const user = db.getUserByEmail(email);
    if (!user) {
        console.error(`No account found with email "${email}". Check the address and try again.`);
        process.exit(1);
    }

    console.log(`\nCurrent settings for #${user.id} ${user.email}:`);
    console.log(`  ai_system_prompt = ${(db.getSetting(user.id, 'ai_system_prompt') || '').slice(0, 100)}`);
    console.log(`  ai_enabled       = ${db.getSetting(user.id, 'ai_enabled')}`);
    console.log(`  ai_mode          = ${db.getSetting(user.id, 'ai_mode')}`);
    console.log(`  away_mode        = ${db.getSetting(user.id, 'away_mode')}`);

    db.setSetting(user.id, 'ai_system_prompt', goodPrompt);
    db.setSetting(user.id, 'ai_enabled', 'true');
    db.setSetting(user.id, 'ai_mode', 'ai_first');
    db.setSetting(user.id, 'away_mode', 'false');

    const rules = db.getChatbotRules(user.id);
    for (const rule of rules) {
        db.updateChatbotRule(user.id, rule.id, { is_active: 0 });
    }

    console.log(`\nFixed! ${email} now has:`);
    console.log(`  ai_system_prompt = ${(db.getSetting(user.id, 'ai_system_prompt') || '').slice(0, 100)}`);
    console.log(`  ai_enabled       = ${db.getSetting(user.id, 'ai_enabled')}`);
    console.log(`  ai_mode          = ${db.getSetting(user.id, 'ai_mode')}`);
    console.log(`  away_mode        = ${db.getSetting(user.id, 'away_mode')}`);
    console.log(`  chatbot rules disabled: ${rules.length}`);
    console.log('\nOnly this one account was touched. Now run: npm start');
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
