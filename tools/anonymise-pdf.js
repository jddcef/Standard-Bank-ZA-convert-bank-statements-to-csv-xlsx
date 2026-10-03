#!/usr/bin/env node
/**
 * Produces a commit-safe, anonymised copy of a real statement PDF.
 *
 *   npm run anonymise -- <statement.pdf> [--name current-account-basic]
 *   npm run anonymise -- test/fixtures/originals/*.pdf
 *
 * What it does, in order:
 *   1. Reads the PDF's text with pdf.js (read-only; the original is untouched).
 *   2. Scans for identifying data.
 *   3. Writes a flattened, redacted copy with pdf-lib into test/fixtures/pdfs.
 *   4. Writes test/fixtures/pdfs/<name>.anonymisation-manifest.json recording
 *      every substitution, so a reviewer can verify nothing sensitive remains.
 *
 * Amounts are deliberately preserved: the running-balance arithmetic is what
 * makes these fixtures worth having. Digits are shifted consistently (each
 * digit d becomes (d+7)%10) rather than deleted, so a substituted account number
 * stays the same length and column geometry survives — and because the mapping
 * is deterministic, the redaction is verifiable and idempotent.
 *
 * IMPORTANT: this is a redaction *aid*, not a guarantee. Read the manifest and
 * eyeball the rendered pages before committing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'pdfs');

/** Fixed-width placeholder patterns, applied before digit shifting. */
const PLACEHOLDERS = [
    [/\b\d{6}-\d{2}-\d{4}\b/g, '000000-00-0000'],
    [/\b\d{2}\s?\d{3}\s?\d{4}\s?\d{2}\s?\d{3}\s?\d{1}\b/g, '00 000 0000 000 0'],
    [/\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/g, '0000 0000 0000 0000'],
    [/\b[A-Z]{2}\d{6}\b/g, 'XX000000'],
    [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '0000 0000 0000']
];

/** Labels whose value is replaced wholesale. */
const LABEL_PATTERNS = [
    'Account Number', 'Account number', 'Account No', 'Account no', 'ACCOUNT NUMBER',
    'Card Number', 'Card number', 'CARD NUMBER', 'Cardholder', 'CARDHOLDER',
    'Client Name', 'CLIENT NAME', 'Surname', 'SURNAME', 'First Name',
    'Address', 'ADDRESS', 'Physical Address', 'PHYSICAL ADDRESS',
    'Postal Address', 'POSTAL ADDRESS', 'Email Address', 'E-mail Address',
    'Email', 'E-mail', 'E-MAIL', 'Telephone', 'Phone', 'Mobile', 'Cell',
    'Identity Number', 'IDENTITY NUMBER', 'ID Number', 'Passport Number',
    'Tax Number', 'TAX NUMBER', 'Tax No', 'VAT Reg. No', 'VAT NUMBER', 'VAT No',
    'Company Name', 'Registered Address', 'Registration Number'
];

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the value following a sensitive label with «REDACTED».
 *
 * Only the value is consumed, up to the first space. pdf.js hands back one
 * text item per drawn run, so a statement's label, its value and its
 * neighbours usually arrive as separate items — matching to end-of-line would
 * swallow every later item on the page and silently delete real data.
 */
