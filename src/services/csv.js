/**
 * csv.js — tiny dependency-free CSV parser for the contacts import feature.
 *
 * Deliberately not using a library (papaparse etc.) for something this
 * small — one function, no new npm dependency, no new attack surface from
 * a package we'd otherwise never touch again. Handles the things a real
 * contacts export commonly has: quoted fields, commas and newlines inside
 * quotes, escaped quotes (""), and both \n and \r\n line endings.
 *
 * Every bound in here exists because the parser runs on the single shared
 * event loop: a pathological file must fail fast rather than hold the
 * process while every other tenant's request waits.
 */

const DEFAULTS = {
    maxRows: 5001,        // one more than the import cap, so the caller can detect "too many"
    maxColumns: 200,
    maxFieldLength: 10000
};

/** Parses raw CSV text into an array of row objects keyed by the header row. */
function parseCSV(text, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const rows = parseRows(text, opts);
    if (rows.length === 0) return [];

    const header = rows[0].map(h => String(h).trim());
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim() !== ''));

    return dataRows.map(cells => {
        const obj = {};
        header.forEach((key, i) => {
            // A duplicated header column would otherwise silently overwrite:
            // first occurrence wins, which matches what a spreadsheet shows.
            if (Object.prototype.hasOwnProperty.call(obj, key)) return;
            obj[key] = cells[i] !== undefined ? cells[i] : '';
        });
        return obj;
    });
}

/**
 * Splits raw CSV text into an array of rows, each an array of raw string cells.
 *
 * Stops early once maxRows is reached. That matters for more than speed: a
 * 50MB file of newlines would otherwise build a 50-million-element array
 * before the caller ever got a chance to reject it for being too long.
 */
function parseRows(text, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    if (typeof text !== 'string') return [];

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let truncatedField = false;

    const pushField = () => {
        if (row.length < opts.maxColumns) row.push(field);
        field = '';
    };
    const pushRow = () => {
        rows.push(row);
        row = [];
    };

    // Normalize line endings up front so the state machine below only has \n to worry about.
    const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < s.length; i++) {
        const c = s[i];

        if (inQuotes) {
            if (c === '"') {
                if (s[i + 1] === '"') { appendChar('"'); i++; } // escaped quote
                else inQuotes = false;
            } else {
                appendChar(c);
            }
            continue;
        }

        if (c === '"') { inQuotes = true; continue; }
        if (c === ',') { pushField(); continue; }
        if (c === '\n') {
            pushField();
            pushRow();
            if (rows.length >= opts.maxRows) return rows;
            continue;
        }
        appendChar(c);
    }

    // Last field/row (files don't always end with a trailing newline).
    if (field !== '' || row.length > 0) { pushField(); pushRow(); }

    return rows;

    function appendChar(ch) {
        // Silently truncate an absurdly long single field rather than letting
        // one unterminated quote turn the entire remaining file into one
        // string that then gets stored.
        if (field.length >= opts.maxFieldLength) { truncatedField = true; return; }
        field += ch;
    }
}

/**
 * Maps a raw parsed row (keyed by whatever the CSV's own header text was) to
 * the {phone, name, label, notes} shape bulkUpsertContacts expects. Accepts
 * a handful of common header spellings so "Mobile Number" or "WhatsApp #"
 * both work as well as "phone" — most real-world contact exports (Google
 * Contacts, a spreadsheet someone typed by hand, another CRM's export)
 * don't use our exact column names.
 */
const FIELD_ALIASES = {
    phone: ['phone', 'phone number', 'mobile', 'mobile number', 'whatsapp', 'whatsapp number', 'whatsapp #', 'number', 'contact number', 'phone_number'],
    name:  ['name', 'full name', 'contact name', 'first name'],
    label: ['label', 'tag', 'tags', 'category', 'group'],
    notes: ['notes', 'note', 'comment', 'comments', 'description']
};

function mapContactRow(rawRow) {
    // Object.create(null): a CSV header literally spelled "__proto__" or
    // "constructor" would otherwise write to the prototype chain of this
    // lookup object instead of a normal key. Harmless here in isolation, but
    // it is exactly the shape of a prototype-pollution bug and costs nothing
    // to avoid.
    const lowerKeys = Object.create(null);
    for (const key of Object.keys(rawRow)) {
        lowerKeys[String(key).trim().toLowerCase()] = rawRow[key];
    }

    const pick = (aliases) => {
        for (const alias of aliases) {
            const value = lowerKeys[alias];
            if (value !== undefined && value !== '') return value;
        }
        return '';
    };

    return {
        phone: pick(FIELD_ALIASES.phone),
        name:  pick(FIELD_ALIASES.name),
        label: pick(FIELD_ALIASES.label),
        notes: pick(FIELD_ALIASES.notes)
    };
}

module.exports = { parseCSV, parseRows, mapContactRow, FIELD_ALIASES };
