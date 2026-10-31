// Shared fixtures + helpers for the e2e regression suite.
//
// What makes this suite different from the old visual/qa specs (and why it can
// actually catch the bugs they missed):
//
//  1. HERMETIC. The only external dependency the app makes at runtime is the
//     map tile servers. We abort every request to them.
//     That removes network flakiness from CI AND doubles as a regression test
//     for the documented invariant "if the tile server is down, the functional
//     app keeps working" (CLAUDE.md / docs). Everything else (video, GPS, chart,
//     export) is local files, so the suite is fully deterministic offline.
//
//  2. FAIL-LOUD on errors. Every test asserts, at teardown, that no uncaught
//     exception (pageerror / unhandledrejection) and no unexpected console.error
//     fired. The project routes diagnostics through a ring buffer, not console.*,
//     so a stray console.error is a real signal.
//
//  3. NO SILENT PASSES. Helpers assert presence before reading geometry; specs
//     use web-first auto-retrying assertions instead of `waitForTimeout` +
//     `if (box) { ... }` blocks that pass green when an element is absent.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Page, expect, test as base } from "@playwright/test";

// Type-only (erased at runtime - no app module is pulled into the Playwright
// process). Mirrors the production tour-id union below.
import type { OnboardTourId } from "../../src/ui/onboarding.js";

// The e2e suppression / clear lists, kept in lock-step with the production
// OnboardTourId union: `satisfies Record<OnboardTourId, true>` turns adding or
// removing a tour into a compile error here, so a new tour can never silently
// escape the suppression that keeps its overlay from blocking unrelated specs.
export const ONBOARD_TOUR_IDS = Object.keys({
    ingest: true,
    sources: true,
    player: true,
    export: true,
    multichannel: true,
} satisfies Record<OnboardTourId, true>) as OnboardTourId[];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const SCREENSHOT_DIR = path.join(HERE, "screenshots");

// 70mai multichannel: 6 MP4 (Front/Back/Interior) + GPS log. Exercises every
// panel - chart, strip, mini-map, multichannel grid, channel reorder/exclude.
export const SAMPLE_70MAI = path.join(REPO_ROOT, "tests/testdata/70mai-multichannel");
// GoPro HERO5: single-channel clip with embedded GPMF. Used for the "no
// multichannel UI on a single camera" path. (novatek/carcam fixtures are
// <1KB parser stubs with no real video track and won't render in the viewer.)
export const SAMPLE_GOPRO = path.join(REPO_ROOT, "tests/testdata/gopro-gpmf");
// hev1-tagged HEVC (ffmpeg-generated, no GPS). The hev1 sample entry forces the
// needsHevcRemux path -> per-file MSE backend (mediabunny remux), the BlackVue
// ELITE / Vantrue playback route otherwise covered only by hand.
export const SAMPLE_HEVC = path.join(REPO_ROOT, "tests/testdata/hevc-hev1");
// Synthetic H.264 single-channel clip with NO GPS. The fixture for the
// GPS-dependent export gate: every other public sample carries a track. H.264
// (not HEVC) so the gate assertions run on CI Chrome, not only on macOS.
export const SAMPLE_NOGPS = path.join(REPO_ROOT, "tests/testdata/no-gps-h264");
// Synthetic H.264 + AAC Matroska (.mkv), no GPS. Browsers do not play .mkv via
// <video>.src, so this forces the MSE-remux path (like TS/HEVC) - but H.264
// decodes everywhere, so playback + stream-copy export assertions run on CI
// Chrome without a self-skip.
export const SAMPLE_MKV = path.join(REPO_ROOT, "tests/testdata/mkv-h264");

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 }; // iPhone 14 portrait
export const MOBILE_LANDSCAPE = { width: 844, height: 390 };

