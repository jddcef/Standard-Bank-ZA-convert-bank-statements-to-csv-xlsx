#!/usr/bin/env node
/**
 * Produces a commit-safe, anonymised copy of a real statement PDF.
 *
 *   npm run anonymise -- <statement.pdf> [--name current-account-basic]
 *   npm run anonymise -- test/fixtures/originals/*.pdf
 *   npm run anonymise -- --shift-digits <statement.pdf>
 *
 * ## How it works
 *
 * Words are replaced **in place**, inside the PDF's own content streams. Only
 * the bytes of string operands of the text-showing operators `Tj`, `TJ`, `'`
 * and `"` are touched. Every other byte — font programs, `/Widths`, `cm`
 * matrices, `Td` offsets, vector rules, embedded images — is copied through
 * untouched. The result looks exactly like the original except that the words
 * are gibberish: same fonts, same column alignment, same colours, same page
 * furniture.
 *
 * Why a substitution cannot wreck the layout, established by inspecting every
 * statement in `test/fixtures/originals`:
 *
 *   - The generator emits an explicit `Td` before *every* text run, with
 *     generator-computed offsets. Nothing is positioned relative to the advance
 *     width of the run before it, so a changed string width moves nothing.
 *   - There are no `Tz` (horizontal scaling), `Tc` (char spacing) or `Tw`
 *     (word spacing) operators anywhere in the corpus, so no glyph can be
 *     scaled or respaced as a side effect.
 *   - Consecutive show operations with no repositioning between them: zero.
 *
 * Replacement words are additionally generated at the **same length** as the
 * word they replace, so even the advance width is unchanged.
 *
 * ## What is preserved, and why
 *
 * Monetary figures, dates and the parser's own vocabulary are left alone.
 * These fixtures exist to test `bank_parser_v7.js`, and that parser is
 * anchored to real strings: `DEFAULT_JUNK_KEYWORDS`, `DEFAULT_CATEGORIES`,
 * `BALANCE BROUGHT FORWARD`, `Card Division`, the `dd mm` and `dd Mmm yy` row
 * anchors, month names, the `" | "` continuation joiner. Renaming any of those
 * would silently change what the parser produces and make the fixtures
 * worthless. Everything the parser keys off is therefore listed in
 * `PROTECTED_PHRASES`, matched case- and whitespace-insensitively so a phrase
 * split across `TJ` operands still matches.
 *
 * Digits default to a full-parity map (0→0, 1→1, … 9→9). Account and reference
 * numbers are masked — with the parity map they become visibly synthetic
 * figures such as `370 237 174 0` — while dates and money stay provably
 * identical, which keeps the figure-coverage and balance-chain tests exact.
 * `--shift-digits` applies a fixed permutation instead, for identity masking
 * where the original digits must not be derivable.
 *
 * Substitution is deterministic: the same source word always becomes the same
 * replacement. The full map is written to
 * `test/fixtures/pdfs/<name>.anonymisation-manifest.json`, so a reviewer can
 * verify exactly what changed and check nothing sensitive remains. The tool
 * also re-extracts its own output with pdf.js and fails loudly if any
 * monetary figure went missing.
 *
 * IMPORTANT: this is a redaction *aid*, not a guarantee. Read the manifest and
 * eyeball the rendered pages before committing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    PDFDocument,
    PDFArray,
    PDFDict,
    PDFName,
    decodePDFRawStream
} from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'pdfs');

// ===========================================================================
// 1. Protected vocabulary
// ===========================================================================

/**
 * Phrases that must survive byte-for-byte, because `bank_parser_v7.js` keys
 * off them.
 *
 * Matching normalises to uppercase with all whitespace removed, so a `TJ` array
 * that splits `BALANCE BROUGHT` / ` FORWARD` across two operands still
 * matches and is never half-rewritten.
 */
