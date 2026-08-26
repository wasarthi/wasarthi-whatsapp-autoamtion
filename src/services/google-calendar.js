/**
 * google-calendar.js — Google Calendar integration.
 *
 * Three things this wires up, all opt-in per tenant:
 *   1. Every successful outreach/scheduled send is logged as a calendar
 *      event, best-effort, so a business owner has a record of outreach
 *      alongside their other appointments.
 *   2. A user can create an event in their own Google Calendar titled
 *      "WhatsApp: <phone> [name]" with the message in the description, and
 *      a background sync tick (calendar-sync.js) turns it into a normal
 *      scheduled_messages row at the event's start time — the calendar
 *      becomes a scheduling UI, reusing the existing atomic-claim scheduler
 *      rather than inventing a second send path.
 *   3. Outreach can optionally check the user's own free/busy status before
 *      each send and skip contacts while a meeting is in progress, so bulk
 *      sends don't fire off during, say, a call with a client.
 *
 * Everything here is best-effort by design: Google Calendar is a courtesy
 * feature layered on top of a WhatsApp automation product, not something the
 * core send path may depend on. A Calendar API outage, a revoked grant, or a
 * missing OAuth app configuration must never block or fail a WhatsApp send —
 * every entry point below swallows its own errors and logs a warning instead
 * of throwing into the caller.
 */
const {
    saveGoogleCalendarTokens, getGoogleCalendarAccount, deleteGoogleCalendarAccount,
    setCalendarAvailabilityCheck, touchCalendarLastSync, isCalendarEventSynced,
    markCalendarEventSynced, createScheduledMessage, countPendingScheduledMessages
} = require('./database');
const { toSqliteUtc, LIMITS } = require('../utils/validate');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Calendar events created by this app are tagged with this in their
// description so a re-sync (or a human glancing at the calendar) can tell
// them apart from a manually-created "WhatsApp: ..." reminder event.
const LOGGED_EVENT_TAG = '[whatsapp-automation]';

// How far ahead to look for "WhatsApp: <phone>" events to import. Long
// enough that someone scheduling a week of outreach in one sitting isn't
// missed, short enough that a stale/abandoned calendar doesn't get scanned
// forever.
const SYNC_LOOKAHEAD_DAYS = 30;

/**
 * 'googleapis' is required lazily, not at module load, and this module is
 * required unconditionally from outreach.js and scheduler.js — the two
 * files every WhatsApp send goes through. A top-level `require('googleapis')`
 * would mean a server that hasn't run `npm install` since this feature was
 * added (or is deployed from a lockfile that predates it) crashes on boot
 * with MODULE_NOT_FOUND — Calendar being a checked-out feature nobody
 * configured yet must never be able to take down the send path with it.
 */
let _google = null;
let _googleLoadError = null;
function getGoogle() {
    if (_google) return _google;
    if (_googleLoadError) throw _googleLoadError;
    try {
        _google = require('googleapis').google;
        return _google;
    } catch (err) {
        _googleLoadError = new Error(
            "The 'googleapis' package is not installed. Run `npm install` in the project root, then restart the server, to enable Google Calendar."
        );
        throw _googleLoadError;
    }
}

function isPackageInstalled() {
    try { require.resolve('googleapis'); return true; } catch (e) { return false; }
}

/** True once GOOGLE_CALENDAR_CLIENT_ID/SECRET/REDIRECT_URI are all set AND the googleapis package is installed. Every route and background job checks this first — an unconfigured server should say so clearly rather than fail deep inside a Google API call. */
function isConfigured() {
    return !!(
        process.env.GOOGLE_CALENDAR_CLIENT_ID &&
        process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
        process.env.GOOGLE_CALENDAR_REDIRECT_URI &&
        isPackageInstalled()
    );
}

function newOAuthClient() {
    const google = getGoogle();
    return new google.auth.OAuth2(
        process.env.GOOGLE_CALENDAR_CLIENT_ID,
        process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
        process.env.GOOGLE_CALENDAR_REDIRECT_URI
    );
}

/** Builds the URL to send the user to for consent. `state` is an opaque, server-generated anti-CSRF token — see routes/calendar.js. */
function getAuthUrl(state) {
    const client = newOAuthClient();
    return client.generateAuthUrl({
        access_type: 'offline', // required to receive a refresh_token
        prompt: 'consent',      // forces a refresh_token even on a re-connect
        scope: SCOPES,
        state
    });
}

/** Exchanges an OAuth `code` for tokens and persists them for the user. */
async function connectAccount(userId, code) {
    const client = newOAuthClient();
    const { tokens } = await client.getToken(code);
    saveGoogleCalendarTokens(userId, tokens);
    return true;
}

function isConnected(userId) {
    return !!getGoogleCalendarAccount(userId);
}

function disconnectAccount(userId) {
    deleteGoogleCalendarAccount(userId);
}

