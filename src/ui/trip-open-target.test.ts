import { describe, expect, it } from "vitest";

import type { Trip, VideoCandidate } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";

import {
    captureTripMomentTarget,
    captureTripOpenTarget,
    closestEventIndex,
    resolveTripOpenTarget,
    withPreparedRecordingKeys,
} from "./trip-open-target.js";

function candidate(file: File, relativePath: string, sourceKey = "card-a"): VideoCandidate {
    return { file, relativePath, sourceKey } as VideoCandidate;
}

function trip(
    candidates: VideoCandidate[],
    options: { startUtc?: number; endUtc?: number; eventUtc?: number } = {},
): Trip {
    return {
        startUtc: options.startUtc ?? 100,
        endUtc: options.endUtc ?? 200,
        events: options.eventUtc === undefined ? [] : [{ unixSeconds: options.eventUtc }],
        frames: candidates.map((item) => ({ channels: { front: item } })),
    } as unknown as Trip;
}

describe("trip-open target identity", () => {
    it("follows a recording after container repair replaces its File object", () => {
        const original = new File(["abc"], "clip.mp4", { lastModified: 42 });
        const clicked = trip([candidate(original, "Normal/clip.mp4")]);
        const target = captureTripOpenTarget([clicked], 0);
        expect(target).not.toBeNull();

        // Container repair makes a new File with the same source metadata, then
        // the closing regroup can move it to another positional trip index.
        const repaired = new File(["xyz"], "clip.mp4", { lastModified: 42 });
        const unrelated = new File(["abc"], "clip.mp4", { lastModified: 42 });
        const regrouped = [
            trip([candidate(unrelated, "Normal/clip.mp4", "card-b")]),
            trip([candidate(repaired, "Normal/clip.mp4")]),
        ];

        expect(resolveTripOpenTarget(regrouped, target!)).toEqual({ tripIdx: 1, frameIdx: 0 });
    });

    it("keeps an exact clip row exact while carrying the whole-trip join identity", () => {
        const first = candidate(new File(["a"], "a.mp4"), "a.mp4");
        const second = candidate(new File(["b"], "b.mp4"), "b.mp4");
        const target = captureTripOpenTarget([trip([first, second])], 0, 1);

        expect(target?.exactFrame).toBe(true);
        expect(target?.keys).toHaveLength(1);
        expect(target?.tripKeys).toHaveLength(2);
    });

    it("opens a reused recording at its first playback interval", () => {
        const long = candidate(new File(["long"], "long.mp4"), "InternalView/long.mp4");
        const target = captureTripOpenTarget([trip([long])], 0);
        const regrouped = trip([long, long, long]);
        expect(resolveTripOpenTarget([regrouped], target!)).toEqual({ tripIdx: 0, frameIdx: 0 });
    });

    it("opens the newly starting interior file when the exterior continues", () => {
        const front = candidate(new File(["front"], "front.mp4"), "ExteriorView/front.mp4");
        const before = candidate(new File(["before"], "before.mp4"), "InternalView/before.mp4");
        const next = candidate(new File(["next"], "next.mp4"), "InternalView/next.mp4");
        const recording = trip([]);
        recording.frames = [
            {
                startUtc: 78,
                durationSec: 14,
                wallDurationSec: 14,
                channels: { front, interior: before },
                mediaOffsetSec: { front: 0, interior: 78 },
            },
            {
                startUtc: 92,
                durationSec: 12,
                wallDurationSec: 12,
                channels: { front, interior: next },
                mediaOffsetSec: { front: 14, interior: 0 },
            },
        ];
        const target = captureTripOpenTarget([recording], 0, 1);
        expect(resolveTripOpenTarget([recording], target!)).toEqual({ tripIdx: 0, frameIdx: 1 });
        const prepared = withPreparedRecordingKeys(target!, [vendorFileKey(front), vendorFileKey(next)]);
        expect(
            resolveTripOpenTarget([recording], prepared),
            "preparation preserves the clicked interior start",
        ).toEqual({
            tripIdx: 0,
            frameIdx: 1,
        });
    });

    it("drops unreadable captured recordings after metadata preparation", () => {
        const unreadable = candidate(new File(["bad"], "bad.mp4"), "bad.mp4");
        const playable = candidate(new File(["good"], "good.mp4"), "good.mp4");
        const recording = trip([unreadable, playable]);
        const target = captureTripOpenTarget([recording], 0)!;
        const prepared = withPreparedRecordingKeys(target, [vendorFileKey(playable)]);

        expect(prepared.keys).toEqual([vendorFileKey(playable)]);
        expect(prepared.tripKeys).toEqual(target.tripKeys);
        expect(resolveTripOpenTarget([recording], prepared)).toEqual({ tripIdx: 0, frameIdx: 1 });
    });

    it("resolves a rebuilt event to the surviving trip nearest its original UTC", () => {
        const first = candidate(new File(["a"], "a.mp4"), "a.mp4");
        const second = candidate(new File(["b"], "b.mp4"), "b.mp4");
        const target = captureTripOpenTarget([trip([first, second], { eventUtc: 1_050 })], 0, undefined, 0);
        expect(target).not.toBeNull();

        const split = [
            trip([first], { startUtc: 100, endUtc: 200 }),
            trip([second], { startUtc: 1_000, endUtc: 1_100 }),
        ];
        expect(resolveTripOpenTarget(split, target!)).toEqual({ tripIdx: 1, frameIdx: 0 });
    });

    it("opens a place pass in the rebuilt trip that contains its moment", () => {
        const first = candidate(new File(["a"], "a.mp4"), "a.mp4");
        const second = candidate(new File(["b"], "b.mp4"), "b.mp4");
        const target = captureTripMomentTarget([trip([first, second])], 0, 1_020);
        expect(target?.momentUtc).toBe(1_020);
        expect(target?.exactFrame).toBe(false);

        const split = [
            trip([first], { startUtc: 100, endUtc: 200 }),
            trip([second], { startUtc: 1_000, endUtc: 1_100 }),
        ];
        expect(resolveTripOpenTarget(split, target!)).toEqual({ tripIdx: 1, frameIdx: 0 });
    });

    it("finds the closest rebuilt event", () => {
        expect(closestEventIndex([{ unixSeconds: 10 }, { unixSeconds: 30 }, { unixSeconds: 80 }], 27)).toBe(1);
        expect(closestEventIndex([], 27)).toBe(-1);
    });
});
