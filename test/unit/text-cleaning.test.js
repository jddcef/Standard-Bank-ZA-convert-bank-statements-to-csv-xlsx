/**
 * Description cleaning, junk detection, categorisation and the YARS detail split.
 * These decide what ends up in Details 1/2/3 and which lines get dropped
 * entirely, so a regression here silently deletes data.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';

const ctx = loadApp();
const { app, reset } = ctx;
const { cleanDetails, cleanCcDetails, isJunk, getCategory, splitDetails, escapeRegExp, sanitizeId } = app;

beforeEach(() => reset());

describe('escapeRegExp', () => {
    test('escapes regex metacharacters', () => {
        assert.equal(escapeRegExp('a.b*c+d?'), 'a\\.b\\*c\\+d\\?');
        assert.equal(escapeRegExp('(x)'), '\\(x\\)');
    });

    test('produces a pattern that matches the literal input', () => {
        assert.ok(new RegExp(escapeRegExp('*Overdraft facilities*')).test('*Overdraft facilities*'));
    });
});

describe('sanitizeId', () => {
    test('produces a DOM-safe id from a filename', () => {
        // Every character outside [a-z0-9] becomes '-', so each run of
                // punctuation/spaces collapses into exactly one '-'.
                assert.equal(sanitizeId('Statement 2026 (Final).pdf'), 'file-statement-2026--final--pdf');
    });
});

describe('cleanDetails', () => {
    test('removes junk keywords case-insensitively', () => {
        assert.equal(cleanDetails('Standard Bank EFT PAYMENT'), 'EFT PAYMENT');
        assert.equal(cleanDetails('standard bank FEE'), 'FEE');
    });

    test('collapses internal whitespace', () => {
        assert.equal(cleanDetails('CARD    PURCHASE'), 'CARD PURCHASE');
    });

    test('trims the result', () => {
        assert.equal(cleanDetails('   ATM WITHDRAWAL   '), 'ATM WITHDRAWAL');
    });

    test('returns an empty string when the line is entirely junk', () => {
        // Callers treat "" as falsy and drop the line rather than appending it.
        assert.equal(cleanDetails('www.standardbank.co.za'), '');
    });

    test('keeps keywords verbatim when the keyword filter is off', () => {
        app.appState.filters.keyword = false;
        assert.equal(cleanDetails('Standard Bank EFT'), 'Standard Bank EFT');
    });

    test('does not treat keyword text as a regex', () => {
        assert.equal(cleanDetails('PAYMENT (S)'), 'PAYMENT (S)');
    });
});

describe('cleanCcDetails', () => {
    test('strips leading pipe and hash separators', () => {
        assert.equal(cleanCcDetails('|#ATM WITHDRAWAL'), 'ATM WITHDRAWAL');
        assert.equal(cleanCcDetails('   ##PURCHASE'), 'PURCHASE');
    });

    test('also removes junk keywords', () => {
        assert.equal(cleanCcDetails('|Standard Bank EFT'), 'EFT');
    });
});

describe('isJunk', () => {
    test('flags very short lines', () => {
            assert.equal(isJunk('a'), 'Short');
            assert.equal(isJunk(''), 'Short');
            assert.equal(isJunk(null), 'Short');
            // Two characters is the shortest input that is not "Short".
            assert.equal(isJunk('ab'), null);
        });

    test('flags over-long lines as noise', () => {
        assert.equal(isJunk('x'.repeat(61)), 'Disclaimer/Noise Pattern');
    });

    test('flags known junk keywords', () => {
        assert.equal(isJunk('BANK STATEMENT'), 'BANK STATEMENT');
    });

    test('flags bare account-length digit runs when the regex filter is on', () => {
        assert.equal(isJunk('123456789'), 'Account Pattern');
    });

    test('flags bare 4-digit postcodes when the regex filter is on', () => {
        assert.equal(isJunk('8001'), 'Postcode Pattern');
    });

    test('ignores the regex patterns when that filter is off', () => {
        app.appState.filters.regex = false;
        assert.equal(isJunk('123456789'), null);
    });

    test('returns null for an ordinary transaction description', () => {
        assert.equal(isJunk('EFT PAYMENT TO SUPPLIER'), null);
    });

    test('returns null for null or empty input', () => {
        assert.ok(isJunk(null));
        assert.ok(isJunk(''));
    });
});

describe('getCategory', () => {
    test('matches the first matching configured rule', () => {
        assert.equal(getCategory('SERVICE FEE CHARGED'), 'Bank Fees');
    });

    test('matches on a substring anywhere in the details', () => {
        assert.equal(getCategory('POS PURCHASE ATM'), 'ATM Withdrawal');
    });

    test('is case-insensitive', () => {
        assert.equal(getCategory('salary payment received'), 'Salary');
    });

    test('falls back to Uncategorized', () => {
        assert.equal(getCategory('SOMETHING UNMATCHED'), 'Uncategorized');
    });

    test('respects a user-edited category list', () => {
        app.appState.categories = ['Church: PARISH'];
        assert.equal(getCategory('PARISH DONATION'), 'Church');
        assert.equal(getCategory('ATM WITHDRAWAL'), 'Uncategorized');
    });
});

describe('splitDetails', () => {
    test('splits a 4-digit code out of the main details when requested', () => {
        const r = splitDetails('1234 EFT PAYMENT TO SUPPLIER', true);
        assert.equal(r.details1, 'EFT PAYMENT TO SUPPLIER');
        assert.equal(r.details2, '1234');
        assert.equal(r.details3, '');
    });

    test('keeps everything in Details 1 when not splitting on code', () => {
        const r = splitDetails('1234 EFT PAYMENT TO SUPPLIER', false);
        assert.equal(r.details1, '1234 EFT PAYMENT TO SUPPLIER');
        assert.equal(r.details2, '');
    });

    test('puts continuation parts into Details 3', () => {
        const r = splitDetails('1234 EFT PAYMENT | REF ABC | extra', true);
        assert.equal(r.details1, 'EFT PAYMENT');
        assert.equal(r.details2, '1234');
        assert.equal(r.details3, 'REF ABC | extra');
    });

    test('handles details with no code and no continuation', () => {
        const r = splitDetails('ATM WITHDRAWAL', true);
        assert.equal(r.details1, 'ATM WITHDRAWAL');
        assert.equal(r.details2, '');
        assert.equal(r.details3, '');
    });

    test('handles null and empty input', () => {
        assert.deepEqual(splitDetails(null, true), { details1: '', details2: '', details3: '' });
        assert.deepEqual(splitDetails('', false), { details1: '', details2: '', details3: '' });
    });
});