// console.error lines we tolerate. Kept as narrow as possible - over-filtering
// here would re-introduce the "tests miss bugs" problem. Failures of the
// deliberately-aborted tile server are EXPECTED; everything else stays loud.
function isBenignConsole(text: string, url: string): boolean {
    // Browser resource-load failure for an aborted tile-server request
    // ("Failed to load resource: net::ERR_FAILED"): msg.location().url is the
    // openfreemap request URL itself.
    if (/openfreemap\.org|(?:tile|vector)\.openstreetmap\.org|tiles\.api-maps\.yandex\.ru/i.test(url)) return true;
    // Firefox raw browser CORS console error for an aborted tile request
    // ("Cross-Origin Request Blocked: ... https://tiles.openfreemap.org/...")
    // carries the domain in the TEXT, not in the console message's url field, so
    // the url check above misses it. The openfreemap.org domain only ever appears
    // because WE abort every request to it, so trusting it in text is as safe as
    // trusting it in the url - a tile server being unreachable IS the invariant.
    if (/openfreemap\.org|(?:tile|vector)\.openstreetmap\.org|tiles\.api-maps\.yandex\.ru/i.test(text)) return true;
    // src/ui/map.ts mirrors map.on("error") / mini.on("error") through the app
    // logger as "[map] maplibre [mini ]error <cause>". Tolerate ONLY the causes
    // the aborted tile server actually produces (verified by capturing every
    // console.error across the suite):
    //  - Chromium: MapLibre AJAXError "Failed to fetch (0): https://tiles.
    //    openfreemap.org/..." - the message embeds the request URL, and tile,
    //    sprite and glyph requests all hit openfreemap.org, so require it.
    //  - AbortError: MapLibre cancels its own in-flight tile/style requests on
    //    teardown / style swap; the DOMException carries no URL, so scope it to
    //    this logger line instead of matching it anywhere.
    // A maplibre error with any other cause - and any app error that merely
    // mentions "tile" or "AbortError" outside this exact logger line (e.g. a
    // video-tile feature, an export/ingest cancel) - is NOT masked.
    const isMaplibreLogLine = /^\[map\] maplibre (mini )?error /.test(text);
    if (
        isMaplibreLogLine &&
        /openfreemap\.org|(?:tile|vector)\.openstreetmap\.org|tiles\.api-maps\.yandex\.ru/i.test(text)
    )
        return true;
    if (isMaplibreLogLine && /\bAbortError\b/.test(text)) return true;
    // MapLibre "Style is not done loading" race on style swap - phrasing is
    // maplibre-specific, safe to match anywhere.
    if (text.includes("style is not done loading")) return true;
    // Expected only when a spec deliberately disables WebGL (compat): the map
    // degrades and the logger mirrors its error level to console.error.
    if (/\[map] map unavailable: no WebGL/i.test(text)) return true;
    // Firefox shapes the aborted-tile-server failure as a generic MapLibre
    // error event with NO message, where Chromium surfaces the AJAXError /
    // AbortError forms already caught above. Same hermetic cause (we abort
    // openfreemap.org), different engine wording. Match the bare generic form
    // only - a maplibre error carrying a real message/name is still NOT masked.
    if (/^\[map] maplibre (mini )?error Error$/.test(text)) return true;
    // Expected only when the onboarding fail-open spec deliberately injects a
    // fault: the engine logs at error level as it tears the broken tour down.
    // Other specs suppress tours, so these never fire there.
    if (/onboarding (failed to start|control failed)/i.test(text)) return true;
    return false;
}

// Body large enough to be a media/file upload rather than a small beacon. Video
// is MB-scale; a GPX/telemetry POST would be well under this. Combined with the
// host allowlist below, it turns "video is never uploaded" into an assertion.
const UPLOAD_BODY_LIMIT = 256 * 1024;

/**
 * Whether a request URL is an allowed network egress for the hermetic suite:
 * same-origin (the preview server) or a map provider (which we abort anyway).
 * data:/blob: and any non-HTTP scheme are inert (not egress). Anything else -
 * a request to a third-party host - would mean bytes leaving the machine,
 * violating CLAUDE.md's "No backend. Video is never uploaded."
 */
function isEgressAllowed(reqUrl: string, baseHost: string): boolean {
    let u: URL;
    try {
        u = new URL(reqUrl);
    } catch {
        return true; // relative / malformed - resolves same-origin, not egress
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    if (u.host === baseHost) return true;
    // mockDirectoryPicker routes this synthetic host straight to local sample
    // bytes; the separate origin keeps the app service worker out of the way.
    if (u.hostname === "everydashcam-fsa.test") return true;
    return (
        /(^|\.)openfreemap\.org$/i.test(u.hostname) ||
        u.hostname === "vector.openstreetmap.org" ||
        u.hostname === "tile.openstreetmap.org" ||
        u.hostname === "tiles.api-maps.yandex.ru"
    );
}

// Override the built-in `page` fixture.
export const test = base.extend<{ tolerateConsole: RegExp[]; viewerMap: "default" | "route-only" }>({
    // Per-spec opt-in tolerance for console errors a fault-injection spec
    // causes ON PURPOSE (e.g. asset-retry 404s the bundle). Default empty so
    // the suite stays fail-loud; a spec opts in via
    // test.use({ tolerateConsole: [...] }).
    tolerateConsole: [[], { option: true }],
    viewerMap: ["default", { option: true }],
    page: async ({ page, baseURL, tolerateConsole, viewerMap }, use) => {
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        // Invariant #1 guard: nothing may be uploaded. Record every request; on
        // teardown fail if any hit a non-allowlisted host or carried a body big
        // enough to be a video/file upload (even to same-origin).
        const offHostRequests: string[] = [];
        const uploadRequests: string[] = [];
        const baseHost = baseURL ? new URL(baseURL).host : "localhost:4173";

        page.on("pageerror", (err) => {
            pageErrors.push(`${err.name}: ${err.message}`);
        });
        page.on("console", (msg) => {
            if (msg.type() !== "error") return;
            const url = msg.location().url ?? "";
            if (isBenignConsole(msg.text(), url)) return;
            if (tolerateConsole.some((re) => re.test(msg.text()))) return;
            consoleErrors.push(msg.text());
        });
        page.on("request", (req) => {
            const url = req.url();
            if (!isEgressAllowed(url, baseHost)) offHostRequests.push(`${req.method()} ${url}`);
            const body = req.postDataBuffer();
            if (body && body.length > UPLOAD_BODY_LIMIT) {
                uploadRequests.push(`${req.method()} ${url} (${body.length} bytes)`);
            }
        });

        // Hermetic + degradation guard: block the tile server.
        await page.route(/openfreemap\.org|(?:tile|vector)\.openstreetmap\.org|tiles\.api-maps\.yandex\.ru/i, (route) =>
            route.abort(),
        );

        if (viewerMap === "route-only") {
            // Keep MapLibre and local overlays real without parsing basemap styles
            // in scenarios that exercise other viewer controls.
            await page.addInitScript(() => {
                window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), {
                    once: true,
                });
            });
        }

        await use(page);

        // Hard failures. pageErrors must ALWAYS be empty; console.error must be
        // empty after the benign filter. If either trips the test fails with the
        // captured text so the regression is visible, not swallowed.
        expect(pageErrors, "uncaught exceptions / unhandledrejections").toEqual([]);
        expect(consoleErrors, "unexpected console.error (not tile-server noise)").toEqual([]);
        // No bytes leave the machine: no third-party host, no large upload body.
        expect(offHostRequests, "requests to a non-allowlisted host (nothing may be uploaded)").toEqual([]);
        expect(uploadRequests, "request carrying a large body (possible video/file upload)").toEqual([]);
    },
});