const PROTECTED_PHRASES = [
    // --- DEFAULT_JUNK_KEYWORDS: the parser DELETES lines containing these, so
    //     renaming one would turn a disclaimer into a transaction row. ---
    'Standard Bank', 'BANK STATEMENT', 'TAX INVOICE', 'BUSINESS CURRENT ACCOUNT',
    'Statement Frequency', 'VAT Reg. No.', 'Statement from', 'Account Number',
    'Month-end Balance', 'DAILY BALANCE ANALYSIS', 'Account Summary',
    'Details of Agreement', 'Summary of Transactions', 'VAT Summary',
    'Fee Structure', 'Overdraft Rate*', 'BizDirect', 'PO BOX',
    'Registered credit provider', 'Ombudsman', 'Details Service',
    'Debits Credits', 'Date Balance', 'unresolved disputes',
    'Authorised financial services', 'Page ', 'Statement No',
    'Statement / Invoice No', 'Fee Debits', 'Fees include VAT',
    '*Overdraft facilities', 'Annual Rate of Interest',
    'Monthly Repayment amount', 'Frequency of instalment',
    'Balance available at date of statement', 'Arranged Limit',
    'Net Payment Received', 'Interest Charged', 'Total charge amount',
    'This document constitutes a Credit Note', 'www.standardbank.co.za', 'VAT',

    // --- classifyStatement() decision keywords ---
    'CARD DIVISION', 'GOLD CARD', 'PLATINUM CARD', 'CREDIT LIMIT',
    'AVAILABLE MONEY TO SPEND', 'TRANSACTION DETAILS ACCOUNT',
    'DATE DESCRIPTION', 'AMOUNT (R)', 'BALANCE (R)',

    // --- DEFAULT_CATEGORIES: getCategory() splits on ':' and lowercases both
    //     sides, so both the label and the value must keep matching ---
    'SERVICE FEE', 'CASH DEPOSIT FEE', 'INTEREST', 'SALARY', 'ATM', 'EFT',
    'PURCHASE',

    // --- BALANCE BROUGHT FORWARD: the opening-balance anchor, referenced from
    //     five separate regexes across all three statement engines ---
    'BALANCE BROUGHT FORWARD', 'Balance brought forward',
    'balance brought forward',

    // --- credit-card column headers, which the engine splits on ':' ---
    'Purchases', 'Purchase', 'Sale', 'Payment', 'Payments', 'Debit', 'Debits',
    'Credit', 'Credits', 'Instalment', 'Instalments', 'BALANCE BROUGHT',
    'CLOSING BALANCE', 'Closing balance', 'PAYMENTS AND CREDITS',
    'PURCHASES AND DEBITS', 'Card Division', 'Card type', 'TOTAL',

        // --- The same vocabulary, one word at a time.
        //
        // Phrase matching alone is not enough. `TJ` arrays split mid-word, so the
        // literal holding `BALANCE BROUGHT` and the literal holding ` FORWARD` are
        // separate strings and neither contains the whole phrase. Protecting each
        // word independently is what keeps the anchor intact no matter where the
        // generator chose to break it. Bank name and branches are included for the
        // same reason: they identify no one, they appear in the junk-keyword list,
        // and renaming them moves text across column boundaries. ---
        'BALANCE', 'BROUGHT', 'FORWARD', 'BALANCE CARRIED FORWARD',
        'Card', 'Date', 'Description', 'Amount', 'Debits', 'Credits',
        'Opening', 'Closing', 'Previous', 'Carried', 'Brought', 'Forward',
        'Subtotal', 'Total', 'Payments', 'Received', 'Encashed', 'Deposits',
        'Other', 'Credit', 'Transactions', 'Purchase', 'Purchases', 'Payment',
        'Instalment', 'Instalments', 'Monthly', 'Plan', 'Arrears', 'Available',
        'Money', 'Spend', 'Limit', 'Transaction', 'Details', 'Minimum', 'Due',
        'Card', 'Spend', 'Cash', 'Back', 'Budget', 'Facility', 'Interest',
        'Charged', 'Fees', 'And', 'Currency', 'Country', 'International',
        'Statement', 'Due', 'Opening', 'Closing', 'Value', 'Reference',
        'Previous', 'Adjustment', 'Debit', 'Order', 'Number', 'Type',
        'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
        'Bank', 'Standard', 'VAT', 'Account', 'Number', 'Balance', 'Total',
        'PINELANDS', 'Pinelands', 'MARSHALLTOWN', 'Marshalltown', 'STELLENBOSCH',
        'Stellenbosch', 'Cape', 'Gauteng', 'NCRCP', 'Ncr', 'Catholic',

    // --- structural markers the app and the tests rely on ---
    'Continued on next page', '***End of Statement***',
    'Bank Statement / Tax Invoice', 'Statement Period', 'Statement Number',
    'Statement / Invoice Number', 'Available Balance', 'Account:',
    'Account Number', 'Account number',

    // --- MONTHS[] (3-letter abbreviations) and parseWeeklyStatement's
        //     monthMap (full names, lowercased before lookup). The abbreviations
        //     matter most: a row date reads `16 Mar`, so replacing `Mar` changes
        //     the month the parser resolves. ---
        'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December',
        'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
        'september', 'october', 'november', 'december',
        'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT',
        'NOV', 'DEC',
        'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
        'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',

    // --- Afrikaans statement furniture ---
    'SUID-AFRIKA', 'GEMAGTIGDE', 'BEPERK', 'FINANSI', 'VERSKAFFER',
    'KREDIETVERSKAFFER', 'DIENSTE', 'RENTE', 'KREDIE', 'VERSKYFMONSTER',
    'REKENING', 'SALDO', 'FINANSIELE',

    // --- other institutions appear as counterparties; they identify nobody ---
    'ABSA', 'Capitec', 'Nedbank', 'FNB', 'SARS', 'SASSA'
];

