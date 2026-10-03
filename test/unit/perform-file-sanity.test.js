/**
 * performFileSanity() is the app's only correctness guarantee: it reconstructs
 * the running balance and flags any row where the statement's printed balance
 * disagrees. If it silently passes, users upload wrong figures to YARS.
 *
 * Tests use hand-built transaction objects rather than parsed PDFs so that a
 * single arithmetic rule is isolated and the expected outcome is unambiguous.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';

const ctx = loadApp();
const { app, reset } = ctx;
const { performFileSanity } = app;

/** Builds a transaction row. */
function txn(amount, balance, details = 'EFT PAYMENT') {
    return {
        date: '01 Feb',
        year: 2026,
        details,
        category: 'Uncategorized',
        amount,
        balance,
        source: 'test.pdf'
    };
}

function file(transactions, extra = {}) {
    return {
        statementType: 'current',
        startingBalance: null,
        closingBalance: null,
        transactions,
        ...extra
    };
}

beforeEach(() => reset());

describe('performFileSanity — current account balance chain', () => {
    test('passes a chain whose balances reconcile exactly', () => {
        const f = file([txn('100.00', '1100.00'), txn('-250.50', '849.50')], {
            startingBalance: 1000.0
        });
        const errors = performFileSanity(f);
        assert.equal(errors, 0);
        assert.deepEqual(f.transactions.map((t) => t.sanity), ['ok', 'ok']);
    });

    test('flags a row whose printed balance does not follow from the previous', () => {
        // 1100.00 + 100 = 1200.00, but the statement printed 1300.00.
        const f = file([txn('100.00', '1100.00'), txn('100.00', '1300.00')], {
            startingBalance: 1000.0
        });
        const errors = performFileSanity(f);
        assert.equal(errors, 1);
        assert.equal(f.transactions[0].sanity, 'ok');
        assert.equal(f.transactions[1].sanity, 'err');
        assert.match(f.transactions[1].math, /Exp: 1200\.00/);
    });

    test('re-bases the chain on the printed balance after an error', () => {
        // Matches the app: a bad row does not cascade errors into every later
        // row, so one real break stays one error.
        const f = file(
            [txn('100.00', '1300.00'), txn('100.00', '1400.00'), txn('50.00', '1450.00')],
            { startingBalance: 1000.0 }
        );
        assert.equal(performFileSanity(f), 1);
        assert.deepEqual(f.transactions.map((t) => t.sanity), ['err', 'ok', 'ok']);
    });

    test('tolerates a sub-cent rounding difference', () => {
        const f = file([txn('0.10', '1000.10')], { startingBalance: 1000.0 });
        assert.equal(performFileSanity(f), 0);
        assert.equal(f.transactions[0].sanity, 'ok');
    });

    test('tolerates a one-cent discrepancy but flags two cents', () => {
            // The check is a strict `< 0.01` on the absolute difference.
            assert.equal(performFileSanity(file([txn('0.10', '1000.11')], { startingBalance: 1000.0 })), 0);
            assert.equal(performFileSanity(file([txn('0.10', '1000.12')], { startingBalance: 1000.0 })), 1);
        });

    test('handles a single-transaction statement', () => {
        const f = file([txn('-100.00', '900.00')], { startingBalance: 1000.0 });
        assert.equal(performFileSanity(f), 0);
    });

    test('reports nothing for an empty statement', () => {
        assert.equal(performFileSanity(file([])), 0);
    });
});

describe('performFileSanity — opening balance not found', () => {
    test('marks every row unknown and reports zero errors when the opening balance is missing', () => {
        // Documents current behaviour: the check disables itself and still
        // reports success. See the "silent pass" test in the gaps suite.
        const f = file([txn('100.00', '1100.00'), txn('50.00', '1150.00')]);
        assert.equal(performFileSanity(f), 0);
        assert.deepEqual(f.transactions.map((t) => t.sanity), ['unknown', 'unknown']);
        assert.equal(f.transactions[0].math, undefined);
    });
});