// Chromium 153's in-memory IndexedDB crashes on FileSystemHandle readback.
// A fresh on-disk profile safely exercises the persistent-storage contract.
// Report an unaffected engine so the app's crash workaround does not replace
// that contract with session storage; file-handle-compat.spec uses the real
// reported version and default incognito context to test the workaround.
// Playwright applies test.use options and trace recording to this context too.
export const persistentTest = test.extend({
    context: async ({ playwright, browserName }, use) => {
        // An empty path gives each test a temporary profile, removed on close.
        const context = await playwright[browserName].launchPersistentContext("");
        try {
            if (browserName === "chromium") {
                await context.addInitScript(() => {
                    const userAgent = navigator.userAgent.replace(/(HeadlessChrome|Chrome)\/\d+/, "$1/152");
                    Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
                    Object.defineProperty(navigator, "userAgentData", {
                        configurable: true,
                        value: { brands: [{ brand: "Chromium", version: "152" }] },
                    });
                });
            }
            await use(context);
        } finally {
            await context.close();
        }
    },
});

export { expect };

/**
 * Preset localStorage BEFORE app code runs (addInitScript). Without this the
 * upload-warning / PWA toast pop over the UI on first load and cover the very
 * elements under test. Defaults to dark theme; override per test.
 */
export async function presetLocalStorage(
    page: Page,
    opts?: { theme?: "dark" | "light"; lang?: string; preferences?: Record<string, string> },
): Promise<void> {
    const theme = opts?.theme ?? "dark";
    const lang = opts?.lang;
    await page.addInitScript(
        ({ theme, lang, tourIds, preferences }) => {
            function seed(): void {
                try {
                    const now = String(Date.now());
                    localStorage.setItem("dc-theme", theme);
                    localStorage.setItem("everydashcam:upload-warning-shown-at", now);
                    localStorage.setItem("everydashcam:pwa:toast:shown", "1");
                    localStorage.setItem("everydashcam:pwa:toast:dismissedAt", now);
                    localStorage.setItem("everydashcam:support:action-taken", "1");
                    // Suppress the onboarding tours by default: their full-screen
                    // overlay blocks interaction and would break every spec that
                    // loads a trip / opens export. The onboarding spec clears these
                    // selectively via clearOnboarding() to test the first-run path.
                    for (const id of tourIds) {
                        localStorage.setItem(`everydashcam:onboarding:${id}`, "1");
                    }
                    if (lang) localStorage.setItem("everydashcam:lang", lang);
                    for (const [key, value] of Object.entries(preferences)) localStorage.setItem(key, value);
                } catch {
                    /* private mode - ignore */
                }
            }
            // On file URLs, pre-commit storage access can leave Chromium with a
            // disconnected cache: reads succeed but miss saved values on reload.
            // Seed after parsing, before the compressed portable app starts.
            // https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/dom_storage/dom_storage_context_wrapper.cc#L326-L330
            if (location.protocol === "file:" && document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", seed, { once: true });
            } else {
                seed();
            }
        },
        { theme, lang, tourIds: ONBOARD_TOUR_IDS, preferences: opts?.preferences ?? {} },
    );
}

/** Navigate to a locale home. Defaults to /en/ so copy assertions are stable. */
export async function gotoApp(page: Page, locale = "en"): Promise<void> {
    await page.goto(`/${locale}/`);
}

/** Change a stored preference in an already loaded page. */
export async function setStoredPreference(page: Page, key: string, value: string | null): Promise<void> {
    await page.evaluate(
        ({ key, value }) => {
            if (!key.startsWith("everydashcam:")) throw new Error("expected a current preference key");
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        },
        { key, value },
    );
}

/**
 * Re-enable onboarding tours for a first-run test. presetLocalStorage() seeds
 * all four as "done"; call this AFTER it (so the removal wins) to make the
 * listed tours fire again. Must run before gotoApp (uses addInitScript).
 */
export async function clearOnboarding(page: Page, ids: OnboardTourId[] = ONBOARD_TOUR_IDS): Promise<void> {
    await page.addInitScript((ids) => {
        try {
            for (const id of ids) {
                localStorage.removeItem(`everydashcam:onboarding:${id}`);
                localStorage.removeItem(`everydashcam:onboarding:${id}:offered`);
            }
        } catch {
            /* private mode - ignore */
        }
    }, ids);
}

/**
 * Waits until ingest, recording analysis and deferred GPS are all finished and
 * every clip's metadata is read. Before that a late pass can regroup trips and
 * replace the Trip objects a test mutates through `window.__everydashcam`.
 */
