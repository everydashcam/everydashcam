import { describe, expect, it } from "vitest";

import { pairedTailHoldCandidate, resolveSlaveTarget } from "./player-slave-target.js";
import type { Channel } from "../parsers/types.js";
import { groupTrips, type TripFrame, type VideoCandidate } from "../trips.js";

function makeCandidate(opts: {
    name: string;
    startUtc: number;
    durationSec: number;
    driftLeadSec?: number | null;
    canPlay?: boolean;
    isTransportStream?: boolean;
    channel?: Channel;
}): VideoCandidate {
    return {
        file: new File([new Uint8Array(16)], opts.name),
        relativePath: opts.name,
        fingerprint: "fp:cam",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: opts.channel ?? null,
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
        canPlay: opts.canPlay ?? true,
        needsHevcRemux: false,
        isTransportStream: opts.isTransportStream ?? false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
}

interface PairSpec {
    startUtc: number;
    frontDur?: number;
    rearDur?: number;
    frontLead?: number | null;
    rearLead?: number | null;
    rearCanPlay?: boolean;
    rearMse?: boolean;
    noRear?: boolean;
}

function makeFrames(specs: PairSpec[]): TripFrame[] {
    return specs.map((spec) => {
        const front = makeCandidate({
            name: `t${spec.startUtc}F.mp4`,
            startUtc: spec.startUtc,
            durationSec: spec.frontDur ?? 60,
            driftLeadSec: spec.frontLead ?? null,
        });
        const channels: TripFrame["channels"] = { front };
        if (!spec.noRear) {
            channels.rear = makeCandidate({
                name: `t${spec.startUtc}R.mp4`,
                startUtc: spec.startUtc,
                durationSec: spec.rearDur ?? 60,
                driftLeadSec: spec.rearLead ?? null,
                canPlay: spec.rearCanPlay,
                isTransportStream: spec.rearMse,
            });
        }
        const durationSec = Math.max(spec.frontDur ?? 60, spec.rearDur ?? 60);
        return { startUtc: spec.startUtc, durationSec, wallDurationSec: durationSec, channels };
    });
}

describe("resolveSlaveTarget", () => {
    it("aligns reused files across interval boundaries with either camera as master", () => {
        const frames = makeFrames([{ startUtc: 26, frontDur: 26, rearDur: 92 }]);
        const frame = frames[0]!;
        frame.channels.rear!.startUtc = 0;
        frame.mediaOffsetSec = { front: 0, rear: 26 };
        expect(resolveSlaveTarget(frames, 0, "front", "rear", 7)?.positionSec).toBe(33);
        expect(resolveSlaveTarget(frames, 0, "rear", "front", 33)?.positionSec).toBe(7);
    });

    it("mirrors the master position exactly when no channel carries a lead", () => {
        const frames = makeFrames([{ startUtc: 0 }, { startUtc: 60 }]);
        const target = resolveSlaveTarget(frames, 1, "front", "rear", 12.34);
        expect(target?.cand).toBe(frames[1]!.channels.rear);
        expect(target?.positionSec).toBeCloseTo(12.34, 9);
    });

    it("returns null for a channel absent from the frame", () => {
        const frames = makeFrames([{ startUtc: 0, noRear: true }]);
        expect(resolveSlaveTarget(frames, 0, "front", "rear", 10)).toBeNull();
    });

    it("offsets a drifting slave by its lead inside the frame", () => {
        // Rear content is 3s ahead of its names: master at 10s = rear file at 7s.
        const frames = makeFrames([
            { startUtc: 0, rearLead: 2.98 },
            { startUtc: 60, rearLead: 3.0 },
        ]);
        const target = resolveSlaveTarget(frames, 1, "front", "rear", 10);
        expect(target?.cand).toBe(frames[1]!.channels.rear);
        expect(target?.positionSec).toBeCloseTo(7.0, 9);
    });

    it("reaches into the previous file's tail for the start of a drifting slave's window", () => {
        // Master at 1s, rear lead 3s: the moment lives at 58s of the previous rear file.
        const frames = makeFrames([
            { startUtc: 0, rearLead: 2.98 },
            { startUtc: 60, rearLead: 3.0 },
        ]);
        const target = resolveSlaveTarget(frames, 1, "front", "rear", 1);
        expect(target?.cand).toBe(frames[0]!.channels.rear);
        expect(target?.positionSec).toBeCloseTo(1 + 60 - 2.98, 9);
    });

    it("reaches into the next file early when the DRIFTING channel is the master", () => {
        // User prefers rear (lead 3s): near the master file's end the front
        // slave must already show the next front file.
        const frames = makeFrames([
            { startUtc: 0, rearLead: 3.0 },
            { startUtc: 60, rearLead: 3.02 },
        ]);
        const target = resolveSlaveTarget(frames, 0, "rear", "front", 58);
        expect(target?.cand).toBe(frames[1]!.channels.front);
        expect(target?.positionSec).toBeCloseTo(58 - 60 + 3.0, 9);
    });

    it("crosses into the next file when the master file simply outlasts the slave file", () => {
        // Healthy camera, stamped durations differ a fraction: front 60.03s,
        // rear 60.00s, seamless naming - the last 30ms of the master's file
        // corresponds to the first 30ms of the next rear file.
        const frames = makeFrames([
            { startUtc: 0, frontDur: 60.03, rearDur: 60.0 },
            { startUtc: 60, frontDur: 60.03, rearDur: 60.0 },
        ]);
        const target = resolveSlaveTarget(frames, 0, "front", "rear", 60.02);
        expect(target?.cand).toBe(frames[1]!.channels.rear);
        expect(target?.positionSec).toBeCloseTo(0.02, 9);
    });

    it("holds at the own file's edge when the next frame starts after a gap", () => {
        // 20s recording gap: the moment past the slave file's end exists on no
        // file - the raw out-of-range position tells the caller to hold.
        const frames = makeFrames([{ startUtc: 0, frontDur: 60.03, rearDur: 60.0 }, { startUtc: 80 }]);
        const target = resolveSlaveTarget(frames, 0, "front", "rear", 60.02);
        expect(target?.cand).toBe(frames[0]!.channels.rear);
        expect(target?.positionSec).toBeCloseTo(60.02, 9);
    });

    it("rejects an overlapping protected copy whose file does not hold the moment", () => {
        // An event copy starts 2s after the normal clip and lasts 30s; the
        // master's position 59.9s maps to 57.9s of the copy - beyond its end,
        // so the resolver must not jump into it.
        const frames = makeFrames([
            { startUtc: 0, frontDur: 60.03, rearDur: 59.9 },
            { startUtc: 2, frontDur: 30, rearDur: 30 },
        ]);
        const target = resolveSlaveTarget(frames, 0, "front", "rear", 59.95);
        expect(target?.cand).toBe(frames[0]!.channels.rear);
        expect(target?.positionSec).toBeCloseTo(59.95, 9);
    });

    it("stays in-frame at a trip edge where no previous file exists", () => {
        const frames = makeFrames([{ startUtc: 0, rearLead: 3.0 }]);
        const target = resolveSlaveTarget(frames, 0, "front", "rear", 1);
        expect(target?.cand).toBe(frames[0]!.channels.rear);
        expect(target?.positionSec, "raw negative position = hold at 0").toBeCloseTo(-2.0, 9);
    });

    it("does not cross into a neighbour that cannot play natively", () => {
        const unplayable = makeFrames([
            { startUtc: 0, rearLead: 2.98, rearCanPlay: false },
            { startUtc: 60, rearLead: 3.0 },
        ]);
        expect(resolveSlaveTarget(unplayable, 1, "front", "rear", 1)?.cand).toBe(unplayable[1]!.channels.rear);
        const mseOnly = makeFrames([
            { startUtc: 0, rearLead: 2.98, rearMse: true },
            { startUtc: 60, rearLead: 3.0 },
        ]);
        expect(resolveSlaveTarget(mseOnly, 1, "front", "rear", 1)?.cand).toBe(mseOnly[1]!.channels.rear);
    });

    it("keeps the pair aligned through the window regardless of which channel is master", () => {
        // Same wall moment resolved from both masters must agree: front at t
        // and rear at t-lead describe the same instant.
        const frames = makeFrames([
            { startUtc: 0, rearLead: 2.98 },
            { startUtc: 60, rearLead: 3.0 },
        ]);
        const lead = 3.0;
        const fromFront = resolveSlaveTarget(frames, 1, "front", "rear", 10);
        const fromRear = resolveSlaveTarget(frames, 1, "rear", "front", 10 - lead);
        expect(fromFront?.positionSec).toBeCloseTo(10 - lead, 9);
        expect(fromRear?.positionSec).toBeCloseTo(10, 9);
    });
});

describe("pairedTailHoldCandidate", () => {
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
        expect(pairedTailHoldCandidate(frames, 1, "front")).toBe(front);
        expect(pairedTailHoldCandidate(frames, 1, "rear"), "present channel").toBeNull();
        expect(pairedTailHoldCandidate(frames, 0, "front"), "first frame").toBeNull();
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
        expect(pairedTailHoldCandidate(frames, 1, "front")).toBe(first[0]);
        expect(pairedTailHoldCandidate(frames, 2, "front"), "channel back in the next pair").toBeNull();
        expect(pairedTailHoldCandidate(frames, 3, "rear")).toBe(second[1]);
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
        expect(pairedTailHoldCandidate(frames, 1, "front")).toBe(front);
        expect(pairedTailHoldCandidate(frames, 2, "front"), "second tail").toBe(front);
        expect(pairedTailHoldCandidate(frames, 2, "rear")).toBe(rear);
    });

    it("stops holding once the tails outlast the hold limit", () => {
        const front = makeCandidate({ name: "1000F.ts", startUtc: 1000, durationSec: 60, channel: "front" });
        const rear = makeCandidate({ name: "1000R.ts", startUtc: 1000, durationSec: 61.5, channel: "rear" });
        const interior = makeCandidate({ name: "1000I.ts", startUtc: 1000, durationSec: 62.5, channel: "interior" });
        const frames = groupTrips([front, rear, interior])[0]!.frames;
        expect(frames).toHaveLength(3);
        expect(pairedTailHoldCandidate(frames, 1, "front"), "1.5 s tail").toBe(front);
        expect(pairedTailHoldCandidate(frames, 2, "front"), "2.5 s of tails").toBeNull();
        expect(pairedTailHoldCandidate(frames, 2, "rear"), "1 s tail").toBe(rear);
    });

    describe("against a front+rear pair whose rear outlasts the front", () => {
        function pairWithTail(frontDurationSec: number, rearDurationSec: number) {
            const front = makeCandidate({
                name: "0F.mp4",
                startUtc: 0,
                durationSec: frontDurationSec,
                channel: "front",
            });
            const rear = makeCandidate({ name: "0R.mp4", startUtc: 0, durationSec: rearDurationSec, channel: "rear" });
            const tailSec = rearDurationSec - frontDurationSec;
            const frames: TripFrame[] = [
                {
                    startUtc: 0,
                    durationSec: frontDurationSec,
                    wallDurationSec: frontDurationSec,
                    channels: { front, rear },
                    mediaOffsetSec: { front: 0, rear: 0 },
                },
                {
                    startUtc: frontDurationSec,
                    durationSec: tailSec,
                    wallDurationSec: tailSec,
                    channels: { rear },
                    mediaOffsetSec: { rear: frontDurationSec },
                },
            ];
            return { front, frames };
        }

        it("holds the front through a short tail", () => {
            const { front, frames } = pairWithTail(60, 61);
            expect(pairedTailHoldCandidate(frames, 1, "front")).toBe(front);
        });

        it("shows nothing for a camera that stopped long before its sibling", () => {
            const { frames } = pairWithTail(30, 60);
            expect(pairedTailHoldCandidate(frames, 1, "front")).toBeNull();
        });

        it("shows nothing across a recording gap", () => {
            const { frames } = pairWithTail(60, 61);
            frames[1]!.startUtc += 0.5;
            expect(pairedTailHoldCandidate(frames, 1, "front")).toBeNull();
        });

        it("shows nothing when the sibling does not play on from the pair", () => {
            const { frames } = pairWithTail(60, 61);
            const nextRear = makeCandidate({ name: "60R.mp4", startUtc: 60, durationSec: 1, channel: "rear" });
            frames[1]!.channels = { rear: nextRear };
            frames[1]!.mediaOffsetSec = { rear: 0 };
            expect(pairedTailHoldCandidate(frames, 1, "front")).toBeNull();
        });
    });
});
