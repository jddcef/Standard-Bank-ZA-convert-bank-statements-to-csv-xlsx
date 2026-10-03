/**
 * Characterisation tests for the sanity check's known gaps.
 *
 * These are NOT bugs this suite introduced — they describe what
 * performFileSanity() does today. They are written to fail loudly the moment
 * the behaviour changes, which is exactly when you want to re-read the
 * reasoning above and decide whether the new behaviour is correct.
 *
 * Each gap is a way a figure can be wrong in the export without the UI
 * reporting an error.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';

const { app } = loadApp();
const { performFileSanity } = app;

function txn(amount, balance, details = 'EFT PAYMENT') {
    return { date: '01 Feb', year: 2026, details, category: 'Uncategorized', amount, balance, source: 't.pdf' };
}

describe('gap: no closing-balance verification on current accounts', () => {
    test('trailing rows that fail to parse are not detected', () => {
        // Three real rows were on the statement, but only two parsed. The
        // chain over the two parsed rows is internally consistent, so the
        // final balance is wrong by the amount of the dropped row — yet the
        // file reports zero errors and the UI badge reads "Verified".
        const dropped = txn('899.99', '2999.99', 'DROPPED ROW');
        const f = {
            statementType: 'current',
            startingBalance: 1000.0,
                    closingBalance: 2999.99, // what the statement actually printed
            transactions: [txn('100.00', '1100.00'), txn('1000.00', '2100.00')]
        };

        assert.equal(performFileSanity(f), 0, 'no error is raised today');
        assert.equal(f.transactions[1].sanity, 'ok');

        // The statement's own closing balance disagrees with the last parsed
                // row's balance by exactly the dropped row's amount. A closing-balance
                // check on current accounts would catch this.
        const lastParsed = Number.parseFloat(f.transactions[1].balance);
                const shortfall = f.closingBalance - lastParsed;
                assert.ok(
                    Math.abs(shortfall - Number(dropped.amount)) < 0.01,
                    `expected a ${dropped.amount} shortfall, got ${shortfall}`
                );
    });
});

describe('gap: a missing opening balance disables the check but still reports success', () => {
    test('all rows go "unknown" while errorCount stays zero', () => {
        const f = {
            statementType: 'current',
            startingBalance: null,
            closingBalance: null,
            transactions: [txn('100.00', '1100.00'), txn('-50.00', '1050.00')]
        };

        const errors = performFileSanity(f);

        assert.equal(errors, 0);
        assert.deepEqual(f.transactions.map((t) => t.sanity), ['unknown', 'unknown']);
        // renderAll() turns errorCount === 0 into a green "Math OK" badge.
        assert.ok(errors === 0);
    });
});

describe('gap: no figure-coverage check', () => {
    test('an amount present in the output can be absent from the statement', () => {
        // Nothing verifies that output amounts correspond to figures printed on
        // the PDF, so a mis-parsed column can produce a wrong-but-consistent
        // chain. This test records that the chain check cannot detect it.
        const f = {
            statementType: 'current',
            startingBalance: 1000.0,
            closingBalance: 1000.0,
            // Balance column actually held the reference number, not the balance.
            transactions: [txn('100.00', '0.00'), txn('-50.00', '0.00')]
        };

        assert.equal(performFileSanity(f), 2);
        assert.deepEqual(f.transactions.map((t) => t.sanity), ['err', 'err']);
    });

    test('totals on non-transaction lines are never reconciled', () => {
        // A statement printing "Total debits 1,234.56" is never compared with
        // the sum of parsed amounts, so a wholly missing row goes unnoticed
        // when the balance chain happens to survive.
        const f = {
            statementType: 'current',
            startingBalance: 1000.0,
            closingBalance: 1000.0,
            transactions: [txn('0.00', '1000.00')]
        };

        assert.equal(performFileSanity(f), 0);
        // The row count and the debits total are simply never compared.
        assert.equal(f.transactions.length, 1);
    });
});