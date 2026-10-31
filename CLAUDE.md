# Project guidance

Shared instructions for every coding agent working on **everydashcam**, a
browser-only dashcam viewer. `AGENTS.md` points here; keep one source of truth.
Read the task-specific guidance below only when it applies. Code and config own
implementation details; they do not override the constraints in this file.

## Constraints

- **No backend or recording uploads.** Read user-selected files locally in the
  browser. Analytics and error reporting must remain optional and separable.
- **Graceful degradation.** External service failures must not break local video,
  charts, markers, or the route drawn on the map canvas.
- **Desktop and mobile are first-class.** Target current and previous major
  versions of popular browser engines. Degrade by capability, not device label;
  document unavoidable API limitations at their call site. See
  [browser support](docs/browser-support.md) when changing platform behavior.
- A new or replacement npm dependency is an architectural decision to discuss
  separately: maintained, widely used, MIT/Apache, reasonable bundle cost, no paid
  service requirement. Routine work within these boundaries needs no extra approval.
- If a task requires a constraint change not already authorized, explain the
  conflict and obtain the user's decision before implementing that part.

## Private data

- `private/` never enters the public repository, Docker context, or external
  services. Keep its exclusions in `.gitignore` and `.dockerignore`. Real samples
  and incoming recordings stay local; publish only anonymized fixtures using
  `scripts/anonymize-*` (coordinates rounded to whole degrees, footage replaced).
- Internal notes belong in the nested private repository. Before editing them,
  read `private/README.md`; commit text-note edits there in the same session and
  keep its remote private. Never sweep recordings into a notes commit.
- Keep credentials, checkout `.env` files, and private deployment settings out of
  public code, logs, and artifacts. Use synthetic configuration in tests.

## Working and git rules

- Inspect the relevant code and `git status` before editing. Preserve unrelated
  work; do not include it in commits. Complete the requested local work and checks
  without stopping for approval of routine edits or test runs.
- `main` is the working branch; pushing it deploys staging. Production deploys on
  a release tag. Only the release workflow moves the machine-managed `release`
  branch. Never rebase `main`; surface conflicts instead of rewriting history.
- Local commits are allowed; pushes require an explicit request. Production
  promotion is the user's decision. Never overwrite a published release. For
  release operations, follow the release skill in the task table below.
- Before changing history, recheck `git status` and `git branch --show-current`.
  `reset --hard`, `checkout --`/`restore`, `clean`, and `stash` require an explicit
  request. Amend/fixup only your unpushed work; append commits after a push.
- Commits use `type(scope): subject`, lower-case, no trailing period. State the
  outcome in the subject and the reason/tradeoffs in the body. One logical change
  per commit; keep unrelated refactors separate. No attribution trailers.
