/**
 * Real-PDF integration tests.
 *
 * These drive the real parse pipeline (classifyStatement -> groupLines ->
 * applyBatchFilters -> performFileSanity -> buildExportRows) over genuine PDF
 * files in test/fixtures/pdfs, using the same pdf.js build the browser loads.
 *
 * With no fixtures committed, every test below skips with an explicit message.
 * A missing fixture therefore can never read as a passing suite.
 *
 *   npm run fixtures:list                 # what is present
 *   npm run anonymise -- my-statement.pdf  # produce a commit-safe fixture
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';
import {
    listPdfFixtures,
    hasPdf,
    extractRawPages,
    renderPagesText,
    parseFixture,
    amountsFromTransactions,
    balancesFromTransactions
} from '../helpers/pdf.js';

const { app, reset } = loadApp();
const FIXTURES = listPdfFixtures();

/**
 * Runs `fn(fixtureName)` for each committed fixture, or skips the test with a
 * message naming exactly what to do when there are none.
 */
function forEachFixture(fn) {
    if (FIXTURES.length === 0) {
        test('no PDF fixtures committed — skipping (add one with `npm run anonymise -- <statement.pdf>`)', { skip: true }, () => {});
        return;
    }
    for (const name of FIXTURES) {
        test(name, async () => fn(name));
    }
}

describe('fixture inventory', () => {
    test('the fixture directory is readable', () => {
        assert.ok(Array.isArray(FIXTURES));
        if (FIXTURES.length === 0) {
            console.log(
                `[fixtures] none found. Add anonymised statements to test/fixtures/pdfs ` +
                `or run: npm run anonymise -- <statement.pdf>`
            );
        }
    });
});

describe('text extraction from real PDFs', () => {
    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);

        assert.ok(rawPages.length > 0, `${name} produced no pages`);
        for (const [i, page] of rawPages.entries()) {
            assert.ok(Array.isArray(page.items), `${name} page ${i + 1} has no items array`);
            for (const item of page.items) {
                assert.equal(typeof item.str, 'string', `${name} page ${i + 1} has a non-string text item`);
                assert.ok(Array.isArray(item.transform), `${name} page ${i + 1} item is missing transform`);
                assert.equal(item.transform.length, 6, 'transform must be a 2D affine matrix');
            }
        }
    });
});

describe('statement classification on real PDFs', () => {
    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        const lines = rawPages.flatMap((p) => app.groupLines(p.items.map((it) => ({ ...it }))));

        const type = app.classifyStatement(lines, rawPages);
        assert.ok(
            ['current', 'credit', 'weekly'].includes(type),
            `${name} classified as unexpected type "${type}"`
        );
    });
});

describe('end-to-end parse of real PDFs', () => {
    beforeEach(() => reset());

    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        const file = parseFixture(name, rawPages, app);

        assert.equal(file.statementType !== undefined, true);
        assert.ok(Array.isArray(file.transactions), 'transactions must be an array');

                // A statement that yields no rows is a parser failure, not a pass. Fail
                // here with a legible message rather than letting it surface as a
                // confusing empty-column assertion further down.
                assert.ok(
                    file.transactions.length > 0,
                    `${name}: parsed 0 transactions from a real statement. ` +
                    `Rendered text:\n${renderPagesText(rawPages, app)}`
                );

        // Every parsed row must be structurally complete.
        file.transactions.forEach((t, i) => {
            const where = `${name} row ${i + 1}`;
            assert.equal(typeof t.date, 'string', `${where}: date must be a string`);
            assert.ok(t.details, `${where}: empty details`);
            assert.ok(t.amount, `${where}: empty amount`);
            assert.ok(t.source, `${where}: missing source`);
        });

        // Amounts must survive as usable numbers — this is the invariant the
        // whole export depends on.
        const amounts = amountsFromTransactions(file.transactions);
        assert.equal(amounts.length, file.transactions.length, `${name}: some amounts did not parse as numbers`);
        for (const n of amounts) {
            assert.ok(Number.isFinite(n), `${name}: non-finite amount ${n}`);
        }

        // Statement types other than 'credit' print a balance on every row, so
        // each balance must parse too.
        if (file.statementType !== 'credit') {
            const balances = balancesFromTransactions(file.transactions);
            assert.equal(balances.length, file.transactions.length, `${name}: some balances did not parse as numbers`);
        }

        assert.equal(typeof file.errorCount, 'number');
    });
});

