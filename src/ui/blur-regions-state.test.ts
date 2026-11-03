import { beforeEach, describe, expect, it } from "vitest";

import { createBlurRegion } from "../blur-regions.js";
import { groupTrips, type Trip, type VideoCandidate } from "../trips.js";
import {
    _resetForTests,
    activeBlurRegions,
    addBlurRegion,
    carryBlurRegions,
    setDroppedRegionPassCanceller,
    subscribeBlurRegions,
    subscribeBlurTripRegroup,
} from "./blur-regions-state.js";
import { state } from "./state.js";

function candidate(name: string, startUtc: number): VideoCandidate {
    return {
        file: new File(["video"], name),
        relativePath: name,
        fingerprint: "generic",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: "front",
        channelConfident: true,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc,
        durationSec: 60,
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

function activate(trip: Trip): void {
    state.trips = [trip];
    state.active = { trip: 0, frame: 0 };
}

function addRegion(): ReturnType<typeof createBlurRegion> {
    const region = createBlurRegion("front", "fill", 10, 20, 10, {
        xPct: 0.1,
        yPct: 0.2,
        wPct: 0.3,
        hPct: 0.4,
    });
    addBlurRegion(region);
    return region;
}

beforeEach(() => {
    _resetForTests();
    state.trips = [];
    state.active = null;
});

describe("blur region regroup", () => {
    it("keeps zone objects and Follow work across unchanged footage rebuilds", () => {
        const files = [candidate("first.mp4", 1000), candidate("second.mp4", 1060)];
        const old = groupTrips(files)[0]!;
        activate(old);
        const region = addRegion();
        const cancelled: string[] = [];
        setDroppedRegionPassCanceller((id) => cancelled.push(id));
        const next = groupTrips(files)[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()[0]).toBe(region);
        expect(cancelled).toEqual([]);
    });

    it("keeps zones when absolute clock corrections preserve footage offsets", () => {
        const files = [candidate("first.mp4", 1000), candidate("second.mp4", 1060)];
        const old = groupTrips(files)[0]!;
        activate(old);
        const region = addRegion();
        for (const file of files) file.startUtc += 3600;
        const next = groupTrips(files)[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()[0]).toBe(region);
    });

    it("keeps zones when paired GPS clocks change without moving footage", () => {
        const front = candidate("front.mp4", 1000);
        const rear = candidate("rear.mp4", 1006);
        front.durationSec = 45;
        rear.durationSec = 46;
        rear.channel = "rear";
        const old = groupTrips([front, rear])[0]!;
        activate(old);
        const region = addRegion();
        rear.startUtc = 994;
        const next = groupTrips([front, rear])[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()[0]).toBe(region);
    });

    it("drops zones when interval ownership changes within the same files", () => {
        const front = candidate("front.mp4", 1000);
        const rear = candidate("rear.mp4", 1000);
        front.durationSec = 20;
        rear.durationSec = 60;
        rear.channel = "rear";
        const old = groupTrips([front, rear])[0]!;
        activate(old);
        addRegion();
        const next: Trip = {
            ...old,
            frames: old.frames.map((frame) => ({
                ...frame,
                mediaOffsetSec: { ...frame.mediaOffsetSec, rear: (frame.mediaOffsetSec?.rear ?? 0) + 1 },
            })),
        };
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()).toEqual([]);
    });

    it("drops zones when the same files change camera assignments", () => {
        const file = candidate("front.mp4", 1000);
        const old = groupTrips([file])[0]!;
        activate(old);
        const region = addRegion();
        const cancelled: string[] = [];
        setDroppedRegionPassCanceller((id) => cancelled.push(id));
        file.channel = "rear";
        const next = groupTrips([file])[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()).toEqual([]);
        expect(cancelled).toEqual([region.id]);
    });

    it("drops zones when later files reorder without changing the first file", () => {
        const files = [candidate("first.mp4", 1000), candidate("second.mp4", 1060), candidate("third.mp4", 1120)];
        const old = groupTrips(files)[0]!;
        activate(old);
        addRegion();
        files[1]!.startUtc = 1120;
        files[2]!.startUtc = 1060;
        const next = groupTrips(files)[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()).toEqual([]);
    });

    it.each(["drift", "rotation", "duration"] as const)(
        "drops zones when %s changes on a shared candidate object",
        (changed) => {
            const file = candidate("front.mp4", 1000);
            const old = groupTrips([file])[0]!;
            activate(old);
            addRegion();
            if (changed === "drift") file.driftLeadSec = 0.25;
            if (changed === "rotation") file.rotation = 90;
            if (changed === "duration") file.durationSec = 30;
            const next = groupTrips([file])[0]!;
            activate(next);

            carryBlurRegions([old], [next]);

            expect(activeBlurRegions()).toEqual([]);
        },
    );

    it("drops zones when a merged trip adds footage", () => {
        const file = candidate("first.mp4", 1000);
        const old = groupTrips([file])[0]!;
        activate(old);
        addRegion();
        const next = groupTrips([file, candidate("second.mp4", 1060)])[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()).toEqual([]);
    });

    it("does not cancel Follow for a trip whose object is retained", () => {
        const trip = groupTrips([candidate("front.mp4", 1000)])[0]!;
        activate(trip);
        const region = addRegion();
        const cancelled: string[] = [];
        setDroppedRegionPassCanceller((id) => cancelled.push(id));

        carryBlurRegions([trip], [trip]);

        expect(activeBlurRegions()[0]).toBe(region);
        expect(cancelled).toEqual([]);
    });

    it("captures timing when the first zone is added after an empty list read", () => {
        const file = candidate("front.mp4", 1000);
        const old = groupTrips([file])[0]!;
        activate(old);
        activeBlurRegions();
        file.driftLeadSec = 0.25;
        const region = addRegion();
        const next = groupTrips([file])[0]!;
        activate(next);

        carryBlurRegions([old], [next]);

        expect(activeBlurRegions()[0]).toBe(region);
    });

    it("invalidates changed source pixels even when the Trip object is retained", () => {
        const file = candidate("front.mp4", 1000);
        const trip = groupTrips([file])[0]!;
        activate(trip);
        addRegion();
        file.rotation = 90;

        carryBlurRegions([trip], [trip]);

        expect(activeBlurRegions()).toEqual([]);
    });

    it("notifies detection regroup subscribers when no manual zones exist", () => {
        const file = candidate("front.mp4", 1000);
        const old = groupTrips([file]);
        const next = groupTrips([file]);
        const notifications: Array<{ oldTrips: readonly Trip[]; newTrips: readonly Trip[] }> = [];
        const unsubscribe = subscribeBlurTripRegroup((oldTrips, newTrips) =>
            notifications.push({ oldTrips, newTrips }),
        );

        carryBlurRegions(old, next);
        unsubscribe();

        expect(notifications).toEqual([{ oldTrips: old, newTrips: next }]);
    });

    it("reports invalidated zones when some source footage survives a regroup", () => {
        const file = candidate("front.mp4", 1000);
        const old = groupTrips([file])[0]!;
        activate(old);
        addRegion();
        const counts: number[] = [];
        const unsubscribe = subscribeBlurTripRegroup((_old, _next, count) => counts.push(count));
        file.channel = "rear";
        const next = groupTrips([file])[0]!;
        activate(next);

        carryBlurRegions([old], [next]);
        unsubscribe();

        expect(counts).toEqual([1]);
    });

    it("does not report lost zones when their source footage is removed", () => {
        const old = groupTrips([candidate("front.mp4", 1000)])[0]!;
        activate(old);
        addRegion();
        const counts: number[] = [];
        const unsubscribe = subscribeBlurTripRegroup((_old, _next, count) => counts.push(count));
        const next = groupTrips([candidate("other.mp4", 2000)])[0]!;
        activate(next);

        carryBlurRegions([old], [next]);
        unsubscribe();

        expect(counts).toEqual([0]);
    });

    it("ignores adding a zone when no trip is active", () => {
        let notifications = 0;
        subscribeBlurRegions(() => notifications++);

        addRegion();

        expect(activeBlurRegions()).toEqual([]);
        expect(notifications).toBe(0);
    });
});
