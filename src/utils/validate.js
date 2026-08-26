/**
 * validate.js — one place for every "can I trust this value?" decision.
 *
 * Everything a client can send reaches the database, the WhatsApp JID
 * builder, or a RegExp constructor. Each of those has a way to hurt us:
 * unbounded strings grow the (fully in-memory) SQLite database until the
 * process dies, an unvalidated "phone" becomes an arbitrary WhatsApp
 * address (group JID, broadcast list, status), and a user-supplied regex
 * can block the single event loop for every tenant at once.
 *
 * So validation is centralised here rather than sprinkled per-route: a
 * route that forgets to call one of these is the bug, and the tests in
 * tests/validation.test.js pin the behaviour down.
 */

// ─── Size limits ───────────────────────────────────────────────
// Chosen from what the product actually needs, not from what SQLite can
// hold. A WhatsApp text message caps out around 65k characters; a contact
// name that needs 200 characters is already pathological.
const LIMITS = {
    PHONE_DIGITS_MIN: 7,          // shortest real national number
    PHONE_DIGITS_MAX: 15,         // E.164 hard maximum
    CONTACT_NAME: 200,
    CONTACT_LABEL: 60,
    CONTACT_NOTES: 2000,
    MESSAGE_BODY: 4096,           // WhatsApp itself rejects far less than this in practice
    RULE_KEYWORD: 200,
    RULE_REGEX_SOURCE: 200,
    RULE_RESPONSE: 4096,
    PRODUCT_NAME: 200,
    PRODUCT_DESCRIPTION: 2000,
    PRODUCT_PRICE: 60,
    PRODUCT_CATEGORY: 60,
    PRODUCT_URL: 500,
    CRM_NOTES: 4000,
    CRM_NOTE_ENTRY: 2000,
    CRM_PRODUCT_INTEREST: 300,
    SETTING_VALUE_DEFAULT: 1000,
    SEARCH_QUERY: 100,
    // Per-tenant row caps — the point where "a lot of data" becomes "a
    // denial of service against every other tenant on the box", since one
    // shared in-memory database is exported to disk on every write.
    MAX_CONTACTS_PER_USER: 50000,
    MAX_RULES_PER_USER: 500,
    MAX_PRODUCTS_PER_USER: 1000,
    MAX_PENDING_SCHEDULED_PER_USER: 2000,
    MAX_DEALS_PER_USER: 50000,
    MAX_APPOINTMENTS_PER_USER: 20000,
    APPOINTMENT_NOTES: 1000,
    // Pagination
    DEFAULT_PAGE_LIMIT: 100,
    MAX_PAGE_LIMIT: 500,
    MAX_OFFSET: 1000000,
    // Regex matching safety
    REGEX_INPUT_MAX: 1000
};

class ValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'ValidationError';
        this.status = 400;
        this.field = field;
    }
}

/**
 * Accepts only real strings. Numbers/booleans/objects/arrays are rejected
 * rather than coerced: `String([1,2])` is "1,2" and `String({})` is
 * "[object Object]" — silently storing either is how a client-side bug
 * turns into permanent junk in the database.
 */
function requireString(value, field, { max, min = 1, trim = true, allowEmpty = false } = {}) {
    if (typeof value !== 'string') {
        throw new ValidationError(`${field} must be a string.`, field);
    }
    const out = trim ? value.trim() : value;
    if (!allowEmpty && out.length < min) {
        throw new ValidationError(`${field} is required.`, field);
    }
    if (max !== undefined && out.length > max) {
        throw new ValidationError(`${field} must be ${max} characters or fewer.`, field);
    }
    return out;
}

/** Optional string: undefined/null become '', anything else must be a string. */
function optionalString(value, field, max) {
    if (value === undefined || value === null) return '';
    return requireString(value, field, { max, allowEmpty: true });
}

