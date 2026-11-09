// What the map of all trips filters the trip list by: the chosen place with
// every trip's passes through it, and the routes crossing the map's frame.
// Owns `state.tripFilters.place` and `.mapArea`; the list asks it for each
// trip's facts and pass times. No MapLibre and no DOM, so the list can use it
// while the map itself is hidden.

import { createSubscribers } from "../subscribers.js";
import { NO_TRIP_MAP_FACTS, type TripMapFacts } from "../trip-filters.js";
import { trackIntersectsArea, tripPassesThroughCircle, type PlaceCircle, type TripPass } from "../trip-map/queries.js";
import type { TripMapTrack } from "../trip-map/track-geometry.js";
import type { WorldBounds } from "../trip-map/world.js";
import { state } from "./state.js";
import { subscribeTripMapLibrary, tripMapEntries } from "./trip-map-library.js";

let place: PlaceCircle | null = null;
let passesById = new Map<number, TripPass[]>();
/** The map's frame while the map is visible; null otherwise. */
let frame: WorldBounds | null = null;
/** Track ids crossing the frame, or null while the frame cuts nothing. */
let areaIds: Set<number> | null = null;
let resultKey = "";
let isEmitQueued = false;
let isLibrarySubscribed = false;
const listeners = createSubscribers<[]>("trip-map-search");

function readyTracks(): Map<number, TripMapTrack> {
    const tracks = new Map<number, TripMapTrack>();
    for (const entry of tripMapEntries()) if (entry?.track) tracks.set(entry.id, entry.track);
    return tracks;
}

function recompute(): void {
    const tracks = readyTracks();
    passesById = new Map();
    if (place) {
        for (const [id, track] of tracks) {
            const passes = tripPassesThroughCircle(track, place);
            if (passes.length > 0) passesById.set(id, passes);
        }
    }
    areaIds = null;
    if (frame) {
        const inside = new Set<number>();
        for (const [id, track] of tracks) if (trackIntersectsArea(track, frame)) inside.add(id);
        // The area filter only exists while it hides something: with every
        // route in frame the list stays whole, trips without GPS included.
        if (inside.size < tracks.size) areaIds = inside;
    }
}

/** Recomputes and tells listeners when the list's membership or pass times changed. */
function update(): void {
    if (!isLibrarySubscribed) {
        isLibrarySubscribed = true;
        subscribeTripMapLibrary(() => {
            if (place || frame) update();
        });
    }
    recompute();
    state.tripFilters.place = place !== null;
    state.tripFilters.mapArea = areaIds !== null;
    const passKey = [...passesById].map(([id, passes]) => `${id}:${passes.map((pass) => pass.unixSeconds).join(",")}`);
    const key = `${place ? passKey.join(";") : "-"}|${areaIds ? [...areaIds].join(",") : "-"}`;
    if (key === resultKey || isEmitQueued) {
        resultKey = key;
        return;
    }
    resultKey = key;
    // Updates arrive from inside list renders (the map hides when a trip
    // opens); a listener that renders the list must not run inside one.
    isEmitQueued = true;
    queueMicrotask(() => {
        isEmitQueued = false;
        listeners.emit();
    });
}

export function tripMapPlace(): PlaceCircle | null {
    return place;
}

/** Chooses (or with null, clears) the place the list is filtered by. */
export function setTripMapPlace(next: PlaceCircle | null): void {
    place = next;
    update();
}

/** The map's visible frame in world coordinates; null when the map is not visible. */
export function setTripMapFrame(next: WorldBounds | null): void {
    frame = next;
    update();
}

/** Fires when the trips matching the place or the frame, or their pass times, change. */
export function subscribeTripMapSearch(listener: () => void): () => void {
    return listeners.subscribe(listener);
}

/** Facts of the trip at `tripIndex` in `state.trips`, for the list filters. */
export function tripMapFactsFor(tripIndex: number): TripMapFacts {
    const entry = tripMapEntries()[tripIndex];
    if (!entry?.track) return NO_TRIP_MAP_FACTS;
    return {
        hasTrack: true,
        inMapArea: areaIds === null || areaIds.has(entry.id),
        passesPlace: passesById.has(entry.id),
    };
}

/** The trip's passes through the chosen place in time order; empty without a place. */
export function tripMapPassesFor(tripIndex: number): readonly TripPass[] {
    const entry = tripMapEntries()[tripIndex];
    return (entry && passesById.get(entry.id)) ?? [];
}

/** Track ids passing through the chosen place. */
export function tripMapPlaceIds(): ReadonlySet<number> {
    return new Set(passesById.keys());
}

/** How many library trips pass within the circle, for the pointer probe. */
export function countTripsThrough(circle: PlaceCircle): number {
    let count = 0;
    for (const track of readyTracks().values()) if (tripPassesThroughCircle(track, circle).length > 0) count++;
    return count;
}

export function _resetForTests(): void {
    place = null;
    passesById = new Map();
    frame = null;
    areaIds = null;
    resultKey = "";
    isEmitQueued = false;
    listeners.clear();
}
