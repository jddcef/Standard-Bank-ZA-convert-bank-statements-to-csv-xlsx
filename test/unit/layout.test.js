/**
 * Layout reconstruction: groupLines() reassembles pdf.js text items into
 * visual lines, regexSplitLines() breaks a line that holds two transactions,
 * and classifyStatement() routes a statement to the right parsing engine.
 *
 * The item fixtures below are built with makeItem() so they carry the real
 * transform/width shape groupLines() depends on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';

const { app } = loadApp();
const { groupLines, regexSplitLines, classifyStatement } = app;

/** Builds a pdf.js text item at (x, y) with an approximate width. */
function makeItem(str, x, y, widthPerChar = 5) {
    return {
        str,
        width: str.length * widthPerChar,
        // transform[4] = x, transform[5] = y; remaining elements unused here.
        transform: [1, 0, 0, 1, x, y]
    };
}

describe('groupLines', () => {
    test('joins items on the same baseline into one line', () => {
        const lines = groupLines([
            makeItem('DATE', 50, 700),
            makeItem('DESCRIPTION', 100, 700),
            makeItem('BALANCE', 300, 700)
        ]);
        assert.deepEqual(lines, ['DATE DESCRIPTION BALANCE']);
    });

    test('orders lines top to bottom', () => {
        const lines = groupLines([
            makeItem('SECOND', 50, 600),
            makeItem('FIRST', 50, 700)
        ]);
        assert.deepEqual(lines, ['FIRST', 'SECOND']);
    });

    test('orders same-row items left to right', () => {
        const lines = groupLines([
            makeItem('RIGHT', 300, 700),
            makeItem('LEFT', 50, 700)
        ]);
        assert.deepEqual(lines, ['LEFT RIGHT']);
    });

    test('splits lines whose baselines differ by more than the tolerance', () => {
        const lines = groupLines([
            makeItem('ROW1', 50, 700),
            makeItem('ROW2', 50, 690)
        ]);
        assert.deepEqual(lines, ['ROW1', 'ROW2']);
    });

    test('omits a separator space between tightly adjacent items', () => {
        // The parser stitches split words back together, so a gap under the
        // threshold must not introduce a space.
        const lines = groupLines([makeItem('BAL', 50, 700, 1), makeItem('ANCE', 52, 700, 1)]);
        assert.deepEqual(lines, ['BALANCE']);
    });

    test('trims each line', () => {
        const lines = groupLines([makeItem('   PADDED   ', 50, 700)]);
        assert.deepEqual(lines, ['PADDED']);
    });

    test('returns an empty array for no items', () => {
        assert.deepEqual(groupLines([]), []);
    });

    test('does not mutate the caller\'s array order as a side effect of output', () => {
        // groupLines sorts in place by design; document that so callers know.
        const items = [makeItem('B', 50, 600), makeItem('A', 50, 700)];
        const lines = groupLines(items);
        assert.deepEqual(lines, ['A', 'B']);
        assert.equal(items[0].str, 'A');
    });
});

describe('regexSplitLines', () => {
    const DATE = /\b\d{1,2}\s+[A-Za-z]{3}\s+\d{2}\b/;

    test('leaves a single-transaction line untouched', () => {
        const input = ['01 Jan 25 PURCHASE 100.00'];
        assert.deepEqual(regexSplitLines(input), input);
    });

    test('splits a line carrying two transactions at the second date', () => {
        const line = '01 Jan 25 PURCHASE 100.00 500.00 05 Feb 25 SALARY 2000.00 2500.00';
        const out = regexSplitLines([line]);
        assert.equal(out.length, 2);
        assert.ok(DATE.test(out[0]));
        assert.ok(out[0].startsWith('01 Jan 25'));
        assert.ok(out[1].startsWith('05 Feb 25'));
    });

    test('preserves content on both sides of the split', () => {
        const line = '01 Jan 25 A 1.00 10.00 05 Feb 25 B 2.00 12.00';
        const [a, b] = regexSplitLines([line]);
        assert.equal(a, '01 Jan 25 A 1.00 10.00');
        assert.equal(b, '05 Feb 25 B 2.00 12.00');
    });

    test('leaves lines with no date at all untouched', () => {
        const input = ['ACCOUNT SUMMARY', 'TOTAL 1,234.56'];
        assert.deepEqual(regexSplitLines(input), input);
    });

    test('handles an empty input list', () => {
        assert.deepEqual(regexSplitLines([]), []);
    });
});

describe('classifyStatement', () => {
    test('detects a credit card statement', () => {
        const lines = ['STANDARD BANK', 'CARD DIVISION', 'GOLD CARD', 'CREDIT LIMIT 50 000.00'];
        assert.equal(classifyStatement(lines, null), 'credit');
    });

    test('detects a credit card from any one of the marker phrases', () => {
        assert.equal(classifyStatement(['AVAILABLE MONEY TO SPEND 1 000.00'], null), 'credit');
        assert.equal(classifyStatement(['TRANSACTION DETAILS ACCOUNT 1234'], null), 'credit');
        assert.equal(classifyStatement(['PLATINUM CARD'], null), 'credit');
    });

    test('detects a weekly statement from the column header', () => {
        const lines = ['ACME MINIMALIST FOODS CC', 'DATE DESCRIPTION AMOUNT (R) BALANCE (R)'];
        assert.equal(classifyStatement(lines, null), 'weekly');
    });

    test('the weekly header must appear on ONE line, not spread across lines', () => {
            // Each branch tests a single line for all three substrings at once, so
            // a header split across three lines does NOT classify as weekly...
            const split = ['DATE   DESCRIPTION', 'AMOUNT (R)', 'BALANCE (R)'];
            assert.equal(classifyStatement(split, null), 'current');

            // ...and extra internal spacing defeats the literal first alternative
            // too, because "DATE DESCRIPTION AMOUNT (R) BALANCE (R)" is matched as
            // a contiguous substring with exactly one space between the words.
            assert.equal(classifyStatement(['DATE   DESCRIPTION   AMOUNT (R)   BALANCE (R)'], null), 'current');

            // Exactly one space between each header word is what matches.
            assert.equal(classifyStatement(['DATE DESCRIPTION AMOUNT (R) BALANCE (R)'], null), 'weekly');
        });

    test('falls back to the raw page text for the weekly header', () => {
        const rawPages = [
            { items: [{ str: 'DATE DESCRIPTION AMOUNT (R) BALANCE (R)' }] }
        ];
        assert.equal(classifyStatement([], rawPages), 'weekly');
    });

    test('defaults to current', () => {
        assert.equal(classifyStatement(['BALANCE BROUGHT FORWARD 100.00'], null), 'current');
    });

    test('defaults to current for empty input', () => {
        assert.equal(classifyStatement([], null), 'current');
    });

    test('prefers credit over weekly when both markers appear', () => {
        const lines = ['CARD DIVISION', 'DATE DESCRIPTION AMOUNT (R) BALANCE (R)'];
        assert.equal(classifyStatement(lines, null), 'credit');
    });
});