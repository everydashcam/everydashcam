// Export throughput per configuration (re-encode and stream-copy).
//
// Drives the real export panel on a sample folder with the save picker stubbed,
// then lifts the export's done-lines (frames, elapsed, encoder config, map
// render/reuse counts, GPMF injection mode) out of the log ring buffer and
// prints one EXPORT_PERF JSON line. One configuration per run, selected
// through env knobs so the same spec can A/B a code change:
//
//   PERF_SAMPLE_DIR   sample folder (required; see vendors.ts)
//   EXPORT_QUALITY    original | medium | low           (default medium)
//   EXPORT_OUTPUT     output preset id, e.g. source     (default source)
//   EXPORT_OVERLAYS   comma list of widget ids, "" = none (default "")
//   EXPORT_WATERMARK  1 | 0                             (default 0)
//   EXPORT_CHANNELS   number of channels to keep        (default 1)
//   EXPORT_RANGE_SEC  clip length from the trip start   (default 30)
//   EXPORT_ENCODER    auto | hardware | software        (default hardware)
//   EXPORT_SPEED      timelapse factor                  (default 1)
//   EXPORT_SINK       memory | opfs                     (default memory)
//
// "memory" is a growable in-page buffer (measures the pipeline alone); "opfs"
// is a real FileSystemFileHandle from the origin-private file system - the
// same Chromium writable implementation as a picker handle, so the disk
// commit and the GPMF post-process cost what they cost on the native path.
//
// Google Chrome (channel "chrome") is used so HEVC sources decode on macOS;
// Playwright's Chromium build has no HEVC decoder.

import { test } from "@playwright/test";

import type { Page } from "@playwright/test";

import { loadTrip, openExport, presetLocalStorage } from "../../e2e/_fixtures.js";
import { discoverVendors } from "../harness/vendors.js";

/**
 * Save-picker stub with an amortized O(1) sink. The e2e capture stub grows its
 * buffer to the exact size on every write, which turns a 4 MiB-chunked 500 MB
 * stream-copy into ~30 GB of memcpy and dominates the measurement; this one
 * doubles capacity. Also counts the bytes the MAIN thread actually pulled
 * through ReadableStream readers (the stream-copy read path), so read
 * amplification is visible. Note the figure double-counts: the retrying blob
 * source's own tail reader and mediabunny's consumer of the range stream both
 * go through this prototype, so one byte read off disk counts twice.
 */
async function installPerfExportCapture(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const perf = { streamBytes: 0, sinkBytes: 0, sinkWrites: 0 };
        (window as unknown as { __perfExport: typeof perf }).__perfExport = perf;
        const origRead = ReadableStreamDefaultReader.prototype.read;
        ReadableStreamDefaultReader.prototype.read = async function (this: ReadableStreamDefaultReader) {
            const r = await origRead.call(this);
            const v = (r as { value?: { byteLength?: number } }).value;
            if (v && typeof v.byteLength === "number") perf.streamBytes += v.byteLength;
            return r;
        } as typeof origRead;
        const toU8 = (data: unknown): Uint8Array => {
            if (data instanceof Uint8Array) return data;
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (typeof data === "string") return new TextEncoder().encode(data);
            return new Uint8Array(0);
        };
        const makeHandle = (name: string) => {
            let buf = new Uint8Array(1 << 20);
            let len = 0;
            let pos = 0;
            const ensure = (n: number): void => {
                if (n <= buf.length) return;
                let cap = buf.length;
                while (cap < n) cap *= 2;
                const nb = new Uint8Array(cap);
                nb.set(buf.subarray(0, len));
                buf = nb;
            };
            const put = (u8: Uint8Array, at?: number): void => {
                const p = at ?? pos;
                ensure(p + u8.length);
                buf.set(u8, p);
                pos = p + u8.length;
                len = Math.max(len, pos);
                perf.sinkBytes += u8.length;
                perf.sinkWrites++;
            };
            return {
                name,
                kind: "file",
                createWritable: async (opts?: { keepExistingData?: boolean }) => {
                    if (!opts?.keepExistingData) len = 0;
                    pos = 0;
                    return {
                        write: async (chunk: unknown) => {
                            const cmd = chunk as { type?: string; position?: number; size?: number; data?: unknown };
                            if (cmd && (cmd.type === "write" || cmd.type === "seek" || cmd.type === "truncate")) {
                                if (cmd.type === "seek") {
                                    pos = cmd.position ?? pos;
                                    return;
                                }
                                if (cmd.type === "truncate") {
                                    len = Math.min(len, cmd.size ?? 0);
                                    if (pos > len) pos = len;
                                    return;
                                }
                                const d = cmd.data;
                                put(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : toU8(d), cmd.position);
                                return;
                            }
                            put(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : toU8(chunk));
                        },
                        seek: async (p: number) => {
                            pos = p;
                        },
                        truncate: async (n: number) => {
                            len = Math.min(len, n);
                            if (pos > len) pos = len;
                        },
                        close: async () => {},
                        abort: async () => {},
                    };
                },
                getFile: async () => new File([buf.slice(0, len) as BlobPart], name, { type: "video/mp4" }),
            };
        };
        (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options?: {
            suggestedName?: string;
        }) => makeHandle(options?.suggestedName ?? "export.mp4");
    });
}

/**
 * Real FileSystemFileHandle from the origin-private file system: the same
 * Chromium writable implementation (swap file, keepExistingData copy, atomic
 * close) as a picker handle, minus the dialog. Measures what the native path
 * pays for the GPMF post-process re-open.
 */