export async function waitForMetadata(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__everydashcam.state;
                return (
                    state.ingestController === null &&
                    state.recordingAnalysisProgress === null &&
                    state.inflightEmbeddedGps.size === 0 &&
                    state.pendingHeavyEmbeddedGps.size === 0 &&
                    state.trips.every((trip) =>
                        trip.frames.every((frame) =>
                            Object.values(frame.channels).every((file) => file?.metadataReady === true),
                        ),
                    )
                );
            }),
        )
        .toBe(true);
}

/**
 * Pick the sample folder and activate its first trip. Resolves only once the
 * active trip is actually playable (chart rendered, or - on layouts that hide
 * the chart - the total-time readout has advanced past 0:00). Fails loudly
 * within the timeouts rather than racing on a fixed sleep.
 */
export async function loadTrip(page: Page, sampleDir: string = SAMPLE_70MAI): Promise<void> {
    await page.locator("#folder-input").setInputFiles(sampleDir);
    const firstTrip = page.locator("li.trip:not(.unindexed-note)").first();
    await expect(firstTrip, "a trip card must appear after ingest").toBeVisible({ timeout: 30_000 });
    // Metadata updates replace provisional cards and can interrupt a click.
    // Deferred GPS may wait for activation, so only wait for recording metadata.
    await expect(firstTrip).not.toHaveAttribute("aria-busy", "true");
    await firstTrip.locator(".trip-title").click();
    await page.waitForFunction(
        () => {
            const c = document.getElementById("player-chart-canvas") as HTMLCanvasElement | null;
            if (c && c.getBoundingClientRect().width > 0) return true;
            const total = document.getElementById("player-total");
            return total !== null && total.textContent !== null && total.textContent !== "0:00";
        },
        null,
        { timeout: 15_000 },
    );
}

/**
 * Open the export panel, regardless of viewport. Export is the LAST control to
 * overflow into the player-bar kebab on a narrow bar, so click it directly when
 * visible, otherwise reach it through the overflow menu. Both branches end with
 * the panel asserted visible.
 *
 * Precondition: an ACTIVE player (a decodable trip). On a browser without an
 * H.264 decoder the viewer shows a "no decoder" overlay instead of the player
 * bar and there is no export button. The pinned Chrome for Testing includes
 * the codecs required by the suite's H.264/AAC samples.
 */
export async function openExport(page: Page, expandAdvanced = true): Promise<void> {
    const btn = page.locator("#player-export");
    await expect(btn, "export must be enabled once a decodable trip is active").toBeEnabled();
    if (await btn.isVisible()) {
        await btn.click();
    } else {
        await page.locator("#player-overflow").click();
        const item = page.locator("#player-overflow-menu button.overflow-menu-btn", {
            hasText: /save clip|export|сохранить фрагмент|экспорт/i,
        });
        await expect(item).toBeVisible();
        await item.click();
    }
    await expect(page.locator("#export-panel")).toBeVisible();
    if (expandAdvanced) {
        const closed = page.locator(".export-panel__disclosure:not([open]) > summary");
        while (await closed.count()) await closed.first().click();
    }
}

/** Alias kept for readability at mobile call sites; the logic is viewport-agnostic. */
export const openMobileExport = openExport;

/**
 * Assert an element is present and return its bounding box, non-null. Replaces
 * the `const box = await loc.boundingBox(); if (box) { ... }` anti-pattern that
 * silently skips its assertions when the element is missing.
 */
export async function boxOf(
    page: Page,
    selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
    const loc = page.locator(selector);
    await expect(loc).toBeVisible();
    const box = await loc.boundingBox();
    expect(box, `${selector} must have a bounding box`).not.toBeNull();
    return box!;
}

const MASTER_VIDEO = ".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)";

/**
 * Current playback position of the MASTER tile in seconds - the element a frame
 * step / seek actually moves (getTripCurrentTime / seekTripTime read dom.player,
 * the active-channel, active-slot <video>). The `.active` tile marks the master
 * channel; each tile carries three <video>s (a decorative `.tile-blur-bg`
 * backdrop, the live slot, and a hot `.preload-slot`), so exclude the other two
 * to land on the live slot - the same `video:not(.tile-blur-bg)` convention the
 * player CSS uses.
 *
 * Do NOT use Math.max over every <video>: during playback the slave tiles drift
 * a frame or two ahead of the master and pause freezes that drift, so a pre-step
 * max is a stale slave that the first step re-syncs *down* to master+1/fps -
 * which reads as a step that went backwards and flakes the frame-step assertions.
 */
export async function masterVideoTime(page: Page): Promise<number> {
    const master = page.locator(MASTER_VIDEO);
    await expect(master).toHaveCount(1);
    return master.evaluate((v: HTMLVideoElement) => v.currentTime);
}

/** The chart can render before metadata starts autoplay. Wait for the media
 * before pausing so a later load cannot move the position under an assertion. */
export async function pausePlayback(page: Page): Promise<void> {
    const master = page.locator(MASTER_VIDEO);
    await expect
        .poll(() => master.evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking), {
            message: "the active video has a decoded frame before pausing",
        })
        .toBe(true);
    if (!(await master.evaluate((video: HTMLVideoElement) => video.paused))) {
        await page.locator("#player-play").click();
    }
    await expect
        .poll(
            () => master.evaluate((video: HTMLVideoElement) => video.paused && !video.seeking && video.readyState >= 2),
            { message: "the active video is paused with no pending seek" },
        )
        .toBe(true);
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
}

