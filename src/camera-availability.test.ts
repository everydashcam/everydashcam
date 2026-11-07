import { describe, expect, it } from "vitest";

import {
    anyCameraRecords,
    cameraAvailabilitySpans,
    frameCameraAvailability,
    firstRecordingChannel,
    pairedTailHold,
} from "./camera-availability.js";
import type { Channel } from "./parsers/types.js";
import { groupTrips, type TripFrame, type VideoCandidate } from "./trips.js";

function makeCandidate(opts: {
    name: string;
    startUtc: number;
    durationSec: number;
    channel: Channel;
}): VideoCandidate {
    return {
        file: new File([new Uint8Array(16)], opts.name),
        relativePath: opts.name,
        fingerprint: "fp:cam",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: opts.channel,
        channelConfident: true,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc: opts.startUtc,
        durationSec: opts.durationSec,
        wallDurationSec: null,
        driftLeadSec: null,
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

function clip(channel: Channel, startUtc: number, durationSec: number): VideoCandidate {
    const letter = channel === "front" ? "F" : channel === "rear" ? "R" : "I";
    return makeCandidate({ name: `${startUtc}${letter}.ts`, startUtc, durationSec, channel });
}

describe("pairedTailHold", () => {
    function pair(startUtc: number, frontDur: number, rearDur: number): VideoCandidate[] {
        return [
            makeCandidate({ name: `${startUtc}F.ts`, startUtc, durationSec: frontDur, channel: "front" }),
            makeCandidate({ name: `${startUtc}R.ts`, startUtc, durationSec: rearDur, channel: "rear" }),
        ];
    }

    it("holds the shorter channel's last frame through its sibling's tail", () => {
        const [front, rear] = pair(1000, 60.08, 60.091);
        const frames = groupTrips([front!, rear!])[0]!.frames;
        expect(frames.map((frame) => Object.keys(frame.channels))).toEqual([["front", "rear"], ["rear"]]);
        expect(pairedTailHold(frames[1]!, "front")).toBe(front);
        expect(pairedTailHold(frames[1]!, "rear"), "present channel").toBeNull();
        expect(pairedTailHold(frames[0]!, "front"), "first frame").toBeNull();
    });

    it("holds each pair's shorter channel between sequential pairs", () => {
        const first = pair(1000, 60, 60.5);
        const second = pair(1060, 35.56, 35.2);
        const frames = groupTrips([...first, ...second])[0]!.frames;
        expect(frames.map((frame) => Object.keys(frame.channels).sort().join("+"))).toEqual([
            "front+rear",
            "rear",
            "front+rear",
            "front",
        ]);
        expect(pairedTailHold(frames[1]!, "front")).toBe(first[0]);
        expect(pairedTailHold(frames[2]!, "front"), "channel back in the next pair").toBeNull();
        expect(pairedTailHold(frames[3]!, "rear")).toBe(second[1]);
    });

    it("holds through consecutive tails of a three-camera set", () => {
        const front = makeCandidate({ name: "1000F.ts", startUtc: 1000, durationSec: 60, channel: "front" });
        const rear = makeCandidate({ name: "1000R.ts", startUtc: 1000, durationSec: 60.2, channel: "rear" });
        const interior = makeCandidate({ name: "1000I.ts", startUtc: 1000, durationSec: 60.4, channel: "interior" });
        const frames = groupTrips([front, rear, interior])[0]!.frames;
        expect(frames.map((frame) => Object.keys(frame.channels).sort().join("+"))).toEqual([
            "front+interior+rear",
            "interior+rear",
            "interior",
        ]);
        expect(pairedTailHold(frames[1]!, "front")).toBe(front);
        expect(pairedTailHold(frames[2]!, "front"), "second tail").toBe(front);
        expect(pairedTailHold(frames[2]!, "rear")).toBe(rear);
    });

    it("stops holding once the tails outlast the hold limit", () => {
        const front = makeCandidate({ name: "1000F.ts", startUtc: 1000, durationSec: 60, channel: "front" });
        const rear = makeCandidate({ name: "1000R.ts", startUtc: 1000, durationSec: 61.5, channel: "rear" });
        const interior = makeCandidate({ name: "1000I.ts", startUtc: 1000, durationSec: 62.5, channel: "interior" });
        const frames = groupTrips([front, rear, interior])[0]!.frames;
        expect(frames).toHaveLength(3);
        expect(pairedTailHold(frames[1]!, "front"), "1.5 s tail").toBe(front);
        expect(pairedTailHold(frames[2]!, "front"), "2.5 s of tails").toBeNull();
        expect(pairedTailHold(frames[2]!, "rear"), "1 s tail").toBe(rear);
    });

    it("holds a pair's shorter channel when another camera is cut independently", () => {
        // One interior file spans both pairs, so the trip goes through the
        // independent-cut splitter rather than splitting pair by pair.
        const first = pair(1000, 60, 60.5);
        const second = pair(1060.5, 60, 60.5);
        const interior = makeCandidate({ name: "1000I.ts", startUtc: 1000, durationSec: 121, channel: "interior" });
        const frames = groupTrips([...first, ...second, interior])[0]!.frames;
        expect(frames.map((frame) => Object.keys(frame.channels).sort().join("+"))).toEqual([
            "front+interior+rear",
            "interior+rear",
            "front+interior+rear",
            "interior+rear",
        ]);
        expect(pairedTailHold(frames[1]!, "front")).toBe(first[0]);
        expect(pairedTailHold(frames[3]!, "front")).toBe(second[0]);
        expect(pairedTailHold(frames[2]!, "front"), "front back in the next pair").toBeNull();
        expect(pairedTailHold(frames[3]!, "interior"), "independent camera still plays").toBeNull();
    });

    it("shows nothing for a camera that stopped long before its sibling", () => {
        const [front, rear] = pair(1000, 30, 60);
        const frames = groupTrips([front!, rear!])[0]!.frames;
        expect(frames.map((frame) => Object.keys(frame.channels).sort().join("+"))).toEqual(["front+rear", "rear"]);
        expect(pairedTailHold(frames[1]!, "front")).toBeNull();
    });

    it("holds nothing in an interval the trip did not mark as a paired tail", () => {
        // An independently cut camera or a recording gap: the interval lacks
        // the front, but no pair ended into it.
        const rear = makeCandidate({ name: "0R.mp4", startUtc: 0, durationSec: 61, channel: "rear" });
        const frame: TripFrame = {
            startUtc: 60,
            durationSec: 1,
            wallDurationSec: 1,
            channels: { rear },
            mediaOffsetSec: { rear: 60 },
        };
        expect(pairedTailHold(frame, "front")).toBeNull();
    });
});

describe("frameCameraAvailability", () => {
    const front = clip("front", 0, 60);
    const rear = clip("rear", 0, 60);
    const frame = (channels: TripFrame["channels"]): TripFrame => ({
        startUtc: 0,
        durationSec: 60,
        wallDurationSec: 60,
        channels,
    });

    it("keeps the arrangement order while the main camera records", () => {
        const availability = frameCameraAvailability(frame({ front, rear }), ["front", "rear"], "main");
        expect(availability).toEqual({ order: ["front", "rear"], presence: { front: "recording", rear: "recording" } });
    });

    it("lets the next camera with footage stand in for a main camera without any", () => {
        const availability = frameCameraAvailability(frame({ rear }), ["front", "interior", "rear"], "main");
        expect(availability.order, "the stand-in trades places, the others stay").toEqual([
            "rear",
            "interior",
            "front",
        ]);
        expect(availability.presence).toEqual({ front: "absent", interior: "absent", rear: "recording" });
    });

    it("keeps every camera in place in equal mode", () => {
        const availability = frameCameraAvailability(frame({ rear }), ["front", "rear"], "equal");
        expect(availability.order).toEqual(["front", "rear"]);
    });

    it("keeps the order when no visible camera records", () => {
        const availability = frameCameraAvailability(frame({ rear }), ["front", "interior"], "main");
        expect(availability.order).toEqual(["front", "interior"]);
        expect(firstRecordingChannel(frame({ rear }), ["front", "interior"])).toBeNull();
        expect(firstRecordingChannel(frame({ rear }), ["front", "rear"])).toBe("rear");
    });
});

describe("cameraAvailabilitySpans", () => {
    it("keeps a paired tail's camera in the main place", () => {
        const trip = groupTrips([clip("front", 1000, 60), clip("rear", 1000, 60.5)])[0]!;
        const spans = cameraAvailabilitySpans(trip, ["front", "rear"], "main", 0, trip.timeline.contentDurationSec);
        expect(spans.map((span) => span.availability)).toEqual([
            { order: ["front", "rear"], presence: { front: "recording", rear: "recording" } },
            { order: ["front", "rear"], presence: { front: "held-tail", rear: "recording" } },
        ]);
        expect(spans[0]!.endSec).toBeCloseTo(60, 6);
        expect(spans[1]!.endSec).toBeCloseTo(60.5, 6);
    });

    it("swaps in a stand-in for a late main camera and back once it records", () => {
        // The rear starts 20 s before the front; the front then runs to the end.
        const trip = groupTrips([clip("rear", 1000, 80), clip("front", 1020, 60)])[0]!;
        const spans = cameraAvailabilitySpans(trip, ["front", "rear"], "main", 0, trip.timeline.contentDurationSec);
        expect(spans.map((span) => span.availability.order)).toEqual([
            ["rear", "front"],
            ["front", "rear"],
        ]);
        expect(spans[0]!.availability.presence.front).toBe("absent");
        expect(spans[0]!.endSec).toBeCloseTo(20, 6);
    });

    it("marks a camera without footage in the middle of a trip as absent", () => {
        const trip = groupTrips([
            clip("front", 1000, 60),
            clip("rear", 1000, 60),
            clip("front", 1060, 60),
            clip("front", 1120, 60),
            clip("rear", 1120, 60),
        ])[0]!;
        const spans = cameraAvailabilitySpans(trip, ["front", "rear"], "main", 0, trip.timeline.contentDurationSec);
        expect(spans.map((span) => span.availability.presence.rear)).toEqual(["recording", "absent", "recording"]);
        expect(spans.map((span) => [Math.round(span.startSec), Math.round(span.endSec)])).toEqual([
            [0, 60],
            [60, 120],
            [120, 180],
        ]);
    });

    it("clips the spans to the requested range and merges unchanged intervals", () => {
        const trip = groupTrips([
            clip("front", 1000, 60),
            clip("rear", 1000, 60),
            clip("front", 1060, 60),
            clip("rear", 1060, 60),
        ])[0]!;
        const spans = cameraAvailabilitySpans(trip, ["front", "rear"], "main", 30, 90);
        expect(spans).toHaveLength(1);
        expect(spans[0]!.startSec).toBeCloseTo(30, 6);
        expect(spans[0]!.endSec).toBeCloseTo(90, 6);
    });

    it("reports whether any visible camera records in a range", () => {
        const trip = groupTrips([clip("front", 1000, 60), clip("rear", 1000, 60)])[0]!;
        expect(anyCameraRecords(trip, ["rear"], 0, 60)).toBe(true);
        expect(anyCameraRecords(trip, ["interior"], 0, 60)).toBe(false);
    });
});
