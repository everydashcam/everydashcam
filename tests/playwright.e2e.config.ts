// Playwright config for the e2e regression suite (tests/e2e/).
//
// This is the assertion-driven, fail-loud gate meant to replace manual
// click-through testing - distinct from:
//  - playwright.perf.config.ts   -> perf timings (tests/perf/)
//
// Design choices baked in here:
//  - cap local parallelism to leave room for video decoding and WebGL; CI
//    distributes the suite across runners instead of overloading one machine.
//  - files opt into parallel tests when their setup and outputs are independent.
//  - channel "chromium" (full, not headless-shell) - WebGL (MapLibre) and
//    WebCodecs (decode/transcode) need the real pipeline.
//  - trace on-first-retry - cheap post-mortem exactly when a flake/regression
//    happens, per Playwright CI guidance.
//  - retries on CI collect traces; retry-only passes still fail the job.

import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Run artifacts (traces, failure screenshots, the HTML report) are pinned next
// to this config instead of Playwright's default, which resolves them against
// the CURRENT WORKING DIRECTORY - every run starts from the repo root, so they
// landed there, outside the .gitignore entry and outside the path ci.yml
// uploads.
const ARTIFACT_ROOT = dirname(fileURLToPath(import.meta.url));

const isCI = !!process.env.CI;

// Opt-in second engine. The default suite runs Chromium only (the bar that gates
// CI); set PW_FIREFOX=1 to ALSO run on real Firefox - it natively lacks
// showSaveFilePicker, so it is the only way to exercise the in-memory (RAM)
// export path on a non-Chromium engine. Gated because Gecko's H.264 decode is
// not guaranteed on every host
// and Firefox has no WebCodecs H.264 ENCODE (Bugzilla 1918769), so the re-encode
// export specs self-skip there. See docs/browser-support.md and the e2e README.
const withFirefox = !!process.env.PW_FIREFOX;

export default defineConfig({
    testDir: "./e2e",
    outputDir: resolve(ARTIFACT_ROOT, "test-results"),
    workers: isCI ? 1 : Math.min(5, Math.max(1, Math.floor(availableParallelism() / 2))),
    fullyParallel: false,
    forbidOnly: isCI,
    failOnFlakyTests: true,
    retries: isCI ? 2 : 0,
    timeout: 60 * 1000,
    expect: { timeout: 10 * 1000 },
    use: {
        // Shared, engine-agnostic options; per-engine specifics live in projects.
        headless: true,
        screenshot: "off", // specs screenshot explicitly as review artifacts
        video: "off",
        trace: "on-first-retry",
        // Offline specs cover installation and cached playback explicitly.
        serviceWorkers: "block",
        baseURL: "http://localhost:4173",
        // No --autoplay-policy override: tests drive playback through real button
        // clicks (trusted gestures), which the policy already permits. Forcing
        // autoplay let the muted master start on load and then stall the
        // multichannel sync, making the initial play state nondeterministic.
    },
    projects: [
        {
            // Playwright's pinned Chrome for Testing includes H.264/AAC codecs.
            // PW_CHANNEL allows local checks against another installed browser.
            name: "chromium",
            use: { channel: process.env.PW_CHANNEL || "chromium" },
        },
        {
            // Real detector coverage is required here, even on GPU-less CI.
            // Linux CI selects Mesa lavapipe through VK_DRIVER_FILES. Chrome's
            // bundled SwiftShader lacks shader-f16, which our models require.
            // Vulkan flags: https://developer.chrome.com/blog/supercharge-web-ai-testing
            name: "detectors-webgpu",
            default: false,
            metadata: { requireWebGpu: true },
            testMatch: /(?:detector-motion|plate-recovery|detection-cache)\.spec\.ts/,
            grep: /checkpoint cache matches fresh|every frame of a brief fast-moving (?:plate|face)|thorough real detector covers only eligible small-plate checkpoint hits|genuine large plate|only the final frame seeds reverse tracking|a real plate tracker loss|60 fps face/,
            outputDir: resolve(ARTIFACT_ROOT, "test-results/detectors"),
            use: {
                channel: "chromium",
                trace: "retain-on-failure",
                launchOptions: {
                    args: [
                        "--enable-unsafe-webgpu",
                        ...(process.platform === "linux"
                            ? ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface"]
                            : []),
                    ],
                },
            },
        },
        ...(withFirefox
            ? [
                  {
                      name: "firefox",
                      use: { browserName: "firefox" as const },
                      // Scope to the export-run spec: Firefox's value here is the
                      // in-memory (no native picker) export path on a non-Chromium
                      // engine. Bringing the whole suite up on Gecko is a separate
                      // effort (each spec needs its own engine-specific noise/skip
                      // tuning); this keeps the opt-in run focused and green.
                      testMatch: /export-run\.spec\.ts/,
                  },
              ]
            : []),
    ],
    // github: inline PR annotations for failures. html: post-mortem artifact
    // (uploaded if: always(), so a retry-then-pass flake keeps its trace).
    reporter: isCI
        ? [["list"], ["github"], ["html", { open: "never", outputFolder: resolve(ARTIFACT_ROOT, "playwright-report") }]]
        : [["list"]],
    webServer: {
        // Serves whatever is in dist/. The npm script (`test:e2e`) runs `build`
        // first; locally `reuseExistingServer` skips the server boot wait on
        // iterative runs against an already-running preview.
        command: "npm run preview -- --port 4173",
        port: 4173,
        reuseExistingServer: !isCI,
        timeout: 60 * 1000,
        stdout: "ignore",
        stderr: "pipe",
    },
});