/** Makes the stubbed save target fail every write once it holds `afterBytes`,
 *  with a DOMException named `errorName` (what a vanished destination throws).
 *  0 fails the very first write - note the muxer buffers into multi-MiB chunks,
 *  so a short clip only ever issues one write and any real threshold is unreachable. */
export interface ExportSinkFailure {
    afterBytes: number;
    errorName: string;
}

interface ExportCaptureOptions {
    pickerDelayMs?: number;
    pickerErrorOnce?: { name: string; message: string };
}

interface ExportCaptureInit extends ExportCaptureOptions {
    fail?: ExportSinkFailure;
}

/** Screenshot helper - artifacts for human review, written next to the suite. */
export async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: false });
}

/**
 * Stub `window.showSaveFilePicker` with an in-memory file before the bundle
 * loads so capability probes see native saving. This routes the entire export
 * write path (createWritable / write /
 * seek / truncate / getFile, including the GPMF meta-track re-open with
 * keepExistingData) into a buffer we can inspect - exercising the REAL mux /
 * re-encode / telemetry-injection pipeline, stubbing only the disk handle.
 *
 * Must be called before `gotoApp`. Read the result with `readExportResult`.
 *
 * Pass `failure` to make the stubbed destination start rejecting writes partway
 * through - the only way to drive a real sink failure through the whole chain
 * (worker -> port bridge -> the export flow's error mapping).
 */
export async function installExportCapture(
    page: Page,
    failure?: ExportSinkFailure,
    opts?: ExportCaptureOptions,
): Promise<void> {
    const initConfig: ExportCaptureInit = { fail: failure, ...opts };
    await page.addInitScript((config: ExportCaptureInit) => {
        const { fail, pickerDelayMs = 0, pickerErrorOnce } = config;
        const enc = new TextEncoder();
        const toU8 = (data: unknown): Uint8Array => {
            if (data == null) return new Uint8Array(0);
            if (typeof data === "string") return enc.encode(data);
            if (data instanceof Uint8Array) return data;
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (ArrayBuffer.isView(data)) {
                const v = data as ArrayBufferView;
                return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            }
            return new Uint8Array(0);
        };
        const makeHandle = (name: string): Record<string, unknown> => {
            const h = { name, kind: "file", _buf: new Uint8Array(0), _pos: 0 } as {
                name: string;
                kind: string;
                _buf: Uint8Array;
                _pos: number;
                _ensure: (n: number) => void;
                _put: (u8: Uint8Array, at?: number) => void;
                createWritable: (opts?: { keepExistingData?: boolean }) => Promise<unknown>;
                getFile: () => Promise<File>;
            };
            h._ensure = (n) => {
                if (n > h._buf.length) {
                    const nb = new Uint8Array(n);
                    nb.set(h._buf);
                    h._buf = nb;
                }
            };
            h._put = (u8, at) => {
                const p = at ?? h._pos;
                h._ensure(p + u8.length);
                h._buf.set(u8, p);
                h._pos = p + u8.length;
            };
            h.createWritable = async (opts) => {
                if (!opts?.keepExistingData) h._buf = new Uint8Array(0);
                h._pos = 0;
                return {
                    // FSA write() accepts BufferSource | Blob | string, or a command
                    // object {type:'write'|'seek'|'truncate', ...}. Match the command
                    // form by its specific type values - a Blob also has a `.type`
                    // (its MIME), so a bare `"type" in chunk` check would misread it.
                    write: async (chunk: unknown) => {
                        // Simulated destination failure: the save target stops
                        // accepting writes once the file passes a threshold, the
                        // way a disconnected drive or a swap file taken by another
                        // app does mid-export.
                        if (fail && h._buf.length >= fail.afterBytes) {
                            throw new DOMException("the destination is gone", fail.errorName);
                        }
                        const cmd = chunk as { type?: string; position?: number; size?: number; data?: unknown };
                        if (cmd && (cmd.type === "write" || cmd.type === "seek" || cmd.type === "truncate")) {
                            if (cmd.type === "seek") {
                                h._pos = cmd.position ?? h._pos;
                                return;
                            }
                            if (cmd.type === "truncate") {
                                const size = cmd.size ?? 0;
                                h._buf = h._buf.slice(0, size);
                                if (h._pos > size) h._pos = size;
                                return;
                            }
                            if (cmd.position != null) h._pos = cmd.position;
                            const d = cmd.data;
                            h._put(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : toU8(d));
                            return;
                        }
                        h._put(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : toU8(chunk));
                    },
                    seek: async (p: number) => {
                        h._pos = p;
                    },
                    truncate: async (n: number) => {
                        h._buf = h._buf.slice(0, n);
                        if (h._pos > n) h._pos = n;
                    },
                    close: async () => {},
                    // A real FileSystemWritableFileStream is a WritableStream and
                    // has abort(); export-flow calls it to discard a cancelled /
                    // failed stream-copy.
                    abort: async () => {},
                };
            };
            h.getFile = async () => new File([h._buf as BlobPart], h.name, { type: "video/mp4" });
            return h;
        };
        const w = window as unknown as {
            showSaveFilePicker: unknown;
            __lastExportHandle: unknown;
            __exportPickerOpened: boolean;
            __exportPickerCalls: number;
        };
        w.__exportPickerCalls = 0;
        w.showSaveFilePicker = async (options?: { suggestedName?: string }) => {
            w.__exportPickerCalls++;
            w.__exportPickerOpened = true;
            if (pickerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pickerDelayMs));
            if (pickerErrorOnce && w.__exportPickerCalls === 1) {
                throw new DOMException(pickerErrorOnce.message, pickerErrorOnce.name);
            }
            const h = makeHandle(options?.suggestedName ?? "export.mp4");
            w.__lastExportHandle = h;
            return h;
        };
    }, initConfig);
}