/**
 * Normalises a phone number to digits only and validates its length.
 *
 * Returning digits-only (never a WhatsApp JID) is the security-relevant
 * part: whatsapp-client.js appends "@c.us" itself, so a client can no
 * longer smuggle in "1234@g.us" (a group), "status@broadcast", or a raw
 * internal LID and have the server send to it. The digits-only shape also
 * has to match what the CSV importer produces, or the same person shows
 * up as two contacts depending on how they were added.
 */
function normalizePhone(value, field = 'phone') {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') {
        throw new ValidationError(`${field} must be a string of digits.`, field);
    }
    const raw = value.trim();
    if (raw.length > 40) {
        throw new ValidationError(`${field} is not a valid phone number.`, field);
    }
    // Strip the cosmetic characters real people type: + ( ) - space .
    const digits = raw.replace(/[\s()+\-.]/g, '');
    if (!/^\d+$/.test(digits)) {
        throw new ValidationError(`${field} must contain only digits (an optional leading + is allowed).`, field);
    }
    if (digits.length < LIMITS.PHONE_DIGITS_MIN || digits.length > LIMITS.PHONE_DIGITS_MAX) {
        throw new ValidationError(
            `${field} must be between ${LIMITS.PHONE_DIGITS_MIN} and ${LIMITS.PHONE_DIGITS_MAX} digits.`,
            field
        );
    }
    return digits;
}

/** Same rules as normalizePhone but returns null instead of throwing. */
function tryNormalizePhone(value) {
    try {
        return normalizePhone(value);
    } catch (e) {
        return null;
    }
}

/**
 * Integer with clamping. Used for pagination so that `?limit=999999999`
 * can't ask the process to materialise every row it owns into one JSON
 * response, and `?offset=-1` can't produce a SQL error.
 */
function clampInt(value, { min, max, fallback }) {
    let n;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    else return fallback;
    if (!Number.isFinite(n)) return fallback;
    n = Math.trunc(n);
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/** Strict positive integer id (route params). Rejects "1abc", "", "-1", 1e21. */
function requireId(value, field = 'id') {
    const s = typeof value === 'number' ? String(value) : value;
    if (typeof s !== 'string' || !/^\d{1,15}$/.test(s)) {
        throw new ValidationError(`${field} must be a positive integer.`, field);
    }
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) {
        throw new ValidationError(`${field} must be a positive integer.`, field);
    }
    return n;
}

function requireEnum(value, allowed, field) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`, field);
    }
    return value;
}

function optionalEnum(value, allowed, field) {
    if (value === undefined || value === null || value === '') return undefined;
    return requireEnum(value, allowed, field);
}

/** Finite non-negative number (deal values). Rejects NaN/Infinity/1e308 overflow. */
function clampNumber(value, { min = 0, max = 1e12, fallback = 0 } = {}) {
    let n;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    else return fallback;
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * A datetime the SQLite comparisons in this codebase can actually use.
 *
 * Every "is it due yet" query is `scheduled_at <= datetime('now')`, which
 * is a *string* comparison against "YYYY-MM-DD HH:MM:SS" in UTC. Storing
 * the client's raw input meant an ISO string with a "T" and a "Z" sorted
 * differently from datetime('now') — a job that either fired instantly or
 * never fired at all, depending on the character after the date. So parse
 * whatever came in, then store exactly one canonical format.
 */
function toSqliteUtc(value, field = 'scheduled_at') {
    if (value instanceof Date) {
        if (isNaN(value.getTime())) throw new ValidationError(`${field} is not a valid date/time.`, field);
        return formatSqliteUtc(value);
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError(`${field} is required.`, field);
    }
    const raw = value.trim();
    if (raw.length > 40) throw new ValidationError(`${field} is not a valid date/time.`, field);
    // Accept "YYYY-MM-DD HH:MM(:SS)" (treated as UTC, which is what the
    // dashboard sends) as well as full ISO-8601 with an explicit offset.
    const hasZone = /[Zz]$/.test(raw) || /[+-]\d\d:?\d\d$/.test(raw);
    const iso = raw.replace(' ', 'T') + (hasZone ? '' : 'Z');
    const d = new Date(iso);
    if (isNaN(d.getTime())) throw new ValidationError(`${field} is not a valid date/time.`, field);
    // Guard against absurd dates that would sort oddly / overflow displays.
    const year = d.getUTCFullYear();
    if (year < 2000 || year > 2100) {
        throw new ValidationError(`${field} must be between the years 2000 and 2100.`, field);
    }
    return formatSqliteUtc(d);
}

function formatSqliteUtc(d) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
           `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ─── Regex safety (ReDoS) ──────────────────────────────────────
