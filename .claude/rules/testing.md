---
paths:
  - "src/**/*.test.ts"
  - "src/**/__fixtures__/**/*"
  - "tests/**/*"
  - "vite.config.ts"
---

# Testing

Read this when changing behavior, tests, fixtures, or test configuration.
Verification gates live in [CLAUDE.md](../../CLAUDE.md).

## Unit tests and fixtures

- Use colocated `src/**/*.test.ts` files; `*.spec.ts` is for Playwright.
  The unit-test include pattern lives in `vite.config.ts`.
- Import explicitly from `vitest`; use `it()`, not `test()`. Titles describe
  present-tense behavior ("clamps to first when before first"), never "should".
  Do not commit `.only` or unconditional skips. Documented runtime guards for
  unavailable platform capabilities are allowed; do not use them to hide failures.
- Mock nothing under test. Use `vi.mock` only to sever DOM-touching imports
  so pure logic runs in the Node test environment. Parser input is real bytes,
  never hand-faked parsed structures.
- New formats need real-sample evidence via
  [onboard-format](../skills/onboard-format/SKILL.md); the sole exception is the
  [documented foreign-source waiver](../../docs/gps-format-coverage.md).
  Synthetic malformed and negative byte fixtures supplement that evidence;
  they do not replace it.
- Default test suites must run without `private/`. Use committed anonymized
  fixtures or synthetic cases; missing required fixtures must fail, not skip.
  Keep private-sample diagnostics outside the default suites and require their
  inputs explicitly. Browser capability guards remain valid when documented.
- Shared semantic checks are plain helper functions, not `expect.extend`;
  see `src/parsers/__fixtures__/helpers.ts`. Pair snapshots with plausibility
  checks; a snapshot alone only preserves the parser's output.
- Keep tests deterministic: no randomness or network. Use fake timers only
  when timing itself is under test. Modules with module-level state export
  `_resetForTests()` for `beforeEach`.
- Compare floats with `toBeCloseTo`; label multi-step invariants with
  `expect(value, "label")`.
- Use the npm test script for focused runs, for example
  `npm test -- src/parsers/registry.test.ts`. It retains the timezone pin and
  `pretest` validation from `package.json`; direct Vitest calls bypass them.
- Coverage is an on-demand diagnostic (`npm run test:coverage`), not a gate.
  Its output under `tests/coverage/` stays gitignored. Plain `npm test` does
  not collect coverage.

## Browser tests

- Keep Playwright tests hermetic, assertion-driven, and fail-loud.
  Read [the e2e guide](../../tests/e2e/README.md) for fixtures and browser setup.
- Use the build-and-test npm scripts from `package.json`; do not run bare
  Playwright against stale build output.
- On macOS, launch browser tests outside a restricted agent sandbox from the
  first run (Codex: `sandbox_permissions: "require_escalated"`). This includes
  hosted, portable, VRT, encoder tests and ad-hoc browser harnesses. A blocked
  browser launch can produce a system crash dialog for every test. If the
  browser fails before test execution with a sandbox/permission error or
  repeated immediate `SIGABRT`, stop the entire run immediately. Correct the
  launch permissions before retrying; if launching remains blocked, use CI.
  Do not let the suite keep launching browsers or reinstall them to work
  around a confirmed sandbox restriction.
- Concurrent Playwright suites need disjoint `--output` directories: the hosted
  default clears `tests/test-results/`, including a running portable suite's
  traces. Do not rebuild `dist/` while another suite is using it.
- Seed file-origin preferences through `presetLocalStorage(page, { preferences })`;
  its implementation documents the Chromium navigation race. Do not access
  `localStorage` directly in a portable test's `addInitScript` callback.
- On macOS, give Playwright Firefox a separate app-data directory before its
  first launch: `CFFIXED_USER_HOME="$(mktemp -d)" PW_FIREFOX=1 npm run test:e2e -- --project=firefox`.
  A temporary `-profile` alone is insufficient: Firefox also accesses its shared
  app-data directory, which macOS may protect. This causes `Could not find profile
  folder` before any test runs ([upstream issue](https://github.com/microsoft/playwright/issues/42768)).
  Use this isolated launch rather than reinstalling Firefox or changing permissions
  on the user's browser data. It fixes startup only; inspect subsequent test
  failures normally.

- Service-worker upgrade tests must change the published files on a real HTTP
  server while preserving the browser profile. Playwright routing does not
  intercept updated worker main scripts. Exercise failed installs, overlapping
  windows, full window closure, offline startup and rollback on the same origin.
  Keep this distinct from routing individual asset fetches to simulate corruption.

## Pixel artifacts

- VRT baselines (`tests/e2e/*-snapshots/`) are committed references for
  deterministic surfaces. Regenerate with `npm run test:vrt:update` only for
  an intended visual change, and review the resulting image diff.
- e2e `shot()` PNGs (`tests/e2e/screenshots/`) are gitignored local/CI review
  aids. Live video and map frame timing make them nondeterministic; never
  commit these outputs.
- README screenshots are committed and generated by
  `scripts/generate-readme-screenshots.mjs` from the committed source frames
  under `docs/screenshots/frames/`. Regenerate only when the change is visible
  in their open-trip viewer surface. Landing-page, export-mode, modal, and
  other changes absent from those screenshots do not require regeneration.