/**
 * Simulates a browser WITHOUT the native File System Access save picker
 * (Android Chrome / Firefox / Safari), forcing the export through the in-memory
 * path (src/ui/in-memory-file.ts). Also intercepts `URL.createObjectURL` to
 * record every Blob handed to a download, so the test can read the produced MP4
 * bytes (the file never touches disk - it is offered via the done-view Download
 * button). Must be called before `gotoApp`; read with `readInMemoryDownload`.
 */
export async function installInMemoryExportCapture(page: Page): Promise<void> {
    await page.addInitScript(() => {
        // typeof check in nativeFsaAvailable() treats a present-but-undefined
        // getter as "no native picker" - matches the compat-spec removal style.
        // With no native picker the export takes the in-memory (RAM) path, which
        // is the only no-native path now.
        Object.defineProperty(window, "showSaveFilePicker", { configurable: true, get: () => undefined });
        const orig = URL.createObjectURL.bind(URL);
        (window as unknown as { __downloads: Blob[] }).__downloads = [];
        URL.createObjectURL = (obj: Blob | MediaSource): string => {
            if (obj instanceof Blob) (window as unknown as { __downloads: Blob[] }).__downloads.push(obj);
            return orig(obj);
        };
    });
}

/** The frame counters the single-channel pipeline reports when it finishes. */
export interface TranscodeDoneFields {
    framesEncoded: number;
    /** Frames handed to the encoder without going through the composition canvas. */
    framesDirect: number;
}

/**
 * Pulls the transcode worker's "transcode done" counters out of the log ring
 * buffer (worker records are bridged into the main-thread buffer). Null when the
 * line is absent - i.e. the single-channel pipeline never ran to completion.
 */
export async function readTranscodeDoneFields(page: Page): Promise<TranscodeDoneFields | null> {
    return page.evaluate(() => {
        const dump = (window as unknown as { __everydashcam?: { dumpLog: () => unknown[] } }).__everydashcam?.dumpLog;
        if (!dump) return null;
        const rec = dump()
            .reverse()
            .find((r) => (r as { msg?: string }).msg === "transcode done") as
            | { ctx?: { framesEncoded?: number; framesDirect?: number } }
            | undefined;
        if (!rec?.ctx) return null;
        return {
            framesEncoded: rec.ctx.framesEncoded ?? 0,
            framesDirect: rec.ctx.framesDirect ?? 0,
        };
    });
}

export interface ExportResult {
    len: number;
    ftyp: boolean;
    moov: boolean;
    mdat: boolean;
    gpmd: boolean;
    /** An audio media handler ('soun' in a hdlr box) is present - i.e. the export
     *  carries an audio track. Gates that audio survives the export (stream-copy
     *  copies it; the re-encode path passes AAC/MP3 through without an encoder). */
    soun: boolean;
}

/** Inspect the bytes the export pipeline wrote into the stubbed handle. */
export async function readExportResult(page: Page): Promise<ExportResult | null> {
    return page.evaluate(() => {
        const h = (window as unknown as { __lastExportHandle?: { _buf: Uint8Array } }).__lastExportHandle;
        if (!h) return null;
        const buf: Uint8Array = h._buf;
        const has = (needle: string): boolean => {
            const n = [...needle].map((c) => c.charCodeAt(0));
            outer: for (let i = 0; i + n.length <= buf.length; i++) {
                for (let j = 0; j < n.length; j++) if (buf[i + j] !== n[j]) continue outer;
                return true;
            }
            return false;
        };
        return {
            len: buf.length,
            ftyp: has("ftyp"),
            moov: has("moov"),
            mdat: has("mdat"),
            gpmd: has("gpmd"),
            soun: has("soun"),
        };
    });
}

/**
 * Whether this runner can encode the exact H.264 config the re-encode/compositing
 * pipeline asks of WebCodecs. The probe MUST mirror the real config or the test
 * skips on the wrong platforms: mediabunny emits HIGH-profile H.264 for codec
 * "avc" (profile 0x64, hardcoded) and gates on a single
 * VideoEncoder.isConfigSupported() with no hardwareAcceleration preference. On a
 * headless Linux runner without a hardware encoder the only software path is
 * Chrome's bundled OpenH264, which does NOT implement High - so High-profile
 * encode is impossible there and mediabunny throws. A baseline-profile probe
 * would return supported on that same runner and fail to skip. Used by both
 * re-encode export tests to skip (not fail) where encode is unavailable.
 *
 * NOTE: this does NOT catch Firefox - isConfigSupported returns true there but
 * the real encode throws (Bugzilla 1918769), and even a probe-frame encode of a
 * blank canvas succeeds while the actual split-screen export fails. The re-encode
 * tests therefore skip Firefox explicitly by browserName, not via this probe.
 */
export async function canEncodeHighProfileH264(page: Page): Promise<boolean> {
    return page.evaluate(async () => {
        const VE = (
            globalThis as unknown as {
                VideoEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
            }
        ).VideoEncoder;
        if (!VE) return false;
        try {
            const s = await VE.isConfigSupported({
                codec: "avc1.64001f", // High profile, level 3.1 (720p) - what mediabunny emits
                width: 1280,
                height: 720,
                bitrate: 3_686_400,
                framerate: 30,
            });
            return !!s?.supported;
        } catch {
            return false;
        }
    });
}