/** Whitespace-free, uppercase forms, for substring matching. */
const PROTECTED_FLAT = PROTECTED_PHRASES.map((p) => p.replace(/\s+/g, '').toUpperCase());

/**
 * Identifier formats to mask even though they contain no letters and would
 * otherwise pass through untouched — because they *are* the account, card or
 * identity numbers.
 */
const IDENTIFIER_PATTERNS = [
    { kind: 'account-number', re: /^\d{2}(?:\s+\d{3}){2}\s+\d$/ },   // 27 021 178 0
    { kind: 'card-number', re: /^\d{4}(?:\s+\*{4}){3}\s*\d{4}$/ }, // 5221 **** **** 1312
    { kind: 'card-number', re: /^\d{4}\s+\d{4}$/ },                  // 5520 7838
    { kind: 'id-number', re: /^\d{6}-?\d{2}-?\d{4}$/ },
    { kind: 'vat-number', re: /^\d{10}$/ },
    { kind: 'account-number', re: /^\d{9,13}$/ },
    { kind: 'account-number', re: /^\d{6,8}$/ }
];

/** A token with no letters or digits: pure punctuation, never substitute. */
const NON_WORD = /^[^\w]*$/;

// ===========================================================================
// 2. Deterministic gibberish generation
// ===========================================================================

const CONSONANTS = 'qxzjkvtbnmwgpfhcsd';
const VOWELS = 'aeiou';

/** FNV-1a. Small, stable, identical across runs and platforms. */
function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** xorshift32 seeded from a string, so output is reproducible. */
function rng(seed) {
    let s = hash32(seed) || 0x9e3779b9;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0x100000000;
    };
}

/**
 * Builds a consonant/vowel pattern of exactly `len` characters: pronounceable
 * nonsense, never an English word and never a real name, so a reviewer reading
 * the output can see at a glance that it has been replaced.
 */
function pattern(len, seed) {
    if (len === 0) return '';
    const r = rng(`pat:${seed}`);
    let out = '';
    for (let i = 0; i < len; i++) {
        out += i % 2 === 0
            ? CONSONANTS[Math.floor(r() * CONSONANTS.length)]
            : VOWELS[Math.floor(r() * VOWELS.length)];
    }
    return out;
}

/**
 * The deterministic replacement for `word`, memoised per run so the manifest
 * shows each word once and the same word always yields the same replacement.
 *
 * Length is preserved exactly; with no `Tz`/`Tc`/`Tw` in these documents that
 * means the substituted text occupies precisely the same width on the page.
 */
function fakeWord(word, ctx) {
    const hit = ctx.words.get(word);
    if (hit !== undefined) return hit;
    let out = pattern(word.length, word);
    if (/^\d/.test(out)) out = `q${out.slice(1)}`;
    ctx.words.set(word, out);
    return out;
}

/** Mirrors the source's capitalisation onto the replacement. */
function recase(source, replacement) {
    if (source === source.toUpperCase() && /[A-Z]/.test(source)) return replacement.toUpperCase();
    if (source === source.toLowerCase()) return replacement.toLowerCase();
    const body = replacement.slice(1).toLowerCase();
    return source[0] === source[0].toUpperCase()
        ? replacement[0].toUpperCase() + body
        : replacement.toLowerCase();
}

// ===========================================================================
// 3. Digit masking
// ===========================================================================

/** Identity: dates, money and page numbers are deliberately left alone. */
const PARITY = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9 };
/** Fixed permutation, for when the original digits must not be derivable. */
const SHIFT = { 0: 3, 1: 7, 2: 9, 3: 1, 4: 6, 5: 0, 6: 8, 7: 2, 8: 5, 9: 4 };

function maskDigitsIn(str, mode) {
    const map = mode === 'shift' ? SHIFT : PARITY;
    return [...str].map((ch) => (/\d/.test(ch) ? String(map[Number(ch)] ?? ch) : ch)).join('');
}

// ===========================================================================
// 4. Context
// ===========================================================================

function makeContext(mode) {
    return {
        mode,
        words: new Map(),      // source word -> replacement, in first-seen order
        masked: [],            // identifier runs masked
        preserved: new Set(),  // protected phrases actually found
        literalCount: 0,
                hexStrings: false,    // true if any operand arrived as <hex> rather than (...)
                skippedStreams: []
            };
}

/** Uppercase with whitespace removed, for protected-phrase matching. */
function flat(text) {
    return text.replace(/\s+/g, '').toUpperCase();
}

function isProtected(text) {
    const f = flat(text);
    if (!f) return false;
    return PROTECTED_FLAT.some((p) => f.includes(p));
}

function matchIdentifier(text) {
    const t = text.trim();
    for (const { kind, re } of IDENTIFIER_PATTERNS) if (re.test(t)) return kind;
    return null;
}

