import { describe, expect, it } from "vitest";

import {
    buildClipGpx,
    candidatesInRange,
    clipRecordsForRange,
    type FileSegment,
    rangeSourceBitrateBps,
    rangeSourceFps,
    sliceCandidatesForRange,
    sliceTripChannelForRange,
} from "./export-range.js";
import type { GpsRecord } from "./parsers/types.js";
import { buildTripTimeline, groupTrips, type TripFrame, type VideoCandidate } from "./trips.js";

/**
 * Segment over a synthetic file of `mb` megabytes lasting `fileSec`, of which
 * the range uses [from, to). File.size is stubbed rather than backed by real
 * bytes - allocating tens of megabytes per case buys nothing, and size is the
 * only input the File constructor cannot set directly.
 */
function segWithSize(opts: {
    mb: number;
    fileSec: number;
    from: number;
    to: number;
    fps?: number | null;
}): FileSegment {
    const file = new File([], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: opts.mb * 1_000_000, configurable: true });
    return {
        file,
        startInFile: opts.from,
        endInFile: opts.to,
        tripStart: 0,
        fps: opts.fps === undefined ? 30 : opts.fps,
        fileDurationSec: opts.fileSec,
    };
}

describe("rangeSourceFps", () => {
    it("takes the highest rate among the files the range touches", () => {
        const fps = rangeSourceFps([
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: 30 }),
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: 60 }),
        ]);
        expect(fps).toBe(60);
    });

    it("ignores files whose rate is unknown", () => {
        const fps = rangeSourceFps([
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: null }),
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: 25 }),
        ]);
        expect(fps).toBe(25);
    });

    it("rejects an implausible estimate rather than inflating the budget", () => {
        const fps = rangeSourceFps([
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: 30 }),
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: 100_000 }),
        ]);
        expect(fps).toBe(30);
    });

    it("returns null when no file reports a rate", () => {
        expect(rangeSourceFps([segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60, fps: null })])).toBeNull();
        expect(rangeSourceFps([])).toBeNull();
    });
});

describe("rangeSourceBitrateBps", () => {
    it("reads one file's own average rate", () => {
        // 60 MB over 60 s = 8 Mbps.
        const rate = rangeSourceBitrateBps([segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60 })]);
        expect(rate / 1e6).toBeCloseTo(8, 3);
    });

    it("is unaffected by how much of the file the range slices", () => {
        const whole = rangeSourceBitrateBps([segWithSize({ mb: 60, fileSec: 60, from: 0, to: 60 })]);
        const tenth = rangeSourceBitrateBps([segWithSize({ mb: 60, fileSec: 60, from: 10, to: 16 })]);
        expect(tenth).toBeCloseTo(whole, 3);
    });

    it("weights by used duration, so a brief dip into a thin file barely counts", () => {
        // 30 s of a 24 Mbps file plus 1 s of a 4 Mbps one.
        const rate = rangeSourceBitrateBps([
            segWithSize({ mb: 180, fileSec: 60, from: 0, to: 30 }),
            segWithSize({ mb: 30, fileSec: 60, from: 0, to: 1 }),
        ]);
        expect(rate / 1e6).toBeCloseTo((24 * 30 + 4 * 1) / 31, 2);
    });

    it("tracks the exported stretch rather than the whole trip", () => {
        // The busy file the user trimmed to, against the trip it sits in.
        const busy = segWithSize({ mb: 180, fileSec: 60, from: 0, to: 60 });
        const calm = segWithSize({ mb: 45, fileSec: 60, from: 0, to: 60 });
        const rangeOnly = rangeSourceBitrateBps([busy]);
        const wholeTrip = rangeSourceBitrateBps([busy, calm, calm, calm]);
        expect(rangeOnly).toBeGreaterThan(wholeTrip * 1.5);
    });

    it("returns 0 for a range that covers nothing", () => {
        expect(rangeSourceBitrateBps([])).toBe(0);
        expect(rangeSourceBitrateBps([segWithSize({ mb: 60, fileSec: 60, from: 12, to: 12 })])).toBe(0);
    });

    it("skips a file with no usable duration instead of dividing by zero", () => {
        const rate = rangeSourceBitrateBps([
            segWithSize({ mb: 60, fileSec: 0, from: 0, to: 10 }),
            segWithSize({ mb: 60, fileSec: 60, from: 0, to: 10 }),
        ]);
        expect(rate / 1e6).toBeCloseTo(8, 3);
    });
});

