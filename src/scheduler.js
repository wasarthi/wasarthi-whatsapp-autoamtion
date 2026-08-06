const cron = require('node-cron');
const { getPendingScheduledMessages, updateScheduledMessageStatus } = require('./database');
const { sendTextMessage } = require('./whatsapp-client');
const { logMessage } = require('./database');

let schedulerTask = null;

// ─── Initialize the scheduler ───────────────────────────────
function initScheduler() {
    // Run every minute to check for pending scheduled messages
    schedulerTask = cron.schedule('* * * * *', async () => {
        await processPendingMessages();
    });

    console.log('⏰ Scheduler: checking for pending messages every minute');
}

// ─── Process all due scheduled messages ─────────────────────
async function processPendingMessages() {
    const pending = getPendingScheduledMessages();

    if (pending.length === 0) return;

    console.log(`⏰ Processing ${pending.length} scheduled message(s)...`);

    for (const msg of pending) {
        try {
            const result = await sendTextMessage(msg.phone, msg.body);

            // Log the sent message
            logMessage({
                waMessageId: result.messageId,
                phone: msg.phone,
                direction: 'outgoing',
                messageType: 'text',
                body: msg.body,
                status: 'sent'
            });

            // Update scheduled message status
            updateScheduledMessageStatus(msg.id, 'sent');
            console.log(`✅ Scheduled message #${msg.id} sent to ${msg.phone}`);
        } catch (error) {
            console.error(`❌ Scheduled message #${msg.id} failed:`, error.message);
            updateScheduledMessageStatus(msg.id, 'failed', error.message);
        }

        // Rate limiting: wait 1 second between messages
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// ─── Stop the scheduler ─────────────────────────────────────
function stopScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        console.log('⏰ Scheduler stopped');
    }
}

module.exports = { initScheduler, stopScheduler, processPendingMessages };