/**
 * Whether a real WebGPU adapter can be acquired here. Plate/face detection is
 * WebGPU-only (no wasm fallback), and the checkbox is DISABLED without an
 * adapter - so a detect spec that .check()s it would hang the full 180 s
 * timeout on a runner whose (SwiftShader) adapter is missing. Guards those
 * specs into a clean skip instead. Presence of navigator.gpu is not enough:
 * requestAdapter() can still resolve null, which is what actually gates the UI.
 * The required detector project asserts adapter and FP16 support before any
 * caller can skip, so an unavailable CI driver cannot silently remove coverage.
 */
export async function hasWebGpuAdapter(page: Page): Promise<boolean> {
    const capability = await page.evaluate(async () => {
        const gpu = (
            navigator as unknown as {
                gpu?: {
                    requestAdapter(): Promise<{
                        features: { has(name: string): boolean };
                        info: { vendor: string; architecture: string; device: string; description: string };
                    } | null>;
                };
            }
        ).gpu;
        if (!gpu) return { adapter: false, fp16: false };
        try {
            const adapter = await gpu.requestAdapter();
            return {
                adapter: !!adapter,
                fp16: adapter?.features.has("shader-f16") ?? false,
                info: adapter && {
                    vendor: adapter.info.vendor,
                    architecture: adapter.info.architecture,
                    device: adapter.info.device,
                    description: adapter.info.description,
                },
            };
        } catch {
            return { adapter: false, fp16: false };
        }
    });
    if (test.info().project.metadata.requireWebGpu) {
        const detail = JSON.stringify(capability);
        expect(capability.adapter, `required detector project must acquire a WebGPU adapter: ${detail}`).toBe(true);
        expect(
            capability.fp16,
            `required detector project must support shader-f16 for packaged models: ${detail}`,
        ).toBe(true);
    }
    return capability.adapter;
}

/** Inspect the MP4 Blob handed to the download on the in-memory export path
 *  (the most recent captured video/mp4 blob). Null when none was produced. */
export async function readInMemoryDownload(page: Page): Promise<ExportResult | null> {
    return page.evaluate(async () => {
        const blobs = (window as unknown as { __downloads?: Blob[] }).__downloads ?? [];
        const mp4 = [...blobs].reverse().find((b) => b.type === "video/mp4");
        if (!mp4) return null;
        const buf = new Uint8Array(await mp4.arrayBuffer());
        const has = (needle: string): boolean => {
            const n = [...needle].map((c) => c.charCodeAt(0));
            outer: for (let i = 0; i + n.length <= buf.length; i++) {
                for (let j = 0; j < n.length; j++) if (buf[i + j] !== n[j]) continue outer;
                return true;
            }
            return false;
        };
        return {
            len: buf.length,
            ftyp: has("ftyp"),
            moov: has("moov"),
            mdat: has("mdat"),
            gpmd: has("gpmd"),
            soun: has("soun"),
        };
    });
}

/** One folder the fake picker can hand back, in the order they are requested. */
export interface MockFolder {
    /** Root folder name the app will show and key the source row by. */
    label: string;
    /** Sample directory on disk whose real bytes the handle serves. */
    dir: string;
}

/**
 * Stands in for the File System Access directory picker, so the FSA half of the
 * folder feature (remember / status dot) is reachable from a spec
 * at all - Playwright cannot drive the real OS picker.
 *
 * Each picker call hands back the next folder of the list (the last one repeats),
 * which is how a spec loads two different cards in one session. Files are copied
 * into OPFS, so the returned handles are real browser FileSystemHandles: they
 * survive IndexedDB structured clone. Independently picked notes files live in
 * a separate OPFS directory; a notes file already in a mocked folder remains
 * discoverable through that folder's read-only handle.
 */
