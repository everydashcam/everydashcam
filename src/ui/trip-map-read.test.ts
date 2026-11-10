// "Read now" walks the trips the list shows and reads the GPS tracks that wait
// inside their videos. Each read can regroup the trips, so the walk must find
// every trip again by its recordings, never by a remembered index.

import { beforeEach, describe, expect, it } from "vitest";

import type { ClassifiedFile } from "../parsers/registry.js";
import type { Trip, VideoCandidate } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";
import { state } from "./state.js";
import { _resetForTests as resetSearch, setTripMapScope } from "./trip-map-search.js";
import {
    _resetForTests,
    startReadingTracks,
    stopReadingTracks,
    subscribeTrackRead,
    trackReadProgress,
    untrackedTrips,
    type TripGpsReader,
} from "./trip-map-read.js";

function buildCandidate(name: string): VideoCandidate {
    return {
        file: new File([name], name, { lastModified: 1 }),
        relativePath: name,
        startUtc: 1_700_000_000,
        durationSec: 60,
        metadataReady: true,
    } as unknown as VideoCandidate;
}

function buildTrip(...candidates: VideoCandidate[]): Trip {
    return {
        frames: candidates.map((candidate) => ({ channels: { front: candidate } })),
    } as unknown as Trip;
}

function markUnread(candidate: VideoCandidate): string {
    const key = vendorFileKey(candidate);
    state.pendingHeavyEmbeddedGps.set(key, { file: candidate } as unknown as ClassifiedFile);
    return key;
}

/** A reader that reads the trip's pending files the way the loader does. */
function readingReader(log: string[]): TripGpsReader {
    return async (tripIndex) => {
        const trip = state.trips[tripIndex]!;
        for (const frame of trip.frames) {
            const candidate = frame.channels.front!;
            log.push(candidate.relativePath);
            state.pendingHeavyEmbeddedGps.delete(vendorFileKey(candidate));
        }
        return "ready";
    };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("trip map reading", () => {
    beforeEach(() => {
        _resetForTests();
        resetSearch();
        state.trips = [];
        state.pendingHeavyEmbeddedGps.clear();
        state.inflightEmbeddedGps.clear();
        state.failedEmbeddedGps.clear();
    });

    it("tells trips with an unread track from trips without GPS", () => {
        const unread = buildCandidate("A.MP4");
        const failed = buildCandidate("B.MP4");
        const reading = buildCandidate("C.MP4");
        state.trips = [buildTrip(unread), buildTrip(failed), buildTrip(reading), buildTrip(buildCandidate("D.MP4"))];
        markUnread(unread);
        // A failed read stays pending for a retry from its trip; here it counts as no GPS.
        state.failedEmbeddedGps.add(markUnread(failed));
        state.inflightEmbeddedGps.set(vendorFileKey(reading), 1);

        expect(untrackedTrips()).toEqual({ withoutGps: 2, unread: 2 });
    });

    it("counts only the trips the list shows", () => {
        const first = buildCandidate("A.MP4");
        const second = buildCandidate("B.MP4");
        state.trips = [buildTrip(first), buildTrip(second)];
        markUnread(first);
        markUnread(second);
        setTripMapScope([1]);

        expect(untrackedTrips()).toEqual({ withoutGps: 0, unread: 1 });
    });

    it("reads the shown trips in list order and reports progress", async () => {
        const first = buildCandidate("A.MP4");
        const second = buildCandidate("B.MP4");
        const hidden = buildCandidate("C.MP4");
        state.trips = [buildTrip(first), buildTrip(hidden), buildTrip(second)];
        for (const candidate of [first, second, hidden]) markUnread(candidate);
        setTripMapScope([0, 2]);
        const progress: (string | null)[] = [];
        subscribeTrackRead(() => {
            const current = trackReadProgress();
            progress.push(current ? `${current.done}/${current.total}` : null);
        });
        const read: string[] = [];

        startReadingTracks(readingReader(read));
        await settle();

        expect(read).toEqual(["A.MP4", "B.MP4"]);
        expect(progress).toEqual(["0/2", "1/2", "2/2", null]);
        expect(state.pendingHeavyEmbeddedGps.has(vendorFileKey(hidden)), "the hidden trip waits").toBe(true);
    });

    it("finds a trip again by its recordings after a read regroups the list", async () => {
        const first = buildCandidate("A.MP4");
        const second = buildCandidate("B.MP4");
        const third = buildCandidate("C.MP4");
        state.trips = [buildTrip(first), buildTrip(second), buildTrip(third)];
        for (const candidate of [first, second, third]) markUnread(candidate);
        const read: string[] = [];
        const inner = readingReader(read);
        let isFirstRead = true;
        startReadingTracks(async (tripIndex, signal) => {
            const result = await inner(tripIndex, signal);
            if (isFirstRead) {
                isFirstRead = false;
                // The read moved the clock: the second and third trips merge and land first.
                state.trips = [buildTrip(second, third), state.trips[0]!];
            }
            return result;
        });
        await settle();

        expect(read).toEqual(["A.MP4", "B.MP4", "C.MP4"]);
        expect(state.pendingHeavyEmbeddedGps.size).toBe(0);
        expect(trackReadProgress()).toBeNull();
    });

    it("goes on past a failed trip and stops when a trip open takes over", async () => {
        const candidates = ["A.MP4", "B.MP4", "C.MP4"].map(buildCandidate);
        state.trips = candidates.map((candidate) => buildTrip(candidate));
        for (const candidate of candidates) markUnread(candidate);
        const results: ("failed" | "ready" | "cancelled")[] = ["failed", "cancelled", "ready"];
        const asked: number[] = [];
        startReadingTracks(async (tripIndex) => {
            asked.push(tripIndex);
            return results.shift()!;
        });
        await settle();

        expect(asked).toEqual([0, 1]);
        expect(trackReadProgress()).toBeNull();
    });

    it("stops on request and passes the stop to the read in flight", async () => {
        const candidates = ["A.MP4", "B.MP4"].map(buildCandidate);
        state.trips = candidates.map((candidate) => buildTrip(candidate));
        for (const candidate of candidates) markUnread(candidate);
        let seenSignal: AbortSignal | null = null;
        const asked: number[] = [];
        startReadingTracks(
            (tripIndex, signal) =>
                new Promise((resolve) => {
                    asked.push(tripIndex);
                    seenSignal = signal;
                    signal.addEventListener("abort", () => resolve("cancelled"));
                }),
        );
        expect(trackReadProgress()).toEqual({ done: 0, total: 2 });

        stopReadingTracks();
        await settle();

        expect(seenSignal!.aborted).toBe(true);
        expect(asked).toEqual([0]);
        expect(trackReadProgress()).toBeNull();
    });

    it("does nothing when no shown trip has an unread track", () => {
        state.trips = [buildTrip(buildCandidate("A.MP4"))];
        let calls = 0;
        startReadingTracks(async () => {
            calls++;
            return "ready";
        });

        expect(calls).toBe(0);
        expect(trackReadProgress()).toBeNull();
    });
});