// ===========================================================================
// 5. Names
//
// A personal name cannot be detected by pattern alone, so rather than guess,
// every capitalised run that is *not* on the protected list is replaced
// wholesale by an equally shaped synthetic name. Erring towards
// over-anonymising is the right direction for this tool.
// ===========================================================================

const TITLE_WORDS = new Set([
    'MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'ADV', 'REV', 'FR',
    'SISTER', 'BROTHER', 'FATHER', 'PASTOR'
]);

const GIVEN_NAMES = [
    'ANNEKE', 'PIETER', 'MARIAAN', 'JOHANNES', 'SANDRA', 'THEODIUS', 'ELENI',
    'WERNER', 'ZANETTE', 'FRANS', 'HELENA', 'JOHANN', 'LIEZEL', 'NICOLAAS',
    'MARIANA', 'DEON', 'RIEN', 'KATRINA', 'SIEGLING', 'WESSELS'
];
const SURNAMES = [
    'VENTER', 'BESTE', 'COETZEE', 'DUPLESSIS', 'FAKIR', 'GROBBELAAR', 'HATTINGH',
    'JACOBS', 'KRIEL', 'LABUSCHAGNE', 'NKOSI', 'NEL', 'OOSTHUIZEN', 'POTGIETER',
    'RADEBE', 'STEYN', 'MBEKI', 'VANZYL'
];
const PARTICLES = new Set(['VAN', 'VANDER', 'DER', 'DU', 'DE', 'LA', 'LE']);
const INITIALS = 'ABCDEFGHJKLMNPRSTVW';

/**
 * Replaces a personal name with a synthetic one of the same shape, keeping the
 * title, any particles and the number of initials:
 * `MR J D DE CAIRES E FREITAS` → `MR A B DE NKOSI`.
 */
function substituteName(text, ctx) {
    const tokens = text.split(/(\s+)/);
    const words = tokens.filter((t) => t.trim() && !NON_WORD.test(t));
    if (!words.length) return text;

    const bare = words.map((w) => w.replace(/[^\w]/g, '').toUpperCase());
    // A lone title with nothing to replace ("MR") is left alone.
    if (bare.every((w) => TITLE_WORDS.has(w))) return text;

    const r = rng(`name:${text}`);
    const out = [];

    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const key = bare[i];
        if (TITLE_WORDS.has(key)) { out.push(w); continue; }
        // A lone initial stays a lone initial.
        if (/^[A-Z]\.?$/.test(w)) {
            const pool = INITIALS.replace(key[0], '');
            out.push(pool[Math.floor(r() * pool.length)]);
            continue;
        }
        if (PARTICLES.has(key) && i < words.length - 1) { out.push(w); continue; }
        const isSurname = i === words.length - 1 || PARTICLES.has(bare[i + 1] ?? '');
        const pool = isSurname ? SURNAMES : GIVEN_NAMES;
        out.push(pool[Math.floor(r() * pool.length)]);
    }

    const joined = out.join(' ');
    ctx.masked.push({ kind: 'name', from: text.trim(), to: joined });
    return joined;
}

/**
 * True when a run looks like a person's name: it starts with a title, or it is
 * a capitalised multi-word run with at least one initial.
 *
 * A single digit disqualifies the run. Several statements print author names in
 * the form `J. M. 08.04.26`, which is two initials plus a date — reading that
 * as a name would delete the date along with the author, and the transaction
 * rows would stop lining up. Word-wise substitution is the safe fallback there:
 * it leaves pure-digit tokens such as `08.04.26` untouched.
 */
function looksLikeName(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    if (words.some((w) => /\d/.test(w))) return false;
    if (TITLE_WORDS.has(words[0].replace(/[^\w]/g, '').toUpperCase())) return true;
    const capitals = words.filter((w) => /^[A-Z]/.test(w)).length;
    return capitals >= 2 && words.some((w) => /^[A-Z]\.?$/.test(w));
}

// ===========================================================================
// 6. Substitution
// ===========================================================================

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whitespace-tolerant regex for a protected phrase. */
function protectedRegex(phrase) {
    const escaped = phrase
        .split(/\s+/)
        .map(escapeRe)
        .join('\\s*');
    return new RegExp(escaped, 'gi');
}

/**
 * Substitutes one word token.
 *
 * In order:
 *   - Pure digits: left alone. These are dates, money and page numbers, and
 *     the tests depend on them being exactly what the bank printed.
 *   - Digits mixed with letters (a reference or cheque number): digits masked,
 *     letters kept, so the shape of the reference survives without leaking it.
 *   - Everything else: deterministic same-length gibberish.
 */
function substituteWord(word, ctx) {
    if (NON_WORD.test(word)) return word;
    if (/^\d+$/.test(word)) return word;

    const digits = [...word].filter((c) => /\d/.test(c)).length;
    if (digits > 0 && digits < word.length) {
        const out = maskDigitsIn(word, ctx.mode);
        ctx.masked.push({ kind: 'reference', from: word, to: out });
        return out;
    }
    if (digits === word.length) return word;

    return recase(word, fakeWord(word, ctx));
}

