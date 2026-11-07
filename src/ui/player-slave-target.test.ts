import { describe, expect, it } from "vitest";

import { nativeSlaveSyncStep, resolveSlaveTarget } from "./player-slave-target.js";
import type { Channel } from "../parsers/types.js";
import type { TripFrame, VideoCandidate } from "../trips.js";

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

describe("nativeSlaveSyncStep", () => {
    const TOLERANCE_SEC = 0.15;
    const playing = { currentTime: 30, duration: 60, paused: false, ended: false };

    it("leaves a slave within the tolerance alone", () => {
        expect(nativeSlaveSyncStep(30.1, playing, TOLERANCE_SEC)).toEqual({
            shouldPause: false,
            seekSec: null,
            shouldResume: false,
        });
    });

    it("seeks a slave that drifted past the tolerance", () => {
        expect(nativeSlaveSyncStep(31, playing, TOLERANCE_SEC)).toEqual({
            shouldPause: false,
            seekSec: 31,
            shouldResume: false,
        });
    });

    it("holds the boundary frame where no file serves the moment", () => {
        expect(nativeSlaveSyncStep(61, { ...playing, currentTime: 59.5 }, TOLERANCE_SEC), "past the end").toEqual({
            shouldPause: true,
            seekSec: 60,
            shouldResume: false,
        });
        expect(nativeSlaveSyncStep(-1, { ...playing, currentTime: 0.1 }, TOLERANCE_SEC), "before the start").toEqual({
            shouldPause: true,
            seekSec: null,
            shouldResume: false,
        });
    });

    it("resumes a slave whose moment is back inside its file", () => {
        expect(nativeSlaveSyncStep(30, { ...playing, paused: true }, TOLERANCE_SEC)).toEqual({
            shouldPause: false,
            seekSec: null,
            shouldResume: true,
        });
    });

    it("keeps an ended slave that ran ahead of its master on its last frame", () => {
        const ended = { currentTime: 60, duration: 60, paused: true, ended: true };
        expect(nativeSlaveSyncStep(59.9, ended, TOLERANCE_SEC)).toEqual({
            shouldPause: false,
            seekSec: null,
            shouldResume: false,
        });
    });

    it("seeks an ended slave back before resuming it", () => {
        // play() on an ended element would restart its file from 0.
        const ended = { currentTime: 60, duration: 60, paused: true, ended: true };
        expect(nativeSlaveSyncStep(12, ended, TOLERANCE_SEC)).toEqual({
            shouldPause: false,
            seekSec: 12,
            shouldResume: true,
        });
    });
});
