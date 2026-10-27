/**
 * cleanNum() normalises the many number formats Standard Bank prints into the
 * plain decimal string the rest of the app parses. Every balance-chain
 * assertion depends on it, so it gets the most exhaustive coverage here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from '../helpers/load-app.js';

const { app } = loadApp();
const { cleanNum } = app;

describe('cleanNum', () => {
    test('passes through plain decimals unchanged', () => {
        assert.equal(cleanNum('1234.56'), '1234.56');
        assert.equal(cleanNum('0.00'), '0.00');
        assert.equal(cleanNum('999999.99'), '999999.99');
    });

    test('strips thousands separators', () => {
        assert.equal(cleanNum('1,234.56'), '1234.56');
        assert.equal(cleanNum('1,234,567.89'), '1234567.89');
    });

    test('treats a comma three digits from the end as a decimal point', () => {
        // European-style output, as seen on some card statements.
        assert.equal(cleanNum('1234,56'), '1234.56');
        assert.equal(cleanNum('1.234,56'), '1234.56');
    });

    test('removes embedded whitespace', () => {
        assert.equal(cleanNum('1 234.56'), '1234.56');
        assert.equal(cleanNum('  42.00  '), '42.00');
    });

    test('handles a trailing minus sign', () => {
        assert.equal(cleanNum('500.00-'), '-500.00');
        assert.equal(cleanNum('-500.00'), '-500.00');
    });

    test('keeps a leading minus sign alongside separators', () => {
        assert.equal(cleanNum('-1,250.75'), '-1250.75');
        assert.equal(cleanNum('1,250.75-'), '-1250.75');
    });

    test('discards currency symbols and stray characters', () => {
        assert.equal(cleanNum('R 1,234.56'), '1234.56');
        assert.equal(cleanNum('R1,234.56'), '1234.56');
    });

    test('preserves South African spaced values and comma decimals', () => {
        assert.equal(cleanNum('1 234,50'), '1234.50');
        assert.equal(cleanNum('-1 234,50'), '-1234.50');
        assert.equal(cleanNum('1.234,50'), '1234.50');
        assert.equal(cleanNum('10 000.00'), '10000.00');
    });

    test('integers without a decimal part are preserved', () => {
        assert.equal(cleanNum('1000'), '1000');
        assert.equal(cleanNum('5'), '5');

        // A separator exactly 3 characters from the end is always read as a
        // thousands separator. '1,000' has its comma at index 1, not 2, so no
        // split happens at all and every separator is simply dropped.
        assert.equal(cleanNum('1,000'), '1000');
        assert.equal(cleanNum('1,000.00'), '1000.00');
        // Same trap for European-style grouping of a 4-digit integer.
        assert.equal(cleanNum('1.000'), '1000');
    });
});