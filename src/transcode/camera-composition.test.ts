import { describe, expect, it } from "vitest";

import type { Channel } from "../parsers/types.js";
import { groupTrips, type VideoCandidate } from "../trips.js";
import { type CameraArrangement, createCompositionCursor, planCompositionSpans } from "./camera-composition.js";

function clip(channel: Channel, startUtc: number, durationSec: number): VideoCandidate {
    const letter = channel === "front" ? "F" : channel === "rear" ? "R" : "I";
    const name = `${startUtc}${letter}.ts`;
    return {
        file: new File([new Uint8Array(16)], name),
        relativePath: name,
        fingerprint: "fp:cam",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel,
        channelConfident: true,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc,
        durationSec,
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

const MAIN: CameraArrangement = { mode: "main", thumbScale: null, allowOverlay: false, overlayPositions: {} };
const WIDE = 16 / 9;

describe("planCompositionSpans", () => {
    it("lays a late main camera's place out for its stand-in, then for the main camera", () => {
        // The rear starts 20 s before the front.
        const trip = groupTrips([clip("rear", 1000, 80), clip("front", 1020, 60)])[0]!;
        const spans = planCompositionSpans({
            trip,
            channels: ["front", "rear"],
            arrangement: MAIN,
            aspects: { front: WIDE, rear: WIDE },
            width: 1280,
            height: 720,
            startSec: 0,
            endSec: trip.timeline.contentDurationSec,
        });
        expect(spans).toHaveLength(2);
        const [early, late] = spans;
        expect(early!.tiles.map((tile) => [tile.channel, tile.role])).toEqual([
            ["rear", "main"],
            ["front", "thumb"],
        ]);
        expect(early!.presence.front).toBe("absent");
        expect(early!.backdrop, "the stand-in is blurred behind the frame").toBe("rear");
        expect(late!.tiles.map((tile) => [tile.channel, tile.role])).toEqual([
            ["front", "main"],
            ["rear", "thumb"],
        ]);
        expect(late!.backdrop).toBe("front");
        expect(early!.endSec).toBeCloseTo(20, 6);
        expect(late!.startSec).toBeCloseTo(20, 6);
    });

    it("keeps a camera without footage in its place in equal mode", () => {
        const trip = groupTrips([
            clip("front", 1000, 60),
            clip("rear", 1000, 30),
            clip("front", 1060, 60),
            clip("rear", 1090, 30),
        ])[0]!;
        const spans = planCompositionSpans({
            trip,
            channels: ["front", "rear"],
            arrangement: { ...MAIN, mode: "equal" },
            aspects: { front: WIDE, rear: WIDE },
            width: 1280,
            height: 720,
            startSec: 0,
            endSec: trip.timeline.contentDurationSec,
        });
        const gap = spans.find((span) => span.presence.rear === "absent");
        const full = spans.find((span) => span.presence.rear === "recording");
        expect(gap, "the rear has a gap").toBeDefined();
        expect(gap!.tiles).toEqual(full!.tiles);
        expect(gap!.backdrop).toBe("front");
    });

    it("lays tiles out in output pixels without gaps between them", () => {
        const trip = groupTrips([clip("front", 1000, 60), clip("rear", 1000, 60)])[0]!;
        const [span] = planCompositionSpans({
            trip,
            channels: ["front", "rear"],
            arrangement: { ...MAIN, mode: "equal" },
            aspects: { front: WIDE, rear: WIDE },
            width: 1080,
            height: 1920,
            startSec: 0,
            endSec: 60,
        });
        // Two 16:9 cameras in a 9:16 frame stack, each the full width.
        const [top, bottom] = span!.tiles;
        expect(top!.w).toBeCloseTo(1080, 6);
        expect(bottom!.w).toBeCloseTo(1080, 6);
        expect(bottom!.y).toBeCloseTo(top!.y + top!.h, 6);
    });

    it("plans one span with every camera absent for a range outside the timeline", () => {
        const trip = groupTrips([clip("front", 1000, 10), clip("rear", 1000, 10)])[0]!;
        const spans = planCompositionSpans({
            trip,
            channels: ["front", "rear"],
            arrangement: MAIN,
            aspects: {},
            width: 640,
            height: 360,
            startSec: 50,
            endSec: 60,
        });
        expect(spans).toHaveLength(1);
        expect(spans[0]!.presence).toEqual({ front: "absent", rear: "absent" });
        expect(spans[0]!.backdrop).toBeNull();
        expect(spans[0]!.tiles).toHaveLength(2);
    });
});

describe("createCompositionCursor", () => {
    it("walks forward through spans and stays on the last one past the end", () => {
        const trip = groupTrips([clip("rear", 1000, 80), clip("front", 1020, 60)])[0]!;
        const spans = planCompositionSpans({
            trip,
            channels: ["front", "rear"],
            arrangement: MAIN,
            aspects: {},
            width: 1280,
            height: 720,
            startSec: 0,
            endSec: trip.timeline.contentDurationSec,
        });
        const at = createCompositionCursor(spans);
        expect(at(0)).toBe(spans[0]);
        expect(at(19.99)).toBe(spans[0]);
        expect(at(20)).toBe(spans[1]);
        expect(at(trip.timeline.contentDurationSec + 0.01)).toBe(spans[1]);
    });
});
