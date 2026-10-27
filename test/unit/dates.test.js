/**
 * Date parsing across the three statement formats. Year attribution matters:
 * the export writes a Year column, and a wrong year silently misfiles rows in
 * a YARS upload.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';

const { app } = loadApp();
const {
    parsePeriodDate,
    parseCreditCardPeriodDate,
    formatShortDate,
    parseCcDate,
    getTransactionYear
} = app;

describe('parsePeriodDate (current account)', () => {
    test('parses "28 Feb 2026"', () => {
        assert.deepEqual(parsePeriodDate('28 Feb 2026'), { day: 28, month: 2, year: 2026 });
    });

    test('is case-insensitive and tolerates full month names', () => {
        assert.deepEqual(parsePeriodDate('01 JANUARY 2025'), { day: 1, month: 1, year: 2025 });
    });

    test('falls back to month 1 for an unrecognised month name', () => {
        assert.deepEqual(parsePeriodDate('15 Foo 2024'), { day: 15, month: 1, year: 2024 });
    });

    test('returns null for missing or malformed input', () => {
        assert.equal(parsePeriodDate(''), null);
        assert.equal(parsePeriodDate(null), null);
        assert.equal(parsePeriodDate('Feb 2026'), null);
    });
});

describe('parseCreditCardPeriodDate', () => {
    test('expands a two-digit year into the 2000s', () => {
        assert.deepEqual(parseCreditCardPeriodDate('05 Mar 25'), { day: 5, month: 3, year: 2025 });
    });

    test('keeps a four-digit year as-is', () => {
        assert.deepEqual(parseCreditCardPeriodDate('05 Mar 2025'), { day: 5, month: 3, year: 2025 });
    });

    test('returns null for malformed input', () => {
        assert.equal(parseCreditCardPeriodDate('Mar'), null);
    });
});

describe('parseCcDate', () => {
    test('formats the display date and expands the year', () => {
        assert.deepEqual(parseCcDate('05 Mar 25'), { dateDisplay: '05 Mar', year: 2025 });
    });

    test('zero-pads a single-digit day', () => {
        assert.deepEqual(parseCcDate('1 Apr 24'), { dateDisplay: '01 Apr', year: 2024 });
    });

    test('does not validate that three tokens are really a date', () => {
                    // Any 3-token string parses: the "day" and "month" are copied
                    // verbatim and the third token is force-run through parseInt, so
                    // garbage in the year slot yields NaN rather than the input.
                    assert.deepEqual(parseCcDate('05 Mar xx'), { dateDisplay: '05 Mar', year: NaN });
                    assert.deepEqual(parseCcDate('not a date'), { dateDisplay: 'not a', year: NaN });

                    // Fewer than three tokens is the only path that returns the input
                    // untouched.
                    assert.deepEqual(parseCcDate('05 Mar'), { dateDisplay: '05 Mar', year: null });
        });
            });

describe('formatShortDate', () => {
    test('renders a zero-padded short date', () => {
        assert.equal(formatShortDate({ day: 5, month: 3, year: 2025 }), '05 Mar 2025');
    });

    test('returns an empty string for null', () => {
        assert.equal(formatShortDate(null), '');
    });
});

describe('getTransactionYear', () => {
    test('uses the single year when the period does not span a year end', () => {
        const start = { day: 1, month: 2, year: 2026 };
        const end = { day: 28, month: 2, year: 2026 };
        assert.equal(getTransactionYear('15 Feb', start, end, 1999), 2026);
    });

    test('splits across the year boundary for a Dec-Jan period', () => {
        const start = { day: 15, month: 12, year: 2025 };
        const end = { day: 15, month: 1, year: 2026 };
        assert.equal(getTransactionYear('20 Dec', start, end, 1999), 2025);
        assert.equal(getTransactionYear('05 Jan', start, end, 1999), 2026);
    });

    test('falls back to the guessed year when the period is unknown', () => {
        assert.equal(getTransactionYear('15 Feb', null, null, 2024), 2024);
    });

    test('falls back to the guessed year for an empty or short date', () => {
        assert.equal(getTransactionYear('', null, null, 2024), 2024);
        assert.equal(getTransactionYear('Feb', null, null, 2024), 2024);
    });
});