/**
 * calendar-sync.js — periodically imports "WhatsApp: <phone>" calendar
 * events into scheduled_messages for every connected account.
 *
 * Split out from scheduler.js (which dispatches due sends) rather than
 * folded into it: this tick talks to the Google Calendar API — a slow,
 * third-party network call — while scheduler.js's per-minute tick must stay
 * fast and reliable, since it's what fires time-sensitive sends. Keeping
 * them as separate cron jobs means a slow or failing Calendar API call can
 * never delay an actual WhatsApp send.
 *
 * Runs less often than the send scheduler (every 5 minutes, not every
 * minute) since calendar events are typically created minutes to days
 * ahead of when they should fire — there's no correctness reason to poll
 * faster, only Calendar API quota to burn.
 */
const cron = require('node-cron');
const { getAllConnectedCalendarUserIds } = require('./database');
const { isConfigured, syncEventsToScheduledMessages } = require('./google-calendar');

let syncTask = null;
let isRunning = false;

function initCalendarSync() {
    if (!isConfigured()) {
        console.log('📅 Calendar sync: GOOGLE_CALENDAR_* env vars not set — Google Calendar features are disabled.');
        return;
    }

    syncTask = cron.schedule('*/5 * * * *', async () => {
        if (isRunning) return; // a slow tick shouldn't pile up alongside the next one
        isRunning = true;
        try {
            const userIds = getAllConnectedCalendarUserIds();
            for (const userId of userIds) {
                try {
                    const imported = await syncEventsToScheduledMessages(userId);
                    if (imported > 0) {
                        console.log(`📅 Calendar sync: imported ${imported} event(s) as scheduled message(s) for user ${userId}`);
                    }
                } catch (err) {
                    // One tenant's connection breaking (revoked grant, expired
                    // refresh token) must not stop every other tenant's sync.
                    console.warn(`⚠️ Calendar sync failed for user ${userId} (non-fatal):`, err.message);
                }
            }
        } catch (err) {
            console.error('❌ Calendar sync tick error (non-fatal):', err.message);
        } finally {
            isRunning = false;
        }
    });

    console.log('📅 Calendar sync: checking connected calendars every 5 minutes');
}

function stopCalendarSync() {
    if (syncTask) {
        syncTask.stop();
        syncTask = null;
        console.log('📅 Calendar sync stopped');
    }
}

module.exports = { initCalendarSync, stopCalendarSync };