function setAvailabilityCheck(userId, enabled) {
    setCalendarAvailabilityCheck(userId, enabled);
}

/**
 * Returns an authenticated Calendar client for the user, or null if they
 * haven't connected one. Refreshed tokens are persisted automatically via
 * the 'tokens' event — googleapis fires this whenever it silently exchanges
 * the refresh_token for a new access_token, which happens transparently
 * inside any API call once the old one has expired.
 */
function getClientForUser(userId) {
    const account = getGoogleCalendarAccount(userId);
    if (!account) return null;

    const oauth2Client = newOAuthClient();
    oauth2Client.setCredentials({
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        scope: account.scope,
        token_type: account.token_type,
        expiry_date: account.expiry_date
    });
    oauth2Client.on('tokens', (tokens) => {
        try { saveGoogleCalendarTokens(userId, tokens); } catch (e) { /* best-effort */ }
    });

    return {
        calendar: getGoogle().calendar({ version: 'v3', auth: oauth2Client }),
        calendarId: account.calendar_id || 'primary',
        checkAvailability: !!account.check_availability
    };
}

/**
 * Logs a sent message as a short calendar event. Best-effort: called after
 * a WhatsApp send has already succeeded, so a failure here must never make
 * the send itself look like it failed.
 */
async function logOutreachEvent(userId, { phone, name, message }) {
    try {
        if (!isConfigured()) return;
        const client = getClientForUser(userId);
        if (!client) return;

        const now = new Date();
        const end = new Date(now.getTime() + 5 * 60 * 1000);
        await client.calendar.events.insert({
            calendarId: client.calendarId,
            requestBody: {
                summary: `WhatsApp sent: ${name || phone}`,
                description: `${LOGGED_EVENT_TAG} To: ${phone}${name ? ` (${name})` : ''}\n\n${message}`.slice(0, 8000),
                start: { dateTime: now.toISOString() },
                end: { dateTime: end.toISOString() }
            }
        });
    } catch (err) {
        console.warn(`⚠️ Calendar: could not log outreach event for user ${userId} (non-fatal):`, err.message);
    }
}

/**
 * Checks the user's own calendar for a conflict right now. Returns
 * { busy, reason } — busy is always false (fail open) if the check itself
 * errors, because a Calendar hiccup should never be the reason a WhatsApp
 * send silently never goes out.
 */
async function checkAvailabilityNow(userId) {
    try {
        if (!isConfigured()) return { busy: false };
        const client = getClientForUser(userId);
        if (!client || !client.checkAvailability) return { busy: false };

        const now = new Date();
        const soon = new Date(now.getTime() + 60 * 1000);
        const busyBlocks = await queryBusyBlocks(client, now.toISOString(), soon.toISOString());
        return { busy: busyBlocks.length > 0 };
    } catch (err) {
        console.warn(`⚠️ Calendar: availability check failed for user ${userId}, sending anyway (non-fatal):`, err.message);
        return { busy: false };
    }
}

/** Raw freebusy.query wrapper shared by checkAvailabilityNow and getBusyBlocks. */
async function queryBusyBlocks(client, timeMinIso, timeMaxIso) {
    const res = await client.calendar.freebusy.query({
        requestBody: {
            timeMin: timeMinIso,
            timeMax: timeMaxIso,
            items: [{ id: client.calendarId }]
        }
    });
    return res.data.calendars?.[client.calendarId]?.busy || [];
}

/**
 * Returns this user's busy blocks (each `{ start, end }`, ISO strings) over
 * an arbitrary range — used by the appointment-booking feature to compute
 * which candidate slots are actually free. Returns `[]` (never throws) if
 * Calendar isn't configured/connected or the lookup fails: an account with
 * no calendar connected is still bookable purely off the internal
 * appointments table, and a Calendar hiccup should mean "can't double-check
 * busy times right now", not "booking is broken".
 */
async function getBusyBlocks(userId, timeMinIso, timeMaxIso) {
    try {
        if (!isConfigured()) return [];
        const client = getClientForUser(userId);
        if (!client) return [];
        return await queryBusyBlocks(client, timeMinIso, timeMaxIso);
    } catch (err) {
        console.warn(`⚠️ Calendar: busy-block lookup failed for user ${userId} (non-fatal):`, err.message);
        return [];
    }
}

/**
 * Creates a calendar event for a newly booked appointment. Best-effort: the
 * appointment is already recorded in our own `appointments` table by the
 * time this runs, so a Calendar failure here must not undo or fail the
 * booking — it just means that one appointment won't show up on the
 * owner's Google Calendar until the next manual sync. Returns the created
 * event's id, or null if Calendar isn't connected/configured or the call
 * failed.
 */
