import { zstdCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
    clocksEvent,
    concatBytes,
    frameIndexEvents,
    type GpsFixSpec,
    gpsEvent,
} from "../__fixtures__/openpilot/build-log.js";
import { cutInsideLastBlock, streamedZstd } from "../__fixtures__/zstd-stream.js";
import { type VendorFile, WrongFormatError } from "../types.js";
import { openpilotLogPrimitive } from "./openpilot-log.js";
import type { PrimitiveVideoRef } from "./types.js";

const PREFIX = "0123456789abcdef_00000001--0000000000--7";
const FLAT_NAME = `${PREFIX}--qlog.zst`;
const BOOT_NS = 3_000_000_000_000;
const T0_MS = 1_793_000_000_000; // 2026-10-26T08:53:20Z

function qlogFile(
    events: readonly Uint8Array[],
    options: { name?: string; relativePath?: string; sourceKey?: string } = {},
): VendorFile {
    const name = options.name ?? FLAT_NAME;
    const bytes = zstdCompressSync(concatBytes(events));
    return {
        file: new File([bytes], name),
        relativePath: options.relativePath ?? name,
        ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey }),
    };
}

/** Fixes one second apart whose publish latency varies; the median is 30 ms. */
function fixes(overrides: Partial<GpsFixSpec> = {}): Uint8Array[] {
    return [20, 40, 30].map((latencyMs, k) =>
        gpsEvent({
            monoNs: BOOT_NS + k * 1e9,
            unixMillis: T0_MS + k * 1000 + latencyMs,
            lat: 39 + k / 1000,
            lon: -77 - k / 1000,
            speedMs: 10 + k,
            bearingDeg: -90,
            ...overrides,
        }),
    );
}

/** Frame index of every camera: frame 0 half a second before the first fix. */
function cameras(frames = 40): Uint8Array[] {
    return (["fcamera", "ecamera", "dcamera", "qcamera"] as const).flatMap((stream) =>
        frameIndexEvents(stream, 7, frames, BOOT_NS - 500_000_000),
    );
}

const EXPECTED_START = T0_MS / 1000 - 0.5 + 0.03;

describe("openpilotLogPrimitive.marker", () => {
    it("claims zstd qlogs in both route layouts", async () => {
        expect(await openpilotLogPrimitive.marker(qlogFile([]))).toBe(true);
        expect(
            await openpilotLogPrimitive.marker(
                qlogFile([], { name: "qlog.zst", relativePath: "realdata/00000001--0000000000--7/qlog.zst" }),
            ),
        ).toBe(true);
    });

    it("rejects rlogs, other names and non-zstd content", async () => {
        expect(await openpilotLogPrimitive.marker(qlogFile([], { name: `${PREFIX}--rlog.zst` }))).toBe(false);
        expect(await openpilotLogPrimitive.marker(qlogFile([], { name: "qlog.zst" }))).toBe(false);
        const bz2: VendorFile = { file: new File(["BZh91AY&SY"], FLAT_NAME), relativePath: FLAT_NAME };
        expect(await openpilotLogPrimitive.marker(bz2)).toBe(false);
    });
});

