# Math contract and recognition pipeline validation

Branch: `fix/math-contract-recognition-20260913`. No merge into `main` or production deployment is performed by this change.

## Verified checkpoint

Application/CI commit: `108950c052e07c69b443f63d87cd66f2e0e579bf`.
GitHub Actions run: `34765052758`, 2026-09-13. A subsequent documentation-only commit records these results without changing application code.

| Check | Result |
| --- | --- |
| Focused Studio suite | 140 passed, 0 failed |
| Production build through `npm test` | Passed |
| Full project suite | 255 passed, 1 failed, 0 skipped, 256 total |
| Chromium browser regression | Passed |
| Actual browser-exported DOCX | XML inspected and both rendered pages visually inspected |
| Live model accuracy/latency; Microsoft Word/WPS | Not verified; local acceptance required |

The remaining full-suite failure is `tests/homework-e2e.test.mjs:250`: the homework end-to-end scenario received HTTP 503 where it expected 201. This test was not skipped or weakened. Earlier runs also showed unstable homework/publication end-to-end outcomes; the precise cause of that remaining failure has not been established. Do not treat the focused-suite or browser success as a fully green project suite.

The browser harness used the actual React component, canvas, IndexedDB and DOCX exporter, with authentication/model HTTP responses mocked. It verified upload, reload without another recognition request, strict export refusal for an unsupported formula, the separate REVIEW_ONLY download, owner-isolated storage and rollback after a failed write. At 1440px and 390px, document scroll width equalled viewport width and there were no page errors. One source-image write was followed by 20 unchanged checkpoints with zero additional source-image writes.

The exported formal DOCX contained 22 editable math objects, nine matrix structures and two native tables. All explicit math run base sizes were 22 half-points (11 points); there were no embedded images or font files. Both pages were rendered and inspected for arrows, matrix delimiters, nested grids, real horizontal rules and column alignment. Installed substitute fonts were used for unavailable Word fonts; native Word/WPS rendering remains a separate acceptance check.

## Local checkout

Preserve uncommitted work before switching branches. Use a current Node.js 22 release. The focused suite also runs on Node 22.16; the full project has pre-existing direct TypeScript imports that need a release with type stripping enabled by default or the appropriate Node flag.

```sh
git fetch origin
git switch --track origin/fix/math-contract-recognition-20260913
npm ci
npm run test:studio
npm run benchmark:studio
npm run dev
```

If the branch already exists locally, switch to it and use `git pull --ff-only` instead of creating it again. The existing development command uses Unix environment-variable syntax. On Windows, run its components separately:

```sh
node scripts/prepare-homework-assets.mjs
node scripts/sync-local-env.mjs
npx vinext dev --port 3001
```

Open the local `/answer-studio` page. Keep the existing model endpoint, model, reasoning configuration, source files and concurrency unchanged for an A/B comparison.

**Data safety:** initial validation should use a new browser profile. The draft database upgrades to IndexedDB version 2, storing original page images separately from checkpoints. Existing version-1 drafts migrate on their first successful write, but older application versions that explicitly open database version 1 cannot open an upgraded database. Preserve original source files and a browser-profile backup; do not clear storage to work around an error. Close old Studio tabs when prompted before upgrading. The automated browser test covers new version-2 storage, not a real user's version-1 profile migration.

## What changed