async function createAppointmentEvent(userId, { phone, contactName, startIso, endIso, notes }) {
    try {
        if (!isConfigured()) return null;
        const client = getClientForUser(userId);
        if (!client) return null;

        const who = contactName || phone;
        const description = [
            `${LOGGED_EVENT_TAG} Appointment with ${who} (${phone})`,
            notes ? `\n${notes}` : ''
        ].join('').slice(0, 8000);

        const res = await client.calendar.events.insert({
            calendarId: client.calendarId,
            requestBody: {
                summary: `Appointment: ${who}`,
                description,
                start: { dateTime: startIso },
                end: { dateTime: endIso }
            }
        });
        return res.data && res.data.id ? res.data.id : null;
    } catch (err) {
        console.warn(`⚠️ Calendar: could not create appointment event for user ${userId} (non-fatal):`, err.message);
        return null;
    }
}

/** Deletes a previously-created appointment event. Best-effort — a cancellation must succeed in our own DB regardless of Calendar's state. */
async function cancelAppointmentEvent(userId, eventId) {
    try {
        if (!eventId || !isConfigured()) return;
        const client = getClientForUser(userId);
        if (!client) return;
        await client.calendar.events.delete({ calendarId: client.calendarId, eventId });
    } catch (err) {
        console.warn(`⚠️ Calendar: could not delete appointment event ${eventId} for user ${userId} (non-fatal):`, err.message);
    }
}

/**
 * Parses "WhatsApp: <phone> [optional name]" style event titles into a
 * phone number. Fairly permissive — a business owner typing into Google
 * Calendar's title field is not going to match a strict grammar — but
 * requires the "WhatsApp:" prefix so ordinary personal/business events on
 * the same calendar are never mistaken for scheduling instructions.
 */
function parseEventTitle(summary) {
    if (!summary) return null;
    const match = /^\s*whatsapp\s*:\s*([+\d][\d\s-]{5,20})/i.exec(summary);
    if (!match) return null;
    return match[1].replace(/[\s-]/g, '');
}

/**
 * Scans the user's calendar for upcoming "WhatsApp: <phone>" events not yet
 * imported, and creates a normal scheduled_messages row for each — which
 * then goes through the exact same atomic-claim send path as any message
 * scheduled from the dashboard (see scheduler.js). Returns how many were
 * imported.
 */
async function syncEventsToScheduledMessages(userId) {
    const client = getClientForUser(userId);
    if (!client) return 0;

    const now = new Date();
    const until = new Date(now.getTime() + SYNC_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    let events;
    try {
        const res = await client.calendar.events.list({
            calendarId: client.calendarId,
            timeMin: now.toISOString(),
            timeMax: until.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250
        });
        events = res.data.items || [];
    } catch (err) {
        console.warn(`⚠️ Calendar: sync failed for user ${userId} (non-fatal):`, err.message);
        return 0;
    }

    let imported = 0;
    for (const event of events) {
        if (!event.id || !event.start) continue;
        // Never re-import our own outreach-log events, and never import the
        // same calendar event twice across sync ticks.
        if (event.description && event.description.includes(LOGGED_EVENT_TAG)) continue;
        if (isCalendarEventSynced(userId, event.id)) continue;

        const phone = parseEventTitle(event.summary);
        if (!phone) continue;

        const startIso = event.start.dateTime || (event.start.date ? `${event.start.date}T09:00:00` : null);
        if (!startIso) continue;

        // Respect the same per-user pending-schedule ceiling the dashboard's
        // "Schedule a message" form enforces (routes/api.js), so a calendar
        // full of tagged events can't bypass it.
        if (countPendingScheduledMessages(userId) >= LIMITS.MAX_PENDING_SCHEDULED_PER_USER) {
            console.warn(`⚠️ Calendar: user ${userId} has too many pending scheduled messages — stopping import for this tick.`);
            break;
        }

        try {
            const scheduledAt = toSqliteUtc(new Date(startIso));
            const body = (event.description || `Hi, this is a scheduled message via ${event.summary}.`).slice(0, 4000);
            const msg = createScheduledMessage(userId, phone, body, scheduledAt);
            markCalendarEventSynced(event.id, userId, msg.id);
            imported++;
        } catch (err) {
            // A malformed event (bad date, phone that fails normalization
            // downstream) shouldn't stop the rest of the sync — mark it
            // synced anyway so it isn't retried forever.
            markCalendarEventSynced(event.id, userId, null);
            console.warn(`⚠️ Calendar: skipped unimportable event ${event.id} for user ${userId}:`, err.message);
        }
    }

    touchCalendarLastSync(userId);
    return imported;
}

module.exports = {
    isConfigured,
    getAuthUrl,
    connectAccount,
    isConnected,
    disconnectAccount,
    setAvailabilityCheck,
    logOutreachEvent,
    checkAvailabilityNow,
    syncEventsToScheduledMessages,
    getBusyBlocks,
    createAppointmentEvent,
    cancelAppointmentEvent
};
