const cron = require('node-cron');
const { getPendingScheduledMessages, updateScheduledMessageStatus, logMessage } = require('./database');
const { sendTextMessage } = require('./whatsapp-client');

let schedulerTask = null;
let isRunning = false;   // prevent overlapping runs

// ─── Initialize the scheduler ────────────────────────────────
function initScheduler() {
    // Run every minute — the outer try/catch ensures a cron error never crashes the process
    schedulerTask = cron.schedule('* * * * *', async () => {
        try {
            await processPendingMessages();
        } catch (err) {
            console.error('❌ Scheduler tick error (non-fatal):', err.message);
        }
    });

    console.log('⏰ Scheduler: checking for pending messages every minute');
}

// ─── Process all due scheduled messages ─────────────────────
async function processPendingMessages() {
    // Skip if a previous run is still in-flight (e.g. slow network)
    if (isRunning) return;
    isRunning = true;

    let pending = [];
    try {
        pending = getPendingScheduledMessages();
    } catch (dbErr) {
        console.error('❌ Scheduler: failed to query pending messages:', dbErr.message);
        isRunning = false;
        return;
    }

    if (pending.length === 0) {
        isRunning = false;
        return;
    }

    console.log(`⏰ Processing ${pending.length} scheduled message(s)...`);

    for (const msg of pending) {
        try {
            // Timeout guard: don't let a single message block the whole scheduler
            const result = await Promise.race([
                sendTextMessage(msg.phone, msg.body),
                new Promise((_, rej) => setTimeout(() => rej(new Error('sendTextMessage timeout')), 20000))
            ]);

            try {
                logMessage({
                    waMessageId: result?.id?._serialized || null,
                    phone: msg.phone,
                    direction: 'outgoing',
                    messageType: 'text',
                    body: msg.body,
                    status: 'sent'
                });
            } catch (logErr) {
                console.warn('⚠️ Could not log scheduled message (non-fatal):', logErr.message);
            }

            updateScheduledMessageStatus(msg.id, 'sent');
            console.log(`✅ Scheduled message #${msg.id} sent to ${msg.phone}`);
        } catch (error) {
            console.error(`❌ Scheduled message #${msg.id} failed:`, error.message);
            try {
                updateScheduledMessageStatus(msg.id, 'failed', error.message);
            } catch (dbErr) {
                console.error('❌ Could not update failed status:', dbErr.message);
            }
        }

        // Anti-spam delay between messages
        await new Promise(resolve => setTimeout(resolve, 1200));
    }

    isRunning = false;
}

// ─── Stop the scheduler ──────────────────────────────────────
function stopScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        console.log('⏰ Scheduler stopped');
    }
}

module.exports = { initScheduler, stopScheduler, processPendingMessages };