/**
 * Chatbot rules let a tenant supply a regular expression that the server
 * then runs against incoming message text. Node's RegExp engine is
 * backtracking, so "(a+)+$" against a few dozen 'a's takes exponential
 * time — on the single shared event loop. One tenant's rule would freeze
 * the API for every other tenant, which makes this a cross-tenant
 * availability bug, not just a foot-gun for the tenant who wrote it.
 *
 * Node has no way to interrupt a running RegExp, so the only reliable
 * defence is to refuse dangerous patterns before they are ever stored,
 * and to bound the input they run against. This checks the two shapes
 * that actually cause exponential blowup:
 *
 *   1. a quantifier applied to a group that itself contains a quantifier
 *      — (a+)+, (a*)*, ([a-z]+)*, (\d+){2,}
 *   2. a quantifier applied to an alternation whose branches can match
 *      the same text — (a|aa)+, (a|a?)*
 *
 * plus backreferences (\1), which add their own exponential cases.
 */
function assertSafeRegexSource(source, field = 'trigger_keyword') {
    if (typeof source !== 'string' || source.length === 0) {
        throw new ValidationError(`${field} is required.`, field);
    }
    if (source.length > LIMITS.RULE_REGEX_SOURCE) {
        throw new ValidationError(
            `A regex rule must be ${LIMITS.RULE_REGEX_SOURCE} characters or fewer.`, field
        );
    }
    // Must compile at all.
    try {
        new RegExp(source, 'i');
    } catch (e) {
        throw new ValidationError(`That is not a valid regular expression: ${e.message}`, field);
    }
    if (/\\[1-9]/.test(source)) {
        throw new ValidationError(
            'Backreferences (\\1, \\2, …) are not allowed in regex rules — they can be extremely slow to evaluate.',
            field
        );
    }
    const reason = findCatastrophicConstruct(source);
    if (reason) {
        throw new ValidationError(
            `That regex could hang the server (${reason}). Simplify it, or use a "contains" rule instead.`,
            field
        );
    }
    return source;
}

const QUANTIFIER_RE = /[*+?]|\{\d+(,\d*)?\}/;

/**
 * Walks the pattern, finds each group, and reports the first group that is
 * both quantified and internally ambiguous. Deliberately conservative:
 * it would rather reject a safe-but-weird pattern than let a hang through,
 * because "contains" covers almost every rule a real user writes.
 */
function findCatastrophicConstruct(source) {
    const groups = extractGroups(source);
    for (const g of groups) {
        const after = source.slice(g.end + 1);
        const quantified = /^([*+]|\{\d+,\d*\}|\{[2-9]\d*\})/.test(after) ||
                           /^\?[*+]/.test(after); // (…)?+ style
        if (!quantified) continue;
        const body = g.body;
        // Nested quantifier: (a+)+ , (a{2,})* , ([a-z]*)+
        if (QUANTIFIER_RE.test(stripEscapes(body))) {
            return 'a repeated group that already contains a repetition';
        }
        // Ambiguous alternation: (a|aa)+ , (a|ab)+
        if (body.includes('|') && alternationOverlaps(body)) {
            return 'a repeated group whose alternatives can match the same text';
        }
    }
    return null;
}

