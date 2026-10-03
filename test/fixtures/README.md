# Test fixtures

Three tiers. Only the middle one is committed.

| Directory | Committed? | Purpose |
|---|---|---|
| `originals/` | **no** (gitignored) | your untouched statements, kept locally only |
| `pdfs/` | yes | the anonymised PDFs the tests actually run against |
| `derived/` | no (gitignored) | a regenerable speed cache of extracted text |

## Adding a statement

Put the original PDF in `originals/`, then redact it:

```bash
npm run anonymise -- originals/my-statement.pdf
```

That writes `pdfs/my-statement.pdf` plus `pdfs/my-statement.anonymisation-manifest.json`.
The manifest lists every substitution it made and, importantly, every case it
**could not** confidently redact (it reports `name-UNREDACTED` candidates rather
than guessing). **Read the manifest before committing.**

The rewriter flattens the page to monospaced text while preserving row order,
column x-offsets and every monetary figure — the running-balance arithmetic is
what makes these fixtures valuable. Non-monetary digit runs are left alone so
column widths and layout survive. Long rows are truncated rather than wrapped,
and a warning is printed if that happens; check for it, because a truncated row
silently loses data and the figure-coverage test is what catches it.

## Checking a fixture before you commit it

```bash
npm run fixtures:list      # what is present
npm run fixtures:build     # regenerate the cache
npm test                   # unit tier always runs; integration tier activates
```

Two things worth eyeballing in `derived/<name>.txt` before committing:

- the text reads in the right order, top to bottom;
- no `…` truncation marker appears mid-figure.

## Why tests skip rather than fail when a fixture is absent

The integration tier discovers `pdfs/*.pdf` at import time. With none present it
registers its tests as **skipped** with a message naming the command to run.
A missing fixture therefore can never read as a green suite — which is the
failure mode that matters most here.