/** Minimal candidate for slicing tests - only placement inputs matter here. */
function makeCandidate(opts: {
    name: string;
    startUtc: number;
    durationSec: number;
    driftLeadSec?: number | null;
}): VideoCandidate {
    return {
        file: new File([new Uint8Array(16)], opts.name),
        relativePath: opts.name,
        fingerprint: "fp:cam",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: "rear",
        channelConfident: true,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc: opts.startUtc,
        durationSec: opts.durationSec,
        wallDurationSec: null,
        driftLeadSec: opts.driftLeadSec ?? null,
        startSource: "mp4",
        cameraTzSec: null,
        createdUtc: null,
        records: [],
        codec: null,
        codecParam: null,
        videoCodecString: null,
        rotation: 0,
        width: null,
        height: null,
        fps: null,
        audio: null,
        canPlay: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
}

function frameOf(startUtc: number, durationSec: number, candidate: VideoCandidate): TripFrame {
    return { startUtc, durationSec, wallDurationSec: durationSec, channels: { rear: candidate } };
}

function makeGpsRecord(unixSeconds: number, active = true): GpsRecord {
    return {
        unixSeconds,
        active,
        lat: 51,
        lon: 19,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "clip.mp4",
    };
}

describe("clipRecordsForRange", () => {
    it("counts the same valid fixes as the GPX file without dropping source telemetry", () => {
        const candidate = makeCandidate({ name: "clip.mp4", startUtc: 1000, durationSec: 60 });
        const trip = groupTrips([candidate])[0]!;
        const source = [
            { ...makeGpsRecord(1010), lat: 0, lon: 0, accelYg: 0.8 },
            { ...makeGpsRecord(1011), lat: 0 },
            makeGpsRecord(1012, false),
            { ...makeGpsRecord(1013), lon: 0 },
            { ...makeGpsRecord(1014), lat: 0, lon: 0 },
        ];
        trip.records = source;

        const selected = clipRecordsForRange(trip, 10, 14);
        const xml = buildClipGpx(trip, 10, 14);
        expect(selected).toEqual([source[1], source[3]]);
        expect(xml.match(/<trkpt /g)).toHaveLength(selected.length);
        expect(clipRecordsForRange(trip, 14, 14)).toEqual([]);
        expect(buildClipGpx(trip, 14, 14)).not.toContain("<trkpt ");
        expect(trip.records).toBe(source);
        expect(source[0]).toMatchObject({ unixSeconds: 1010, accelYg: 0.8 });
    });

    it("excludes GPX points at and beyond the fractional footage end", () => {
        const candidate = makeCandidate({ name: "clip.mp4", startUtc: 1000, durationSec: 60.37 });
        const trip = groupTrips([candidate])[0]!;
        trip.records = [999, 1000, 1020, 1060.36, 1060.37, 1100, 15000].map((unixSeconds) =>
            makeGpsRecord(unixSeconds),
        );

        const records = clipRecordsForRange(trip, 0, trip.timeline.contentDurationSec);
        expect(records.map((record) => record.unixSeconds)).toEqual([1000, 1020, 1060.36]);
    });

    it("keeps inclusive clip boundaries inside footage and excludes inactive points", () => {
        const candidate = makeCandidate({ name: "clip.mp4", startUtc: 1000, durationSec: 60 });
        const trip = groupTrips([candidate])[0]!;
        trip.records = [
            makeGpsRecord(1009),
            makeGpsRecord(1010),
            makeGpsRecord(1015, false),
            makeGpsRecord(1020),
            makeGpsRecord(1021),
        ];

        const records = clipRecordsForRange(trip, 10, 20);
        expect(records.map((record) => record.unixSeconds)).toEqual([1010, 1020]);
    });

    it("excludes pause points while preserving the following footage start", () => {
        const a = makeCandidate({ name: "a.mp4", startUtc: 1000, durationSec: 60 });
        const b = makeCandidate({ name: "b.mp4", startUtc: 1360, durationSec: 60 });
        const trip = groupTrips([a, b], Number.POSITIVE_INFINITY)[0]!;
        trip.records = [1058, 1059, 1060, 1200, 1359.999, 1360, 1400].map((unixSeconds) => makeGpsRecord(unixSeconds));

        const records = clipRecordsForRange(trip, 59, 100);
        expect(records.map((record) => record.unixSeconds)).toEqual([1059, 1360, 1400]);
    });
});

describe("sliceCandidatesForRange", () => {
    it("places files back-to-back and slices the overlap of each", () => {
        const a = makeCandidate({ name: "a.mp4", startUtc: 0, durationSec: 60 });
        const b = makeCandidate({ name: "b.mp4", startUtc: 60, durationSec: 60 });
        const timeline = buildTripTimeline([frameOf(0, 60, a), frameOf(60, 60, b)]);
        const segs = sliceCandidatesForRange([a, b], timeline, 30, 90);
        expect(segs).toHaveLength(2);
        expect(segs[0]!.startInFile).toBeCloseTo(30, 6);
        expect(segs[0]!.endInFile).toBeCloseTo(60, 6);
        expect(segs[1]!.startInFile).toBeCloseTo(0, 6);
        expect(segs[1]!.endInFile).toBeCloseTo(30, 6);
    });

    it("a drift lead shifts the file later, so the same range reads earlier file positions", () => {
        // Rear channel 2s ahead of its names (see channel-drift.ts): content for
        // trip time t lives at file position t - lead, and the first 2s of each
        // minute live in the PREVIOUS file's tail.
        const a = makeCandidate({ name: "a.mp4", startUtc: 0, durationSec: 60, driftLeadSec: 2.0 });
        const b = makeCandidate({ name: "b.mp4", startUtc: 60, durationSec: 60, driftLeadSec: 2.018 });
        const timeline = buildTripTimeline([frameOf(0, 60, a), frameOf(60, 60, b)]);
        const segs = sliceCandidatesForRange([a, b], timeline, 30, 90);
        expect(segs).toHaveLength(2);
        expect(segs[0]!.startInFile, "content for trip 30s sits 2s earlier in the file").toBeCloseTo(28, 6);
        expect(segs[0]!.endInFile, "previous file covers up to its shifted end").toBeCloseTo(60, 6);
        expect(segs[1]!.startInFile).toBeCloseTo(0, 6);
        expect(segs[1]!.endInFile).toBeCloseTo(90 - 62.018, 6);
    });

    it("candidatesInRange returns the overlapping candidates themselves", () => {
        // The export decode preflight walks candidates (not file slices) to
        // find an undecodable source - the selection must match the slicer's.
        const a = makeCandidate({ name: "a.mp4", startUtc: 0, durationSec: 60 });
        const b = makeCandidate({ name: "b.mp4", startUtc: 60, durationSec: 60 });
        const timeline = buildTripTimeline([frameOf(0, 60, a), frameOf(60, 60, b)]);
        const before = candidatesInRange([a, b], timeline, 0, 50);
        expect(before.map((e) => e.candidate)).toEqual([a]);
        const spanning = candidatesInRange([a, b], timeline, 30, 90);
        expect(spanning.map((e) => e.candidate)).toEqual([a, b]);
        expect(spanning[1]!.fileStart).toBeCloseTo(60, 6);
    });

    it("exports unequal camera cuts once at their original file positions", () => {
        const interior = makeCandidate({ name: "interior.mp4", startUtc: 1000, durationSec: 92 });
        interior.channel = "interior";
        const exterior = [0, 26, 52, 78].map((offset) => {
            const candidate = makeCandidate({
                name: `exterior-${offset}.mp4`,
                startUtc: 1000 + offset,
                durationSec: 26,
            });
            candidate.channel = "front";
            return candidate;
        });
        const trip = groupTrips([interior, ...exterior])[0]!;
        expect(trip.timeline.contentDurationSec).toBe(104);

        const inside = sliceTripChannelForRange(trip, "interior", 50, 80);
        expect(inside).toHaveLength(1);
        expect(inside[0]).toMatchObject({ file: interior.file, startInFile: 50, endInFile: 80, tripStart: 0 });

        const outside = sliceTripChannelForRange(trip, "front", 50, 80);
        expect(outside.map(({ startInFile, endInFile }) => [startInFile, endInFile])).toEqual([
            [24, 26],
            [0, 26],
            [0, 2],
        ]);
        expect(outside.reduce((total, segment) => total + segment.endInFile - segment.startInFile, 0)).toBe(30);
    });

    it("exports overlapping files in the same order as interval playback", () => {
        const front = makeCandidate({ name: "front.mp4", startUtc: 1000, durationSec: 92 });
        front.channel = "front";
        const interior = makeCandidate({ name: "interior.mp4", startUtc: 1000, durationSec: 92 });
        interior.channel = "interior";
        const overlap = makeCandidate({ name: "short-front.mp4", startUtc: 1026, durationSec: 10 });
        overlap.channel = "front";
        const trip = groupTrips([front, interior, overlap])[0]!;
        expect(trip.frames.some((frame) => frame.mediaOffsetSec)).toBe(true);

        const slices = sliceTripChannelForRange(trip, "front", 20, 40);
        expect(slices.map(({ file, startInFile, endInFile }) => [file.name, startInFile, endInFile])).toEqual([
            [front.file.name, 20, 26],
            [overlap.file.name, 0, 10],
            [front.file.name, 36, 40],
        ]);
        expect(slices.reduce((total, slice) => total + slice.endInFile - slice.startInFile, 0)).toBe(20);
    });

    it("the shifted tail file ends exactly where the other channel's tail ends", () => {
        // The session tail pair: front 23s, rear 19s with a 4s lead - both
        // channels stopped at the same wall instant, so on the content axis the
        // shifted rear tail must end at the same point as the front tail (83s).
        const full = makeCandidate({ name: "r0.mp4", startUtc: 0, durationSec: 60, driftLeadSec: 3.98 });
        const tail = makeCandidate({ name: "r1.mp4", startUtc: 60, durationSec: 19, driftLeadSec: 4 });
        const timeline = buildTripTimeline([frameOf(0, 60, full), frameOf(60, 23, tail)]);
        expect(timeline.contentDurationSec, "front-anchored axis ends at the front tail").toBeCloseTo(83, 6);
        const segs = sliceCandidatesForRange([full, tail], timeline, 73, 83);
        expect(segs).toHaveLength(1);
        expect(segs[0]!.startInFile).toBeCloseTo(9, 6);
        expect(segs[0]!.endInFile, "last rear content second aligns with the stop instant").toBeCloseTo(19, 6);
    });
});
