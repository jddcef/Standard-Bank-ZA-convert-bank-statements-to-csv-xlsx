/**
 * Loads the shipped, unmodified `bank_parser_v7.js` into a synthetic browser-ish
 * context and exposes its top-level declarations for testing.
 *
 * The app is a classic (non-module) browser script. Evaluating it inside
 * `new Function(...)` puts every top-level `const`/`function` into that
 * function's own scope, which the trailing `return { ... }` then hands back.
 * That keeps the shipped file byte-identical and still shippable: no bundler,
 * no import rewrites, no refactor.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const APP_SOURCE_PATH = path.join(REPO_ROOT, 'bank_parser_v7.js');
export const APP_HTML_PATH = path.join(REPO_ROOT, 'index.html');

/** Names pulled out of the app's scope after evaluation. */
const EXPORTS = [
    'appState',
    'DEFAULT_JUNK_KEYWORDS',
    'DEFAULT_CATEGORIES',
    'MONTHS',
    'escapeRegExp',
    'sanitizeId',
    'parsePeriodDate',
    'parseCreditCardPeriodDate',
    'formatShortDate',
    'getTransactionYear',
    'classifyStatement',
    'parseWeeklyStatement',
    'groupLines',
    'regexSplitLines',
    'applyBatchFilters',
    'performFileSanity',
    'buildExportRows',
    'splitDetails',
    'getCategory',
    'isJunk',
    'cleanDetails',
    'cleanCcDetails',
    'cleanNum',
    'parseCcDate'
];

let cached = null;

/**
 * @returns {{
 *   app: Record<string, any>,
 *   window: Window,
 *   reset: () => void,
 *   alerts: string[]
 * }}
 */
export function loadApp() {
    if (cached) return cached;

    const source = readFileSync(APP_SOURCE_PATH, 'utf8');

    // Load the app's real page markup, stripped of its <script>/<link> tags so
    // jsdom fetches nothing over the network. `init()` wires handlers onto
    // specific element ids, so an empty <body> throws — hand-building the ids
    // just moves the same problem to the next missing node. Using the real
    // markup also means the harness fails loudly if the page and the script
    // ever drift apart, which is the signal worth having.
    const html = readFileSync(APP_HTML_PATH, 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<link\b[^>]*>/gi, '');

    const dom = new JSDOM(html, {
        url: 'https://localhost/',
        pretendToBeVisual: true
    });

    const { window } = dom;

    // Minimal stand-in for the browser globals the app touches at load time.
    const alerts = [];
    const noop = () => {};
    globalThis.alert = (msg) => { alerts.push(msg); };
    globalThis.lucide = { createIcons: noop };

    // The app resolves pdf.js off `window['pdfjs-dist/build/pdf']` at top level.
    // Tests that exercise PDF parsing install the real library here; pure
    // function tests never read it.
    Object.defineProperty(window, 'pdfjs-dist/build/pdf', {
        configurable: true,
        get: () => globalThis.__pdfjsStub ?? {}
    });

    // jsdom fires the load event that runs the app's `init()`, which reads
    // localStorage. Node has no localStorage, so a null getItem would throw an
    // uncaught error inside jsdom's event dispatch. An in-memory stand-in keeps
    // init() inert and quiet.
    //
    // The app refers to `localStorage` as a bare identifier, so it resolves on
    // the real global object rather than on the jsdom window. Both need the stub.
    const memory = new Map();
    const localStorageStub = {
        getItem: (k) => (memory.has(String(k)) ? memory.get(String(k)) : null),
        setItem: (k, v) => { memory.set(String(k), String(v)); },
        removeItem: (k) => { memory.delete(String(k)); },
        clear: () => memory.clear(),
        key: (i) => [...memory.keys()][i] ?? null,
        get length() { return memory.size; }
    };
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: localStorageStub
    });
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: localStorageStub
    });

    const factory = new Function(
        'window',
        'document',
        'alert',
        'lucide',
        `${source}\n;return { ${EXPORTS.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`
    );

    const app = factory(window, window.document, globalThis.alert, globalThis.lucide);

    const missing = EXPORTS.filter((n) => app[n] === undefined);
    if (missing.length) {
        throw new Error(
            `loadApp: expected exports missing from bank_parser_v7.js: ${missing.join(', ')}\n` +
            'The app source may have been refactored — update EXPORTS in this helper.'
        );
    }

    /** Restores appState to a pristine, freshly-parsed state between tests. */
    const reset = () => {
        app.appState.batchData = [];
        app.appState.junkKeywords = [...app.DEFAULT_JUNK_KEYWORDS];
        app.appState.categories = [...app.DEFAULT_CATEGORIES];
        app.appState.filters = { keyword: true, regex: true, strict: false, sanity: true };
        app.appState.splitMethod = 'center';
        app.appState.splitX = 297.5;
        app.appState.splitCode = false;
        app.appState.masterTransactions = [];
        app.appState.masterExclusions = [];
        app.appState.nextBatchFileId = 1;
        app.appState.lastPdfPassword = '';
    };

    cached = { app, window, reset, alerts, dom };
    return cached;
}