describe('the running-balance chain on real PDFs', () => {
    beforeEach(() => reset());

    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        const file = parseFixture(name, rawPages, app);

        if (file.statementType === 'credit') {
            // Credit cards print no per-row balance, so the chain is only
            // meaningful once an opening balance is known.
            if (file.startingBalance !== null) {
                const last = file.transactions[file.transactions.length - 1];
                if (last) {
                    assert.equal(last.sanity, 'ok', `${name}: final reconstructed balance failed verification`);
                }
            }
            return;
        }

        // For current/weekly statements the chain is an independent arithmetic
        // check over the parsed rows. Only rows with a known opening balance
        // can be judged; 'unknown' is the app's signal that it could not.
        const verifiable = file.transactions.filter((t) => t.sanity === 'ok' || t.sanity === 'err');
        if (verifiable.length === 0) return;

        let prev = file.startingBalance;
        for (const [i, t] of file.transactions.entries()) {
            if (t.sanity === 'unknown') break; // chain never started
            const expected = Math.round((prev + Number.parseFloat(t.amount)) * 100) / 100;
            const actual = Number.parseFloat(t.balance);
            const agrees = Math.abs(expected - actual) < 0.01;

            assert.equal(
                t.sanity === (agrees ? 'ok' : 'err'),
                true,
                `${name} row ${i + 1}: sanity flag disagrees with an independent recomputation`
            );
            prev = actual;
        }
    });
});

describe('figure coverage: every parsed amount was printed on the statement', () => {
    beforeEach(() => reset());

    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        const file = parseFixture(name, rawPages, app);

        // The set of figures physically present on the page. Matching on the
        // set rather than a 1:1 row mapping tolerates statement lines that
        // are totals or balances rather than transaction amounts.
        const printed = new Set();
        for (const page of rawPages) {
            for (const item of page.items) {
                for (const m of item.str.matchAll(/\d[\d\s]*[.,]\d{2}/g)) {
                    const n = Number.parseFloat(app.cleanNum(m[0]));
                    if (Number.isFinite(n)) printed.add(Math.round(n * 100));
                }
            }
        }

        const parsed = amountsFromTransactions(file.transactions)
            .map((n) => Math.round(n * 100));

        // The anonymiser shifts non-money digits but deliberately preserves
        // monetary figures, so every parsed amount must appear in the PDF.
        const invented = parsed.filter((n) => !printed.has(n));
        assert.deepEqual(
            invented,
            [],
            `${name}: ${invented.length} parsed amount(s) do not appear on the statement: ` +
            invented.slice(0, 10).map((c) => (c / 100).toFixed(2)).join(', ')
        );
    });
});

describe('export row shape on real PDFs', () => {
    beforeEach(() => reset());

    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        const file = parseFixture(name, rawPages, app);

        app.appState.splitCode = false;
        const rows = app.buildExportRows(file.transactions, true);

        assert.equal(rows.length, file.transactions.length);
                for (const row of rows) {
                    assert.deepEqual(
                        Object.keys(row),
                        ['Date', 'Year', 'Details 1 (Type)', 'Details 2 (Additional)', 'Category', 'Amount', 'Balance', 'Source'],
                        `${name}: unexpected column set when splitCode is off`
                    );
            assert.equal(row.Source, file.filename);
        }

        app.appState.splitCode = true;
        const coded = app.buildExportRows(file.transactions, false);
                for (const row of coded) {
                    assert.deepEqual(
                        Object.keys(row),
                        ['Date', 'Year', 'Details 1 (Type)', 'Details 2 (Code)', 'Details 3 (Additional)', 'Category', 'Amount', 'Balance'],
                        `${name}: unexpected column set when splitCode is on`
                    );
                }
    });
});

describe('batch-level aggregation on real PDFs', () => {
    beforeEach(() => reset());

    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        parseFixture(name, rawPages, app);

        // applyBatchFilters() appends into masterTransactions; every parsed row
        // must reach the master list exactly once or the export double-counts.
        const fromThisFile = app.appState.masterTransactions.filter(
            (t) => t.source === `${name}`.toLowerCase().endsWith('.pdf') ? `${name}.pdf` : `${name}.pdf`
        );
        assert.equal(
            fromThisFile.length,
            app.appState.batchData[0].transactions.length,
            `${name}: masterTransactions does not match the parsed row count`
        );
    });
});

describe('text rendering is available for debugging', () => {
    forEachFixture(async (name) => {
        const rawPages = await extractRawPages(name);
        const text = renderPagesText(rawPages, app);
        assert.ok(text.length > 0, `${name} rendered no text`);
        assert.ok(text.includes(`--- page 1 ---`), `${name} render has no page markers`);
    });
});

before(async () => {
    if (FIXTURES.length > 0) await extractRawPages(FIXTURES[0]).catch(() => {});
});