function stripEscapes(s) {
    // Remove escaped characters so "\\+" isn't mistaken for a quantifier,
    // and drop character-class contents where * and + are literals.
    return s.replace(/\\./g, '').replace(/\[[^\]]*\]/g, 'C');
}

function extractGroups(source) {
    const groups = [];
    const stack = [];
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '\\') { i++; continue; }
        if (c === '[') {
            // Skip character class wholesale.
            i++;
            while (i < source.length && source[i] !== ']') {
                if (source[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (c === '(') stack.push(i);
        else if (c === ')' && stack.length) {
            const start = stack.pop();
            let bodyStart = start + 1;
            // Skip group modifiers: (?:  (?=  (?!  (?<name>  (?<=  (?<!
            const mod = source.slice(bodyStart).match(/^\?(:|=|!|<[=!]|<[A-Za-z_$][\w$]*>)/);
            if (mod) bodyStart += mod[0].length;
            groups.push({ start, end: i, body: source.slice(bodyStart, i) });
        }
    }
    return groups;
}

function alternationOverlaps(body) {
    const parts = splitAlternation(body);
    if (parts.length < 2) return false;
    for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
            const a = parts[i], b = parts[j];
            if (a === '' || b === '') return true;               // (a|)+ always loops
            if (a.startsWith(b) || b.startsWith(a)) return true; // (a|aa)+ classic
        }
    }
    return false;
}

function splitAlternation(body) {
    const parts = [];
    let depth = 0, cur = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\') { cur += c + (body[i + 1] || ''); i++; continue; }
        if (c === '[') {
            let cls = c; i++;
            while (i < body.length && body[i] !== ']') {
                if (body[i] === '\\') { cls += body[i]; i++; }
                cls += body[i]; i++;
            }
            cur += cls + ']';
            continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    parts.push(cur);
    return parts;
}

/**
 * Runs an already-validated rule regex against message text with a hard
 * input-length bound. assertSafeRegexSource has rejected the exponential
 * shapes; bounding the input keeps even a merely-slow polynomial pattern
 * (which is legitimate and hard to detect statically) to a few
 * microseconds instead of scaling with whatever a sender pastes in.
 */
function safeRegexTest(source, text) {
    if (typeof text !== 'string') return false;
    const input = text.length > LIMITS.REGEX_INPUT_MAX ? text.slice(0, LIMITS.REGEX_INPUT_MAX) : text;
    let re;
    try {
        re = new RegExp(source, 'i');
    } catch (e) {
        return false;
    }
    try {
        return re.test(input);
    } catch (e) {
        return false;
    }
}

// ─── CSV / spreadsheet formula injection ───────────────────────
/**
 * A cell beginning with = + - @ (or a tab/CR, which Excel treats the same
 * way) is executed as a formula when the file is opened in Excel, Sheets,
 * or LibreOffice — =HYPERLINK(...) exfiltrates data, and legacy
 * =cmd|'...' can execute. We store contact data that a user may later
 * export and open in a spreadsheet, so neutralise it at the boundary
 * where it enters our database rather than hoping every future export
 * path remembers to.
 *
 * Prefixing with an apostrophe is the standard neutralisation and is what
 * spreadsheets themselves write when they quote a literal.
 */
function sanitizeSpreadsheetCell(value) {
    if (typeof value !== 'string' || value === '') return value;
    if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
    return value;
}

// ─── Appointment booking ────────────────────────────────────────
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validates "HH:MM" 24-hour time strings used by the weekly availability template. */
function assertHHMM(value, field) {
    if (typeof value !== 'string' || !HHMM_RE.test(value)) {
        throw new ValidationError(`${field} must be a 24-hour time in HH:MM format (e.g. "09:00").`, field);
    }
    return value;
}

/**
 * Validates a working-days list: an array (or comma-separated string) of
 * integers 0–6 (0 = Sunday, matching JS Date#getDay / Intl weekday order).
 * Returns the canonical comma-separated string the DB column stores.
 */
function normalizeWorkingDays(value, field = 'workingDays') {
    let arr = value;
    if (typeof arr === 'string') arr = arr.split(',').map(s => s.trim()).filter(s => s !== '');
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new ValidationError(`${field} must be a non-empty list of weekdays.`, field);
    }
    const days = arr.map(v => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 6) {
            throw new ValidationError(`${field} must only contain integers 0-6 (0 = Sunday).`, field);
        }
        return n;
    });
    return [...new Set(days)].sort((a, b) => a - b).join(',');
}