/** Splits on non-space runs and substitutes each, keeping the spacing. */
function substituteWords(text, ctx) {
    return text.replace(/\S+/g, (token) => {
        // Punctuation-only fragments such as "R" or "-" are part of the money
        // format that `cleanNum` relies on, so they are left alone.
        if (NON_WORD.test(token)) return token;
        return substituteWord(token, ctx);
    });
}

/**
 * Substitutes one `Tj`/`TJ` operand.
 *
 * A protected phrase *inside* a longer run keeps just that span and has the
 * rest substituted, so "Your Standard Bank account" keeps the part the parser
 * needs while the rest becomes gibberish.
 */
function substituteRun(text, ctx) {
    if (!text.trim()) return text;

    const upper = text.toUpperCase();
    const spans = [];
    for (const phrase of PROTECTED_PHRASES) {
        if (!phrase.trim()) continue;
        const re = protectedRegex(phrase);
        const m = re.exec(upper);
        if (m) {
            spans.push([m.index, m.index + m[0].length]);
            ctx.preserved.add(phrase);
        }
    }
    if (!spans.length) return substituteFreeRun(text, ctx);

    // Merge overlapping spans before substituting the gaps between them.
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
        else merged.push([...s]);
    }

    let out = '';
    let cursor = 0;
    for (const [start, end] of merged) {
        if (start > cursor) out += substituteFreeRun(text.slice(cursor, start), ctx);
        out += text.slice(start, end); // protected: verbatim
        cursor = end;
    }
    if (cursor < text.length) out += substituteFreeRun(text.slice(cursor), ctx);
    return out;
}

function substituteFreeRun(text, ctx) {
    if (!text.trim()) return text;

    // Emails and URLs: the bank domain is already protected and a mangled
    // address is still an address, so these are reported rather than rewritten.
    if (/@|:\/\//.test(text)) return text;

    if (looksLikeName(text)) return substituteName(text, ctx);

    const ident = matchIdentifier(text);
    if (ident) {
        ctx.masked.push({ kind: ident, from: text.trim() });
        return maskDigitsIn(text, ctx.mode);
    }

    return substituteWords(text, ctx);
}

// ===========================================================================
// 7. Content-stream rewriting
//
// Only string operands of text-showing operators are touched. `TJ` arrays keep
// their structure and their kerning numbers, so intra-word letter spacing is
// unchanged.
// ===========================================================================

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

const isWS = (ch) => WS.has(ch);
const isDelim = (ch) => DELIM.has(ch);
const isRegular = (ch) => !isWS(ch) && !isDelim(ch);

/** Decodes the body of a PDF literal string (between the parentheses). */
function decodeLiteral(body) {
    const bytes = [];
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') { bytes.push(c.charCodeAt(0) & 0xff); continue; }
        const n = body[++i];
        if (n === undefined) break;
        if (n >= '0' && n <= '7') {
            let oct = n;
            while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
            bytes.push(parseInt(oct, 8) & 0xff);
            continue;
        }
        const map = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        bytes.push(map[n] !== undefined ? map[n] : n.charCodeAt(0) & 0xff);
    }
    return Buffer.from(bytes).toString('latin1');
}

/** Re-encodes text as a PDF literal string, escaping as the spec requires. */
function encodeLiteral(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
        else if (code === 10) out += '\\n';
        else if (code === 13) out += '\\r';
        else if (code > 126 || code < 32) out += `\\${code.toString(8).padStart(3, '0')}`;
        else out += ch;
    }
    return `(${out})`;
}

    /**
     * The hex-string counterpart of `encodeLiteral`.
     *
     * Round-tripping through the *same* encoding is what keeps the glyph widths
     * unchanged: the replacement text has the same byte length as the original, so
     * every advance the text matrix was given still lands in the same place. The
     * PDF TextEncoder would have emitted UTF-8, which is two bytes for every
     * accented character and would have shifted the rest of the line.
     */
    function encodeHexLiteral(text) {
        return `<${Buffer.from(text, 'latin1').toString('hex').toUpperCase()}>`;
    }

/**
 * Walks a content stream and rewrites the string operands of `Tj`, `TJ`, `'`
 * and `"`. Everything else — names, numbers, arrays, operators, whitespace,
 * comments — is emitted byte-for-byte as it was read.
 */
