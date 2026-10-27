/**
 * Real-PDF fixture support.
 *
 * Tests run against genuine PDF files on disk. Two fixture tiers:
 *
 *   test/fixtures/pdfs/*.pdf     anonymised, committed. The source of truth.
 *   test/fixtures/derived/*.json  cached `rawPages` (pdf.js text items) so the
 *                                bulk of the suite stays fast. Regenerate with
 *                                `npm run fixtures:build`.
 *
 * A fixture is "discovered" if a .pdf exists for it. Tests for a missing
 * fixture are skipped with an explanatory message rather than silently
 * passing, so an absent fixture can never masquerade as a green suite.
 */
import {
    readdirSync,
    existsSync,
    readFileSync,
    mkdirSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures');
export const PDF_DIR = path.join(FIXTURES_DIR, 'pdfs');
export const DERIVED_DIR = path.join(FIXTURES_DIR, 'derived');
export const ORIGINALS_DIR = path.join(FIXTURES_DIR, 'originals');

/** The real pdf.js build the browser page loads from CDN. */
const PDFJS_BUILD = 'pdfjs-dist/legacy/build/pdf.js';

let pdfjsPromise = null;
async function getPdfjs() {
    if (!pdfjsPromise) pdfjsPromise = import(PDFJS_BUILD);
    const m = await pdfjsPromise;
    return m.default ?? m;
}

/**
 * Makes the real pdf.js available to the loaded app under the exact global name
 * the app expects. Call before any test that touches `parsePdf`.
 */
export async function installPdfjs() {
    const pdfjs = await getPdfjs();
    globalThis.__pdfjsStub = pdfjs;
    return pdfjs;
}

/** Fixture base names, i.e. every file present in test/fixtures/pdfs. */
export function listPdfFixtures() {
    if (!existsSync(PDF_DIR)) return [];
    return readdirSync(PDF_DIR)
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .map((f) => f.replace(/\.pdf$/i, ''))
        .sort();
}

export function pdfPath(name) {
    return path.join(PDF_DIR, `${name}.pdf`);
}

export function hasPdf(name) {
    return existsSync(pdfPath(name));
}

export function derivedPath(name) {
    return path.join(DERIVED_DIR, `${name}.json`);
}

/**
 * Runs a real PDF through pdf.js exactly as `parsePdf` does, producing the
 * `rawPages` shape the app consumes: one entry per page of `{ items }`.
 */
export async function extractRawPages(name, { useCache = true } = {}) {
    const cacheFile = derivedPath(name);
    if (useCache && existsSync(cacheFile)) {
        return JSON.parse(readFileSync(cacheFile, 'utf8'));
    }

    const pdfjs = await installPdfjs();
    const data = new Uint8Array(readFileSync(pdfPath(name)));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;

    const rawPages = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        // Keep only the fields groupLines() reads, so derived fixtures stay
        // small and diff-friendly.
        rawPages.push({
            items: content.items.map((it) => ({
                str: it.str,
                width: it.width,
                transform: it.transform
            }))
        });
    }
    await doc.destroy();

    if (useCache) {
        mkdirSync(DERIVED_DIR, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(rawPages, null, 2));
    }
    return rawPages;
}

/** Renders rawPages to plain text, mirroring what groupLines() would see. */
export function renderPagesText(rawPages, app) {
    return rawPages
        .map((page, idx) => {
            const lines = app.groupLines(page.items.map((it) => ({ ...it })));
            return `--- page ${idx + 1} ---\n${lines.join('\n')}`;
        })
        .join('\n');
}

/**
 * Builds the app's per-file `batchData` record the way `processFiles` does,
 * minus the browser File/pdf.js plumbing.
 */
export function makeFileRecord(name, rawPages, app) {
    return {
        id: `batch-file-${app.appState.nextBatchFileId++}`,
        filename: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`,
        size: 0,
        rawPages,
        lines: [],
        metadataLines: [],
        transactions: [],
        exclusions: [],
        startingBalance: null,
        closingBalance: null,
        rawLines: [],
        errorCount: 0,
        statementType: 'current'
    };
}

/** Runs the full parse pipeline over real PDF pages. */
export function parseFixture(name, rawPages, app) {
    const file = makeFileRecord(name, rawPages, app);
    app.appState.batchData.push(file);
    app.applyBatchFilters();
    return file;
}

/**
 * Every amount the statement puts on a transaction row, read off the parsed
 * output. Used by the figure-coverage assertions: if a PDF prints a figure and
 * the row set does not contain it, the parser dropped or mangled data.
 */
export function amountsFromTransactions(transactions) {
    return transactions.map((t) => Number.parseFloat(t.amount)).filter((n) => Number.isFinite(n));
}

export function balancesFromTransactions(transactions) {
    return transactions.map((t) => Number.parseFloat(t.balance)).filter((n) => Number.isFinite(n));
}