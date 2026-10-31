// Real recordings, rebuilt by scripts/anonymize-supported-gps-mp4.mjs.
// Only understood telemetry fields survive; footage is testsrc2, audio is
// absent, and coordinates are rounded to whole degrees. Source clocks/speeds
// are retained and checked against the originals by the generator.
//
// Sources:
// Garmin 57: https://dashcamtalk.com/forum/threads/garmin-57-review.45027/ (#3)
// Type S S403: https://dashcamtalk.com/forum/threads/50383/page-3 (#54), page-4 (#73)
// Rove R2-4K: https://exiftool.org/forum/index.php?topic=5095.120 (#121)
// Nextbase 422GW: https://github.com/exiftool/exiftool/issues/281
// Vantrue S1 Pro Max: https://www.wideorejestratory24.pl/kamera-samochodowa-vantrue-s1pro-max
// Transcend 550: https://www.ixbt.com/car/transcend-drivepro-550-review.html
// Mikavi PQ6: https://www.wideorejestratory24.pl/kamera-samochodowa-mikavi-pq6-3ch

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildMp4Index, loadTrackSampleBuffers } from "../../internal/mp4-index.js";
import { readMediaTimescale, readSampleDurationsInTicks, readSampleTable } from "../../internal/mp4-walker.js";
import { hasFmasFirstSamplePrefix } from "../../internal/vantrue-fmas.js";
import { nmeaSubtitlePrimitive } from "../../primitives/nmea-subtitle.js";
import { vantrueFmasPrimitive } from "../../primitives/vantrue-fmas.js";
import { classifyFiles, dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { WrongFormatError } from "../../types.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

interface Fixture {
    fixture: string;
    original: string;
    extractor: string;
    count: number;
    first: number;
    last: number;
    position: [number, number];
    speeds: [number, number];
    accel: boolean;
    duration?: number;
    created?: string;
}

const FIXTURES: Fixture[] = [
    { fixture: "garmin57", original: "GRMN0240.MP4", extractor: "garmin-uuid", count: 2, first: 1625344567, last: 1625344568, position: [35, -83], speeds: [15.19936, 15.19936], accel: false },
    { fixture: "types-august", original: "20240812_125341F.MOV", extractor: "ligo-json", count: 2, first: 1723492421, last: 1723492422, position: [34, -118], speeds: [31.299287404, 31.589948264], accel: false },
    { fixture: "types-december", original: "20241218_095819F.MOV", extractor: "ligo-json", count: 2, first: 1734544700, last: 1734544701, position: [39, -121], speeds: [10.868143944, 9.118005456], accel: false },
    { fixture: "rove", original: "2022_0426_115626_003.MP4", extractor: "freegps", count: 2, first: 1650974186, last: 1650974187, position: [40, -80], speeds: [35 / 3.6, 35 / 3.6], accel: true },
    { fixture: "nextbase422", original: "422GW_GPX.MP4", extractor: "nextbase-subtitle", count: 18, first: 1726849110.5, last: 1726849112.4, position: [53, -6], speeds: [25.52413906, 25.448515792], accel: true },
    { fixture: "vantrue-a", original: "20250617_133014_00031_N_A.MP4", extractor: "freegps", count: 60, first: 1750159815, last: 1750159874, position: [52, 16], speeds: [12.33893934, 11.464384540000001], accel: true, duration: 60, created: "2025-06-17T13:31:14.000Z" },
    { fixture: "vantrue-b", original: "20250617_133014_00031_N_B.MP4", extractor: "freegps", count: 60, first: 1750159815, last: 1750159874, position: [52, 16], speeds: [12.33893934, 11.464384540000001], accel: true, duration: 60, created: "2025-06-17T13:31:14.000Z" },
    { fixture: "transcend-a", original: "day-a.MP4", extractor: "freegps", count: 2, first: 1535441845, last: 1535441846, position: [57, 41], speeds: [4.007004333662033, 6.154807886478424], accel: false },
    { fixture: "transcend-b", original: "day-b.MP4", extractor: "freegps", count: 2, first: 1535441845, last: 1535441846, position: [57, 41], speeds: [4.007004333662033, 6.154807886478424], accel: false },
    { fixture: "mikavi-a", original: "20210913120104_0000574A.MP4", extractor: "freegps", count: 60, first: 1631527264, last: 1631527322, position: [52, 16], speeds: [5.612583961502075, 13.879698884506226], accel: false, duration: 60, created: "2021-09-13T12:02:03.000Z" },
    { fixture: "mikavi-b", original: "20210913120104_0000575B.MP4", extractor: "freegps", count: 60, first: 1631527264, last: 1631527322, position: [52, 16], speeds: [5.612583961502075, 13.879698884506226], accel: false, duration: 60, created: "2021-09-13T12:02:04.000Z" },
    { fixture: "mikavi-c", original: "20210913120104_0000576C.MP4", extractor: "freegps", count: 60, first: 1631527264, last: 1631527324, position: [52, 16], speeds: [5.612583961502075, 13.992877192489624], accel: false, duration: 60, created: "2021-09-13T12:02:04.000Z" },
];

describe.each(FIXTURES)("real anonymized $fixture", (fixture) => {
    const bytes = readFileSync(new URL(`./${fixture.fixture}.mp4`, import.meta.url));

    it.each([fixture.original, "renamed.mp4"])("dispatches real telemetry independently of filename %s", async (name) => {
        const file = new File([bytes], name);
        const vf = { file, relativePath: name };
        const result = await dispatchParseVideoEmbeddedGps(await classifyFiles([vf]));
        expect(result.appliedExtractors).toEqual([fixture.extractor]);
        expect(result.errors).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(result.records).toHaveLength(fixture.count);
        expectPlausibleGpsTrack(result.records, { minCount: fixture.count });
        const first = result.records[0]!;
        const last = result.records.at(-1)!;
        expect(first.unixSeconds).toBeCloseTo(fixture.first, 5);
        expect(last.unixSeconds).toBeCloseTo(fixture.last, 5);
        expect(first.speedMs).toBeCloseTo(fixture.speeds[0], 8);
        expect(last.speedMs).toBeCloseTo(fixture.speeds[1], 8);
        expect(result.records.some((r) => r.accelXg || r.accelYg || r.accelZg)).toBe(fixture.accel);
        for (const record of result.records) {
            expect(record.lat).toBeCloseTo(fixture.position[0], 6);
            expect(record.lon).toBeCloseTo(fixture.position[1], 6);
            expect(record.active).toBe(true);
            expect(record.timeUnsynced).not.toBe(true);
            expect(record.mp4Filename).toBe(name);
            expect(record.speedMs).toBeGreaterThanOrEqual(0);
            expect(record.speedMs).toBeLessThan(60);
        }
    });

    it("contains replacement video and the retained container timing", async () => {
        expect(bytes.length).toBeLessThan(fixture.duration ? 5_000_000 : 100_000);
        const index = await buildMp4Index(new File([bytes], fixture.original));
        expect(index.durationSec).toBe(fixture.duration ?? 2);
        expect(index.createdUtc?.toISOString() ?? null).toBe(fixture.created ?? null);
        expect(index.tracks.filter((t) => t.handlerType === "vide").map((t) => t.sampleFormat)).toEqual(["avc1"]);
        expect(index.tracks.some((t) => t.handlerType === "soun")).toBe(false);
    });
});

it("keeps the Nextbase binary subtitle ahead of the text-only NMEA fallback", async () => {
    const bytes = readFileSync(new URL("./nextbase422.mp4", import.meta.url));
    const file = new File([bytes], "renamed.mp4");
    const vf = { file, relativePath: file.name };
    const index = await buildMp4Index(file);
    // Both recognize the real RMC carrier; only the binary extractor retains accel.
    expect(await nmeaSubtitlePrimitive.marker(vf, index)).toBe(true);
    const result = await dispatchParseVideoEmbeddedGps(await classifyFiles([vf]));
    expect(result.appliedExtractors).toEqual(["nextbase-subtitle"]);
    expect(result.records).toHaveLength(18);
    expect(result.records.some((r) => r.accelXg || r.accelYg || r.accelZg)).toBe(true);
    const track = index.tracks.find((t) => t.handlerType === "text")!;
    const samples = await loadTrackSampleBuffers(file, index, track);
    expect(samples).toHaveLength(20);
    for (const sample of samples!) {
        // The unused GGA twin also contained source coordinates and altitude.
        expect(new Uint8Array(sample).subarray(162).every((b) => b === 0)).toBe(true);
    }
});

it.each(["vantrue-a", "vantrue-b"])("clears the redundant binary coordinates in %s", (name) => {
    const bytes = readFileSync(new URL(`./${name}.mp4`, import.meta.url));
    const offsets: number[] = [];
    for (let at = bytes.indexOf("freeGPS "); at >= 0; at = bytes.indexOf("freeGPS ", at + 8)) offsets.push(at);
    expect(offsets).toHaveLength(60);
    for (const at of offsets) {
        for (const [start, end] of [[16, 24], [25, 36], [37, 52], [53, 88]]) {
            expect(bytes.subarray(at + start!, at + end!).every((b) => b === 0)).toBe(true);
        }
    }
});

it.each(["types-august", "types-december"])("clears GKU header data and coordinate twins in %s", async (name) => {
    const bytes = readFileSync(new URL(`./${name}.mp4`, import.meta.url));
    const index = await buildMp4Index(new File([bytes], `${name}.mp4`));
    const carrier = index.topLevelUdtaAtoms[0]!;
    const payload = bytes.subarray(carrier.offset + carrier.headerSize, carrier.offset + carrier.size);
    expect(payload.toString("ascii", 8, 24)).toBe("__V35AX_QVDATA__");
    const start = payload.readUInt32LE(0);
    expect(payload.subarray(24, start).every((b) => b === 0)).toBe(true);
    const matches = [...payload.subarray(start).toString("ascii").matchAll(/LIGOGPSINFO (\{[^}]+\})/g)];
    expect(matches).toHaveLength(2);
    for (const match of matches) {
        const record = JSON.parse(match[1]!) as Record<string, string>;
        expect(Number.isInteger(Number(record.Latitude))).toBe(true);
        expect(Number.isInteger(Number(record.Longitude))).toBe(true);
        expect(record.OLatitude).toBe("0");
        expect(record.OLongitude).toBe("0");
    }
});