function redactLabelled(line, state) {
    // MARKER uses «» so a partially-redacted row is unmistakable in the derived
    // text. Courier is WinAnsi-encoded, so writeRedactedPdf swaps it to plain
    // quotes at the font boundary; the manifest logs what actually gets written.
    const RENDERED_MARKER = '"REDACTED"';

    let out = line;
    for (const label of LABEL_PATTERNS) {
        const re = new RegExp(`(${escapeRe(label)})(\\s*[:\\-]?\\s*)([^\\s]+)`, 'gi');
        out = out.replace(re, (m, lbl, sep, value) => {
            if (/^(«|\[|"')?REDACTED/.test(value)) return m;
            state.log.push({ kind: 'labelled', label: lbl.trim(), from: value, to: RENDERED_MARKER });
            return `${lbl}${sep}«REDACTED»`;
        });
    }
    return out;
}

/** True when a token is a money figure we must not disturb. */
function isMoney(trimmed) {
    return /^-?[\d\s]+[.,]\d{2}$/.test(trimmed);
}

function redactDigits(text, state) {
    return text.replace(/\b\d[\d\s]{5,}\b/g, (match) => {
        const trimmed = match.trim();
        if (isMoney(trimmed)) return match;
        const digits = trimmed.replace(/\D/g, '');
        if (digits.length < 6) return match;
        if (state.seen.has(trimmed)) return match.replace(trimmed, state.seen.get(trimmed));
        const replacement = digits.replace(/\d/g, (d) => String((Number(d) + 7) % 10));
        state.seen.set(trimmed, replacement);
        state.log.push({ kind: 'number', from: trimmed, to: replacement });
        return match.replace(trimmed, replacement);
    });
}

function redactAll(text) {
    const state = { seen: new Map(), log: [] };
    let out = text;

    for (const [pattern, replacement] of PLACEHOLDERS) {
        out = out.replace(pattern, (m) => {
            state.log.push({ kind: 'pattern', from: m, to: replacement });
            return replacement;
        });
    }

    out = out.split('\n').map((l) => redactLabelled(l, state)).join('\n');
    out = redactDigits(out, state);

    // Free-text personal names cannot be detected reliably; report, don't guess.
    const nameish = out.match(
        /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}/g
    );
    if (nameish) {
        for (const n of new Set(nameish)) {
            state.log.push({ kind: 'name-UNREDACTED', from: n, to: null });
        }
    }
    return { text: out, log: state.log };
}

/**
 * Rebuilds the PDF as flat, redacted text, preserving row geometry.
 *
 * Rows keep their original x offset and use a monospaced font, so the column
 * alignment that `groupLines()` relies on survives the round trip. Truncates
 * rather than wraps: an invented second line would be misread as a genuine
 * continuation line by the continuation-line parser.
 */
async function writeRedactedPdf(pagesText, outFile) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Courier);
    const bold = await doc.embedFont(StandardFonts.CourierBold);

    // PDF origin is bottom-left; scale source top-left coordinates into it.
    const SOURCE_W = 595;
    const SOURCE_H = 842;
    const SCALE = 0.72; // shrinks wide statements so columns still fit
    const SIZE = 6 * SCALE;
    const MARGIN = 12;

    // Courier is WinAnsi-encoded, so '«' would round-trip as mojibake.
    const ANGLED = /[«»]/g;

    for (const rows of pagesText) {
        let page = doc.addPage([SOURCE_W, SOURCE_H]);

        for (const row of rows) {
            const size = SIZE;
            // PDF y grows upward, so the source coordinate maps straight
            // through — inverting it here would flip the page top-to-bottom.
            const y = row.y * SCALE;
            if (y < 20 || y > SOURCE_H - 8) {
                page = doc.addPage([SOURCE_W, SOURCE_H]);
            }

            const isHeader = /^(DATE|DESCRIPTION|STATEMENT|BALANCE|TRANSACTION)/i.test(row.text.trim());
            const used = isHeader ? bold : font;

            const x = Math.max(MARGIN, MARGIN + row.x * SCALE);
            // Derive the character budget from the font's own advance width at
            // this size. A hard-coded constant silently clipped long rows at the
            // page edge, dropping figures from the fixture — exactly the data
            // loss the figure-coverage tests exist to catch.
            const charW = used.widthOfTextAtSize('0', size);
            const maxChars = Math.max(1, Math.floor((SOURCE_W - MARGIN - x) / charW));
            let text = row.text.replace(ANGLED, '"');
            if (text.length > maxChars) {
                text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
                console.warn(`    row clipped at ${maxChars} chars: ${row.text.slice(0, 40)}…`);
            }
            if (!text.trim()) continue;

            page.drawText(text, {
                x,
                y,
                size,
                font: used,
                color: rgb(0, 0, 0)
            });
        }
    }

    const bytes = await doc.save();
    await writeFile(outFile, bytes);
    return bytes.length;
}

/**
 * Reads each page as positioned text *rows*, preserving x offset and vertical
 * grouping.
 *
 * Reading `item.str` alone (the obvious approach) throws away the geometry, and
 * a statement drawn as several text runs per row then flattens into dozens of
 * one-word "lines" — which the redacted copy would faithfully reproduce as a
 * mangled page. Grouping by y first and joining a row's runs restores the
 * original reading order.
 */
