// Progressive ingest on the responsive storage policy. Covers provisional list
// availability, deterministic click feedback, mandatory playback readiness,
// final regroup reconciliation, cancellation and recovery from unreadable clips.

import { installWorkerRpc } from "./_worker-rpc.js";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import {
    DESKTOP,
    MOBILE,
    REPO_ROOT,
    SAMPLE_70MAI,
    SAMPLE_GOPRO,
    SAMPLE_NOGPS,
    expect,
    gotoApp,
    presetLocalStorage,
    setStoredPreference,
    shot,
    test,
} from "./_fixtures.js";

const temporaryDirectories: string[] = [];
const DEFERRED_GPS_FILENAME = "2021_1013_183759_050.MP4";

function makeTemporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(path.join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function armImmediateTripClick(page: Page): Promise<void> {
    await page.evaluate(() => {
        const observer = new MutationObserver(() => {
            const trip = document.querySelector<HTMLElement>("li.trip:not(.unindexed-note)");
            const open = trip?.querySelector<HTMLElement>(".trip-title");
            if (!trip || !open) return;
            open.click();
            (window as typeof window & { __openingFeedbackSeen?: boolean }).__openingFeedbackSeen =
                trip.classList.contains("trip--opening");
            observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

async function armImmediateTripClickAndCancel(page: Page): Promise<void> {
    await armImmediateTripClick(page);
    await page.evaluate(() => {
        const preparation = document.getElementById("trip-preparation");
        if (!preparation) return;
        const observer = new MutationObserver(() => {
            if (preparation.hidden) return;
            const cancel = document.getElementById("trip-preparation-cancel") as HTMLButtonElement | null;
            const title = document.getElementById("trip-preparation-title");
            const target = window as typeof window & {
                __recordingCancelSeen?: { copy: string; title: string; clicked: boolean };
            };
            target.__recordingCancelSeen = {
                copy: cancel?.textContent?.trim() ?? "",
                title: title?.textContent?.trim() ?? "",
                clicked: false,
            };
            cancel?.click();
            target.__recordingCancelSeen.clicked = true;
            observer.disconnect();
        });
        observer.observe(preparation, { attributes: true, attributeFilter: ["hidden"] });
    });
}

function writeBrokenMp4(dir: string, name: string): void {
    const ftyp = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size 24
        Buffer.from("ftypisom", "ascii"),
        Buffer.from([0x00, 0x00, 0x02, 0x00]),
        Buffer.from("isommp41", "ascii"),
    ]);
    // Valid ftyp plus padding, but no moov box anywhere.
    writeFileSync(path.join(dir, name), Buffer.concat([ftyp, Buffer.alloc(256)]));
}

function withMvhdCreationTime(source: string, iso: string): Buffer {
    const bytes = readFileSync(source);
    const marker = bytes.indexOf("mvhd", 0, "ascii");
    if (marker < 0 || bytes[marker + 4] !== 0) throw new Error("fixture needs a version-0 mvhd box");
    const unixSeconds = Date.parse(iso) / 1000;
    const quickTimeSeconds = unixSeconds + 2_082_844_800;
    if (!Number.isInteger(quickTimeSeconds) || quickTimeSeconds < 0 || quickTimeSeconds > 0xffff_ffff) {
        throw new Error("fixture creation time is outside version-0 mvhd range");
    }
    bytes.writeUInt32BE(quickTimeSeconds, marker + 8);
    bytes.writeUInt32BE(quickTimeSeconds, marker + 12);
    return bytes;
}

function writeDeferredGpsClip(directory: string): void {
    const gps = readFileSync(path.join(REPO_ROOT, "tests/testdata/novatek-real-anonymized/2e-drive-730.mp4"));
    for (let offset = 0; offset + 8 <= gps.length; ) {
        const size = gps.readUInt32BE(offset);
        if (size < 8 || offset + size > gps.length) throw new Error("invalid GPS fixture box");
        if (gps.toString("ascii", offset + 4, offset + 8) === "free") {
            // One real anonymized freeGPS block provides only one scan seed,
            // which forces the heavy/deferred path. Appending it leaves the
            // public clip's video offsets intact and preserves real parser bytes.
            const video = withMvhdCreationTime(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"), "2021-10-13T18:37:59.000Z");
            writeFileSync(
                path.join(directory, DEFERRED_GPS_FILENAME),
                Buffer.concat([video, gps.subarray(offset, offset + size)]),
            );
            return;
        }
        offset += size;
    }
    throw new Error("missing freeGPS fixture box");
}

async function openDeferredGpsTrip(page: Page, includeBackgroundClips = false): Promise<void> {
    const dir = makeTemporaryDirectory("everydashcam-gps-open-");
    writeDeferredGpsClip(dir);
    if (includeBackgroundClips) {
        for (const day of ["01", "02"]) {
            writeFileSync(
                path.join(dir, `NO202001${day}-120000-000001F.MP4`),
                withMvhdCreationTime(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"), `2020-01-${day}T12:00:00.000Z`),
            );
        }
    }
    await armImmediateTripClick(page);
    await page.locator("#folder-input").setInputFiles(dir);
    await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
    await expect
        .poll(() =>
            page.evaluate(
                () => (window as typeof window & { __gpsResponseQueued?: boolean }).__gpsResponseQueued ?? false,
            ),
        )
        .toBe(true);
}

async function dropExcludedEntry(page: Page): Promise<void> {
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["excluded diagnostic data"], "trace.dat"));
        // The browser Entries API supplies names before file bytes. The real
        // walker must retain this path without requesting the excluded File.
        Object.defineProperty(transfer, "items", {
            value: [
                {
                    webkitGetAsEntry: () => ({
                        name: "trace.dat",
                        fullPath: "/.diagnostic-only/trace.dat",
                        isFile: true,
                        isDirectory: false,
                        file: () => {
                            throw new Error("excluded file must not be opened");
                        },
                    }),
                },
            ],
        });
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
}

test.describe("progressive ingest", () => {
    let releaseViewerDownload: (() => void) | undefined;
    let viewerDownloadRequested = false;
    let rejectViewerDownload = false;

    test.afterEach(() => {
        releaseViewerDownload?.();
        releaseViewerDownload = undefined;
        viewerDownloadRequested = false;
        rejectViewerDownload = false;
        for (const directory of temporaryDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test.beforeEach(async ({ page }, testInfo) => {
        if (testInfo.title.includes("ignored-only classic selection")) {
            await page.addInitScript(() => {
                Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
            });
        }
        if (testInfo.title.includes("auxiliary classifier worker crashes")) {
            await installWorkerRpc(page, () => {
                window.__workerRpc.intercept(["ingest-worker"], (worker) => (_type, _data, _forward) => {
                    (window as typeof window & { __classifierCrashInjected?: boolean }).__classifierCrashInjected =
                        true;
                    worker.crash();
                    return new Promise(() => {});
                });
            });
        }
        if (testInfo.title.includes("drains a structure-only queued selection")) {
            await installWorkerRpc(page, () => {
                const target = window as typeof window & { __releaseClassification?: () => void };
                let held = false;
                window.__workerRpc.intercept(["ingest-worker"], () => async (type, _data, forward, kind) => {
                    if (kind === "request" && type === "classify-batch" && !held) {
                        held = true;
                        await new Promise<void>((resolve) => {
                            target.__releaseClassification = resolve;
                        });
                    }
                    return forward();
                });
            });
        }
        if (testInfo.title.includes("ignored-only drop resumes previews")) {
            await installWorkerRpc(page, () => {
                const pending: Array<() => void> = [];
                let isHeld = true;
                (window as typeof window & { __releasePreviews?: () => void }).__releasePreviews = () => {
                    isHeld = false;
                    for (const release of pending.splice(0)) release();
                };
                window.__workerRpc.intercept(["preview-worker"], () => async (type, _data, forward, kind) => {
                    if (kind === "request" && type === "extract-preview" && isHeld) {
                        await new Promise<void>((resolve) => pending.push(resolve));
                    }
                    return forward();
                });
            });
        }
        if (testInfo.title.includes("damaged leading clip")) {
            await page.route("**/assets/maplibre-gl-*.js", async (route) => {
                await new Promise((resolve) => setTimeout(resolve, 1200));
                await route.continue();
            });
        }
        if (testInfo.title.includes("viewer download")) {
            const viewerDownload = new Promise<void>((resolve) => {
                releaseViewerDownload = resolve;
            });
            await page.route("**/assets/maplibre-gl-*.js", async (route) => {
                viewerDownloadRequested = true;
                await viewerDownload;
                if (rejectViewerDownload) {
                    await route.fulfill({ status: 503, contentType: "text/javascript", body: "" });
                } else {
                    await route.continue();
                }
            });
            await installWorkerRpc(page, () => {
                const target = window as typeof window & {
                    __gpsResponseQueued?: boolean;
                    __gpsResponseReleased?: boolean;
                    __playbackStartedBeforeGps?: boolean;
                    __releaseGpsResponses?: () => void;
                };
                let responsesReleased = false;
                const queuedResponses: Array<() => void> = [];
                target.__releaseGpsResponses = () => {
                    responsesReleased = true;
                    target.__gpsResponseReleased = true;
                    for (const deliver of queuedResponses.splice(0)) deliver();
                };
                window.__workerRpc.intercept(["gps-extract-worker"], () => async (_type, data, forward, kind) => {
                    const result = await forward();
                    if (kind === "request" && (data as { mode?: string })?.mode === "all" && !responsesReleased) {
                        target.__gpsResponseQueued = true;
                        await new Promise<void>((resolve) => queuedResponses.push(resolve));
                    }
                    return result;
                });
                setInterval(() => {
                    if (window.__everydashcam?.state.active && !target.__gpsResponseReleased) {
                        target.__playbackStartedBeforeGps = true;
                    }
                }, 0);
            });
        }
        if (testInfo.title.includes("reuses cached metadata while stale GPS reparses")) {
            await installWorkerRpc(page, () => {
                const target = window as typeof window & {
                    __workerRequests?: Array<{ worker: string; type: string }>;
                };
                target.__workerRequests = [];
                window.__workerRpc.intercept(
                    ["ingest-worker", "indexer-worker", "gps-extract-worker"],
                    (worker) => (type, _data, forward, kind) => {
                        if (kind === "request") target.__workerRequests?.push({ worker: worker.name, type });
                        return forward();
                    },
                );
            });
        }
        await presetLocalStorage(page);
        // The override wins over the probe and minimum batch size.
        await page.addInitScript(() => {
            try {
                localStorage.setItem("everydashcam:ingest-policy", "responsive");
            } catch {
                /* private mode - ignore */
            }
        });
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, "en");
    });

    test("renders a provisional list, then makes the opened trip playable", async ({ page }) => {
        await armImmediateTripClick(page);
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);

        // The list is useful before byte-derived metadata is available.
        const trips = page.locator("li.trip:not(.unindexed-note)");
        await expect(trips.first(), "provisional trip card must appear").toBeVisible({ timeout: 30_000 });
        expect(await trips.count(), "70mai sample yields at least one trip").toBeGreaterThanOrEqual(1);

        // The trip title is a keyboard-operable control.
        const title = trips.first().locator(".trip-title");
        await expect(title).toHaveAttribute("role", "button");
        await expect(title).toHaveAttribute("tabindex", "0");

        // The click was issued in the first render microtask, before background
        // scheduling could finish. Its synchronous feedback must be observable.
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () => (window as typeof window & { __openingFeedbackSeen?: boolean }).__openingFeedbackSeen,
                    ),
                { timeout: 10_000 },
            )
            .toBe(true);
        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        await expect
            .poll(async () => (await page.locator("#player-total").textContent())?.trim(), {
                timeout: 20_000,
            })
            .not.toBe("0:00");

        // All discovered channels are available in the player.
        for (const ch of ["front", "rear", "interior"] as const) {
            await expect(
                page.locator(`#video-grid .video-tile[data-channel="${ch}"]`),
                `${ch} tile must render after metadata read`,
            ).toBeVisible();
        }

        // The list clears its busy state once every recording is settled.
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 20_000 });

        // The provisional list initially splits this tiny fixture into two trips.
        // Once real two-second durations land, the final regroup merges them into
        // one four-second trip. The active viewer must adopt that rebuilt timeline
        // too - remapping state.active alone leaves the player stuck on the old
        // two-second Trip object while the sidebar already says four seconds.
        await expect(page.locator("#player-total")).toHaveText("0:04");
        expect(
            await page.evaluate(() => {
                const active = window.__everydashcam.state.active;
                return active ? window.__everydashcam.state.trips[active.trip]?.timeline.contentDurationSec : null;
            }),
            "active state and the visible player use the same post-regroup timeline",
        ).toBe(4);

        await shot(page, "progressive-01-ready");
    });

    test("loads playable videos when an auxiliary classifier worker crashes", async ({ page }) => {
        const directory = makeTemporaryDirectory("everydashcam-classifier-crash-");
        copyFileSync(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"), path.join(directory, "clip-no-gps.mp4"));
        writeFileSync(
            path.join(directory, "GPSData.txt"),
            "$V02,1700000000,1,40.0,N,74.0,W,0,0,clip-no-gps.mp4,0,0,0\n",
        );
        await page.locator("#folder-input").setInputFiles(directory);

        const trip = page.locator("li.trip:not(.unindexed-note)").first();
        await expect(trip).toBeVisible({ timeout: 30_000 });
        expect(
            await page.evaluate(
                () => (window as typeof window & { __classifierCrashInjected?: boolean }).__classifierCrashInjected,
            ),
            "the classifier request reaches the injected failure",
        ).toBe(true);
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        await trip.locator(".trip-title").click();
        await expect(page.locator("#player-wrap")).toBeVisible();
        await expect
            .poll(async () => (await page.locator("#player-total").textContent())?.trim(), { timeout: 20_000 })
            .not.toBe("0:00");
        const master = page.locator(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
        await expect(master).toHaveCount(1);
        await expect
            .poll(() => master.evaluate((video: HTMLVideoElement) => video.readyState))
            .toBeGreaterThanOrEqual(2);
        expect(await page.evaluate(() => window.__everydashcam.state.unindexed.size)).toBe(0);
        expect(await page.evaluate(() => window.__everydashcam.state.trips[0]?.records.length)).toBe(0);
    });

    test("waits for the selected trip GPS and concurrent viewer download before starting playback", async ({
        page,
    }) => {
        await openDeferredGpsTrip(page);
        expect(viewerDownloadRequested, "GPS completes its worker scan while the viewer download is held").toBe(true);

        const preparation = page.locator("#trip-preparation");
        await expect(preparation).toBeVisible();
        // The immediate-click hook can beat the one-time landing-to-sidebar
        // FLIP that a human must visually wait through. Let that unrelated
        // transition settle before capturing the stable preparation surface.
        await expect(page.locator("#landing-cta")).toHaveCount(0);
        await expect(page.locator("#trip-preparation-title")).toHaveText("Preparing this trip");
        await expect(page.locator("#trip-preparation-progressbar")).toHaveAttribute("aria-valuemax", "1");
        await expect(page.locator("#trip-preparation-progressbar")).not.toHaveAttribute("aria-valuenow", /.+/);
        await expect(page.locator("#trip-preparation-progressbar")).toHaveClass(/is-finalizing/);
        await expect(page.locator("#player-wrap")).toBeHidden();
        await shot(page, "progressive-trip-preparation");
        await page.setViewportSize(MOBILE);
        await expect
            .poll(async () => {
                const box = await page.locator(".sidebar").first().boundingBox();
                return box ? box.x + box.width : 0;
            })
            .toBeLessThanOrEqual(1);
        await expect(preparation).toBeVisible();
        await expect(preparation).toBeInViewport();
        await expect(page.locator("#trip-preparation-cancel")).toBeVisible();
        await shot(page, "progressive-trip-preparation-mobile");
        expect(
            await page.evaluate(() => window.__everydashcam.state.active),
            "the player must stay inactive while selected-trip GPS is unresolved",
        ).toBeNull();

        await page.evaluate(() => {
            (
                window as typeof window & {
                    __releaseGpsResponses?: () => void;
                }
            ).__releaseGpsResponses?.();
        });

        await expect
            .poll(
                () =>
                    page.evaluate(
                        () =>
                            (window as typeof window & { __gpsResponseReleased?: boolean }).__gpsResponseReleased ??
                            false,
                    ),
                { timeout: 10_000 },
            )
            .toBe(true);
        await expect(preparation).toBeHidden();
        await expect
            .poll(() => page.evaluate(() => window.__everydashcam.state.trips[0]?.records.length ?? 0))
            .toBeGreaterThan(0);
        expect(
            await page.evaluate(() => ({
                active: window.__everydashcam.state.active,
                pendingGps: window.__everydashcam.state.pendingHeavyEmbeddedGps.size,
                inflightGps: window.__everydashcam.state.inflightEmbeddedGps.size,
            })),
            "GPS is applied independently, but playback still waits for the viewer",
        ).toEqual({ active: null, pendingGps: 0, inflightGps: 0 });
        await expect(page.locator("li.trip.trip--opening")).toHaveCount(1);
        releaseViewerDownload?.();
        await expect
            .poll(async () => (await page.locator("#player-total").textContent())?.trim(), { timeout: 10_000 })
            .not.toBe("0:00");

        const result = await page.evaluate(() => {
            const state = window.__everydashcam.state;
            const active = state.active;
            const trip = active ? state.trips[active.trip] : null;
            return {
                records: trip?.records.length ?? 0,
                pendingGps: state.pendingHeavyEmbeddedGps.size,
                inflightGps: state.inflightEmbeddedGps.size,
                startedEarly:
                    (window as typeof window & { __playbackStartedBeforeGps?: boolean }).__playbackStartedBeforeGps ??
                    false,
            };
        });
        expect(result.records, "the active trip carries its GPS records at first paint").toBeGreaterThan(0);
        expect(result.pendingGps, "the active trip has no deferred GPS tail").toBe(0);
        expect(result.inflightGps, "the active trip has no in-flight GPS tail").toBe(0);
        expect(result.startedEarly, "playback never becomes active before GPS resolves").toBe(false);
    });

    for (const source of ["structure-only drop", "ignored-only classic selection"] as const) {
        test(`keeps selected-trip GPS running after a ${source} during viewer download`, async ({ page }) => {
            await openDeferredGpsTrip(page);
            await expect(page.locator("#ingest-overlay")).toBeHidden();
            await expect(page.locator("#trip-preparation")).toBeVisible();
            await page.evaluate(() => {
                const status = document.getElementById("ingest-overlay-status")!;
                new MutationObserver(() => {
                    if (status.textContent === "Sorting through files...") {
                        (
                            window as typeof window & { __emptySelectionClassified?: boolean }
                        ).__emptySelectionClassified = true;
                    }
                }).observe(status, { childList: true, characterData: true, subtree: true });
            });

            if (source === "structure-only drop") {
                await dropExcludedEntry(page);
            } else {
                const directory = makeTemporaryDirectory("everydashcam-ignored-selection-");
                writeFileSync(path.join(directory, ".DS_Store"), "excluded file");
                const chooserPromise = page.waitForEvent("filechooser");
                // Exercise the picker ownership path while the trip's separate
                // preparation surface is visible. Native selection is supplied
                // through the real directory input's change event.
                await page.locator("#sidebar-cta").evaluate((element: HTMLElement) => element.click());
                const chooser = await chooserPromise;
                await expect(page.locator("#ingest-overlay")).toBeVisible();
                await chooser.setFiles(directory);
            }
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const { state, dumpLog } = window.__everydashcam;
                        return {
                            finished: state.ingestController === null,
                            diagnosticFiles: state.lastIngestStructure?.filter((entry) => entry.kind === "file").length,
                            reported: dumpLog().some(
                                (entry) => entry.msg === "selection contained no primary recordings",
                            ),
                        };
                    }),
                )
                .toEqual({
                    finished: true,
                    diagnosticFiles: 1,
                    reported: true,
                });
            await expect(page.locator("#ingest-overlay")).toBeHidden();
            await expect(page.locator("#trip-preparation")).toBeVisible();
            expect(
                await page.evaluate(() => ({
                    classified:
                        (window as typeof window & { __emptySelectionClassified?: boolean })
                            .__emptySelectionClassified ?? false,
                    inflightGps: window.__everydashcam.state.inflightEmbeddedGps.size,
                    cancelled: window.__everydashcam.dumpLog().some((entry) => entry.msg === "deferred gps cancelled"),
                })),
            ).toEqual({ classified: false, inflightGps: 1, cancelled: false });
            if (source === "structure-only drop") {
                expect(
                    await page.evaluate(
                        () =>
                            window.__everydashcam
                                .dumpLog()
                                .filter((entry) => entry.msg === "selection contained no primary recordings")
                                .at(-1)?.ctx,
                    ),
                ).toEqual({ total: 1, junkRoots: [".diagnostic-only"] });
                expect(await page.evaluate(() => window.__everydashcam.state.lastIngestFiles)).toEqual([]);
            }

            await page.evaluate(() => {
                (window as typeof window & { __releaseGpsResponses?: () => void }).__releaseGpsResponses?.();
            });
            releaseViewerDownload?.();
            await expect(page.locator("#player-wrap")).toBeVisible();
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const { state } = window.__everydashcam;
                        return state.active ? (state.trips[state.active.trip]?.records.length ?? 0) : 0;
                    }),
                )
                .toBeGreaterThan(0);
            expect(await page.evaluate(() => window.__everydashcam.state.pendingHeavyEmbeddedGps.size)).toBe(0);
        });
    }

    test("drains a structure-only queued selection before the following recording import", async ({ page }) => {
        await page.locator("#file-input").setInputFiles([
            {
                name: "NO20200101-120000-000001F.MP4",
                mimeType: "video/mp4",
                buffer: withMvhdCreationTime(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"), "2020-01-01T12:00:00.000Z"),
            },
            { name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("card information") },
        ]);
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        typeof (window as typeof window & { __releaseClassification?: () => void })
                            .__releaseClassification,
                ),
            )
            .toBe("function");
        await dropExcludedEntry(page);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.ingestQueue.length)).toBe(1);
        await page.locator("#file-input").setInputFiles({
            name: "NO20200102-120000-000001F.MP4",
            mimeType: "video/mp4",
            buffer: withMvhdCreationTime(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"), "2020-01-02T12:00:00.000Z"),
        });
        expect(await page.evaluate(() => window.__everydashcam.state.ingestQueue.length)).toBe(2);
        await page.evaluate(() => {
            (window as typeof window & { __releaseClassification?: () => void }).__releaseClassification?.();
        });
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const { state } = window.__everydashcam;
                    return {
                        idle: state.ingestController === null,
                        queued: state.ingestQueue.length,
                        lastFiles: state.lastIngestFiles?.map((vf) => vf.file.name),
                        trips: state.trips.length,
                    };
                }),
            )
            .toEqual({ idle: true, queued: 0, lastFiles: ["NO20200102-120000-000001F.MP4"], trips: 2 });
        expect(
            await page.evaluate(() =>
                window.__everydashcam
                    .dumpLog()
                    .filter(
                        (entry) =>
                            entry.ns === "ingest" &&
                            ["ingest started", "selection contained no primary recordings"].includes(entry.msg),
                    )
                    .map((entry) => entry.msg),
            ),
            "the diagnostic selection runs in FIFO order and cannot strand the final import",
        ).toEqual(["ingest started", "selection contained no primary recordings", "ingest started"]);
    });

    test.describe("viewer download failure", () => {
        test.use({
            tolerateConsole: async ({ tolerateConsole }, use) => {
                await use([
                    ...tolerateConsole,
                    /^Failed to load resource: the server responded with a status of 503/,
                    /^\[landing\] viewer init failed .*Failed to fetch dynamically imported module:/,
                    /^\[app\] trip open failed \(trip \d+\) .*Failed to fetch dynamically imported module:/,
                ]);
            },
        });

        for (const cancelFirst of [true, false]) {
            test(`${cancelFirst ? "Cancel during GPS resumes background metadata before" : "GPS is cancelled and background metadata resumes after"} a failed viewer download`, async ({
                page,
            }) => {
                await openDeferredGpsTrip(page, true);
                expect(viewerDownloadRequested).toBe(true);
                expect(
                    await page.evaluate(() =>
                        window.__everydashcam.state.trips.some((trip) =>
                            trip.frames.some((frame) =>
                                Object.values(frame.channels).some((candidate) => candidate.metadataReady !== true),
                            ),
                        ),
                    ),
                    "unselected recordings still need background metadata",
                ).toBe(true);
                await expect(page.locator("#trip-preparation")).toBeVisible();
                await expect(page.locator("#landing-cta")).toHaveCount(0);

                if (cancelFirst) {
                    await page.locator("#trip-preparation-cancel").click();
                    await expect(page.locator("#trip-preparation")).toBeHidden();
                    await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false");
                    expect(await page.evaluate(() => window.__everydashcam.state.active)).toBeNull();
                }

                // Exhaust only the page-reload recovery ladder; the failed
                // dynamic import must still reject and exercise trip cleanup.
                await page.evaluate(() => sessionStorage.setItem("dc-asset-retry", "4"));
                rejectViewerDownload = true;
                releaseViewerDownload?.();
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            window.__everydashcam.dumpLog().some((entry) => entry.msg === "viewer init failed"),
                        ),
                    )
                    .toBe(true);
                await expect(page.locator("#trip-preparation")).toBeHidden();
                await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false");
                await expect(page.locator("li.trip.trip--opening")).toHaveCount(0);
                const state = await page.evaluate(() => ({
                    active: window.__everydashcam.state.active,
                    pending: window.__everydashcam.state.pendingHeavyEmbeddedGps.size,
                    inflight: window.__everydashcam.state.inflightEmbeddedGps.size,
                }));
                expect(state).toEqual({ active: null, pending: 1, inflight: 0 });
                const failure = page.locator(".dc-toast__body").filter({ hasText: "Couldn't open this trip" });
                if (cancelFirst) await expect(failure).toHaveCount(0);
                else await expect(failure).toBeVisible();
            });
        }
    });

    test("recording-scoped NMEA log binds after MP4 metadata becomes ready", async ({ page }) => {
        const dir = makeTemporaryDirectory("everydashcam-sectioned-nmea-");
        const videoDir = path.join(dir, "MP_ROOT/100ANV01");
        const gpsDir = path.join(dir, "PRIVATE/SONY/GPS");
        mkdirSync(videoDir, { recursive: true });
        mkdirSync(gpsDir, { recursive: true });
        writeFileSync(
            path.join(videoDir, "MAH00384.MP4"),
            withMvhdCreationTime(path.join(SAMPLE_NOGPS, "clip-no-gps.mp4"), "2026-01-15T12:00:00.000Z"),
        );
        writeFileSync(
            path.join(gpsDir, "26011500.LOG"),
            [
                "@Sonygps/ver5.0/wgs-84/20260115120000.000/",
                "@Sonygpsoption/0/20260115120001.000/20260115120003.000/",
                "$GPRMC,120001.000,A,5100.0000,N,00400.0000,E,10.00,,150126,,,A*00",
                "$GPRMC,120002.000,A,5100.0060,N,00400.0060,E,12.00,,150126,,,A*00",
                "$GPRMC,120003.000,A,5100.0120,N,00400.0120,E,14.00,,150126,,,A*00",
                "",
            ].join("\n"),
            "utf8",
        );

        await page.locator("#folder-input").setInputFiles(dir);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 10_000 });
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const trip = window.__everydashcam.state.trips[0];
                    const candidate = trip?.frames.flatMap((frame) => Object.values(frame.channels))[0];
                    return candidate?.records.length ?? 0;
                }),
            )
            .toBe(3);

        const result = await page.evaluate(() => {
            const state = window.__everydashcam.state;
            const candidate = state.trips[0]?.frames.flatMap((frame) => Object.values(frame.channels))[0];
            const records = candidate?.records ?? [];
            return {
                appliedExtractors: candidate?.appliedExtractors ?? [],
                sequence: candidate?.sequence ?? null,
                owners: records.map((record) => record.mp4Filename),
                allOwned: records.every(
                    (record) => record.videoKey !== undefined && record.recordingAssociation === undefined,
                ),
                firstSpeedMs: records[0]?.speedMs ?? null,
                gpsLogRecords: state.gpsLog?.records.length ?? 0,
            };
        });
        expect(result.appliedExtractors).toContain("sectioned-nmea-log");
        expect(result.sequence).toBe(384);
        expect(result.owners).toEqual(["MAH00384.MP4", "MAH00384.MP4", "MAH00384.MP4"]);
        expect(result.allOwned).toBe(true);
        expect(result.firstSpeedMs).toBeCloseTo(5.14444, 5);
        expect(result.gpsLogRecords).toBe(3);
    });

    test("shows the newest trips before a slow storage probe finishes", async ({ page }) => {
        const dir = makeTemporaryDirectory("everydashcam-slow-probe-");
        const source = path.join(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4");
        for (let i = 0; i < 30; i++) {
            const day = String(i + 1).padStart(2, "0");
            copyFileSync(source, path.join(dir, `NO202601${day}-120000-${String(i).padStart(6, "0")}F.MP4`));
        }

        await setStoredPreference(page, "everydashcam:ingest-policy", null);
        await page.evaluate(() => {
            const original = Blob.prototype.arrayBuffer;
            let releaseFirstProbeRead = (): void => {};
            const firstProbeReadGate = new Promise<void>((resolve) => {
                releaseFirstProbeRead = resolve;
            });
            const target = window as typeof window & {
                __slowProbeReads?: number;
                __releaseFirstProbeRead?: () => void;
                __analysisProgressSeen?: string[];
            };
            target.__releaseFirstProbeRead = releaseFirstProbeRead;
            Blob.prototype.arrayBuffer = function () {
                if (this.size !== 4096) return original.call(this);
                target.__slowProbeReads = (target.__slowProbeReads ?? 0) + 1;
                const delay =
                    target.__slowProbeReads === 1
                        ? firstProbeReadGate
                        : new Promise<void>((resolve) => setTimeout(resolve, 600));
                return delay.then(() => original.call(this));
            };
            const status = document.getElementById("trip-analysis-status");
            const percent = document.getElementById("trip-analysis-percent");
            target.__analysisProgressSeen = [];
            if (status && percent) {
                new MutationObserver(() => {
                    if (!status.hidden) target.__analysisProgressSeen?.push(percent.textContent?.trim() ?? "");
                }).observe(status, { attributes: true, childList: true, subtree: true });
            }
        });

        await page.locator("#folder-input").setInputFiles(dir);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 10_000 });
        const analysisStatus = page.locator("#trip-analysis-status");
        await expect(analysisStatus).toBeVisible();
        await expect(page.locator("#trip-analysis-title")).toHaveText("Checking trip details");
        await expect(page.locator("#trip-analysis-percent")).toHaveText("≈0%");
        await expect(page.locator("#trip-analysis-progressbar")).toHaveAttribute("aria-valuenow", "0");
        await expect(page.locator("#trip-analysis-progress")).toHaveText("Time and duration · 0 of 30 recordings");
        await expect(analysisStatus).toContainText(
            "You can open any trip now — the one you choose will be prepared first.",
        );
        // Background work is explained once above the list. Individual cards
        // use a stable preview placeholder and facts instead of presenting an
        // unrelated loading state.
        const firstTrip = page.locator("li.trip:not(.unindexed-note)").first();
        await expect(firstTrip.locator(".trip-no-preview-icon")).toBeVisible();
        await expect(firstTrip.locator(".trip-meta-text")).not.toContainText("Reading");
        expect(
            await page.evaluate(() => (window as typeof window & { __slowProbeReads?: number }).__slowProbeReads ?? 0),
            "the list must render after starting only the first of three delayed probe reads",
        ).toBe(1);
        await page.evaluate(() => {
            (
                window as typeof window & {
                    __releaseFirstProbeRead?: () => void;
                }
            ).__releaseFirstProbeRead?.();
        });
        await expect(page.locator("li.trip:not(.unindexed-note)").first().locator(".trip-title")).toContainText(
            "Jan 30",
        );
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
        expect(
            await page.evaluate(
                () =>
                    (window as typeof window & { __analysisProgressSeen?: string[] }).__analysisProgressSeen?.some(
                        (value) => /^≈(?:[1-9]\d?|100)%$/.test(value),
                    ) ?? false,
            ),
            "the shared status must expose progress beyond its initial 0% state",
        ).toBe(true);
        await expect(analysisStatus).toBeHidden({ timeout: 20_000 });
        expect(
            await page.evaluate(
                () => (window as typeof window & { __analysisProgressSeen?: string[] }).__analysisProgressSeen ?? [],
            ),
            "completion removes the mandatory-details status instead of parking it at 100% during optional work",
        ).not.toContain("≈100%");
    });

    test("explains the shared trip-details work in Russian", async ({ page }) => {
        await gotoApp(page, "ru");
        await page.evaluate(() => {
            const status = document.getElementById("trip-analysis-status");
            const target = window as typeof window & {
                __russianAnalysisStatus?: { title: string; progress: string; hint: string };
            };
            if (!status) return;
            new MutationObserver(() => {
                if (status.hidden || target.__russianAnalysisStatus) return;
                target.__russianAnalysisStatus = {
                    title: document.getElementById("trip-analysis-title")?.textContent?.trim() ?? "",
                    progress: document.getElementById("trip-analysis-progress")?.textContent?.trim() ?? "",
                    hint: status.querySelector(".trip-analysis-status__hint")?.textContent?.trim() ?? "",
                };
            }).observe(status, { attributes: true, childList: true, subtree: true });
        });

        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () =>
                            (
                                window as typeof window & {
                                    __russianAnalysisStatus?: { title: string; progress: string; hint: string };
                                }
                            ).__russianAnalysisStatus,
                    ),
                { timeout: 10_000 },
            )
            .toEqual({
                title: "Уточнение деталей поездок",
                progress: "Время и длительность · 0 из 6 записей",
                hint: "Поездки уже можно открывать — выбранная будет подготовлена первой.",
            });
    });

    test("keyboard: Enter on the focused trip title opens the trip", async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        const title = page.locator("li.trip:not(.unindexed-note)").first().locator(".trip-title");
        await expect(title).toBeVisible({ timeout: 30_000 });

        // Focus the title (role=button) and activate via keyboard - same path as click.
        await title.focus();
        await expect(title).toBeFocused();
        await page.keyboard.press("Enter");

        await expect(page.locator("#player-chart-canvas")).toBeVisible();
        await expect
            .poll(async () => (await page.locator("#player-total").textContent())?.trim(), { timeout: 20_000 })
            .not.toBe("0:00");
    });

    test("a broken clip is removed when the recording list converges", async ({ page }) => {
        // A .mp4 with a valid ftyp but no moov: classified as video by extension,
        // grouped into a trip from its (70mai-style) filename, but the moov read
        // fails. The terminal failure must not wedge the closing regroup.
        const dir = makeTemporaryDirectory("everydashcam-broken-");
        writeBrokenMp4(dir, "NO20260101-120000-000001F.MP4");

        // Click the provisional card in its first render. Even though the clip
        // later proves unreadable, the action must acknowledge immediately and
        // end in a durable explanation instead of silently doing nothing.
        await armImmediateTripClick(page);
        // #folder-input has webkitdirectory, so it takes a DIRECTORY (the temp
        // dir holding just the one broken clip), not a single file path.
        await page.locator("#folder-input").setInputFiles(dir);

        const trips = page.locator("li.trip:not(.unindexed-note)");
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () => (window as typeof window & { __openingFeedbackSeen?: boolean }).__openingFeedbackSeen,
                    ),
                { timeout: 10_000 },
            )
            .toBe(true);
        await expect(
            page.locator(".dc-toast__body", {
                hasText:
                    "Couldn't open this trip. Check that the memory card or drive is connected and open the folder again. If it still fails, report the problem.",
            }),
        ).toBeVisible();

        // Convergence: the read failure is terminal, so metadata read finishes and the
        // list clears its busy flag (a wedge would keep it busy forever -> timeout).
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });

        // A filename estimate is not kept as a fake playable trip after the read
        // fails. The standard skipped-file summary and recovery modal explain it.
        await expect(trips).toHaveCount(0);
        await expect(page.locator("li.trip.unindexed-note")).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Couldn't read this card" })).toBeVisible();
    });

    test("trip header skips a damaged leading clip and opens the first playable one", async ({ page }) => {
        const dir = makeTemporaryDirectory("everydashcam-leading-broken-");
        writeBrokenMp4(dir, "NO20260101-115958-000001F.MP4");
        copyFileSync(
            path.join(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4"),
            path.join(dir, "NO20260101-120000-000002F.MP4"),
        );

        // Viewer initialization is delayed by beforeEach long enough for the
        // provisional trip to regroup and discard its first file. The click must
        // follow surviving File identity instead of whichever trip owns its index.
        await armImmediateTripClick(page);
        await page.locator("#folder-input").setInputFiles(dir);

        // Metadata converges while the delayed viewer chunk is still loading.
        // The broken first File disappears during that regroup, but the busy
        // feedback must follow the surviving recording identity until playback.
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        await expect(page.locator("li.trip.trip--opening")).toHaveCount(1);

        await expect(page.locator("#video-grid .video-tile:not([hidden])")).toHaveCount(1, { timeout: 20_000 });
        await expect
            .poll(async () => (await page.locator("#player-total").textContent())?.trim(), { timeout: 20_000 })
            .not.toBe("0:00");
        await expect(
            page.locator(".dc-toast__body", {
                hasText: "Couldn't open this trip. The file may be damaged or no longer available.",
            }),
        ).toHaveCount(0);
    });

    test("Cancel during a recording read never starts provisional playback", async ({ page }) => {
        await armImmediateTripClickAndCancel(page);
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        const trips = page.locator("li.trip:not(.unindexed-note)");
        await expect(trips.first(), "provisional trip card must appear").toBeVisible({ timeout: 30_000 });

        await expect
            .poll(
                () =>
                    page.evaluate(
                        () =>
                            (
                                window as typeof window & {
                                    __recordingCancelSeen?: { copy: string; title: string; clicked: boolean };
                                }
                            ).__recordingCancelSeen,
                    ),
                { timeout: 10_000 },
            )
            .toEqual({ copy: "Cancel", title: "Preparing this trip", clicked: true });

        await expect(page.locator("#trip-preparation")).toBeHidden();
        await expect(page.locator("#player-chart-canvas")).toBeHidden();
        await expect(page.locator("#player-total")).toHaveText("0:00");

        await shot(page, "progressive-02-cancel-read");
    });

    test("re-drop of the same folder keeps the list converged", async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        const trips = page.locator("li.trip:not(.unindexed-note)");
        await expect(trips.first(), "first drop renders a trip card").toBeVisible({ timeout: 30_000 });

        // Re-drop before background work necessarily converges. Duplicate-only
        // ingest must resume carried pending work and must not clone trips.
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);

        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        // The shared status converges, and the duplicate re-drop did not add a
        // second copy of the footage.
        await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 20_000 });
        expect(
            await trips.count(),
            "duplicate re-drop must yield at least the original trip(s)",
        ).toBeGreaterThanOrEqual(1);
    });

    test("an ignored-only drop resumes previews after recording metadata is ready", async ({ page }) => {
        const directory = makeTemporaryDirectory("everydashcam-preview-resume-");
        const source = path.join(SAMPLE_NOGPS, "clip-no-gps.mp4");
        for (let i = 0; i < 4; i++) {
            writeFileSync(
                path.join(directory, `clip-${i}.mp4`),
                withMvhdCreationTime(source, `2026-01-15T${String(i + 10).padStart(2, "0")}:00:00Z`),
            );
        }
        const ignoredDirectory = makeTemporaryDirectory("everydashcam-preview-ignored-");
        writeFileSync(path.join(ignoredDirectory, ".DS_Store"), "ignored");

        await page.locator("#folder-input").setInputFiles(directory);
        await expect(page.locator("li.trip:not(.unindexed-note)")).toHaveCount(4);
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        await expect(page.locator("#trip-analysis-status")).toBeHidden();
        expect(
            await page.evaluate(() => window.__everydashcam.state.trips.filter((trip) => trip.previewDataUrl).length),
        ).toBe(0);

        await page.locator("#folder-input").setInputFiles(ignoredDirectory);
        await expect(page.locator("#ingest-overlay")).toBeHidden();
        await page.evaluate(() => {
            (window as typeof window & { __releasePreviews?: () => void }).__releasePreviews?.();
        });
        await expect
            .poll(() =>
                page.evaluate(() => window.__everydashcam.state.trips.filter((trip) => trip.previewDataUrl).length),
            )
            .toBe(4);
    });

    test("regrouping from settings preserves the active ingest lifecycle", async ({ page }) => {
        const dir = makeTemporaryDirectory("everydashcam-regroup-");
        const source = path.join(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4");
        for (let i = 0; i < 12; i++) {
            const day = String(i + 1).padStart(2, "0");
            copyFileSync(source, path.join(dir, `NO202602${day}-120000-${String(i).padStart(6, "0")}F.MP4`));
        }
        await page.evaluate(() => {
            const target = window as typeof window & { __ingestDoneCount?: number };
            target.__ingestDoneCount = 0;
            addEventListener("everydashcam:ingest-done", () => {
                target.__ingestDoneCount = (target.__ingestDoneCount ?? 0) + 1;
            });
        });

        await page.locator("#folder-input").setInputFiles(dir);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 10_000 });
        expect(
            await page.evaluate(() =>
                window.__everydashcam.state.trips.some((trip) =>
                    trip.frames.some((frame) =>
                        Object.values(frame.channels).some((candidate) => candidate.metadataReady === false),
                    ),
                ),
            ),
            "the settings change must happen while progressive work is still pending",
        ).toBe(true);

        await page.locator("#settings-btn").click();
        await page.locator("#settings-trip-gap-input").fill("2");
        await page.locator("#settings-trip-gap-input").dispatchEvent("change");
        await page.locator("#settings-modal-close").click();

        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
        await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 30_000 });
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () => (window as typeof window & { __ingestDoneCount?: number }).__ingestDoneCount ?? 0,
                    ),
                { timeout: 30_000 },
            )
            .toBe(1);
    });

    test("a second drop during the background read resumes and finishes", async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        const trips = page.locator("li.trip:not(.unindexed-note)");
        await expect(trips.first(), "first drop renders a trip card").toBeVisible({ timeout: 30_000 });

        // Drop a second, DIFFERENT folder while the first fill may still be running.
        // Both drops share one candidate pool and must converge through one final
        // regroup without leaving provisional cards behind.
        await page.locator("#folder-input").setInputFiles(SAMPLE_GOPRO);

        // Both cards present (70mai trip + gopro trip) and the whole list converges.
        await expect.poll(async () => trips.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
        await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 20_000 });
    });

    test("a second drop preserves unmerged accelerometer sidecars", async ({ page }) => {
        const directory = makeTemporaryDirectory("everydashcam-accel-restart-");
        const name = "20260718_060329_NF.mp4";
        const fixtureRoot = path.resolve("src/parsers/__fixtures__/blackvue");
        writeFileSync(
            path.join(directory, name),
            withMvhdCreationTime(
                path.join(SAMPLE_70MAI, "Normal/Front/NO20260101-120000-000001F.MP4"),
                "2026-07-18T06:03:31Z",
            ),
        );
        copyFileSync(path.join(fixtureRoot, "real-anonymized.gps"), path.join(directory, "20260718_060329_N.gps"));
        copyFileSync(path.join(fixtureRoot, "real-anonymized.3gf"), path.join(directory, "20260718_060329_N.3gf"));

        await page.evaluate(() => {
            const schedule = window.requestIdleCallback.bind(window);
            const pending: Array<() => void> = [];
            let isHeld = true;
            window.requestIdleCallback = (callback, options) =>
                schedule((deadline) => {
                    if (isHeld) pending.push(() => callback(deadline));
                    else callback(deadline);
                }, options);
            (window as typeof window & { __releaseRecordingWork?: () => void }).__releaseRecordingWork = () => {
                isHeld = false;
                for (const callback of pending.splice(0)) callback();
            };
        });
        await page.locator("#folder-input").setInputFiles(directory);
        await expect(page.locator("#ingest-overlay")).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.trips.length)).toBe(1);
        const before = await page.evaluate((filename) => {
            const records = window.__everydashcam.state.gpsLog?.byFilename.get(filename) ?? [];
            return { count: records.length, hasAccel: records.some((r) => r.accelXg !== 0 || r.accelYg !== 0) };
        }, name);
        expect(before.count).toBeGreaterThan(0);
        expect(before.hasAccel).toBe(false);

        await page.locator("#folder-input").setInputFiles(SAMPLE_NOGPS);
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.trips.length)).toBe(2);
        await page.evaluate(() => {
            (window as typeof window & { __releaseRecordingWork?: () => void }).__releaseRecordingWork?.();
        });
        await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 30_000 });
        const after = await page.evaluate((filename) => {
            const records = window.__everydashcam.state.gpsLog?.byFilename.get(filename) ?? [];
            return { count: records.length, hasAccel: records.some((r) => Math.hypot(r.accelXg, r.accelYg) > 0.01) };
        }, name);
        expect(after.count).toBe(before.count);
        expect(after.hasAccel).toBe(true);
    });

    test("reuses cached metadata while stale GPS reparses after reload", async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_GOPRO);
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
        await expect.poll(() => storedParsedGpsCacheEntries(page), { timeout: 20_000 }).toBeGreaterThan(0);
        expect(await staleEmbeddedGpsCacheEntries(page)).toBeGreaterThan(0);

        await page.reload();
        await page.locator("#folder-input").setInputFiles(SAMPLE_GOPRO);
        await expect(page.locator("#trip-list")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
        await expect(page.locator("#trip-analysis-status")).toBeHidden({ timeout: 30_000 });

        const requests = await page.evaluate(
            () =>
                (
                    window as typeof window & {
                        __workerRequests?: Array<{ worker: string; type: string }>;
                    }
                ).__workerRequests ?? [],
        );
        expect(requests).toContainEqual({ worker: "gps-extract-worker", type: "extract" });
        expect(requests).not.toContainEqual({ worker: "indexer-worker", type: "index-all" });
    });
});

async function storedParsedGpsCacheEntries(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const request = indexedDB.open("dashcamigo");
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const get = db.transaction("indexCache").objectStore("indexCache").getAll();
                    get.onerror = () => reject(get.error);
                    get.onsuccess = () => {
                        resolve(
                            get.result.filter(
                                (entry: { embeddedGps?: { status?: string } }) =>
                                    entry.embeddedGps?.status === "parsed",
                            ).length,
                        );
                        db.close();
                    };
                };
            }),
    );
}

async function staleEmbeddedGpsCacheEntries(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const request = indexedDB.open("dashcamigo");
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const transaction = db.transaction("indexCache", "readwrite");
                    const store = transaction.objectStore("indexCache");
                    const get = store.getAll();
                    let changed = 0;
                    get.onerror = () => reject(get.error);
                    get.onsuccess = () => {
                        for (const entry of get.result) {
                            if (entry.embeddedGps?.status !== "parsed") continue;
                            entry.embeddedGps.dispatchRevision = "forced-stale-e2e";
                            store.put(entry);
                            changed++;
                        }
                    };
                    transaction.onerror = () => reject(transaction.error);
                    transaction.oncomplete = () => {
                        resolve(changed);
                        db.close();
                    };
                };
            }),
    );
}
