// The map of all trips asks for every marker with its trip at once and redraws
// when any marker changes. Both must agree with the per-trip view the timeline
// uses.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip, TripTimeline, VideoCandidate } from "../trips.js";

// annotations.ts reaches folder-sources (-> icons/notifications, which want a
// DOM). Only the file->folder lookup is touched here.
vi.mock("./folder-sources.js", () => ({
    folderIdForFileKey: (_identityKey: string, sourceKey?: string) => (sourceKey ? `folder-${sourceKey}` : ""),
}));

import {
    _resetForTests,
    addMarker,
    deleteMarker,
    markersForTrip,
    markersWithTrips,
    subscribeMarkers,
    updateMarkerText,
} from "./annotations.js";
import { state } from "./state.js";

function buildTrip(file: File, startUtc: number): Trip {
    const durationSec = 60;
    const candidate = {
        file,
        relativePath: file.name,
        startUtc,
        durationSec,
        metadataReady: true,
    } as unknown as VideoCandidate;
    const timeline: TripTimeline = {
        contentDurationSec: durationSec,
        segments: [
            {
                contentStart: 0,
                contentEnd: durationSec,
                wallStart: startUtc,
                durationSec,
                wallDurationSec: durationSec,
                frameIndex: 0,
            },
        ],
        gaps: [],
    };
    return {
        frames: [{ startUtc, durationSec, wallDurationSec: durationSec, channels: { front: candidate } }],
        startUtc,
        endUtc: startUtc + durationSec,
        durationSec,
        timeline,
    } as unknown as Trip;
}

const START = 1_700_000_000;

describe("markersWithTrips", () => {
    beforeEach(() => {
        _resetForTests();
        state.trips = [];
    });

    it("lists every trip's markers with their trip, oldest first", () => {
        const morning = buildTrip(new File(["a"], "A.MP4", { lastModified: 1 }), START);
        const evening = buildTrip(new File(["b"], "B.MP4", { lastModified: 2 }), START + 36_000);
        state.trips = [evening, morning];
        const late = addMarker(evening, (START + 36_010) * 1000, "late");
        const early = addMarker(morning, (START + 20) * 1000, "early");

        const listed = markersWithTrips();
        expect(listed.map((item) => item.marker.id)).toEqual([early.id, late.id]);
        expect(listed.map((item) => item.trip)).toEqual([morning, evening]);
        expect(listed.filter((item) => item.trip === morning).map((item) => item.marker)).toEqual(
            markersForTrip(morning),
        );
    });

    it("leaves out deleted markers and markers of trips that are not loaded", () => {
        const trip = buildTrip(new File(["a"], "A.MP4", { lastModified: 1 }), START);
        state.trips = [trip];
        const kept = addMarker(trip, (START + 10) * 1000, "kept");
        const removed = addMarker(trip, (START + 20) * 1000, "removed");
        deleteMarker(removed.id);
        expect(markersWithTrips().map((item) => item.marker.id)).toEqual([kept.id]);

        state.trips = [];
        expect(markersWithTrips()).toEqual([]);
    });

    it("tells listeners once per task about marker edits", async () => {
        const trip = buildTrip(new File(["a"], "A.MP4", { lastModified: 1 }), START);
        state.trips = [trip];
        const listener = vi.fn();
        subscribeMarkers(listener);

        const marker = addMarker(trip, (START + 10) * 1000, "first");
        updateMarkerText(marker.id, "renamed");
        expect(listener, "not inside the edit").not.toHaveBeenCalled();
        await Promise.resolve();
        expect(listener).toHaveBeenCalledTimes(1);

        deleteMarker(marker.id);
        await Promise.resolve();
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