async function readPdfRows(buffer) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.js');
    const pdfjs = mod.default ?? mod;
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: false
    }).promise;

    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();

        // Bucket items by rounded y, descending so rows come out top-first.
        const buckets = new Map();
        for (const it of content.items) {
            if (!it.str || !it.transform) continue;
            const y = Math.round(it.transform[5]);
            const key = buckets.get(y) ?? [];
            key.push({ x: it.transform[4], str: it.str });
            buckets.set(y, key);
        }

        const rows = [...buckets.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([y, items]) => {
                const sorted = items.sort((a, b) => a.x - b.x);
                // Drop the gap left by redacted runs rather than emitting
                // huge runs of spaces.
                let text = '';
                let lastEnd = null;
                for (const it of sorted) {
                    if (lastEnd !== null && it.x - lastEnd > 12) text += '   ';
                    text += it.str;
                    lastEnd = it.x + (it.width || it.str.length * 5);
                }
                return {
                    y,
                    x: sorted[0].x,
                    text: text.replace(/\s+/g, ' ').trim()
                };
            })
            .filter((r) => r.text);

        pages.push(rows);
    }
    await doc.destroy();
    return pages;
}

function parseArgs(argv) {
    const inputs = [];
    let name = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name') { name = argv[++i]; continue; }
        if (a.startsWith('--name=')) { name = a.slice(7); continue; }
        inputs.push(a);
    }
    return { inputs, name };
}

const { inputs, name: nameArg } = parseArgs(process.argv.slice(2));

if (!inputs.length) {
    console.error(
        'Usage: npm run anonymise -- <statement.pdf> [--name fixture-name]\n' +
        '       npm run anonymise -- test/fixtures/originals/*.pdf'
    );
    process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

for (const input of inputs) {
    const base = nameArg ?? path.basename(input).replace(/\.pdf$/i, '');
    const outFile = path.join(OUT_DIR, `${base}.pdf`);

    console.log(`\n=== ${input}`);
    const buffer = await readFile(input);
        const pages = await readPdfRows(buffer);
    console.log(`  ${pages.length} page(s) read`);

    const redactedPages = [];
    const allLog = [];
        pages.forEach((rows, i) => {
            const redactedRows = [];
            for (const row of rows) {
                const { text, log } = redactAll(row.text);
                redactedRows.push({ y: row.y, x: row.x, text });
                log.forEach((e) => allLog.push({ page: i + 1, ...e }));
            }
            redactedPages.push(redactedRows);
        });

    const unredacted = allLog.filter((e) => e.kind === 'name-UNREDACTED');
    const bytes = await writeRedactedPdf(redactedPages, outFile);

    const manifest = {
        source: path.basename(input),
        fixture: path.basename(outFile),
        generatedAt: new Date().toISOString(),
        pages: pages.length,
        redactionCount: allLog.filter((e) => e.kind !== 'name-UNREDACTED').length,
        redactions: allLog,
        reviewRequired: unredacted.length > 0,
        warnings: [
            'Layout is flattened; credit-card fixtures may need a splitX other than 297.5.',
            'Verify the rendered pages contain no personal data before committing.',
            'Amounts are preserved so balance-chain tests stay meaningful.'
        ],
        unredactedCandidates: unredacted
    };

    await writeFile(
        path.join(OUT_DIR, `${base}.anonymisation-manifest.json`),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
    );

    console.log(`  wrote ${path.relative(REPO_ROOT, outFile)} (${bytes} bytes)`);
    console.log(`  ${manifest.redactionCount} redaction(s) recorded in manifest`);
    if (unredacted.length) {
        console.warn(`  !! ${unredacted.length} possible personal name(s) NOT auto-redacted:`);
        unredacted.slice(0, 10).forEach((e) => console.warn(`     ${e.from}`));
        console.warn('     Redact by hand, or do not commit this fixture.');
    } else {
        console.log('  no unredacted personal names detected');
    }
}

console.log('\nNext: npm run fixtures:build && npm test');