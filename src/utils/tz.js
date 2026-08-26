/**
 * tz.js — timezone-aware wall-clock <-> UTC conversion for IANA zones.
 *
 * The appointment feature stores every timestamp in UTC (same as the rest
 * of this codebase — see toSqliteUtc in validate.js), but a business owner
 * configures their working hours ("9am to 6pm") in their own local time.
 * These helpers are the only place that boundary is crossed, using nothing
 * but Intl (Node's bundled full-ICU covers every IANA zone) so this feature
 * doesn't need a date-library dependency the rest of the project doesn't
 * otherwise have.
 */

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function offsetMinutesAt(instantMs, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'longOffset',
        hour: '2-digit',
        hour12: false
    });
    const parts = dtf.formatToParts(new Date(instantMs));
    const tzPart = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+00:00';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(tzPart);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
}

/**
 * Converts a wall-clock date/time in `timeZone` to a UTC Date object.
 * Two passes correctly resolve the (rare, and moot for a fixed-offset zone
 * like Asia/Kolkata) case where the guessed instant lands on a DST
 * transition.
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
    let guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    for (let i = 0; i < 2; i++) {
        const offsetMin = offsetMinutesAt(guessMs, timeZone);
        guessMs = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMin * 60000;
    }
    return new Date(guessMs);
}

/** Breaks a UTC instant into wall-clock parts (and weekday, 0=Sunday) in `timeZone`. */
function utcToZonedParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, weekday: 'short'
    });
    const parts = {};
    for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
    let hour = parseInt(parts.hour, 10);
    if (hour === 24) hour = 0; // some locales render midnight as "24"
    return {
        year: parseInt(parts.year, 10),
        month: parseInt(parts.month, 10),
        day: parseInt(parts.day, 10),
        hour,
        minute: parseInt(parts.minute, 10),
        second: parseInt(parts.second, 10),
        weekday: WEEKDAY_INDEX[parts.weekday] !== undefined ? WEEKDAY_INDEX[parts.weekday] : new Date(date).getUTCDay()
    };
}

/** True if `timeZone` is a real IANA zone name Intl accepts. */
function isValidTimeZone(timeZone) {
    try {
        // eslint-disable-next-line no-new
        new Intl.DateTimeFormat(undefined, { timeZone });
        return true;
    } catch (e) {
        return false;
    }
}

/** Human-readable label for a UTC instant in the given zone, e.g. "Mon, 25 Aug, 3:30 pm". */
function formatInZone(date, timeZone) {
    return new Intl.DateTimeFormat('en-IN', {
        timeZone,
        weekday: 'short', day: '2-digit', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
    }).format(date);
}

module.exports = { zonedWallTimeToUtc, utcToZonedParts, isValidTimeZone, formatInZone };