- Check current primary documentation before changing use of a dependency, Web
  API, or recording format; match library guidance to the installed version.
  For mediabunny, start with [its docs](https://mediabunny.dev/llms-full.txt) and
  [type declarations](https://mediabunny.dev/mediabunny.d.ts).

## Setup and commands

Use Node from `.nvmrc` and `npm ci`; `npm run dev` starts a fresh clone without
accounts or keys. Command definitions live in [package.json](package.json);
CI environments and gates live in [.github/workflows/ci.yml](.github/workflows/ci.yml).
For browser tests, install Playwright's pinned full browser with
`npx playwright install --no-shell chromium` (Linux CI also uses `--with-deps`).

## Architecture and entry points

- Hosted startup: `index.html` and `src/app.ts`. UI state/DOM roots are
  `src/ui/state.ts` and `src/ui/dom.ts`; wire cross-feature callbacks in the
  orchestrator rather than introducing dependency cycles.
- Parsing is capability-first, never a vendor module: `src/parsers/primitives/`,
  `filename/`, `sidecars/`, and `gps-source-hints.ts`. Keep parsing and container
  repair (`src/repair/`) independent of UI. New format support needs an extractor,
  a real sample, and tests together; the only waiver is in
  [GPS format coverage](docs/gps-format-coverage.md).
- Ingest starts in `src/ui/ingest.ts`, `progressive-ingest.ts`, and
  `deferred-gps.ts`. Eager UI may use light parser metadata/filename helpers;
  preserve the heavy-code boundary through `src/parsers/registry-light.ts`.
- Keep materially heavy or optional deferred capabilities lazy; do not split
  small cohesive paths merely to lower a byte count. Extend the dependency guard
  in `vite-plugins/lazy-boundaries.ts` when adding heavy deferred dependencies;
  payload sizes are diagnostics, not a substitute for that guard.
- Export/playback: `src/ui/export-flow.ts`, `src/export/`, `src/transcode/`.
  Worker RPC uses Comlink; lifecycle/cancellation: `src/workers/_protocol/`. Detection/tracking:
  `src/tracking/`; model packaging: `vite-plugins/tracker-assets.ts`.
- Persistence: `src/persist/`; annotations/notes replicas: `src/ui/annotations.ts`
  and `src/ui/annotations-sidecar.ts`. After parser/indexer semantic changes, run
  `npm run generate:parser-cache-revisions` and review the generated diff. Bump
  `INDEX_CACHE_FORMAT` in `src/persist/types.ts` only for persisted shape changes.
  Expected cache invalidation from parser, dependency, or bundler updates is
  routine; it needs no special release warning or workaround to preserve a hash.
- Hosted offline behavior uses Workbox: `src/sw.ts`, `src/ui/sw-registration.ts`, and
  `vite-plugins/sw-precache.ts`. Build/SEO: `vite.config.ts`, `vite-plugins/`.
  Portable shares application code through the `__PORTABLE__` boundary and
  aliases in `vite.portable.config.ts`.
- Styles use semantic aliases from `src/styles/tokens.css`, not raw colors.
  Canvas colors use a `themeColors()` cache invalidated on theme changes.

## Code conventions

- Identifiers, filenames, comments, internal strings, commits, and PRs use simple
  English. Internal error messages are lower-case without a trailing period;
  user-facing errors follow the voice guide and localization rules below.
- Named exports, relative imports ending in `.js`, kebab-case filenames, string
  unions instead of enums, interfaces for object shapes. `index.ts` is an explicit
  ordered registry, not a convenience barrel. Classes are for stateful lifecycles;
  otherwise use functions over interfaces.
- Use `unknown` and narrow at input boundaries. `any` needs an unusable third-party
  type and a justifying comment. Keep casts at real boundaries, out of parser
  core; `arr[i]!` is accepted when bounds are guaranteed by construction.
- Parsing failures have three levels: a bad local record returns null/empty;
  a matched file that is another format throws `WrongFormatError`
  (`src/parsers/types.ts`); invariant violations throw `Error`. User cancellation
  (`AbortError`) propagates. In catches, normalize unknown errors into structured
  log fields or rethrow unchanged after cleanup.
- Application diagnostics use `src/log.ts`, never direct `console.*`. Keep logs
  actionable and out of frame/record/packet loops and `timeupdate`. Preserve the
  local ring buffer and optional, errors-only, PII-scrubbed reporting in
  `src/sentry.ts` and `src/sentry-scrub.ts`; no DSN must remove the SDK from builds.
- Search for existing helpers before adding utilities; share duplicated logic.
  Comments explain current constraints or reasons, not obvious steps, personal
  attribution, or change history. Doc comments are prose, not `@param`/`@returns`
  lists. UPPER_SNAKE_CASE is for literal constants; booleans use is/has/should/can.

## Localization

- UI copy goes through `src/i18n/`, never literals. English owns meaning; Russian
  and English UI copy ship together, and all shipped dictionaries keep key parity with
  `src/i18n/keys.ts`. Follow the voice guide in the task table below.
- Camera landing pages require English as the common fallback. Other languages,
  including Russian, follow each brand's audience and the explicit locale list in
  `vite-plugins/supported-brands.ts`. Every published locale needs reviewed
  camera-specific copy.
- Pass the UI locale explicitly to `Intl.*`; use `getDateLocale()` from
  `src/i18n/index.ts`, not the browser default or a hard-coded two-language choice.
- Locale routing lives in `src/i18n/seo-config.ts`; an explicit locale URL wins
  over stored preference and must remain share-safe.

## Deferred work

Leave a searchable `TODO:` at the affected code and report new deferrals and why
in the handoff/commit/PR. Unfinished community translations use `// TODO i18n:`
next to the key; copied English text is not a completed translation.

## Verification

Match local verification to the scope and risk of the change. Start with the
smallest useful check; expand only when failures or shared behavior warrant it.
Full suites run in CI. Run them locally for broad changes whose effects cannot
be covered by focused checks, or when the user asks. A small edit does not
require a full run just because it touches application files.

During copy or design iteration, review the changed content and screen. Save
automated checks and baseline updates for when the wording or layout is settled.
Report what was actually checked and any relevant gaps; do not describe unrun
coverage as passing.

| Change | Local verification |
| --- | --- |
| Wording only, including translations and page metadata | Review copy, locale consistency, and matching HTML/structured data. Check the affected screen if text length changes layout. No application suite required. Changed keys, placeholders, or rendering logic follow the code rows below. |
| Small styling or layout change | Inspect the affected screen at relevant desktop/mobile sizes. Use focused layout tests or VRT when they help verify the change; a visual edit alone does not require full e2e or portable suites. |
| Application logic or tests | `npm run typecheck`, `npm run check:ci`, and relevant tests, e.g. `npm test -- src/parsers/registry.test.ts` |
| UI behavior | Relevant browser tests, e.g. `npm run test:e2e -- landing-layout.spec.ts`, or an area shortcut from the [e2e guide](tests/e2e/README.md) |
| Portable behavior or shared behavior affecting it | Relevant tests via `npm run test:portable -- <spec>`; follow the portable guide below for artifact validation and configured-provider cases |
| Dependencies or build configuration | Build the affected edition and run checks covering the changed dependency or build behavior; broaden for shared runtime or bundling changes |
| Deterministic visual baselines | Run the affected cases via `npm run test:vrt -- --grep <pattern>`; inspect intended baseline changes under the testing guide |
| Encoder diagnostic tool | Relevant cases via `npm run test:encoder-test` |
| SEO generation, CSP, service worker, or deployment logic | Relevant build/integration tests; exercise the synthetic deployment profile when profile behavior is affected |
| Map style JSON | `npm run validate:styles` |
| Changelog data | Regenerate through its skill; `node scripts/generate-changelog-md.mjs --check` |
| Documentation/instructions only | Check diff, linked paths, and documented commands against their sources; no application suite needed |

`npm run check:ci` checks lint **and** formatting without edits. `npm run check`
fixes files with `--write`; use deliberately and review its diff. These npm checks
target `src/` and `tests/`; check edited scripts explicitly with Biome.
Tests that read `dist/` require a fresh `npm run build` first; unit tests that
only exercise source code do not. Browser test scripts rebuild automatically.
Never run bare Playwright against stale output. `test:perf` does not rebuild;
build first. Perf, benchmarks, and coverage are diagnostics, not universal gates.

## SEO

Canonical URLs in sitemaps, metadata, and links are extension-less; Cloudflare
Pages redirects `.html`. `lastmod` uses git mtime, never build time.

## Documentation

- Keep durable constraints, working rules, rationale, operational pitfalls, and
  useful entry points. Link to code/config for changing values or inventories.
- State each rule once at its point of use; elsewhere use a bare pointer. Replace
  stale implementation facts with source pointers, not another copied value.
- State the current rule without change history or attribution. Keep instructions
  direct; include a reason only when it changes how to apply the rule. Put
  load-bearing code gotchas at their call site as well.
- Keep this file compact. Put task-specific detail in the guidance below; avoid
  unconditional imports that load every workflow into every session.

## Task-specific guidance

Read the matching files before working on that surface. Agents without Claude's
path-scoped rule loading must open them explicitly; these are shared Markdown
instructions, not requirements to install or invoke a particular agent tool.

| Task | Read |
| --- | --- |
| Behavior changes, tests, fixtures, or screenshots | [.claude/rules/testing.md](.claude/rules/testing.md) |
| Portable builds/runtime/downloads, or shared viewer/map/export changes affecting it | [.claude/rules/portable.md](.claude/rules/portable.md) |
| UI copy or localization | [.claude/rules/voice.md](.claude/rules/voice.md) |
| UI polish or visual review | [.claude/skills/ui-polish/SKILL.md](.claude/skills/ui-polish/SKILL.md) |
| New recording format | [.claude/skills/onboard-format/SKILL.md](.claude/skills/onboard-format/SKILL.md) |
| Changelog maintenance | [.claude/skills/changelog/SKILL.md](.claude/skills/changelog/SKILL.md) |
| Release or production promotion | [.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md), [docs/deploy.md](docs/deploy.md) |
| SEO or IndexNow | [docs/seo.md](docs/seo.md) |
| Self-hosting or deployment profiles | [docs/self-hosting.md](docs/self-hosting.md) |