describe('performFileSanity — credit card', () => {
    const ccFile = (transactions, extra = {}) =>
        file(transactions, { statementType: 'credit', ...extra });

    test('reconstructs the balance by accumulating from the opening balance', () => {
        const f = ccFile([txn('-100.00', '0.00'), txn('-50.00', '0.00')], {
            startingBalance: 500.0
        });
        assert.equal(performFileSanity(f), 0);
        assert.equal(f.transactions[0].balance, '400.00');
        assert.equal(f.transactions[1].balance, '350.00');
    });

    test('does not overwrite a transaction that already has a balance', () => {
        // Only relevant if credit statements ever print a per-row balance.
        const f = ccFile([txn('-100.00', '0.00')], { startingBalance: 500.0 });
        performFileSanity(f);
        assert.equal(f.transactions[0].balance, '400.00');
    });

    test('flags a closing-balance mismatch against the statement total', () => {
        const f = ccFile([txn('-100.00', '0.00')], {
            startingBalance: 500.0,
            closingBalance: 399.0
        });
        assert.equal(performFileSanity(f), 1);
        assert.equal(f.transactions[0].sanity, 'err');
        assert.match(f.transactions[0].math, /Closing mismatch/);
        assert.match(f.transactions[0].math, /Calculated: 400\.00/);
        assert.match(f.transactions[0].math, /Statement: 399\.00/);
    });

    test('passes when the closing balance agrees', () => {
        const f = ccFile([txn('-100.00', '0.00')], {
            startingBalance: 500.0,
            closingBalance: 400.0
        });
        assert.equal(performFileSanity(f), 0);
    });

    test('accepts a one-cent closing difference', () => {
        const f = ccFile([txn('-100.00', '0.00')], {
            startingBalance: 500.0,
            closingBalance: 400.01
        });
        assert.equal(performFileSanity(f), 0);
    });

    test('cannot verify the closing balance when it was not scraped', () => {
        const f = ccFile([txn('-100.00', '0.00')], { startingBalance: 500.0 });
        assert.equal(performFileSanity(f), 0);
    });

    test('attaches the mismatch to the last row, not the first', () => {
        const f = ccFile([txn('-100.00', '0.00'), txn('-100.00', '0.00')], {
            startingBalance: 500.0,
            closingBalance: 999.0
        });
        assert.equal(performFileSanity(f), 1);
        assert.equal(f.transactions[0].sanity, 'ok');
        assert.equal(f.transactions[1].sanity, 'err');
    });
});

describe('performFileSanity — reference length', () => {
    test('flags a detail part longer than the 60 character YARS limit', () => {
        const long = 'X'.repeat(61);
        const f = file([txn('10.00', '10.00', long)], { startingBalance: 0.0 });
        assert.equal(performFileSanity(f), 1);
        assert.equal(f.transactions[0].sanity, 'err');
        assert.match(f.transactions[0].math, /Reference > 60 chars/);
    });

    test('accepts a detail part of exactly 60 characters', () => {
        const f = file([txn('10.00', '10.00', 'X'.repeat(60))], { startingBalance: 0.0 });
        assert.equal(performFileSanity(f), 0);
    });

    test('checks every continuation part, not just the first', () => {
        const f = file(
            [txn('10.00', '10.00', `SHORT | ${'Y'.repeat(61)}`)],
            { startingBalance: 0.0 }
        );
        assert.equal(performFileSanity(f), 1);
    });

    test('reports at most one length error per row', () => {
        const f = file(
            [txn('10.00', '10.00', `${'Y'.repeat(61)} | ${'Z'.repeat(61)}`)],
            { startingBalance: 0.0 }
        );
        assert.equal(performFileSanity(f), 1);
    });
});

describe('performFileSanity — combined failures', () => {
    test('counts both a balance break and an over-long reference', () => {
            // The balance break increments once, then the length check increments
            // again on the same row — a single bad row can cost 2 errors.
            const f = file([txn('100.00', '9999.00', 'Z'.repeat(61))], { startingBalance: 1000.0 });
            assert.equal(performFileSanity(f), 2);
            // The length check overwrites the arithmetic note.
            assert.match(f.transactions[0].math, /Reference > 60 chars/);
        });

        test('sums errors across many rows', () => {
            // Row 3 re-seeds `prev` from the wrong balance it just reported, so it
            // is also wrong: 3 broken rows, not 2.
            const f = file(
                [
                    txn('100.00', '1100.00'),
                    txn('100.00', '9999.00'),
                    txn('100.00', '9999.00'),
                    txn('100.00', '1400.00')
                ],
                { startingBalance: 1000.0 }
            );
            assert.equal(performFileSanity(f), 3);
            assert.deepEqual(f.transactions.map((t) => t.sanity), ['ok', 'err', 'err', 'err']);
        });
});