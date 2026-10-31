// Diagnostic: file-boundary transitions + trip-activation breakdown.
// Opt in with DIAG=1 and PERF_SAMPLE_DIR=<folder with a multi-file trip>.
//   DIAG_RATE        playback rate during the run (default 8)
//   DIAG_BOUNDARIES  how many 'ended' events to observe (default 5, loop mode)
//   DIAG_PROFILE=1   CPU-profile the activation (click -> first frame)
// Prints a per-boundary table: which slot took over, preload slot readiness
// at 'ended', the ended -> playing / first presented frame gap for the
// master, and the same gaps for every slave channel.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { setupPage } from "../harness/setup.js";
import { deliverFiles } from "../harness/files.js";
import { discoverVendors } from "../harness/vendors.js";
import { startCpuProfile, type CpuProfileFrame } from "../harness/cpu-profile.js";
import { presetLocalStorage } from "../../e2e/_fixtures.js";

if (process.env.DIAG !== "1") test.skip(true, "diag spec disabled - set DIAG=1 to opt in");

const vendors = discoverVendors();
const vendor = vendors[0];
const RATE = Number(process.env.DIAG_RATE ?? "8");
const BOUNDARIES = Number(process.env.DIAG_BOUNDARIES ?? "5");
const PROFILE = process.env.DIAG_PROFILE === "1";
const SEEK_MODE = process.env.DIAG_SEEK === "1";
const SWITCH = process.env.DIAG_SWITCH === "1";
const RESULTS_DIR = fileURLToPath(new URL("../../../private/perf-results/", import.meta.url));

interface VideoEvt {
    t: number;
    id: string;
    ev: string;
    rs: number;
    ct: number;
    preloadAttr: string;
    isPreloadSlot: boolean;
    extra?: unknown;
}

/** A currentTime write: who moved which element where, and in what element state. */
interface CtWrite {
    t: number;
    id: string;
    value: number;
    rs: number;
    hasSrc: boolean;
    stack: string;
}

/** 10 Hz buffer sample per attached element. */
interface BufferSample {
    t: number;
    id: string;
    ct: number;
    rs: number;
    buffered: string;
}

function fmtFrame(f: CpuProfileFrame): string {
    const file = f.url.split("/").pop() ?? "";
    return `${f.selfMs.toFixed(1)}ms self / ${f.inclusiveMs.toFixed(1)}ms incl  ${f.functionName}  ${file}:${f.line ?? ""}`;
}