// ─── Settings ──────────────────────────────────────────────────
/**
 * PUT /api/settings used to write any key a client sent, at any length.
 * That is an unbounded per-tenant write primitive into a shared
 * in-memory-then-exported-to-disk database: a loop posting 1MB values
 * under random keys grows the file every other tenant's writes must
 * re-export, until the process runs out of memory. It also let a client
 * overwrite server-owned keys such as business_ai_profile.
 *
 * So: an explicit allow-list of client-writable keys, each with its own
 * length cap and (where it matters) an allowed set of values.
 */
const SETTINGS_SCHEMA = {
    chatbot_enabled:              { type: 'bool' },
    ai_enabled:                   { type: 'bool' },
    away_mode:                    { type: 'bool' },
    lead_analysis_auto:           { type: 'bool' },
    ai_mode:                      { type: 'enum', values: ['ai_first', 'rules_first'] },
    default_reply:                { max: 4096 },
    away_message:                 { max: 4096 },
    ai_system_prompt:             { max: 8000 },
    gemini_api_key:               { max: 200, secret: true },
    business_name:                { max: 200 },
    owner_name:                   { max: 200 },
    business_website:             { max: 500 },
    business_description:         { max: 4000 },
    business_industry:            { max: 200 },
    business_target_customers:    { max: 1000 },
    business_offers:              { max: 2000 },
    business_currency:            { max: 8 }
};

/** Keys the server writes itself and a client must never be able to set. */
const SERVER_OWNED_SETTINGS = new Set(['business_ai_profile']);

/**
 * Filters an incoming settings patch down to what the caller may change.
 * Unknown keys are reported (not silently dropped) so a genuine frontend
 * typo surfaces as a 400 instead of a setting that mysteriously never
 * saves — but they are never written either way.
 */
function validateSettingsPatch(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Settings must be sent as a JSON object.', 'settings');
    }
    const keys = Object.keys(body);
    if (keys.length > 60) {
        throw new ValidationError('Too many settings in one request.', 'settings');
    }
    const accepted = {};
    const rejected = [];
    for (const key of keys) {
        if (SERVER_OWNED_SETTINGS.has(key) || !Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) {
            rejected.push(key);
            continue;
        }
        const spec = SETTINGS_SCHEMA[key];
        let value = body[key];

        if (spec.type === 'bool') {
            if (typeof value === 'boolean') value = value ? 'true' : 'false';
            else if (value === 'true' || value === 'false') { /* already fine */ }
            else throw new ValidationError(`${key} must be true or false.`, key);
        } else if (spec.type === 'enum') {
            value = requireEnum(typeof value === 'string' ? value : '', spec.values, key);
        } else {
            if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
            value = requireString(value, key, { max: spec.max, allowEmpty: true, trim: false });
        }
        accepted[key] = value;
    }
    return { accepted, rejected };
}

module.exports = {
    LIMITS,
    ValidationError,
    requireString,
    optionalString,
    normalizePhone,
    tryNormalizePhone,
    clampInt,
    clampNumber,
    requireId,
    requireEnum,
    optionalEnum,
    toSqliteUtc,
    formatSqliteUtc,
    assertSafeRegexSource,
    safeRegexTest,
    findCatastrophicConstruct,
    sanitizeSpreadsheetCell,
    validateSettingsPatch,
    SETTINGS_SCHEMA,
    SERVER_OWNED_SETTINGS,
    assertHHMM,
    normalizeWorkingDays
};