async function installOpfsExportSink(page: Page): Promise<void> {
    await page.addInitScript(() => {
        (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options?: {
            suggestedName?: string;
        }) => {
            const root = await navigator.storage.getDirectory();
            const name = options?.suggestedName ?? "export.mp4";
            try {
                await root.removeEntry(name);
            } catch {
                /* absent */
            }
            return root.getFileHandle(name, { create: true });
        };
    });
}

const QUALITY = process.env.EXPORT_QUALITY ?? "medium";
const OUTPUT = process.env.EXPORT_OUTPUT ?? "source";
const OVERLAYS = (process.env.EXPORT_OVERLAYS ?? "").split(",").filter(Boolean);
const WATERMARK = process.env.EXPORT_WATERMARK === "1";
const CHANNELS = Number(process.env.EXPORT_CHANNELS ?? "1");
const RANGE_SEC = Number(process.env.EXPORT_RANGE_SEC ?? "30");
const ENCODER = process.env.EXPORT_ENCODER ?? "hardware";
const SPEED = Number(process.env.EXPORT_SPEED ?? "1");
const SINK = process.env.EXPORT_SINK ?? "memory";

test.use({ channel: "chrome" });

const vendors = discoverVendors();
if (vendors.length === 0) test.skip(true, "no sample folder selected (PERF_SAMPLE_DIR)");

for (const vendor of vendors) {
    test(`export: ${vendor.name} q=${QUALITY} out=${OUTPUT} ov=${OVERLAYS.join("+") || "none"} wm=${WATERMARK ? 1 : 0} ch=${CHANNELS}`, async ({
        page,
    }, testInfo) => {
        test.setTimeout(20 * 60_000);
        await presetLocalStorage(page);
        await page.addInitScript(
            ({ encoder, overlays }) => {
                localStorage.setItem("everydashcam:encoder", encoder);
                const enabled = (id: string) => ({ enabled: overlays.includes(id) });
                localStorage.setItem(
                    "everydashcam:export:overlays",
                    JSON.stringify({
                        overlaySpeed: enabled("speed"),
                        overlayCoords: enabled("coords"),
                        overlayMap: enabled("map"),
                        overlayClock: enabled("clock"),
                        overlayCompass: enabled("compass"),
                        overlayGforce: enabled("gforce"),
                        overlayDistance: enabled("distance"),
                        overlayGraph: enabled("graph"),
                    }),
                );
            },
            { encoder: ENCODER, overlays: OVERLAYS },
        );
        await installPerfExportCapture(page);
        if (SINK === "opfs") await installOpfsExportSink(page);
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.goto("/en/");
        await loadTrip(page, vendor.absPath);
        await openExport(page);

        const includes = page.locator(".top-panel__channel-include");
        const includeCount = await includes.count();
        for (let i = includeCount - 1; i >= CHANNELS; i--) await includes.nth(i).click();

        await page.locator(`input[name="export-panel-quality"][value="${QUALITY}"]`).check();
        await page.locator("#export-panel-output").selectOption(OUTPUT);
        const watermark = page.locator("#export-panel-watermark");
        if (WATERMARK) await watermark.check();
        else await watermark.uncheck();
        if (SPEED > 1) await page.locator(`.export-panel__seg-btn[data-factor="${SPEED}"]`).click();

        const endInput = page.locator('.export-trim-bar__input[data-range-edge="end"]');
        await endInput.fill(String(RANGE_SEC));
        await endInput.press("Enter");

        await page.evaluate(() => {
            const perf = (window as unknown as { __perfExport: Record<string, number> }).__perfExport;
            perf.streamBytes = 0;
            perf.sinkBytes = 0;
            perf.sinkWrites = 0;
        });
        const wallStart = Date.now();
        await page.locator("#export-panel-save-btn").click();
        await page
            .locator("#export-panel-done-summary, #export-panel-error")
            .first()
            .waitFor({ timeout: 19 * 60_000 });
        const wallMs = Date.now() - wallStart;
        const io = await page.evaluate(
            () => (window as unknown as { __perfExport: Record<string, number> }).__perfExport,
        );

        const records = await page.evaluate(() => {
            const dump = (window as unknown as { __everydashcam?: { dumpLog: () => unknown[] } }).__everydashcam
                ?.dumpLog;
            if (!dump) return [];
            const wanted = new Set([
                "transcode started",
                "split transcode started",
                "transcode done",
                "split transcode done",
                "export done",
                "export started",
                "export settings",
                "map snapshot prewarm done",
                "finalize done",
                "video encoder config requested",
                "encode ceiling below request",
                "export failed",
                "map snapshot perf",
                "writable closed",
                "gpmd track injected",
                "found moov",
            ]);
            return (dump() as Array<{ ts: number; msg: string; ctx?: unknown; lvl?: string; ns?: string }>)
                .filter((r) => wanted.has(r.msg) || r.lvl === "error")
                .map((r) => ({ ts: r.ts, msg: r.msg, ns: r.ns, ctx: r.ctx }));
        });
        const done = records.find((r) => r.msg === "transcode done" || r.msg === "split transcode done")?.ctx as
            | Record<string, unknown>
            | undefined;
        const summary = {
            vendor: vendor.name,
            quality: QUALITY,
            output: OUTPUT,
            overlays: OVERLAYS,
            watermark: WATERMARK,
            channels: CHANNELS,
            rangeSec: RANGE_SEC,
            encoder: ENCODER,
            wallMs,
            speed: SPEED,
            io,
            sourceBytes: vendor.totalBytes,
            fps: done ? Math.round(((done.framesEncoded as number) * 1000) / (done.elapsedMs as number)) : null,
            done,
            records,
        };
        process.stdout.write(`\nEXPORT_PERF ${JSON.stringify(summary)}\n`);
        testInfo.annotations.push({ type: "perf", description: JSON.stringify({ entries: [], detail: summary }) });
    });
}
