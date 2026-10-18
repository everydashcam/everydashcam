import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupTrips, rederiveStartUtcForCandidates, type VideoCandidate } from "../../../trips.js";
import { buildProvisionalCandidate } from "../../../ui/ingest-candidate.js";
import { vendorFileKey } from "../../../vendor-file-key.js";
import { cameraFingerprint } from "../../camera-fingerprint.js";
import { classifyFilenameTime } from "../../filename/index.js";
import { buildMp4Index } from "../../internal/mp4-index.js";
import { readMediaTimescale, readSampleDurationsInTicks } from "../../internal/mp4-walker.js";
import { sstarSsmdPrimitive } from "../../primitives/sstar-ssmd.js";
import { classifyFiles, dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { expectPlausibleGpsTrack, makeVendorFile } from "../helpers.js";

// GPS-only fixtures retain the real sample cadence; video, audio and sibling
// metadata tracks are removed by scripts/anonymize-sstar-ssmd-mp4.mjs.
const CLIPS = [
    { path: "Normal/F/REC20260913-125420-1370.mp4", count: 61 },
    { path: "Normal/R/REC20260913-125420-1334.mp4", count: 61 },
    { path: "Event/F/SOS20260913-125521-1371.mp4", count: 60 },
    { path: "Event/R/SOS20260913-125521-1335.mp4", count: 60 },
    { path: "Normal/F/REC20260913-125622-1372.mp4", count: 60 },
    { path: "Normal/R/REC20260913-125622-1336.mp4", count: 61 },
    { path: "Parking/F/PAR20260913-121858-1.mp4", count: 4 },
    { path: "Parking/R/PAR20260913-121858-1.mp4", count: 4 },
];

function fixture(path: string, name?: string) {
    const bytes = readFileSync(new URL(`./ddmm-dual/${path}`, import.meta.url));
    return makeVendorFile(`card/${path}`, bytes, name);
}

describe("real-anonymized iBox RoadScan 2K dual-channel card", () => {
    it("keeps independent channel counters and interleaved event clips in paired frames", async () => {
        const files = CLIPS.map(({ path }) => fixture(path));
        const parsed = await dispatchParseVideoEmbeddedGps(await classifyFiles(files));
        expect(parsed.appliedExtractors).toEqual(["sstar-ssmd"]);
        expect(parsed.errors).toEqual([]);
        expect(parsed.records).toHaveLength(CLIPS.reduce((sum, clip) => sum + clip.count, 0));
        const candidates: VideoCandidate[] = [];
        for (const [i, file] of files.entries()) {
            const index = await buildMp4Index(file.file);
            expect(index.tracks.map((track) => [track.handlerType, track.sampleFormat])).toEqual([["meta", "ssmd"]]);
            expect(file.file.size).toBeLessThan(5_000_000);
            const result = await sstarSsmdPrimitive.parse(file, index);
            const records = parsed.records.filter((record) => record.videoKey === vendorFileKey(file));
            expect(records).toHaveLength(CLIPS[i]!.count);
            expect(result.records).toHaveLength(CLIPS[i]!.count);
            expect(result.skipped).toEqual([]);
            expectPlausibleGpsTrack(result.records, { minCount: CLIPS[i]!.count });
            for (const [j, record] of result.records.entries()) {
                expect(record.lat).toBe(Math.round(record.lat));
                expect(record.lon).toBe(Math.round(record.lon));
                expect(record.timeUnsynced).toBeUndefined();
                expect(record.unixSeconds).toBe(result.records[0]!.unixSeconds + j);
                expect(record.speedMs).toBeGreaterThanOrEqual(0);
                expect(record.speedMs).toBeLessThan(200 / 3.6);
            }
            const track = index.tracks[0]!;
            const durations = readSampleDurationsInTicks(index.moovView!, track.trakBox)!;
            const durationSec = durations.reduce((sum, duration) => sum + duration, 0) / readMediaTimescale(index.moovView!, track.trakBox)!;
            const candidate = buildProvisionalCandidate({
                file,
                fingerprint: cameraFingerprint(file),
                startUtc: 0,
                startSource: "mtime",
                cameraTzSec: null,
                durationSec,
                records,
                appliedExtractors: parsed.appliedExtractors,
            });
            candidate.embeddedStartUtcHint = parsed.videoStartUtcHintByFileKey.get(vendorFileKey(file)) ?? null;
            expect(candidate.embeddedStartUtcHint).toBe(result.videoStartUtcHint);
            candidates.push(candidate);
        }
        rederiveStartUtcForCandidates(candidates, classifyFilenameTime);
        expect(new Set(candidates.map((candidate) => candidate.fingerprint)).size).toBe(1);
        expect(candidates.every((candidate) => candidate.channelConfident && candidate.startSource === "embedded")).toBe(true);
        expect(candidates.map((candidate) => candidate.sequence)).toEqual([1370, 1334, 1371, 1335, 1372, 1336, 1, 1]);
        const trips = groupTrips(candidates);
        expect(trips).toHaveLength(2);
        expect(trips.map((trip) => trip.frames.map((frame) => Object.values(frame.channels).map((clip) => clip!.recordingMode)))).toEqual([
            [["parking", "parking"]],
            [["normal", "normal"], ["event", "event"], ["normal", "normal"]],
        ]);
        for (const trip of trips) {
            for (const frame of trip.frames) {
                expect(Object.keys(frame.channels).sort()).toEqual(["front", "rear"]);
                expect(Math.abs(frame.channels.front!.startUtc - frame.channels.rear!.startUtc)).toBeLessThanOrEqual(1);
            }
        }
        expect(candidates[0]!.startUtc).toBe(Date.UTC(2026, 8, 13, 9, 54, 20) / 1000);
        expect(candidates[1]!.startUtc).toBe(candidates[0]!.startUtc + 1);
        expect(candidates[6]!.file.name).toBe(candidates[7]!.file.name);
        expect(vendorFileKey(files[6]!)).not.toBe(vendorFileKey(files[7]!));
    });

    it("skips a real loss of fix without admitting its local RTC into the GPS clock", async () => {
        const file = fixture("Event/F/SOS20260913-130326-1379.mp4");
        const result = await sstarSsmdPrimitive.parse(file, await buildMp4Index(file.file));
        expectPlausibleGpsTrack(result.records, { minCount: 51 });
        expect(result.records).toHaveLength(51);
        expect(result.skipped).toEqual([]);
        const start = Date.UTC(2026, 8, 13, 10, 3, 26) / 1000;
        expect(result.videoStartUtcHint).toBe(start);
        expect(result.records[0]!.unixSeconds).toBe(start);
        expect(result.records[23]!.unixSeconds).toBe(start + 23);
        expect(result.records[24]!.unixSeconds).toBe(start + 33);
        expect(result.records.at(-1)!.unixSeconds).toBe(start + 59);
        for (const record of result.records) {
            expect(record.lat).toBe(Math.round(record.lat));
            expect(record.lon).toBe(Math.round(record.lon));
            expect(record.timeUnsynced).toBeUndefined();
        }
    });

    it("keeps staggered unsynced sibling samples on their source clocks", async () => {
        const candidates: VideoCandidate[] = [];
        for (const [path, name] of [
            ["Normal/F/REC20260913-125420-1370.mp4", "REC20260913-125620-1370.mp4"],
            ["Normal/R/REC20260913-125420-1334.mp4", "REC20260913-125621-1334.mp4"],
        ] as const) {
            // Renaming makes the recorded GPS clock stale; the real sample
            // timestamps still provide each channel's distinct media offsets.
            const file = fixture(path, name);
            const index = await buildMp4Index(file.file);
            const result = await sstarSsmdPrimitive.parse(file, index);
            expect(result.records).toHaveLength(61);
            expect(result.videoStartUtcHint).toBeUndefined();
            expect(result.records.every((record) => record.timeUnsynced && record.unixSeconds === 0)).toBe(true);
            const track = index.tracks[0]!;
            const durations = readSampleDurationsInTicks(index.moovView!, track.trakBox)!;
            const durationSec =
                durations.reduce((sum, duration) => sum + duration, 0) /
                readMediaTimescale(index.moovView!, track.trakBox)!;
            const candidate = buildProvisionalCandidate({
                file,
                fingerprint: cameraFingerprint(file),
                startUtc: 0,
                startSource: "mtime",
                cameraTzSec: null,
                durationSec,
                records: result.records,
                appliedExtractors: ["sstar-ssmd"],
            });
            candidate.createdUtc = index.createdUtc;
            candidates.push(candidate);
        }
        rederiveStartUtcForCandidates(candidates, classifyFilenameTime);
        const front = candidates[0]!;
        const rear = candidates[1]!;
        expect(candidates.map((candidate) => candidate.channel)).toEqual(["front", "rear"]);
        expect(candidates.every((candidate) => candidate.startSource === "name")).toBe(true);
        expect(front.fingerprint).toBe(rear.fingerprint);
        expect(rear.startUtc).toBe(front.startUtc + 1);

        // Anonymization rounds both tracks to one position. Their telemetry
        // proves that the rear starts at the front's second fix, not its first.
        expect(front.records[0]).toMatchObject({ speedMs: 0, bearingDeg: 178, relStartSeconds: 0 });
        expect(rear.records[0]).toMatchObject({
            lat: front.records[0]!.lat,
            lon: front.records[0]!.lon,
            speedMs: front.records[1]!.speedMs,
            bearingDeg: front.records[1]!.bearingDeg,
            relStartSeconds: 0,
        });
        expect(rear.records[0]!.speedMs).toBeCloseTo(2 / 3.6);
        expect(rear.records[0]!.bearingDeg).toBe(172);
        expect(front.records[1]!.relStartSeconds).toBeCloseTo(0.9899444444444444);

        const trips = groupTrips(candidates);
        expect(trips).toHaveLength(1);
        expect(trips[0]!.frames).toHaveLength(1);
        expect(Object.keys(trips[0]!.frames[0]!.channels).sort()).toEqual(["front", "rear"]);
        const rearRecords = trips[0]!.records.filter((record) => record.mp4Filename === rear.file.name);
        expect(rearRecords).toHaveLength(rear.records.length);
        for (const [i, record] of rearRecords.entries()) {
            expect(record.relStartSeconds).toBeCloseTo(rear.records[i]!.relStartSeconds!, 8);
            expect(record.speedMs).toBeCloseTo(rear.records[i]!.speedMs);
            expect(record.bearingDeg).toBe(rear.records[i]!.bearingDeg);
            expect(record.unixSeconds).toBeCloseTo(rear.startUtc + record.relStartSeconds!, 5);
        }
    });

    it.each([
        ["Event/F/SOS20260913-125521-1371.mp4", "SOS20260913-125721-1371.mp4"],
        ["Parking/F/PAR20260913-121858-1.mp4", "PAR20260913-122058-1.mp4"],
    ])("withholds a stale GPS clock when the %s filename disagrees", async (path, name) => {
        const file = fixture(path, name);
        const result = await sstarSsmdPrimitive.parse(file, await buildMp4Index(file.file));
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.videoStartUtcHint).toBeUndefined();
        expect(result.records.every((record) => record.timeUnsynced && record.unixSeconds === 0)).toBe(true);
    });
});
