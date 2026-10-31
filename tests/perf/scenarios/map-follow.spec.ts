// Steady playback with an offline basemap. Keep mode, browser and viewport
// fixed when comparing runs; sampling profiles add overhead to CPU totals.
// External requests stay blocked because the input recordings are private.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { presetLocalStorage } from "../../e2e/_fixtures.js";
import { startCpuProfile, type CpuProfileRecording } from "../harness/cpu-profile.js";
import { parseEnvInt } from "../harness/env.js";
import { deliverFiles } from "../harness/files.js";
import type { PerfAnnotationPayload } from "../harness/json-reporter.js";
import { readCdpMetrics, readCdpProcesses, type CdpProcessSnapshot } from "../harness/measure.js";
import { setupPage } from "../harness/setup.js";
import { discoverVendors } from "../harness/vendors.js";

const SETTLE_MS = parseEnvInt("PERF_FOLLOW_SETTLE_MS", 3000);
const MEASURE_MS = parseEnvInt("PERF_FOLLOW_MEASURE_MS", 15000);
const MODE = process.env.PERF_FOLLOW_MODE ?? "chase";
const SHOULD_PROFILE = process.env.PERF_CPU_PROFILE === "1";
const VIEWPORT = { width: 1440, height: 900 };
const BASE_URL = "http://localhost:4173/";
const RESULTS_DIR = fileURLToPath(new URL("../../../private/perf-results/", import.meta.url));

if (!["mini", "chase", "follow", "off", "hidden"].includes(MODE)) {
    throw new Error("invalid PERF_FOLLOW_MODE: expected mini, chase, follow, off or hidden");
}

interface VideoSample {
    video: HTMLVideoElement;
    channel: string;
    src: string;
    currentSrc: string;
    currentTime: number;
    playbackRate: number;
    quality: VideoPlaybackQuality | null;
    onInterrupt: (event: Event) => void;
}

interface VideoWindowResult {
    channel: string;
    width: number;
    height: number;
    playbackRate: number;
    currentTimeDeltaSec: number;
    totalFrames: number | null;
    droppedFrames: number | null;
}

interface FollowCollector {
    renders: number;
    rafCount: number;
    frameDeltas: number[];
    loafCount: number;
    loafTotalMs: number;
    loafSupported: boolean;
    startMs: number;
    activeTrip: number | undefined;
    activeFrame: number | undefined;
    master: HTMLVideoElement;
    videos: VideoSample[];
    interruptionEvents: string[];
    invalidReasons: Set<string>;
    rafId: number;
    onRender: () => void;
    po: PerformanceObserver | null;
    map: { on: (type: string, handler: () => void) => void; off: (type: string, handler: () => void) => void } | null;
}

interface FollowCollectorResult {
    renders: number;
    rafCount: number;
    frameP50Ms: number;
    frameP95Ms: number;
    frameMaxMs: number;
    loafCount: number;
    loafTotalMs: number;
    loafSupported: boolean;
    windowMs: number;
    invalidReasons: string[];
    videos: VideoWindowResult[];
}

type CollectorWindow = Window & { __followCollector?: FollowCollector };

const vendors = discoverVendors();

if (vendors.length === 0) {
    test.skip(true, "no vendor samples in private/samples - skipping map-follow suite");
}

