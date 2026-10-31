// Playwright config for the end-to-end performance suite.
//
// Scope: not functional UI testing - measuring real-world ingest pipeline
// timings, memory and CPU on a production preview build. Functional tests
// live in vitest (src/**/*.test.ts) and stay separate.
//
// Hard requirements baked in here:
//  - workers: 1 - parallel test runs share CPU and pollute timings. Perf
//    suites must be sequential to produce reproducible numbers.
//  - full Chromium (not headless-shell) - WebGL (MapLibre) and WebCodecs
//    (transcode worker) need a real GPU/decoder pipeline. The shell variant
//    skips them and produces unrealistic numbers.
//  - launch args - disable background throttling (otherwise headless Chrome
//    throttles timers and decoder priority when not focused, polluting wall
//    times) and enable precise heap info (--enable-precise-memory-info gives
//    byte-level performance.memory readings instead of 10-MB rounded values).
//  - webServer with PERF_TEST=1 - flips vite.config.ts preview headers to
//    enable cross-origin isolation, unlocking measureUserAgentSpecificMemory.
//  - timeout 3 min (default per-test ceiling) - covers light vendors; heavy
//    vendors (BlackVue 436 MB, Juscar 4×340 MB) raise it per-test via
//    test.setTimeout with a vendor-sized budget computed in the specs.
//
// Sample folder discovery happens at runtime in tests/perf/harness/vendors.ts.
// Vendors absent from private/samples/ are skipped, not failed -
// the suite must run anywhere the repo exists, even without the (gitignored)
// sample tree.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Run artifacts (traces, failure screenshots, the HTML report) are pinned next
// to this config instead of Playwright's default, which resolves them against
// the CURRENT WORKING DIRECTORY - every run starts from the repo root, so they
// landed there, outside the .gitignore entry and outside the path ci.yml
// uploads.
const ARTIFACT_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    testDir: "./perf",
    outputDir: resolve(ARTIFACT_ROOT, "test-results"),
    // Sequential. See header comment.
    workers: 1,
    fullyParallel: false,
    // Don't retry on failure - a perf test that fails is interesting data
    // ("got flaky / regressed"), not noise to be hidden. Re-run manually.
    retries: 0,
    // Per-test ceiling. cold-ingest spends most time on new BrowserContext +
    // cold V8 + cold disk cache for the warmup pass; on light vendors that's
    // ~30 s, total with 4 replays ~80 s. trip-activation is ~25 s. 3 min
    // covers light vendors comfortably; heavy vendors (BlackVue 436 MB,
    // Juscar 2.2 GB) may need test.setTimeout() bumps.
    timeout: 3 * 60 * 1000,
    expect: {
        timeout: 30 * 1000,
    },
    use: {
        baseURL: "http://localhost:4173/",
        // Context routes cannot intercept requests handled by a service worker.
        serviceWorkers: "block",
        // Full Chromium (not the smaller chromium-headless-shell) for proper
        // GPU/WebCodecs pipeline. headless: true on the chromium channel still
        // pulls full Chromium - shell is only auto-selected when no specific
        // launchOptions or channel is requested.
        channel: "chromium",
        headless: true,
        launchOptions: {
            args: [
                // Precise byte-level performance.memory (default rounds to 10 MB
                // for anti-Spectre). Required for meaningful heap deltas.
                "--enable-precise-memory-info",
                // Headless Chrome throttles timers and decoder priority for
                // backgrounded/occluded windows. The perf-test page is technically
                // always "occluded" because there is no real display.
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
            ],
        },
        // Capture screenshot/video only on failure, otherwise the artifact
        // overhead dominates the run.
        screenshot: "only-on-failure",
        video: "off",
        trace: "off",
    },
    reporter: [
        ["list"],
        // Custom reporter writes github-action-benchmark JSON schema to
        // private/perf-results/. See tests/perf/harness/json-reporter.ts.
        ["./perf/harness/json-reporter.ts"],
    ],
    webServer: {
        // PERF_TEST=1 flips vite preview headers (COOP/COEP) for cross-origin
        // isolation. Same build artifacts as a regular `npm run preview`;
        // only the response headers change. `vite build` must have produced
        // dist/ - reuseExistingServer covers iterative development where the
        // dev re-runs tests against a long-running preview.
        command: "PERF_TEST=1 npm run preview -- --port 4173",
        port: 4173,
        reuseExistingServer: !process.env.CI,
        timeout: 60 * 1000,
        stdout: "ignore",
        stderr: "pipe",
    },
});