function rewriteContentStream(src, ctx) {
    const tokens = [];
    let i = 0;
        let sawHex = false;

    while (i < src.length) {
        const c = src[i];

        if (isWS(c)) {
            let j = i;
            while (j < src.length && isWS(src[j])) j++;
            tokens.push({ kind: 'ws', raw: src.slice(i, j) });
            i = j;
            continue;
        }
        if (c === '%') {
            let j = i;
            while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
            tokens.push({ kind: 'comment', raw: src.slice(i, j) });
            i = j;
            continue;
        }
        if (c === '(') {
            let depth = 1;
            let j = i + 1;
            while (j < src.length && depth > 0) {
                const ch = src[j];
                if (ch === '\\') { j += 2; continue; }
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                j++;
            }
            tokens.push({
                kind: 'string',
                raw: src.slice(i, j),
                text: decodeLiteral(src.slice(i + 1, Math.max(i + 1, j - 1)))
            });
            i = j;
            continue;
        }
        if (c === '<' && src[i + 1] !== '<') {
                    // Hex strings are a second, fully legal way to write a string
                    // operand. Treating them as opaque bytes leaves that text
                    // completely un-anonymised, which is worse than not touching the
                    // file at all, so they are decoded, rewritten and re-encoded.
                    let j = i + 1;
                    while (j < src.length && src[j] !== '>') j++;
                    const body = src.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, '');
                    j = Math.min(j + 1, src.length);
                    const bytesOut = body.length % 2 ? body + '0' : body;
                    tokens.push({
                        kind: 'hexstring',
                        raw: src.slice(i, j),
                        // An odd-length body means the stream is malformed; padding it
                        // keeps the tokeniser from silently dropping the string.
                        text: bytesOut.length
                            ? Buffer.from(bytesOut, 'hex').toString('latin1')
                            : '',
                        isHex: true
                    });
                    sawHex = true;
                    i = j;
                    continue;
                }
        if ('<>[]{}'.includes(c)) { tokens.push({ kind: 'bracket', raw: c }); i++; continue; }
        if (c === '/') {
            let j = i + 1;
            while (j < src.length && isRegular(src[j])) j++;
            tokens.push({ kind: 'name', raw: src.slice(i, j) });
            i = j;
            continue;
        }
        if (isRegular(c)) {
            let j = i;
            while (j < src.length && isRegular(src[j])) j++;
            const word = src.slice(i, j);
            tokens.push({
                kind: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? 'number' : 'op',
                raw: word
            });
            i = j;
            continue;
        }
        tokens.push({ kind: 'other', raw: c }); // a byte we do not recognise
        i++;
    }

    // A string is a show operand when the operator that CONSUMES it comes
        // after it: `(text)Tj`. The token before it is whatever positioned it,
        // usually `Td`, so the scan has to go forwards.
        const isShow = new Array(tokens.length).fill(false);
        const next = (from) => {
            let k = from;
            while (k < tokens.length && tokens[k].kind === 'ws') k++;
            return tokens[k];
        };

        for (let t = 0; t < tokens.length; t++) {
                    if (tokens[t].kind !== 'string' && tokens[t].kind !== 'hexstring') continue;
            const after = next(t + 1);
            if (after && after.kind === 'op' && SHOW_OPS.has(after.raw)) {
                isShow[t] = true;
            }
        }

    const out = [];
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.kind !== 'string' && tok.kind !== 'hexstring') { out.push(tok.raw); continue; }
                if (!isShow[t]) { out.push(tok.raw); continue; }

                const replacement = substituteRun(tok.text, ctx);
                if (replacement === tok.text) { out.push(tok.raw); continue; }
                ctx.literalCount++;
                out.push(tok.isHex ? encodeHexLiteral(replacement) : encodeLiteral(replacement));
    }
        if (sawHex) ctx.hexStrings = true;
        return out.join('');
    }

// ===========================================================================
// 8. pdf-lib traversal
// ===========================================================================

/**
 * Resolves a page's `/Contents` — a single stream, an array of streams, or any
 * mix of direct and indirect references — down to the stream objects.
 */
function collectContentStreams(obj, context, seen = new Set(), depth = 0) {
    const out = [];
    if (!obj || depth > 6) return out;

    if (obj instanceof PDFArray) {
            for (let i = 0; i < obj.size(); i++) {
                out.push(...collectContentStreams(context.lookup(obj.get(i)), context, seen, depth + 1));
            }
            return out;
        }
        if (obj && typeof obj.getContents === 'function' && typeof obj.dict === 'object') {
            out.push(obj);
        }
        return out;
}

/**
 * All `/Subtype /Form` XObjects on a page. Eight of the statements keep all of
 * their text inside these rather than in the page content stream, so missing
 * them would leave those fixtures un-anonymised.
 *
 * One level is enough: no document in the corpus nests forms, and none shares
 * an XObject between pages.
 */
function collectFormXObjects(page, context, seen = new Set()) {
    const out = [];
    const resources = page.Resources();
    if (!resources) return out;
    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects || typeof xobjects.entries !== 'function') return out;

    for (const [, ref] of xobjects.entries()) {
        const key = String(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        const obj = context.lookup(ref);
        if (!obj || typeof obj.getContents !== 'function' || !obj.dict) continue;
        const subtype = obj.dict.get(PDFName.of('Subtype'));
        if (!subtype || String(subtype) !== '/Form') continue;
        out.push(obj);
    }
    return out;
}