- One shared math capability registry drives the symbol map, escape repair, prompt capabilities and parser. Inline and display math use an 11-point base size. Native Word script scaling is retained; no depth-based enlargement is applied.
- Balanced grid parsing handles nested matrices/cases/aligned environments, escaped separators and array column alignment. Parsing and successful compilation caches have bounded depth, size and memory.
- Horizontal rules in a standalone array use native editable Word tables with OMML cells and real borders, not screenshots, phantom placeholders or simulated underlining. A separator paragraph prevents adjacent arrays from being merged. Leading relation symbols in alignment cells remain visible.
- Formal exports fail with question/field/location information rather than silently replacing unsupported formulas. A separately marked review copy remains available in the collapsed troubleshooting section.
- Text recognition uses rolling concurrency with ordered commits and bounded lookahead. Fast requests release slots without waiting for a whole batch. Fresh-context cross-page review, role ordering, retry backoff, concurrency reduction on throttling and successful out-of-order checkpoints remain in place.
- Original page images are stored separately from checkpoints and are not rewritten for unchanged page identities/hashes. Snapshots avoid cloning page/diagram image strings. Request-image preparation is cached per run with memory/entry limits and failed-entry eviction. Canvas encoding uses asynchronous blobs without reducing existing resolution or quality.
- Auto protocol negotiation is cached only after a successful, specifically justified fallback. Authentication, throttling, server failures and malformed successful responses do not trigger speculative second-protocol requests. Timeout/cancellation signals propagate upstream. Responses text blocks are joined instead of truncated at the first block. `RECOGNITION_TIMEOUT_MS` defaults to 180000.
- The mobile mode-description overflow found by Chromium testing is fixed without hiding or clipping the description.

## Reproducible performance measurement

```sh
npm run benchmark:studio
```

One measured run used identical synthetic request latencies, 24 pages, 24 requests and a peak concurrency of 4:

| Scheduler | Elapsed |
| --- | ---: |
| Fixed batch barrier | 905 ms |
| Rolling ordered scheduler | 462 ms |

This is a **49% reduction in a simulated mixed-latency scheduling workload, not a 49% live-OCR claim**. Real gains depend on provider latency/limits and the proportion of pages needing fresh-context review. Model, reasoning settings and image fidelity have not been lowered. Repeated runs differ with host scheduling. PDF import still completes before model recognition begins; this change does not claim end-to-end streaming PDF import.

For a real comparison, use the same 10-20 pages and concurrency for both versions, repeat each at least three times, and record total wall time, first-page completion, request count, failures/retries, cross-page reviews and recognition mistakes. The recognition route includes `Server-Timing` model/normalization durations. Test cold runs separately from resumptions; a resumed run is not comparable with a full new import.

## Local acceptance checklist

1. Upload question-only, answer-only and paired material, including a page-spanning answer. Check ownership, order and completeness, not just speed.
2. Interrupt after several pages, reload and continue. Confirm saved successes are not re-recognized and sources remain available. Test a controlled endpoint failure without deleting the draft.
3. Export fractions, arrow families, matrices, nested grids and a standalone ruled array. Open in Word/WPS and edit formulas/cells. Check for rasterized math, merged tables or missing rules.
4. Insert `\unknown{x}`. Formal export must refuse with a location. Only the labelled review copy may contain a visible correction placeholder.
5. Compare latency/request counts with identical model and concurrency. Raising concurrency above provider capacity can increase 429 responses.

## Intentional math boundaries

Standalone ruled arrays are supported in the stem and analysis. **Ruled arrays in inline prose, another equation/grid, a short-answer placement, a diagram caption or a table cell are rejected**, not flattened. Column types are `l/c/r` with supported whitespace material such as `@{\quad}`. Arbitrary inter-column content, vertical rules, `p{...}`, custom row spacing, excess depth/rows/columns and arrays wider than the page are rejected. These are explicit capability limits, not complete LaTeX support.

## Re-run the browser harness

Synthetic data only; no live credentials are needed. Requires Python Playwright and Chromium.

```sh
node scripts/build-studio-browser.mjs .studio-browser-test
python -m pip install playwright
python -m playwright install chromium
python scripts/verify-studio-browser.py .studio-browser-test --out studio-browser-results
```

CI stores the browser report, desktop/mobile screenshots and formal/review DOCX files as artifacts. These mocked-model browser checks do not establish real recognition quality, provider speed, production authentication behaviour or a user's existing browser-profile migration.