export async function mockDirectoryPicker(page: Page, folders: MockFolder[]): Promise<void> {
    const listing = folders.map((folder, index) => ({
        sourceId: String(index),
        label: folder.label,
        files: listFilesRecursively(folder.dir),
    }));
    const bySourceId = new Map(listing.map((folder, index) => [folder.sourceId, folders[index]!.dir]));
    await page.route("**/__fsa/**", async (route) => {
        const url = new URL(route.request().url());
        const [sourceId, ...rest] = url.pathname.replace(/^\/__fsa\//, "").split("/");
        const dir = bySourceId.get(decodeURIComponent(sourceId ?? ""));
        const rel = rest.map(decodeURIComponent).join("/");
        if (!dir || !rel) {
            await route.fulfill({ status: 404, body: "" });
            return;
        }
        await route.fulfill({ path: path.join(dir, rel), headers: { "access-control-allow-origin": "*" } });
    });
    await page.addInitScript((listing: { sourceId: string; label: string; files: MockListedFile[] }[]) => {
        const roots: Array<Promise<FileSystemDirectoryHandle> | undefined> = [];
        const exposed: FileSystemDirectoryHandle[] = [];
        const buildRoot = async (index: number): Promise<FileSystemDirectoryHandle> => {
            const { sourceId, label, files } = listing[index]!;
            const storageRoot = await navigator.storage.getDirectory();
            // Separate parents let two physical sources expose the same leaf
            // name while remaining different entries for isSameEntry().
            const sourceRoot = await storageRoot.getDirectoryHandle(`source-${sourceId}`, { create: true });
            const root = await sourceRoot.getDirectoryHandle(label, { create: true });
            let isSeeded = true;
            try {
                await sourceRoot.getFileHandle("seeded");
            } catch {
                isSeeded = false;
            }
            if (!isSeeded) {
                for (const { relativePath } of files) {
                    const segments = relativePath.split("/");
                    let dir = root;
                    for (const segment of segments.slice(0, -1)) {
                        dir = await dir.getDirectoryHandle(segment, { create: true });
                    }
                    const handle = await dir.getFileHandle(segments.at(-1)!, { create: true });
                    withPickerPermissions(handle);
                    const writable = await handle.createWritable();
                    const encoded = [sourceId, ...segments].map(encodeURIComponent).join("/");
                    const response = await fetch(`https://everydashcam-fsa.test/__fsa/${encoded}`);
                    await writable.write(await response.arrayBuffer());
                    await writable.close();
                }
                // Keep OPFS mtimes and app-written notes stable across reloads.
                // Re-seeding here would silently replace the very backup that
                // persistence tests expect the stored handle to reopen.
                await sourceRoot.getFileHandle("seeded", { create: true });
            }
            exposed[index] = root;
            return root;
        };
        (window as unknown as { __e2eDirectoryPickerRoots: FileSystemDirectoryHandle[] }).__e2eDirectoryPickerRoots =
            exposed;
        let picked = 0;
        (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
            async () => {
                const index = Math.min(picked++, listing.length - 1);
                roots[index] ??= buildRoot(index);
                return roots[index];
            };
        let lastSavedNotesName = "notes.everydashcam";
        const globalNotesHandle = async (name: string, create: boolean): Promise<FileSystemFileHandle> => {
            const storageRoot = await navigator.storage.getDirectory();
            const notesRoot = await storageRoot.getDirectoryHandle("global-notes", { create: true });
            const handle = await notesRoot.getFileHandle(name, { create });
            (window as unknown as { __e2eNotesFileHandle?: FileSystemFileHandle }).__e2eNotesFileHandle = handle;
            return handle;
        };
        const writeGranted = new WeakSet<FileSystemFileHandle>();
        const withPickerPermissions = (handle: FileSystemFileHandle): FileSystemFileHandle => {
            const prototype = Object.getPrototypeOf(handle) as {
                queryPermission?: (options?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
                requestPermission?: (options?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
            };
            Object.defineProperty(prototype, "queryPermission", {
                configurable: true,
                value: async function (this: FileSystemFileHandle, options?: FileSystemHandlePermissionDescriptor) {
                    return options?.mode === "readwrite" && !writeGranted.has(this) ? "prompt" : "granted";
                },
            });
            Object.defineProperty(prototype, "requestPermission", {
                configurable: true,
                value: async function (this: FileSystemFileHandle) {
                    writeGranted.add(this);
                    return "granted";
                },
            });
            return handle;
        };
        (
            window as unknown as {
                showSaveFilePicker: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
            }
        ).showSaveFilePicker = async ({ suggestedName }) => {
            const requested = (window as unknown as { __e2eSaveNotesAs?: string }).__e2eSaveNotesAs;
            lastSavedNotesName = requested || suggestedName;
            return withPickerPermissions(await globalNotesHandle(lastSavedNotesName, true));
        };
        (
            window as unknown as {
                showOpenFilePicker: (options?: {
                    startIn?: FileSystemDirectoryHandle;
                }) => Promise<FileSystemFileHandle[]>;
            }
        ).showOpenFilePicker = async ({ startIn } = {}) => {
            const notesFromFolder = async (folder: FileSystemDirectoryHandle): Promise<FileSystemFileHandle | null> => {
                let only: FileSystemFileHandle | null = null;
                for await (const child of folder.values()) {
                    if (child.kind !== "file" || !/\.(everydashcam|dashcamigo)$/i.test(child.name)) continue;
                    if (/^notes\.(everydashcam|dashcamigo)$/i.test(child.name)) return child;
                    if (only) return null;
                    only = child;
                }
                return only;
            };
            if (startIn) {
                const local = await notesFromFolder(startIn);
                if (local) {
                    (window as unknown as { __e2eNotesFileHandle?: FileSystemFileHandle }).__e2eNotesFileHandle = local;
                    return [withPickerPermissions(local)];
                }
            }
            try {
                return [withPickerPermissions(await globalNotesHandle(lastSavedNotesName, false))];
            } catch {
                // No standalone file yet: let compatibility specs pick the old
                // notes file that arrived with a recording folder.
            }
            for (let index = 0; index < listing.length; index++) {
                roots[index] ??= buildRoot(index);
                const root = await roots[index]!;
                const local = await notesFromFolder(root);
                if (local) {
                    (window as unknown as { __e2eNotesFileHandle?: FileSystemFileHandle }).__e2eNotesFileHandle = local;
                    return [withPickerPermissions(local)];
                }
            }
            throw new DOMException("No notes file selected", "AbortError");
        };
    }, listing);
}

interface MockListedFile {
    relativePath: string;
}

/** Folder-relative file list for the OPFS-backed FSA mock. */
function listFilesRecursively(dir: string, prefix = ""): MockListedFile[] {
    const out: MockListedFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listFilesRecursively(path.join(dir, entry.name), rel));
        else out.push({ relativePath: rel });
    }
    return out;
}
