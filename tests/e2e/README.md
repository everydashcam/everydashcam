# E2E regression tests

Run `npm run test:e2e` from the repository root. It builds the app before testing.
For browser installation, see [the CI workflow](../../.github/workflows/ci.yml).

For a compact local golden set, run `npm run test:e2e:golden`. It selects
representative individual scenarios with `@golden-<area>` tags. To focus on one
area, use these shortcuts:

| Command | Area |
| --- | --- |
| `npm run test:e2e:blur` | Region editing, exported masks, and inference assets |
| `npm run test:e2e:export` | Stream copy, re-encoding, masks, and mobile export UI |
| `npm run test:e2e:offline` | Cached boot, local playback/export, and asset recovery |
| `npm run test:e2e:playback` | Play/pause, frame stepping, and mobile controls |
| `npm run test:e2e:map` | Local route resilience and provider preferences |
| `npm run test:e2e:ingest` | Single-channel and multichannel recording import |

Each shortcut delegates to `test:e2e`, retaining its fresh build and shared
Playwright configuration. Tags on the tests own membership; a scenario may belong
to multiple areas and runs once in the combined golden set. Keep the set small:
tag individual cases that exercise a distinct core flow, not whole suites or
every regression. Choose the local verification scope using
[CLAUDE.md](../../CLAUDE.md#verification). CI runs the full suite.

Append Playwright options after `--`, for example
`npm run test:e2e:blur -- --headed` or `npm run test:e2e:blur -- --list`.
The latter builds and lists the selected tests without launching a browser.
To run every scenario in a feature file, use the full entry point, for example
`npm run test:e2e -- blur-regions.spec.ts`.

Real plate/face inference also has an explicit required project:
`npm run test:e2e -- --project=detectors-webgpu --workers=1`. It runs short
plate and face motion cases, negative small-plate checkpoints, 60 fps mask copying,
same-frame detector recovery after tracker loss, and cached range extensions
compared with fresh inference; missing WebGPU or `shader-f16` fails instead of
skipping. On a local desktop, add `--headed` when the headless browser cannot
acquire its hardware adapter.

The separate Linux CI job installs Mesa lavapipe and selects its ICD through
[`VK_DRIVER_FILES`](https://docs.mesa3d.org/install.html#vulkan). Chromium's
[documented Vulkan flags](https://developer.chrome.com/blog/supercharge-web-ai-testing)
enable headless WebGPU for that project only. Lavapipe exposes
[FP16 support](https://chromium.googlesource.com/external/gitlab.freedesktop.org/mesa/mesa/+/b453331e7cfeceacd414b9fd6e65b8fa25ae6606/src/gallium/frontends/lavapipe/lvp_device.c#495);
Chrome's bundled SwiftShader does not satisfy the packaged FP16 models.
These are correctness tests; software inference timings do not represent
desktop or mobile GPU performance.

Import `test` and `expect` from [`_fixtures.ts`](_fixtures.ts) to retain the shared
runtime-error and network checks. For File System Access tests that persist OPFS
handles in IndexedDB, import `persistentTest as test` from the same module. Keep
each test's temporary browser profile isolated, and exercise real handles.
That fixture reports an unaffected Chromium version to exercise durable storage.
Keep crash-workaround coverage in the default incognito fixture with the real
browser identity, as in [`file-handle-compat.spec.ts`](file-handle-compat.spec.ts).

Keep tests self-contained. Opt large files into parallel mode with
`test.describe.configure({ mode: "parallel" })` only when their setup and output
paths are independent. Account for `beforeAll` and `afterAll` running separately for
every parallel test.

Use `test.use({ viewerMap: "route-only" })` when a scenario does not exercise
basemap styles or providers. This keeps real MapLibre maps and local overlays;
map integration tests must retain the default. Export maps remain independent.

Use reduced motion for data and control assertions; keep normal motion when
testing transitions and layout stability.

A test that passes only after a retry still fails the run. Keep `failOnFlakyTests`
enabled in [the e2e config](../playwright.e2e.config.ts); use retry traces to
diagnose failures.
