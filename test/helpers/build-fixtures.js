#!/usr/bin/env node
/**
 * Builds the derived fixture cache from the committed anonymised PDFs, and
 * writes a human-readable text render next to it for eyeballing.
 *
 *   npm run fixtures:build          rebuild every derived fixture
 *   npm run fixtures:build -- --force  ignore the cache
 *   npm run fixtures:list           show which PDFs are present
 *
 * The .json is only a speed cache. If it ever disagrees with the .pdf, the .pdf
 * wins — pass --force, or delete test/fixtures/derived.
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadApp } from './load-app.js';
import { extractRawPages, listPdfFixtures, PDF_DIR, DERIVED_DIR } from './pdf.js';

const force = process.argv.includes('--force');
const listOnly = process.argv.includes('--list');

const names = listPdfFixtures();

if (listOnly) {
    console.log(`PDF fixtures in ${PDF_DIR}:`);
    if (!names.length) console.log('  (none — see test/fixtures/README.md)');
    names.forEach((n) => console.log(`  - ${n}.pdf`));
    process.exit(0);
}

if (!names.length) {
    console.error(
        'No PDFs found. Drop anonymised statements into test/fixtures/pdfs, or run:\n' +
        '  npm run anonymise -- <statement.pdf>'
    );
    process.exit(1);
}

if (force && existsSync(DERIVED_DIR)) {
    rmSync(DERIVED_DIR, { recursive: true, force: true });
}
mkdirSync(DERIVED_DIR, { recursive: true });

const { app } = loadApp();

for (const name of names) {
    try {
        const rawPages = await extractRawPages(name, { useCache: !force });
        const text = rawPages
            .map((p, i) => {
                const lines = app.groupLines(p.items.map((it) => ({ ...it })));
                return `--- page ${i + 1} ---\n${lines.join('\n')}`;
            })
            .join('\n');
        writeFileSync(path.join(DERIVED_DIR, `${name}.txt`), text, 'utf8');

        const derived = path.join(DERIVED_DIR, `${name}.json`);
        console.log(
            `  ${name}: ${rawPages.length} page(s), ` +
            `${rawPages.reduce((n, p) => n + p.items.length, 0)} text items ` +
            `(${existsSync(derived) ? 'cached' : 'built'})`
        );
    } catch (err) {
        console.error(`  ${name}: FAILED - ${err.message}`);
        process.exitCode = 1;
    }
}

console.log(`\nDerived fixtures written to ${path.relative(process.cwd(), DERIVED_DIR)}`);
console.log(`${readdirSync(DERIVED_DIR).length} file(s) present.`);