/** Decodes a stream, or returns null for image data we must not touch. */
function decodeStreamBytes(stream) {
    try {
        return Buffer.from(
            decodePDFRawStream({ dict: stream.dict, contents: stream.getContents() }).decode()
        );
    } catch {
        return null; // /DCTDecode, /CCITTFaxDecode, ...
    }
}

// ===========================================================================
// 9. Verification
// ===========================================================================

function standardFontsUrl() {
    const dir = path.join(REPO_ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts');
    return pathToFileURL(`${dir}${path.sep}`).href;
}

/** Extracts text with the same pdf.js build the browser page loads. */
async function extractPageText(bytes) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.js');
    const pdfjs = mod.default ?? mod;
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: false,
        standardFontDataUrl: standardFontsUrl()
    }).promise;

    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        pages.push(content.items.map((it) => it.str));
    }
    await doc.destroy();
    return pages;
}

/**
 * Every money-shaped figure printed anywhere in a document.
 *
 * The thousands-group part `(?:[.,]\d{3})*` is not optional decoration: with a
 * plain `[\d\s]*[.,]\d{2}` the engine settles on the *first* separator that
 * satisfies the pattern, so `2,000.00` matches as `2,00` and the thousands
 * figure is never counted. That silently undercounts the corpus and hides lost
 * amounts, which is the one thing this function exists to catch.
 */
function moneyFigures(pages) {
    const out = new Set();
    for (const items of pages) {
        for (const str of items) {
            for (const m of str.matchAll(/-?\d[\d ]*(?:[.,]\d{3})*[.,]\d{2}\b/g)) {
                out.add(m[0].replace(/\s+/g, ''));
            }
        }
    }
    return out;
}

function findAll(items, re) {
    const out = new Set();
    for (const str of items) for (const m of str.matchAll(re)) out.add(m[0]);
    return [...out].sort();
}

// ===========================================================================
// 10. Driver
// ===========================================================================

