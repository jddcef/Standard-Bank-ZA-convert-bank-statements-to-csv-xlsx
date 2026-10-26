# Test fixtures

Three tiers. Only the middle one is committed.

| Directory | Committed? | Purpose |
|---|---|---|
| `originals/` | **no** (gitignored) | your untouched statements, kept locally only |
| `pdfs/` | yes | the anonymised PDFs the tests actually run against |
| `derived/` | no (gitignored) | a regenerable speed cache of extracted text |

## Adding a statement

Put the original PDF in `originals/`, then anonymise it:

```bash
npm run anonymise -- originals/my-statement.pdf
```

That writes `pdfs/my-statement.pdf` plus
`pdfs/my-statement.anonymisation-manifest.json`.
**Read the manifest before committing** — it lists every substitution made and
every case the tool could not confidently rewrite (preserved emails, streams
skipped for an unsupported filter, and so on).

## How the anonymiser works

It rewrites the PDF **in place**. Only the literal-string operands of the text
operators `Tj`, `TJ`, `'` and `"` are touched; every other byte of the file —
fonts, images, page geometry, the text matrix, kerning arrays — is copied
through verbatim. Nothing is re-rendered, so nothing can reflow.

Three properties make this safe for layout:

1. **Every replacement is the same length as the word it replaces.** The
   character count is preserved, so each glyph occupies exactly the advance
   width the original generator assumed and the rest of the line does not move.
2. **Substitution is deterministic and consistent.** One source word always
   maps to one replacement, on every page of every file, so `BALANCE` is the
   same gibberish wherever it appears. Repeated words keep repeating.
3. **Only operands are rewritten, never the operators or numbers.** Positions,
   `Td`/`Tm` offsets and `TJ` kerning values are untouched.

The same word always becomes the same word, and the result is gibberish —
consonant/vowel patterns that are not English words and not real names.

### Digits

Monetary figures are preserved **verbatim**. The running-balance chain is what
makes these fixtures valuable, so changing an amount would make the arithmetic
meaningless. All other digits (dates, references, account numbers) are shifted
deterministically, preserving parity so totals still add up. Pass
`--shift-digits` to perturb money too, if a scenario needs it.

### Protected vocabulary

The parser's own vocabulary is protected: statement-type keywords, junk
keywords, category labels, month names **and their three-letter abbreviations**,
and `BALANCE BROUGHT FORWARD` — the opening-balance anchor, which is what stops
the closing-balance check from silently passing.

Protection is applied **word by word**, not only as whole phrases. `TJ` arrays
frequently split a word mid-token (`(BALANCE BROUGHT)( FOR)(W)(ARD)`), so a
phrase-level rule would match neither half. Protecting each anchor word
independently is what keeps it intact regardless of where the generator chose to
break the line.

### Hex string operands

Some generators write strings as `<48656C6C6F>` rather than `(Hello)`. These
are decoded, rewritten and re-encoded in the same encoding. Round-tripping
through hex (not UTF-8) is deliberate: it keeps the byte count identical, so
glyph advances do not shift.

## Password-protected files

A password-protected PDF is **skipped with a message**, not partially processed.
Remove the protection first (for example `qpdf --decrypt`) and re-run.

## Checking a fixture before you commit it

```bash
npm run fixtures:list      # what is present
npm run fixtures:build     # regenerate the cache (-- --force to overwrite)
npm test                   # unit tier always runs; integration tier activates
```

The anonymiser verifies its own output: it re-extracts the text from the file it
just wrote and compares the set of money-shaped figures against the original.
**Any lost figure sets a non-zero exit code**, so a run that silently dropped an
amount cannot pass unnoticed.

## Known parser gaps

`KNOWN_UNSUPPORTED` in `test/integration/real-pdf.test.js` lists statements the
parser does not handle. Their tests are skipped with the reason printed, and a
companion test asserts each one still parses to zero rows — so if the parser
starts handling one, that test fails and tells you to remove it from the list
rather than leaving the gap invisible.

## Why tests skip rather than fail when a fixture is absent

The integration tier discovers `pdfs/*.pdf` at import time. With none present it
registers its tests as **skipped** with a message naming the command to run.
A missing fixture therefore can never read as a green suite — which is the
failure mode that matters most here.