for (const vendor of vendors) {
    test(`map follow: ${vendor.name} (${MODE}, offline)`, async ({ browser }, testInfo) => {
        const mbTotal = Math.ceil(vendor.totalBytes / (1024 * 1024));
        const ingestBudgetMs = 60_000 + mbTotal * 250;
        test.setTimeout(ingestBudgetMs + SETTLE_MS + MEASURE_MS + 60_000);
        const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
        let recording: CpuProfileRecording | null = null;
        try {
            const page = await ctx.newPage();
            await presetLocalStorage(page);
            await page.addInitScript(() => {
                localStorage.setItem("everydashcam:mapProvider", "openfreemap");
                localStorage.setItem(
                    "everydashcam:mapView",
                    JSON.stringify({ style: "classic", theme: "dark", buildings3d: true }),
                );
            });
            await setupPage(page, BASE_URL);
            await deliverFiles(page, vendor.absPath);
            await page.waitForFunction(
                () => {
                    const w = window as unknown as {
                        __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                    };
                    return !!w.__everydashcamPerf?.lifecycleEvents?.some((e) => e.type === "everydashcam:ingest-done");
                },
                undefined,
                { timeout: ingestBudgetMs, polling: 100 },
            );

            if (await page.evaluate(() => window.__everydashcam.state.trips.length === 0)) {
                test.skip(true, `vendor ${vendor.name} has no trips`);
                return;
            }
            await page.locator('li.trip[data-trip-index="0"] .trip-header').click();
            await page.waitForFunction(
                () => {
                    const w = window as unknown as {
                        __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                    };
                    const seen = new Set((w.__everydashcamPerf?.lifecycleEvents ?? []).map((e) => e.type));
                    return (
                        (seen.has("everydashcam:player-first-frame") || seen.has("everydashcam:player-failed")) &&
                        seen.has("everydashcam:map-tracks-rendered")
                    );
                },
                undefined,
                { timeout: 15_000, polling: 100 },
            );
            const activation = await page.evaluate(() => {
                const w = window as unknown as {
                    __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                };
                return {
                    failed: w.__everydashcamPerf?.lifecycleEvents?.some((e) => e.type === "everydashcam:player-failed"),
                    hasTrack: window.__everydashcam.state.hasTrack,
                    mapless: document.body.classList.contains("map-unavailable"),
                };
            });
            if (activation.failed || !activation.hasTrack || activation.mapless) {
                test.skip(true, `vendor ${vendor.name}: playback or GPS map unavailable`);
                return;
            }

            if (MODE === "hidden") {
                await page.locator('[data-map-mode="off"]').evaluate((button: HTMLButtonElement) => button.click());
            } else if (MODE !== "mini") {
                await page.locator(".mini-map").click();
                await page.locator(`.map-follow-seg[data-follow-mode="${MODE}"]`).click();
            }
            await page.evaluate(() => {
                const player = window.__everydashcam.dom.player;
                player.muted = true;
                return player.play();
            });
            await page.waitForTimeout(SETTLE_MS);

            const metadata = {
                vendor: vendor.name,
                mode: MODE,
                browser: browser.browserType().name(),
                browserVersion: browser.version(),
                viewport: VIEWPORT,
                deviceScaleFactor: 1,
                profileEnabled: SHOULD_PROFILE,
                settleMs: SETTLE_MS,
                requestedWindowMs: MEASURE_MS,
                network: "external requests blocked; service workers disabled",
                mapLoad: "local style and GPS geometry only; external basemap tiles unavailable",
                map: await page.evaluate((mode) => {
                    const { state } = window.__everydashcam;
                    const map = mode === "mini" ? state.miniMap : state.map;
                    return {
                        preferredProvider: localStorage.getItem("everydashcam:mapProvider"),
                        preferences: JSON.parse(localStorage.getItem("everydashcam:mapView") ?? "null") as unknown,
                        styleName: map?.getStyle()?.name ?? null,
                        styleLoaded: map?.isStyleLoaded() ?? false,
                        loaded: map?.loaded() ?? false,
                        zoom: map?.getZoom() ?? null,
                        pitch: map?.getPitch() ?? null,
                        followMode: state.followMode,
                        expanded: state.mapExpanded,
                    };
                }, MODE),
            };
            recording = SHOULD_PROFILE ? await startCpuProfile(page) : null;
            const cdpBefore = await readCdpMetrics(page);
            const procBefore = await readCdpProcesses(page);
            await page.evaluate((mode) => {
                const { state, dom } = window.__everydashcam;
                const map = mode === "hidden" ? null : mode === "mini" ? state.miniMap : state.map;
                const collector: FollowCollector = {
                    renders: 0,
                    rafCount: 0,
                    frameDeltas: [],
                    loafCount: 0,
                    loafTotalMs: 0,
                    loafSupported: PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"),
                    startMs: performance.now(),
                    activeTrip: state.active?.trip,
                    activeFrame: state.active?.frame,
                    master: dom.player,
                    videos: [],
                    interruptionEvents: ["pause", "waiting", "stalled", "ended", "emptied", "seeking", "ratechange"],
                    invalidReasons: new Set(),
                    rafId: 0,
                    po: null,
                    map,
                    onRender: () => {
                        collector.renders++;
                    },
                };
                const videos = [
                    ...document.querySelectorAll<HTMLVideoElement>(
                        ".video-tile:not([hidden]) video:not(.preload-slot):not(.tile-blur-bg)",
                    ),
                ].filter((video) => video.getClientRects().length > 0 && !!video.currentSrc);
                for (const [index, video] of videos.entries()) {
                    const channel = video.closest<HTMLElement>(".video-tile")?.dataset.channel ?? `video-${index}`;
                    const onInterrupt = (event: Event): void => {
                        collector.invalidReasons.add(`${channel}: ${event.type} during sample`);
                    };
                    for (const event of collector.interruptionEvents) video.addEventListener(event, onInterrupt);
                    if (
                        video.paused ||
                        video.ended ||
                        video.seeking ||
                        video.readyState < 2 ||
                        video.playbackRate <= 0
                    ) {
                        collector.invalidReasons.add(`${channel}: not playing at sample start`);
                    }
                    collector.videos.push({
                        video,
                        channel,
                        src: video.src,
                        currentSrc: video.currentSrc,
                        currentTime: video.currentTime,
                        playbackRate: video.playbackRate,
                        quality:
                            typeof video.getVideoPlaybackQuality === "function"
                                ? video.getVideoPlaybackQuality()
                                : null,
                        onInterrupt,
                    });
                }
                if (videos.length === 0 || !videos.includes(dom.player))
                    collector.invalidReasons.add("active video unavailable");
                map?.on("render", collector.onRender);
                let last = performance.now();
                const loop = (now: number): void => {
                    collector.rafCount++;
                    collector.frameDeltas.push(now - last);
                    last = now;
                    if (
                        state.active?.trip !== collector.activeTrip ||
                        state.active?.frame !== collector.activeFrame ||
                        dom.player !== collector.master
                    )
                        collector.invalidReasons.add("active frame or master changed");
                    for (const sample of collector.videos) {
                        if (sample.video.src !== sample.src || sample.video.currentSrc !== sample.currentSrc) {
                            collector.invalidReasons.add(`${sample.channel}: source changed`);
                        }
                    }
                    collector.rafId = requestAnimationFrame(loop);
                };
                collector.rafId = requestAnimationFrame(loop);
                if (collector.loafSupported) {
                    collector.po = new PerformanceObserver((list) => {
                        for (const entry of list.getEntries()) {
                            collector.loafCount++;
                            collector.loafTotalMs += entry.duration;
                        }
                    });
                    collector.po.observe({ type: "long-animation-frame" });
                }
                (window as CollectorWindow).__followCollector = collector;
            }, MODE);
            await page.waitForTimeout(MEASURE_MS);
            const collected = await page.evaluate((): FollowCollectorResult => {
                const w = window as CollectorWindow;
                const c = w.__followCollector;
                if (!c) throw new Error("playback collector unavailable");
                cancelAnimationFrame(c.rafId);
                c.map?.off("render", c.onRender);
                for (const entry of c.po?.takeRecords() ?? []) {
                    c.loafCount++;
                    c.loafTotalMs += entry.duration;
                }
                c.po?.disconnect();
                const windowMs = performance.now() - c.startMs;
                const { state, dom } = window.__everydashcam;
                if (
                    state.active?.trip !== c.activeTrip ||
                    state.active?.frame !== c.activeFrame ||
                    dom.player !== c.master
                ) {
                    c.invalidReasons.add("active frame or master changed");
                }
                const videos = c.videos.map((sample): VideoWindowResult => {
                    const { video, channel } = sample;
                    for (const event of c.interruptionEvents) video.removeEventListener(event, sample.onInterrupt);
                    if (video.paused || video.ended || video.seeking || video.readyState < 2) {
                        c.invalidReasons.add(`${channel}: not playing at sample end`);
                    }
                    if (
                        video.src !== sample.src ||
                        video.currentSrc !== sample.currentSrc ||
                        video.classList.contains("preload-slot")
                    ) {
                        c.invalidReasons.add(`${channel}: source or active slot changed`);
                    }
                    const elapsed = video.currentTime - sample.currentTime;
                    const expected = (windowMs / 1000) * sample.playbackRate;
                    if (elapsed <= 0 || Math.abs(elapsed - expected) > Math.max(0.25, expected * 0.1)) {
                        c.invalidReasons.add(`${channel}: playhead did not advance for the full sample`);
                    }
                    const quality =
                        typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
                    const totalFrames =
                        quality && sample.quality ? quality.totalVideoFrames - sample.quality.totalVideoFrames : null;
                    const droppedFrames =
                        quality && sample.quality
                            ? quality.droppedVideoFrames - sample.quality.droppedVideoFrames
                            : null;
                    if (totalFrames !== null && totalFrames <= 0) {
                        c.invalidReasons.add(`${channel}: video frame count did not advance`);
                    }
                    if (droppedFrames !== null && droppedFrames < 0) {
                        c.invalidReasons.add(`${channel}: video quality counters reset`);
                    }
                    return {
                        channel,
                        width: video.videoWidth,
                        height: video.videoHeight,
                        playbackRate: sample.playbackRate,
                        currentTimeDeltaSec: elapsed,
                        totalFrames,
                        droppedFrames,
                    };
                });
                const sorted = [...c.frameDeltas].sort((a, b) => a - b);
                const pick = (q: number): number =>
                    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
                delete w.__followCollector;
                return {
                    renders: c.renders,
                    rafCount: c.rafCount,
                    frameP50Ms: pick(0.5),
                    frameP95Ms: pick(0.95),
                    frameMaxMs: sorted[sorted.length - 1] ?? 0,
                    loafCount: c.loafCount,
                    loafTotalMs: c.loafTotalMs,
                    loafSupported: c.loafSupported,
                    windowMs,
                    invalidReasons: [...c.invalidReasons],
                    videos,
                };
            });
            const cdpAfter = await readCdpMetrics(page);
            const procAfter = await readCdpProcesses(page);
            const profileResult = await recording?.stop();
            recording = null;
            const processCpu = {
                renderer: processCpuDelta(procBefore, procAfter, "renderer"),
                gpu: processCpuDelta(procBefore, procAfter, "gpu"),
            };
            for (const [type, sample] of Object.entries(processCpu)) {
                if (sample.status === "turnover" || sample.status === "counter-reset") {
                    collected.invalidReasons.push(`${type}: process ${sample.status} during sample`);
                }
            }
            const rendererCpuMs = processCpu.renderer.cpuMs;
            const gpuCpuMs = processCpu.gpu.cpuMs;
            const windowSec = collected.windowMs / 1000;
            const detail = {
                ...metadata,
                ...collected,
                rendererCpuMs,
                gpuCpuMs,
                processCpu,
                scriptCpuMs: (cdpAfter.scriptDurationSec - cdpBefore.scriptDurationSec) * 1000,
                taskCpuMs: (cdpAfter.taskDurationSec - cdpBefore.taskDurationSec) * 1000,
                layoutCount: cdpAfter.layoutCount - cdpBefore.layoutCount,
                recalcStyleCount: cdpAfter.recalcStyleCount - cdpBefore.recalcStyleCount,
            };
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const stem = `playback-${vendor.name.replace(/[^a-zA-Z0-9_-]/g, "_")}-${MODE}-${stamp}`;
            await mkdir(RESULTS_DIR, { recursive: true });
            const summaryPath = resolve(RESULTS_DIR, `${stem}.summary.json`);
            await writeFile(
                summaryPath,
                JSON.stringify({ ...detail, cpuProfile: profileResult?.summary ?? null }, null, 2),
            );
            if (profileResult) {
                await writeFile(resolve(RESULTS_DIR, `${stem}.cpuprofile`), JSON.stringify(profileResult.profile));
            }
            await testInfo.attach("playback-summary", { path: summaryPath, contentType: "application/json" });
            expect(
                collected.invalidReasons,
                "steady playback sample is invalid; shorten the window or inspect the summary",
            ).toEqual([]);

            const prefix = `map-follow/${vendor.name}/${MODE}/offline/`;
            const windowTag = `${Math.round(collected.windowMs)}ms window; profile=${SHOULD_PROFILE}`;
            testInfo.annotations.push({
                type: "perf",
                description: JSON.stringify({
                    entries: [
                        ...Object.entries(processCpu).flatMap(([type, sample]) =>
                            sample.cpuMs === null
                                ? []
                                : [
                                      {
                                          name: `${prefix}${type}-cpu-ms`,
                                          value: round2(sample.cpuMs),
                                          unit: "ms",
                                          extra: windowTag,
                                      },
                                  ],
                        ),
                        {
                            name: `${prefix}script-cpu-ms`,
                            value: round2(detail.scriptCpuMs),
                            unit: "ms",
                            extra: windowTag,
                        },
                        { name: `${prefix}frame-p95-ms`, value: round2(collected.frameP95Ms), unit: "ms" },
                        {
                            name: `${prefix}long-frames-count`,
                            value: collected.loafCount,
                            unit: "count",
                            extra: windowTag,
                        },
                        {
                            name: `${prefix}long-frames-total-ms`,
                            value: round2(collected.loafTotalMs),
                            unit: "ms",
                            extra: windowTag,
                        },
                        {
                            name: `${prefix}map-renders-per-sec`,
                            value: round2(collected.renders / windowSec),
                            unit: "fps",
                        },
                        {
                            name: `${prefix}main-raf-per-sec`,
                            value: round2(collected.rafCount / windowSec),
                            unit: "fps",
                        },
                        ...collected.videos.flatMap((video) =>
                            video.totalFrames === null || video.droppedFrames === null
                                ? []
                                : [
                                      {
                                          name: `${prefix}${video.channel}/video-frames`,
                                          value: video.totalFrames,
                                          unit: "count",
                                          extra: windowTag,
                                      },
                                      {
                                          name: `${prefix}${video.channel}/dropped-frames`,
                                          value: video.droppedFrames,
                                          unit: "count",
                                          extra: windowTag,
                                      },
                                  ],
                        ),
                    ],
                    detail,
                } satisfies PerfAnnotationPayload),
            });
        } finally {
            try {
                await recording?.stop();
            } finally {
                await ctx.close();
            }
        }
    });
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function processCpuDelta(
    before: CdpProcessSnapshot[],
    after: CdpProcessSnapshot[],
    type: string,
): {
    cpuMs: number | null;
    beforeCount: number;
    afterCount: number;
    status: "available" | "unavailable" | "turnover" | "counter-reset";
} {
    const previous = before.filter((process) => process.type.toLowerCase() === type);
    const current = after.filter((process) => process.type.toLowerCase() === type);
    const counts = { beforeCount: previous.length, afterCount: current.length };
    if (before.length === 0 || after.length === 0 || (previous.length === 0 && current.length === 0)) {
        return { ...counts, cpuMs: null, status: "unavailable" };
    }
    const previousById = new Map(previous.map((process) => [process.id, process.cpuTimeSec]));
    if (previous.length !== current.length || current.some((process) => !previousById.has(process.id))) {
        return { ...counts, cpuMs: null, status: "turnover" };
    }
    let cpuSec = 0;
    for (const process of current) {
        const delta = process.cpuTimeSec - previousById.get(process.id)!;
        if (!Number.isFinite(delta)) return { ...counts, cpuMs: null, status: "unavailable" };
        if (delta < 0) return { ...counts, cpuMs: null, status: "counter-reset" };
        cpuSec += delta;
    }
    return { ...counts, cpuMs: cpuSec * 1000, status: "available" };
}