async function anonymisePdf(inputPath, { name, mode }) {
    const base = name ?? path.basename(inputPath).replace(/\.pdf$/i, '');
    const outPath = path.join(OUT_DIR, `${base}.pdf`);
    const manifestPath = path.join(OUT_DIR, `${base}.anonymisation-manifest.json`);

    console.log(`\n=== ${path.relative(REPO_ROOT, inputPath)}`);

    const original = await readFile(inputPath);
    // updateMetadata:false is essential — the default true would overwrite
    // Producer/Creator/dates before they could be cleaned.
    const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });

    if (doc.isEncrypted) {
        console.error('  SKIPPED: the PDF is password-protected. Remove the protection first');
        console.error('          (e.g. `qpdf --decrypt`) and run this again.');
        return { skipped: true };
    }

    const ctx = makeContext(mode);
    const pages = doc.getPages();
    let streamsRewritten = 0;

    for (const page of pages) {
        const streams = [
            ...collectContentStreams(page.node.Contents(), doc.context),
                        ...collectFormXObjects(page.node, doc.context)
        ];

        for (const stream of streams) {
            const decoded = decodeStreamBytes(stream);
            if (!decoded) continue;
            const text = decoded.toString('latin1');
            // Not a text content stream: leave it alone.
            if (!/\bBT\b|\bTj\b|\bTJ\b/.test(text)) continue;

            const rewritten = rewriteContentStream(text, ctx);
            if (rewritten === text) continue;

            // /FlateDecode is the only filter on every content stream in the
            // corpus, so re-deflating is sufficient. Anything else is reported
            // rather than silently mangled.
            const filter = stream.dict.get(PDFName.of('Filter'));
            const names = filter instanceof PDFArray
                ? filter.asArray().map((f) => String(f))
                : filter ? [String(filter)] : [];
            if (names.length && !names.every((n) => n === '/FlateDecode')) {
                ctx.skippedStreams.push({ filter: names.join(',') });
                continue;
            }

            stream.contents = zlib.deflateSync(Buffer.from(rewritten, 'latin1'));
            // updateDict() recomputes /Length from the new contents.
            stream.updateDict();
            streamsRewritten++;
        }
    }

    // Metadata: /Info is the entire metadata surface in this corpus (no XMP
    // streams anywhere), so scrubbing the trailer dict is sufficient.
    const info = doc.context.trailerInfo;
    const infoKeys = typeof info.keys === 'function' ? info.keys() : [];
    const metadataScrubbed = [];
    for (const key of infoKeys) {
        if (!/^(Title|Author|Subject|Keywords|Creator|Producer)$/.test(String(key))) continue;
        info.set(key, doc.context.obj('ANONYMISED'));
        metadataScrubbed.push(String(key));
    }
    doc.setTitle('ANONYMISED');
    doc.setAuthor('ANONYMISED');
    doc.setSubject('ANONYMISED');
    doc.setCreator('ANONYMISED');
    doc.setProducer('ANONYMISED');
    doc.setKeywords(['ANONYMISED']);

    const written = await doc.save();
    await writeFile(outPath, written);

    // ---- verify the result against the original -------------------------
    const beforePages = await extractPageText(original);
    const afterPages = await extractPageText(written);
    const beforeFigures = moneyFigures(beforePages);
    const afterFigures = moneyFigures(afterPages);
    const lost = [...beforeFigures].filter((f) => !afterFigures.has(f));
    const added = [...afterFigures].filter((f) => !beforeFigures.has(f));

    const manifest = {
        source: path.basename(inputPath),
        fixture: path.basename(outPath),
        generatedAt: new Date().toISOString(),
        method: 'in-place substitution of Tj/TJ/\'/" string operands; every other byte copied verbatim',
        digitMode: mode,
        pages: pages.length,
        streamsRewritten,
        literalsRewritten: ctx.literalCount,
        hexStringOperands: ctx.hexStrings,
        distinctWordsReplaced: ctx.words.size,
        metadataKeysScrubbed: metadataScrubbed,
        preservedPhrases: [...ctx.preserved].sort(),
        substitutions: dedupe(ctx.words),
        maskedIdentifiers: dedupe(ctx.masked),
        verification: {
            textItemsBefore: beforePages.flat().length,
            textItemsAfter: afterPages.flat().length,
            moneyFiguresBefore: beforeFigures.size,
            moneyFiguresAfter: afterFigures.size,
            lostMoneyFigures: lost,
            addedMoneyFigures: added
        },
        review: {
            // Preserved deliberately, so a human confirms they identify nobody.
            emails: findAll(beforePages.flat(), /[\w.%+-]+@[\w.-]+\.\w{2,}/g),
            urls: findAll(beforePages.flat(), /(?:\bhttps?:\/\/|\bwww\.)[^\s)>,]*/gi),
            streamsSkipped: ctx.skippedStreams
        },
        warnings: [
            'Read `substitutions` and render the pages before committing.',
            'Amounts are preserved verbatim so balance-chain tests stay meaningful.',
            'Account, card and identity numbers are digit-masked, not removed.'
        ]
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`  ${pages.length} page(s), ${streamsRewritten} stream(s) rewritten, ` +
        `${ctx.literalCount} literal(s) substituted, ${ctx.words.size} distinct word(s)`);
    console.log(`  money figures: ${beforeFigures.size} before -> ${afterFigures.size} after` +
        (lost.length ? `  ** ${lost.length} LOST: ${lost.slice(0, 6).join(' ')} **` : ' (none lost)'));
    if (added.length) console.log(`  new figures (masked account/card numbers): ${added.slice(0, 6).join(' ')}`);
    if (manifest.review.emails.length) {
        console.log(`  review: ${manifest.review.emails.length} email(s) preserved — confirm none is personal`);
    }

    if (lost.length) {
        console.error('  !! Monetary figures were lost. Do not commit this fixture.');
        process.exitCode = 1;
    }
    return { skipped: false, lost };
}

/** source -> replacement pairs, in the order the words were first seen. */
function dedupe(words) {
    return [...words.entries()].map(([from, to]) => ({ from, to }));
}

function parseArgs(argv) {
    const inputs = [];
    let name = null;
    let mode = 'parity';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name') { name = argv[++i]; continue; }
        if (a.startsWith('--name=')) { name = a.slice(7); continue; }
        if (a === '--shift-digits') { mode = 'shift'; continue; }
        inputs.push(a);
    }
    return { inputs, name, mode };
}

// Only run the CLI when invoked directly, so the helpers above can also be
// imported by tests without producing output or writing files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { inputs, name, mode } = parseArgs(process.argv.slice(2));

    if (!inputs.length) {
        console.error(
            'Usage: npm run anonymise -- <statement.pdf> [--name fixture-name] [--shift-digits]\n' +
            '       npm run anonymise -- test/fixtures/originals/*.pdf'
        );
        process.exit(1);
    }

    await mkdir(OUT_DIR, { recursive: true });

    let skipped = 0;
    for (const input of inputs) {
        const result = await anonymisePdf(input, { name, mode });
        if (result.skipped) skipped++;
    }

    console.log('\nNext: npm run fixtures:build && npm test');
    if (skipped) console.log(`(${skipped} file(s) skipped)`);
}

export {
    anonymisePdf,
    rewriteContentStream,
    decodeLiteral,
    encodeLiteral,
        encodeHexLiteral,
    substituteRun,
    substituteWords,
    fakeWord,
    recase,
    PROTECTED_PHRASES
};