test(`_diag-boundary: ${vendor?.name}`, async ({ browser }) => {
    test.setTimeout(Number(process.env.DIAG_TEST_TIMEOUT_MS ?? "400000"));
    if (!vendor) return;
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => console.log("BROWSER ERROR:", err.message));
    await presetLocalStorage(page);
    await setupPage(page);

    // Instrument every <video> before any trip opens.
    await page.evaluate(() => {
        const w = window as unknown as {
            __diag: { events: VideoEvt[]; clickT: number; ctWrites: CtWrite[]; samples: BufferSample[] };
        };
        w.__diag = { events: [], clickT: 0, ctWrites: [], samples: [] };
        const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
        // Every currentTime write with its caller. The element state matters: a
        // write on an element without metadata becomes its default playback start
        // position (HTML spec) and the getter reports it until the next metadata
        // load, so such writes can poison anything that reads currentTime.
        const ctDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
        if (ctDesc?.set && ctDesc.get) {
            const origSet = ctDesc.set;
            Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
                configurable: true,
                get: ctDesc.get,
                set(this: HTMLMediaElement, value: number) {
                    w.__diag.ctWrites.push({
                        t: performance.now(),
                        id: this.id,
                        value,
                        rs: this.readyState,
                        hasSrc: !!this.getAttribute("src"),
                        stack: (new Error().stack ?? "").split("\n").slice(2, 8).join(" | "),
                    });
                    if (w.__diag.ctWrites.length > 4000) w.__diag.ctWrites.splice(0, 1000);
                    origSet.call(this, value);
                },
            });
        }
        setInterval(() => {
            for (const v of videos) {
                if (!v.getAttribute("src")) continue;
                const ranges: string[] = [];
                for (let i = 0; i < v.buffered.length; i++)
                    ranges.push(`${v.buffered.start(i).toFixed(1)}-${v.buffered.end(i).toFixed(1)}`);
                w.__diag.samples.push({
                    t: performance.now(),
                    id: v.id,
                    ct: v.currentTime,
                    rs: v.readyState,
                    buffered: ranges.join(","),
                });
            }
            if (w.__diag.samples.length > 6000) w.__diag.samples.splice(0, w.__diag.samples.length - 6000);
        }, 100);
        const rec = (v: HTMLVideoElement, ev: string, extra?: unknown) => {
            w.__diag.events.push({
                t: performance.now(),
                id: v.id || v.className,
                ev,
                rs: v.readyState,
                ct: v.currentTime,
                preloadAttr: v.getAttribute("preload") ?? "",
                isPreloadSlot: v.classList.contains("preload-slot"),
                extra,
            });
        };
        for (const v of videos) {
            for (const ev of [
                "ended",
                "play",
                "playing",
                "pause",
                "loadstart",
                "loadedmetadata",
                "loadeddata",
                "canplay",
                "canplaythrough",
                "emptied",
                "seeking",
                "seeked",
                "waiting",
                "error",
            ]) {
                v.addEventListener(ev, () => rec(v, ev));
            }
            // First presented frame after each play(): the visual gap end.
            v.addEventListener("play", () => {
                if (typeof v.requestVideoFrameCallback !== "function") return;
                v.requestVideoFrameCallback((_now, meta) => rec(v, "rvfc", { mediaTime: meta.mediaTime }));
            });
            // Also the very first frame after a new source loads (paused or not).
            v.addEventListener("loadstart", () => {
                if (typeof v.requestVideoFrameCallback !== "function") return;
                v.requestVideoFrameCallback((_now, meta) => rec(v, "rvfc-load", { mediaTime: meta.mediaTime }));
            });
        }
        document.addEventListener("pointerdown", () => {
            w.__diag.clickT = performance.now();
        });
    });

    await deliverFiles(page, vendor.absPath);
    await page.waitForFunction(
        () => {
            const w = window as unknown as { __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> } };
            return !!w.__everydashcamPerf?.lifecycleEvents?.some((e) => e.type === "everydashcam:ingest-done");
        },
        { timeout: Number(process.env.DIAG_INGEST_TIMEOUT_MS ?? "240000"), polling: 100 },
    );
    // Pick the trip with the most frames.
    const tripIdx = await page.evaluate(() => {
        const w = window as unknown as { __everydashcam: { state: { trips: Array<{ frames: unknown[] }> } } };
        let best = 0;
        w.__everydashcam.state.trips.forEach((t, i) => {
            if (t.frames.length > w.__everydashcam.state.trips[best]!.frames.length) best = i;
        });
        return best;
    });
    const frames = await page.evaluate(
        (i) =>
            (window as unknown as { __everydashcam: { state: { trips: Array<{ frames: unknown[] }> } } }).__everydashcam
                .state.trips[i]!.frames.length,
        tripIdx,
    );
    console.log(`>>> trip ${tripIdx} with ${frames} frames, rate ${RATE}, boundaries ${BOUNDARIES}`);

    await page.evaluate(() => {
        const w = window as unknown as { __everydashcamPerf?: { lifecycleEvents: unknown[] } };
        if (w.__everydashcamPerf) w.__everydashcamPerf.lifecycleEvents = [];
    });
    const profile = PROFILE ? await startCpuProfile(page) : null;
    await page.locator(`li.trip[data-trip-index="${tripIdx}"] .trip-header`).click();
    await page.waitForFunction(
        () => {
            const w = window as unknown as { __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> } };
            return !!w.__everydashcamPerf?.lifecycleEvents?.some((e) => e.type === "everydashcam:player-first-frame");
        },
        { timeout: 90_000, polling: 50 },
    );
    if (profile) {
        await page.waitForTimeout(300);
        const result = await profile.stop();
        mkdirSync(RESULTS_DIR, { recursive: true });
        const dumpPath = resolve(
            RESULTS_DIR,
            `diag-activation-${vendor.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.summary.json`,
        );
        writeFileSync(dumpPath, JSON.stringify(result.summary, null, 2));
        console.log(`>>> activation profile summary: ${dumpPath}`);
        const app = (f: CpuProfileFrame) => !/maplibre|chart\.js|chunk-/.test(f.url) && f.url !== "";
        console.log(
            `>>> activation profile: ${result.summary.sampledMs.toFixed(0)}ms sampled, idle ${result.summary.idleMs.toFixed(0)}ms, gc ${result.summary.garbageCollectorMs.toFixed(0)}ms`,
        );
        console.log(">>> top inclusive (all):");
        for (const f of result.summary.topInclusive.slice(0, 25)) console.log("   ", fmtFrame(f));
        console.log(">>> top self (all):");
        for (const f of result.summary.topSelf.slice(0, 25)) console.log("   ", fmtFrame(f));
        console.log(">>> top self (app only):");
        for (const f of result.summary.topSelf.filter(app).slice(0, 20)) console.log("   ", fmtFrame(f));
    }

    // Activation breakdown.
    const activation = await page.evaluate(() => {
        const w = window as unknown as {
            __diag: { events: VideoEvt[]; clickT: number };
            __everydashcamPerf: { lifecycleEvents: Array<{ type: string; t: number }> };
        };
        const lc = (name: string) =>
            w.__everydashcamPerf.lifecycleEvents.find((e) => e.type === `everydashcam:${name}`)?.t;
        const activated = lc("trip-activated") ?? 0;
        const firstLoadstart = w.__diag.events.find((e) => e.ev === "loadstart" && e.t >= activated - 1);
        const firstMeta = w.__diag.events.find((e) => e.ev === "loadedmetadata" && e.t >= activated - 1);
        const firstPlaying = w.__diag.events.find((e) => e.ev === "playing" && e.t >= activated - 1);
        return {
            clickToActivatedMs: activated - w.__diag.clickT,
            activatedToLoadstartMs: (firstLoadstart?.t ?? Number.NaN) - activated,
            loadstartToMetadataMs: (firstMeta?.t ?? Number.NaN) - (firstLoadstart?.t ?? Number.NaN),
            loadstartToPlayingMs: (firstPlaying?.t ?? Number.NaN) - (firstLoadstart?.t ?? Number.NaN),
            activatedToFirstFrameMs: (lc("player-first-frame") ?? Number.NaN) - activated,
            activatedToChartMs: (lc("chart-rendered") ?? Number.NaN) - activated,
            activatedToMapMs: (lc("map-tracks-rendered") ?? Number.NaN) - activated,
        };
    });
    console.log(">>> activation:", JSON.stringify(activation));

    if (SWITCH) {
        // Trip switch with a populated sidebar: profile a click on another trip.
        const otherIdx = await page.evaluate((cur) => {
            const w = window as unknown as { __everydashcam: { state: { trips: Array<{ frames: unknown[] }> } } };
            let best = -1;
            w.__everydashcam.state.trips.forEach((t, i) => {
                if (i === cur) return;
                if (best < 0 || t.frames.length > w.__everydashcam.state.trips[best]!.frames.length) best = i;
            });
            return best;
        }, tripIdx);
        const tripCount = await page.evaluate(
            () =>
                (window as unknown as { __everydashcam: { state: { trips: unknown[] } } }).__everydashcam.state.trips
                    .length,
        );
        if (otherIdx >= 0) {
            await page.waitForTimeout(1500);
            await page.evaluate(() => {
                const w = window as unknown as {
                    __everydashcamPerf?: { lifecycleEvents: unknown[] };
                    __diag: { events: VideoEvt[] };
                };
                if (w.__everydashcamPerf) w.__everydashcamPerf.lifecycleEvents = [];
                w.__diag.events.length = 0;
            });
            const prof2 = await startCpuProfile(page);
            await page.locator(`li.trip[data-trip-index="${otherIdx}"] .trip-header`).scrollIntoViewIfNeeded();
            await page.locator(`li.trip[data-trip-index="${otherIdx}"] .trip-header`).click();
            await page.waitForFunction(
                () => {
                    const w = window as unknown as {
                        __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                    };
                    return !!w.__everydashcamPerf?.lifecycleEvents?.some(
                        (e) => e.type === "everydashcam:player-first-frame",
                    );
                },
                { timeout: 90_000, polling: 50 },
            );
            await page.waitForTimeout(300);
            const r2 = await prof2.stop();
            const dump2 = resolve(
                RESULTS_DIR,
                `diag-switch-${vendor.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.summary.json`,
            );
            writeFileSync(dump2, JSON.stringify(r2.summary, null, 2));
            const act2 = await page.evaluate(() => {
                const w = window as unknown as {
                    __diag: { events: VideoEvt[]; clickT: number };
                    __everydashcamPerf: { lifecycleEvents: Array<{ type: string; t: number }> };
                };
                const lc = (name: string) =>
                    w.__everydashcamPerf.lifecycleEvents.find((e) => e.type === `everydashcam:${name}`)?.t;
                const activated = lc("trip-activated") ?? 0;
                const firstLoadstart = w.__diag.events.find((e) => e.ev === "loadstart" && e.t >= activated - 1);
                const firstPlaying = w.__diag.events.find((e) => e.ev === "playing" && e.t >= activated - 1);
                return {
                    clickToActivatedMs: activated - w.__diag.clickT,
                    activatedToLoadstartMs: (firstLoadstart?.t ?? Number.NaN) - activated,
                    loadstartToPlayingMs: (firstPlaying?.t ?? Number.NaN) - (firstLoadstart?.t ?? Number.NaN),
                    activatedToFirstFrameMs: (lc("player-first-frame") ?? Number.NaN) - activated,
                };
            });
            console.log(
                `>>> trip switch to ${otherIdx} (sidebar has ${tripCount} trips): ${JSON.stringify(act2)}; profile ${dump2}`,
            );
        }
    }

    // Loop the trip at the requested rate so several boundaries pass quickly.
    await page.evaluate((rate) => {
        const w = window as unknown as {
            __everydashcam: { state: { preferredPlaybackRate: number; tripEndBehavior: string } };
        };
        w.__everydashcam.state.tripEndBehavior = "loop";
        w.__everydashcam.state.preferredPlaybackRate = rate;
        for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>("video"))) v.playbackRate = rate;
        const active = document.querySelector<HTMLVideoElement>(".video-tile.active video:not(.preload-slot)");
        if (active?.paused) void active.play();
    }, RATE);

    const endedCount = () =>
        page.evaluate(
            () =>
                (window as unknown as { __diag: { events: VideoEvt[] } }).__diag.events.filter((e) => e.ev === "ended")
                    .length,
        );
    const dumpState = async (label: string) => {
        const snap = await page.evaluate(() => {
            const w = window as unknown as {
                __everydashcam: {
                    state: { active: unknown };
                    dumpLog: () => Array<{ ns: string; msg: string; ts: number; ctx?: unknown }>;
                };
                __diag: { events: VideoEvt[] };
            };
            const vids = Array.from(document.querySelectorAll<HTMLVideoElement>("video"))
                .filter((v) => v.src)
                .map((v) => {
                    const ranges: string[] = [];
                    for (let i = 0; i < v.buffered.length; i++)
                        ranges.push(`${v.buffered.start(i).toFixed(1)}-${v.buffered.end(i).toFixed(1)}`);
                    return {
                        id: v.id,
                        ct: v.currentTime.toFixed(2),
                        dur: v.duration.toFixed(2),
                        rs: v.readyState,
                        paused: v.paused,
                        ended: v.ended,
                        buffered: ranges.join(","),
                    };
                });
            const waiting = w.__diag.events.filter((e) => e.ev === "waiting").length;
            return {
                active: w.__everydashcam.state.active,
                vids,
                waiting,
                tail: w.__everydashcam
                    .dumpLog()
                    .slice(-40)
                    .map(
                        (l) => `${l.ts % 100000} ${l.ns}: ${l.msg} ${l.ctx ? JSON.stringify(l.ctx).slice(0, 220) : ""}`,
                    ),
            };
        });
        console.log(`>>> state (${label}):`, JSON.stringify(snap, null, 1));
    };
    if (SEEK_MODE) {
        // Drive boundaries with the scrubber: seek ~8 s before each frame end.
        const plan = await page.evaluate((i) => {
            const w = window as unknown as {
                __everydashcam: {
                    state: {
                        trips: Array<{
                            timeline: { segments: Array<{ contentEnd: number }>; contentDurationSec: number };
                        }>;
                    };
                };
            };
            const tl = w.__everydashcam.state.trips[i]!.timeline;
            return { ends: tl.segments.map((s) => s.contentEnd), dur: tl.contentDurationSec };
        }, tripIdx);
        const bar = page.locator("#player-mini-progress");
        const box = (await bar.boundingBox())!;
        const targetBoundaries = Math.min(BOUNDARIES, plan.ends.length);
        for (let k = 0; k < targetBoundaries; k++) {
            const before = await endedCount();
            const targetSec = Math.max(0, plan.ends[k]! - 8);
            const x = box.x + 12 + (targetSec / plan.dur) * (box.width - 24);
            const seekWall = await page.evaluate(() => Date.now());
            await page.mouse.click(x, box.y + box.height / 2);
            await page.waitForTimeout(400);
            const seekLogs = await page.evaluate((since) => {
                const w = window as unknown as {
                    __everydashcam: { dumpLog: () => Array<{ ns: string; msg: string; ts: number; ctx?: unknown }> };
                };
                return w.__everydashcam
                    .dumpLog()
                    .filter((l) => l.ts >= since)
                    .map(
                        (l) =>
                            `+${l.ts - since}ms ${l.ns}: ${l.msg} ${l.ctx ? JSON.stringify(l.ctx).slice(0, 200) : ""}`,
                    );
            }, seekWall);
            console.log(`>>> logs after seek ${k}:`);
            for (const line of seekLogs) console.log("   ", line);
            const landed = await page.evaluate(
                () =>
                    (window as unknown as { __everydashcam: { dom: { playerBar: { current: HTMLElement } } } })
                        .__everydashcam.dom.playerBar.current.textContent,
            );
            console.log(`>>> seek ${k}: target ${targetSec.toFixed(0)}s, landed at ${landed}`);
            try {
                await page.waitForFunction(
                    (n) =>
                        (window as unknown as { __diag: { events: VideoEvt[] } }).__diag.events.filter(
                            (e) => e.ev === "ended",
                        ).length > n,
                    before,
                    { timeout: 90_000, polling: 200 },
                );
            } catch {
                console.log(`>>> no 'ended' within 90 s after seek ${k}`);
                await dumpState(`after seek ${k}`);
                break;
            }
            await page.waitForTimeout(3000);
        }
    } else {
        try {
            await page.waitForFunction(
                (n) =>
                    (window as unknown as { __diag: { events: VideoEvt[] } }).__diag.events.filter(
                        (e) => e.ev === "ended",
                    ).length >= n,
                BOUNDARIES,
                { timeout: 300_000, polling: 200 },
            );
        } catch {
            console.log(">>> boundary wait timed out");
            await dumpState("timeout");
        }
    }
    // Let the last boundary settle.
    await page.waitForTimeout(2500);

    const report = await page.evaluate(() => {
        const w = window as unknown as {
            __diag: { events: VideoEvt[] };
            __everydashcam: {
                dumpLog: () => Array<{ ns: string; msg: string; ts: number; ctx?: Record<string, unknown> }>;
            };
        };
        const ev = w.__diag.events;
        const endeds = ev.filter((e) => e.ev === "ended");
        const channelOf = (id: string) => id.replace("-preload", "").replace("player-", "").replace("player", "front");
        const rows = endeds.map((end, i) => {
            const after = ev.filter((e) => e.t > end.t && (i + 1 >= endeds.length || e.t <= endeds[i + 1]!.t));
            const otherId = end.id.endsWith("-preload") ? end.id.replace("-preload", "") : `${end.id}-preload`;
            const otherBefore = [...ev].reverse().find((e) => e.id === otherId && e.t <= end.t);
            const masterCh = channelOf(end.id);
            const masterAfter = after.filter((e) => channelOf(e.id) === masterCh);
            const playing = masterAfter.find((e) => e.ev === "playing");
            const rvfc = masterAfter.find((e) => e.ev === "rvfc" || e.ev === "rvfc-load");
            const loadstart = masterAfter.find((e) => e.ev === "loadstart");
            const slaves: Record<string, string> = {};
            for (const ch of ["rear", "interior", "side"]) {
                const sa = after.filter((e) => channelOf(e.id) === ch);
                if (sa.length === 0) continue;
                const ls = sa.find((e) => e.ev === "loadstart");
                const pl = sa.find((e) => e.ev === "playing");
                const fr = sa.find((e) => e.ev === "rvfc" || e.ev === "rvfc-load");
                slaves[ch] =
                    `loadstart+${ls ? (ls.t - end.t).toFixed(0) : "-"} playing+${pl ? (pl.t - end.t).toFixed(0) : "-"} frame+${fr ? (fr.t - end.t).toFixed(0) : "-"}`;
            }
            return {
                i,
                endedOn: end.id,
                otherSlot: otherBefore
                    ? `${otherBefore.ev}@rs${otherBefore.rs} preload=${otherBefore.preloadAttr}`
                    : "none",
                nextPlayingOn: playing?.id ?? "none",
                masterReloadOn: loadstart ? `${loadstart.id}@+${(loadstart.t - end.t).toFixed(0)}ms` : "none",
                endedToPlayingMs: playing ? +(playing.t - end.t).toFixed(1) : null,
                endedToFrameMs: rvfc ? +(rvfc.t - end.t).toFixed(1) : null,
                slaves,
            };
        });
        const all = w.__everydashcam.dumpLog();
        const logs = all
            .filter(
                (l) =>
                    (l.ns === "player" || l.ns === "per-file-mse") &&
                    /preload promoted|attach: |stream up|seekTo|regroup|error|fail/i.test(l.msg),
            )
            .map((l) => ({
                ts: l.ts,
                ns: l.ns,
                msg: l.msg,
                file: l.ctx?.file,
                readyState: l.ctx?.readyState,
                from: l.ctx?.from,
                to: l.ctx?.to,
                startSec: l.ctx?.startSec,
            }));
        const act = all.find((l) => l.msg === "trip activated");
        const window3s = act
            ? all
                  .filter((l) => l.ts >= act.ts && l.ts <= act.ts + 3000)
                  .map(
                      (l) =>
                          `+${l.ts - act.ts}ms ${l.ns}: ${l.msg} ${l.ctx ? JSON.stringify(l.ctx).slice(0, 140) : ""}`,
                  )
            : [];
        return { rows, logs, window3s };
    });
    console.log(">>> boundaries:");
    for (const r of report.rows) console.log(JSON.stringify(r));
    console.log(">>> log window 3 s after activation:");
    for (const line of report.window3s) console.log("   ", line);
    console.log(">>> player logs:");
    let prevTs = 0;
    for (const l of report.logs) {
        console.log(JSON.stringify({ ...l, dtMs: prevTs ? l.ts - prevTs : 0 }));
        prevTs = l.ts;
    }
    const extra = await page.evaluate(() => {
        const w = window as unknown as { __diag: { ctWrites: CtWrite[]; samples: BufferSample[] } };
        return { ctWrites: w.__diag.ctWrites, samples: w.__diag.samples };
    });
    const notable = extra.ctWrites.filter((x) => x.rs < 2 || x.value > 10);
    console.log(`>>> currentTime writes: ${extra.ctWrites.length} total, ${notable.length} notable (rs<2 or >10 s)`);
    for (const x of notable.slice(0, 60)) {
        console.log(
            `    t=${x.t.toFixed(0)} ${x.id} <- ${x.value.toFixed(3)} rs=${x.rs} src=${x.hasSrc} :: ${x.stack}`,
        );
    }
    // Worker-side records (forwarded into the main ring buffer) and the element
    // events around the first moment a buffer runs away from its playhead.
    const workerLogs = await page.evaluate(() =>
        (
            window as unknown as {
                __everydashcam: { dumpLog: () => Array<{ ns: string; msg: string; ts: number; ctx?: unknown }> };
            }
        ).__everydashcam
            .dumpLog()
            .filter((l) => l.ns.startsWith("worker:"))
            .map((l) => `${l.ts % 100000} ${l.ns}: ${l.msg} ${l.ctx ? JSON.stringify(l.ctx).slice(0, 400) : ""}`),
    );
    console.log(`>>> worker logs: ${workerLogs.length}`);
    for (const line of workerLogs.slice(0, 60)) console.log("   ", line);
    const runaway = extra.samples.find((x) => {
        const last = x.buffered.split(",").pop();
        const end = last ? Number(last.split("-")[1]) : 0;
        return end - x.ct > 30;
    });
    if (runaway) {
        const evs = await page.evaluate(
            (t0) =>
                (window as unknown as { __diag: { events: VideoEvt[] } }).__diag.events.filter(
                    (e) => e.t >= t0 - 2500 && e.t <= t0 + 800,
                ),
            runaway.t,
        );
        console.log(`>>> runaway buffer first seen at t=${runaway.t.toFixed(0)} on ${runaway.id}; events around it:`);
        for (const e of evs) console.log(`    t=${e.t.toFixed(0)} ${e.id} ${e.ev} rs=${e.rs} ct=${e.ct.toFixed(2)}`);
    }
    if (process.env.DIAG_SAMPLES === "1") {
        console.log(">>> buffer samples (10 Hz):");
        for (const x of extra.samples) {
            console.log(`    t=${x.t.toFixed(0)} ${x.id} ct=${x.ct.toFixed(2)} rs=${x.rs} [${x.buffered}]`);
        }
    }
    await ctx.close();
});