describe("openpilotLogPrimitive.parse", () => {
    it("dates every camera from GPS and counts the frames of raw streams only", async () => {
        const parsed = await openpilotLogPrimitive.parse(qlogFile([...cameras(), ...fixes()]));
        expect(parsed.skipped).toEqual([]);
        const hints = parsed.videoTimingHints ?? [];
        expect(hints.map((hint) => [hint.mp4Filename, hint.durationSec])).toEqual([
            [`${PREFIX}--fcamera.hevc`, 2],
            [`${PREFIX}--ecamera.hevc`, 2],
            [`${PREFIX}--dcamera.hevc`, 2],
            [`${PREFIX}--qcamera.ts`, null],
        ]);
        for (const hint of hints) {
            expect(hint.startUtc!, hint.mp4Filename).toBeCloseTo(EXPECTED_START, 4);
            expect(hint.videoKey).toBeUndefined();
        }
    });

    it("turns fixes into records of the front video, in time order", async () => {
        const parsed = await openpilotLogPrimitive.parse(qlogFile([...cameras(), ...fixes().reverse()]));
        expect(parsed.records.map((record) => record.unixSeconds)).toEqual([
            (T0_MS + 20) / 1000,
            (T0_MS + 1040) / 1000,
            (T0_MS + 2030) / 1000,
        ]);
        expect(parsed.records[0]).toEqual({
            unixSeconds: (T0_MS + 20) / 1000,
            active: true,
            lat: 39,
            lon: -77,
            bearingDeg: 270,
            speedMs: 10,
            speedSource: "measured",
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: `${PREFIX}--fcamera.hevc`,
        });
    });

    it("drops fix-less reports and unsynced clocks from the track", async () => {
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([
                ...cameras(),
                ...fixes(),
                gpsEvent({ monoNs: BOOT_NS + 4e9, unixMillis: T0_MS + 4000, lat: 0, lon: 0, hasFix: false }),
                gpsEvent({ monoNs: BOOT_NS + 5e9, unixMillis: 315_964_800_000, lat: 39, lon: -77 }),
            ]),
        );
        expect(parsed.records).toHaveLength(3);
        expect(parsed.videoTimingHints![0]!.startUtc!).toBeCloseTo(EXPECTED_START, 4);
    });

    it("binds to the loaded videos of its segment, preferring its own source", async () => {
        const name = (stream: string) => `${PREFIX}--${stream}`;
        const known: PrimitiveVideoRef[] = [
            {
                name: name("fcamera.hevc"),
                relativePath: `drive/${name("fcamera.hevc")}`,
                sourceKey: "b",
                videoKey: "fb",
            },
            {
                name: name("fcamera.hevc"),
                relativePath: `drive/${name("fcamera.hevc")}`,
                sourceKey: "a",
                videoKey: "fa",
            },
            { name: name("qcamera.ts"), relativePath: `drive/${name("qcamera.ts")}`, sourceKey: "a", videoKey: "qa" },
            // Another segment and another route folder are not this log's videos.
            {
                name: "0123456789abcdef_00000001--0000000000--8--ecamera.hevc",
                relativePath: "drive/0123456789abcdef_00000001--0000000000--8--ecamera.hevc",
                sourceKey: "a",
                videoKey: "e8",
            },
            {
                name: name("dcamera.hevc"),
                relativePath: `other/${name("dcamera.hevc")}`,
                sourceKey: "a",
                videoKey: "dx",
            },
        ];
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([...cameras(), ...fixes()], { relativePath: `drive/${FLAT_NAME}`, sourceKey: "a" }),
            undefined,
            undefined,
            { knownVideos: known },
        );
        expect(parsed.records.every((record) => record.videoKey === "fa")).toBe(true);
        expect(parsed.videoTimingHints!.map((hint) => [hint.mp4Filename, hint.videoKey])).toEqual([
            [name("fcamera.hevc"), "fa"],
            [name("ecamera.hevc"), undefined],
            [name("dcamera.hevc"), undefined],
            [name("qcamera.ts"), "qa"],
        ]);
    });

    it("falls back to another source when a log arrives in a later drop", async () => {
        const video = `${PREFIX}--fcamera.hevc`;
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([...cameras(), ...fixes()], { sourceKey: "later" }),
            undefined,
            undefined,
            { knownVideos: [{ name: video, relativePath: video, sourceKey: "first", videoKey: "f1" }] },
        );
        expect(parsed.records[0]!.videoKey).toBe("f1");
    });

    it("gives GPS to the preview when the full-res road video is not loaded", async () => {
        const preview = `${PREFIX}--qcamera.ts`;
        const parsed = await openpilotLogPrimitive.parse(qlogFile([...cameras(), ...fixes()]), undefined, undefined, {
            knownVideos: [{ name: preview, relativePath: preview, videoKey: "q" }],
        });
        expect(parsed.records[0]).toMatchObject({ mp4Filename: preview, videoKey: "q" });
    });

    it("gives GPS to the wide, then the driver camera when no road view is loaded", async () => {
        const wide = `${PREFIX}--ecamera.hevc`;
        const driver = `${PREFIX}--dcamera.hevc`;
        const parse = (knownVideos: PrimitiveVideoRef[]) =>
            openpilotLogPrimitive.parse(qlogFile([...cameras(), ...fixes()]), undefined, undefined, { knownVideos });
        const both = await parse([
            { name: driver, relativePath: driver, videoKey: "d" },
            { name: wide, relativePath: wide, videoKey: "e" },
        ]);
        expect(both.records[0]).toMatchObject({ mp4Filename: wide, videoKey: "e" });
        const driverOnly = await parse([{ name: driver, relativePath: driver, videoKey: "d" }]);
        expect(driverOnly.records[0]).toMatchObject({ mp4Filename: driver, videoKey: "d" });
    });

    it("names unloaded videos in the device layout by their bare file names", async () => {
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([...cameras(), ...fixes()], {
                name: "qlog.zst",
                relativePath: "realdata/00000001--0000000000--7/qlog.zst",
            }),
        );
        expect(parsed.records[0]!.mp4Filename).toBe("fcamera.hevc");
        expect(parsed.videoTimingHints!.map((hint) => hint.mp4Filename)).toEqual([
            "fcamera.hevc",
            "ecamera.hevc",
            "dcamera.hevc",
            "qcamera.ts",
        ]);
    });

    it("falls back to the synced system clock when no fix was received", async () => {
        const offsetNs = T0_MS * 1e6 - BOOT_NS;
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([
                ...cameras(),
                clocksEvent(BOOT_NS, BOOT_NS + offsetNs),
                clocksEvent(BOOT_NS + 1e9, BOOT_NS + 1e9 + offsetNs),
            ]),
        );
        expect(parsed.records).toEqual([]);
        expect(parsed.videoTimingHints![0]!.startUtc!).toBeCloseTo(T0_MS / 1000 - 0.5, 4);
    });

    it("leaves the start unknown without a fix or a synced clock, but still counts frames", async () => {
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([...cameras(), clocksEvent(BOOT_NS, 1_000_000_000_000_000_000)]),
        );
        expect(parsed.videoTimingHints![0]).toEqual({
            mp4Filename: `${PREFIX}--fcamera.hevc`,
            startUtc: null,
            durationSec: 2,
        });
    });

    it("ignores a clock openpilot marks unset, however recent its date", async () => {
        const offsetNs = T0_MS * 1e6 - BOOT_NS;
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([...cameras(), clocksEvent(BOOT_NS, BOOT_NS + offsetNs, false)]),
        );
        expect(parsed.videoTimingHints![0]).toMatchObject({ startUtc: null, durationSec: 2 });
    });

    it("keeps the GPS and start of a log cut short, but not its frame counts", async () => {
        // Over 128 KiB of events, so the fixes sit in a whole first block.
        const cut: VendorFile = {
            file: new File([cutInsideLastBlock(streamedZstd(concatBytes([...fixes(), ...cameras(1200)])))], FLAT_NAME),
            relativePath: FLAT_NAME,
        };
        const parsed = await openpilotLogPrimitive.parse(cut);
        expect(parsed.records).toHaveLength(3);
        const front = parsed.videoTimingHints!.find((hint) => hint.mp4Filename.endsWith("fcamera.hevc"));
        expect(front, "front camera hint").toBeDefined();
        expect(front!.startUtc!).toBeCloseTo(EXPECTED_START, 4);
        expect(front!.durationSec).toBeNull();
    });

    it("drops fixes off the globe from the track", async () => {
        const parsed = await openpilotLogPrimitive.parse(qlogFile([...cameras(), ...fixes({ lat: 391 })]));
        expect(parsed.records).toEqual([]);
        expect(parsed.videoTimingHints![0]!.startUtc!).toBeCloseTo(EXPECTED_START, 4);
    });

    it("ignores a frame index of a different segment than its file name", async () => {
        const parsed = await openpilotLogPrimitive.parse(
            qlogFile([...frameIndexEvents("fcamera", 8, 40, BOOT_NS), ...fixes()]),
        );
        expect(parsed.videoTimingHints).toEqual([]);
        expect(parsed.records).toHaveLength(3);
    });

    it("throws WrongFormatError for a non-zstd body, an empty log, a zstd bomb and a foreign name", async () => {
        const garbage: VendorFile = {
            file: new File([new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5])], FLAT_NAME),
            relativePath: FLAT_NAME,
        };
        await expect(openpilotLogPrimitive.parse(garbage)).rejects.toBeInstanceOf(WrongFormatError);
        await expect(openpilotLogPrimitive.parse(qlogFile([]))).rejects.toBeInstanceOf(WrongFormatError);
        const bomb: VendorFile = {
            file: new File([new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xf8, 0, 0, 0])], FLAT_NAME),
            relativePath: FLAT_NAME,
        };
        await expect(openpilotLogPrimitive.parse(bomb)).rejects.toBeInstanceOf(WrongFormatError);
        await expect(openpilotLogPrimitive.parse(qlogFile(fixes(), { name: "qlog.zst" }))).rejects.toBeInstanceOf(
            WrongFormatError,
        );
    });

    it("stops on cancellation", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            openpilotLogPrimitive.parse(qlogFile(fixes()), undefined, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});
