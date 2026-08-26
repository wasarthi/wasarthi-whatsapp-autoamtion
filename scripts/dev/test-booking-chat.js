/**
 * test-booking-chat.js — simulates a customer trying to book an appointment,
 * without needing WhatsApp or the dashboard, so you can see exactly what the
 * chatbot would say and confirm it actually calls check_availability /
 * book_appointment correctly.
 *
 * Stop the server first — the app keeps its whole database in memory and
 * rewrites the file on every save, so a running server would overwrite
 * whatever this script does the next time it saves anything (same reason
 * make-admin.js asks for the same thing).
 *
 * Usage (from the project root):
 *   node scripts/dev/test-booking-chat.js you@example.com "I'd like to book an appointment tomorrow afternoon"
 *
 * This will:
 *   1. Turn appointment booking ON for that account (if it wasn't already).
 *   2. Send your message through the real AI reply path, exactly as an
 *      inbound WhatsApp message would.
 *   3. Print the bot's reply. If it mentions specific times, ask it to book
 *      one (run the script again with that as your message) to see the
 *      actual booking happen.
 *   4. List any appointment it just booked, so you can confirm — and clean
 *      it up if it was just a test.
 */
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'src', 'services', 'database'));
const availability = require(path.join(__dirname, '..', '..', 'src', 'services', 'availability'));
const ai = require(path.join(__dirname, '..', '..', 'src', 'services', 'ai'));

const TEST_PHONE = '910000000000'; // obviously fake — easy to spot and delete later
const TEST_CONTACT_NAME = 'Test Customer (test-booking-chat.js)';

(async () => {
    const email = (process.argv[2] || '').trim().toLowerCase();
    const message = process.argv[3] || "Hi, I'd like to book an appointment sometime tomorrow";
    if (!email) {
        console.error('Usage: node scripts/dev/test-booking-chat.js you@example.com "your test message"');
        process.exit(1);
    }

    await db.initDatabase();

    const user = db.getUserByEmail(email);
    if (!user) {
        console.error(`No account found for ${email}`);
        process.exit(1);
    }

    const settings = availability.getSettings(user.id);
    if (!settings.bookingEnabled) {
        console.log('ℹ️  Appointment booking was OFF for this account — turning it on for this test.');
        availability.saveSettings(user.id, { ...settings, bookingEnabled: true });
    }

    const geminiKey = db.getSetting(user.id, 'gemini_api_key') || process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey === 'your_gemini_api_key_here') {
        console.error('❌ No Gemini API key configured for this account (Settings → AI Behavior) or in .env. Add one first.');
        process.exit(1);
    }

    // Reuse whatever conversation this test phone already has, so you can
    // run the script multiple times in a row to have a real back-and-forth
    // (e.g. first "I want to book", then "yes, 3pm works").
    const history = db.getConversation(user.id, TEST_PHONE, { limit: 10 });
    db.logMessage(user.id, { phone: TEST_PHONE, contactName: TEST_CONTACT_NAME, direction: 'incoming', body: message });

    console.log(`\n👤 You: ${message}\n`);

    const systemPrompt = db.getSetting(user.id, 'ai_system_prompt');
    const reply = await ai.generateReply(
        user.id, systemPrompt,
        [...history, { direction: 'incoming', body: message }],
        TEST_CONTACT_NAME, TEST_PHONE
    );

    console.log(`🤖 Bot: ${reply}\n`);
    db.logMessage(user.id, { phone: TEST_PHONE, contactName: TEST_CONTACT_NAME, direction: 'outgoing', body: reply });

    const appts = db.listAppointments(user.id, { status: 'confirmed' }).filter(a => a.phone === TEST_PHONE);
    if (appts.length) {
        console.log('📅 Test appointment(s) currently booked for this test phone number:');
        for (const a of appts) console.log(`   #${a.id} — ${a.start_at} to ${a.end_at} (${a.source})`);
        console.log(`\nTo remove them: node -e "require('./src/services/database').initDatabase().then(async db => { db.cancelAppointment(${user.id}, ${appts[0].id}); })"`);
        console.log('(repeat for each id, or just cancel them from the dashboard\'s Appointments page)');
    } else {
        console.log('📅 No appointment booked yet from this turn — if the bot offered times, run the script again with your reply picking one.');
    }

    process.exit(0);
})().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
});