// WR24 original-video gallery: https://www.wideorejestratory24.pl/kamera-samochodowa-vantrue-n2s
// --preserve-timing retains their movie clock/duration and complete native
// sample timing table. These recordings have 276-byte FMAS samples with no active
// status. They validate carrier recognition/no-fix handling, not mph vs km/h.
it.each(["vantrue-n2s-dzien-front", "vantrue-n2s-dzien-wnetrze", "vantrue-n2s-noc-front"])(
    "keeps the real %s FMAS no-fix carrier from producing a route",
    async (name) => {
        const bytes = readFileSync(new URL(`./${name}.mp4`, import.meta.url));
        const file = new File([bytes], `${name}.MP4`);
        const vf = { file, relativePath: file.name };
        const index = await buildMp4Index(file);
        expect(index.durationSec).toBe(60);
        expect(index.createdUtc?.toISOString()).toBe(name.includes("noc") ? "2020-11-05T19:32:27.000Z" : "2020-11-07T14:32:07.000Z");
        const track = index.tracks.find((t) => t.sampleFormat === "gpmd")!;
        expect(track).toBeDefined();
        const samples = await loadTrackSampleBuffers(file, index, track);
        const count = name.includes("noc") ? 197 : 196;
        expect(samples).toHaveLength(count);
        // This media track spans 9.8/9.85 s despite the 60 s movie; preserve
        // its actual clock geometry rather than spreading packets over 60 s.
        expect(readMediaTimescale(index.moovView!, track.trakBox)).toBe(120000);
        expect(readSampleDurationsInTicks(index.moovView!, track.trakBox)).toEqual(Array(count).fill(6000));
        for (const sample of samples!) {
            const raw = new Uint8Array(sample);
            expect(raw).toHaveLength(276);
            expect(hasFmasFirstSamplePrefix(raw)).toBe(true);
            expect(new TextDecoder().decode(raw.subarray(72, 84))).toBe("OFNIMMASSAMM");
            expect(raw[120]).not.toBe(65);
            // No copied coordinate, accel or unknown tail survives sanitization.
            expect(raw.subarray(103, 120).every((b) => b === 0)).toBe(true);
            expect(raw.subarray(123).every((b) => b === 0)).toBe(true);
        }
        expect(await vantrueFmasPrimitive.marker(vf, index)).toBe(true);
        await expect(vantrueFmasPrimitive.parse(vf, index)).rejects.toBeInstanceOf(WrongFormatError);
        const result = await dispatchParseVideoEmbeddedGps(await classifyFiles([vf]));
        expect(result.records).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(result.appliedExtractors).toEqual([]);
    },
);


it("keeps the timing fixtures' synthetic video streams distinct across camera channels", async () => {
    const names = ["mikavi-a", "mikavi-b", "mikavi-c", "vantrue-a", "vantrue-b", "vantrue-n2s-dzien-front", "vantrue-n2s-dzien-wnetrze", "vantrue-n2s-noc-front"];
    const hashes = [];
    for (const name of names) {
        const bytes = readFileSync(new URL(`./${name}.mp4`, import.meta.url));
        const index = await buildMp4Index(new File([bytes], `${name}.mp4`));
        const video = index.tracks.find((t) => t.handlerType === "vide")!;
        const first = readSampleTable(index.moovView!, video.trakBox)![0]!;
        hashes.push(createHash("sha256").update(bytes.subarray(first.offset, first.offset + first.size)).digest("hex"));
    }
    expect(new Set(hashes).size).toBe(names.length);
});
