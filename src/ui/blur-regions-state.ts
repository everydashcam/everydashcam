// Per-trip store of privacy blur regions (src/blur-regions.ts model).
//
// Keyed by Trip object identity in a WeakMap - deliberately NOT reset on trip
// change (unlike perSlotCrops): marking regions is labor, and switching trips
// back and forth must not discard it. A re-ingest that rebuilds Trip objects
// simply orphans the old entries for GC - annotations are in-memory-only, like
// every other session state. Regions store rects in normalized source coords
// and keyframe times on the trip's content axis, so they stay valid for their
// trip regardless of layout/crop/output changes.

import { createSubscribers } from "../subscribers.js";
import type { BlurRegion } from "../blur-regions.js";
import { tripAllCandidates } from "../trips.js";
import type { Trip } from "../trips.js";

import { activeTrip } from "./state.js";
import { captureBlurTripSource, matchesBlurTripSource, type BlurTripSource } from "./blur-trip-source.js";

let regionsByTrip = new WeakMap<Trip, BlurRegion[]>();
let sourceByTrip = new WeakMap<Trip, BlurTripSource>();

type Listener = () => void;
const listeners = createSubscribers<Parameters<Listener>>("blur-regions");

/** Subscribes to blur-region list/geometry changes. Returns unsubscribe. */
export function subscribeBlurRegions(listener: Listener): () => void {
    return listeners.subscribe(listener);
}

/** Wakes subscribers. Call after any region mutation (add/remove/keyframe/style
 *  edits) - mutations are in-place per the codebase convention, so subscribers
 *  re-read via activeBlurRegions(). */
export function notifyBlurRegionsChanged(): void {
    listeners.emit();
}

/** Blur regions of the active trip (live array - do not hold across trip
 *  switches). Empty when no trip is active. */
export function activeBlurRegions(): BlurRegion[] {
    const trip = activeTrip();
    if (!trip) return [];
    let list = regionsByTrip.get(trip);
    if (!list) {
        list = [];
        regionsByTrip.set(trip, list);
    }
    return list;
}

export function addBlurRegion(region: BlurRegion): void {
    const trip = activeTrip();
    if (!trip) return;
    const regions = activeBlurRegions();
    if (regions.length === 0) sourceByTrip.set(trip, captureBlurTripSource(trip));
    regions.push(region);
    notifyBlurRegionsChanged();
}

export function removeBlurRegion(id: string): void {
    const list = activeBlurRegions();
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) {
        list.splice(i, 1);
        notifyBlurRegionsChanged();
    }
}

// Aborts a dropped region's in-flight Follow pass. Injected from app.ts
// (blur-track.cancelTrackPass) rather than imported directly, so this module
// stays out of blur-track's import graph (blur-track already imports this one -
// a direct back-import would be a cycle). No-op until wired / when nothing runs.
let droppedRegionPassCanceller: ((regionId: string) => void) | null = null;

/** Wires the tracker-pass canceller so carryBlurRegions can abort the Follow
 *  pass of a region that a regroup drops (its file set changed). */
export function setDroppedRegionPassCanceller(fn: (regionId: string) => void): void {
    droppedRegionPassCanceller = fn;
}

type RegroupListener = (oldTrips: readonly Trip[], newTrips: readonly Trip[], invalidatedRegionCount: number) => void;
const regroupListeners = createSubscribers<Parameters<RegroupListener>>("blur-regroup");

/** Shares the regroup boundary with detection and the lost-zone notice without
 * importing either UI lifecycle into ingest. Removed footage does not count as
 * invalidation: the notice applies only when source files still survive. */
export function subscribeBlurTripRegroup(listener: RegroupListener): () => void {
    return regroupListeners.subscribe(listener);
}

/**
 * Carries blur regions from replaced Trip objects onto their rebuilt
 * successors. Trip objects are rebuilt through the shared regroup boundary and
 * by incremental aggregate refreshes; without this the user's marking silently
 * vanishes on those paths.
 * Matching mirrors carryOverTripPreviews: the first candidate's File identity
 * names a trip across a rebuild. Regions transfer ONLY when the successor has
 * the same source mapping: channel assignments, footage offsets and orientation
 * must remain unchanged, or a carried region would hide the wrong pixels.
 */
export function carryBlurRegions(oldTrips: readonly Trip[], newTrips: readonly Trip[]): void {
    const byFirstFile = new Map<File, { regions: BlurRegion[]; source: BlurTripSource }>();
    // Every region that existed before the regroup, to tell carried from dropped.
    const oldRegionIds = new Set<string>();
    for (const trip of oldTrips) {
        const regions = regionsByTrip.get(trip);
        if (!regions || regions.length === 0) continue;
        for (const r of regions) oldRegionIds.add(r.id);
        const source = sourceByTrip.get(trip);
        const first = source?.files[0];
        if (first && source) byFirstFile.set(first.file, { regions, source });
    }
    const carriedRegionIds = new Set<string>();
    const remainingFiles = new Set<File>();
    for (const trip of newTrips) {
        const cands = tripAllCandidates(trip);
        for (const candidate of cands) remainingFiles.add(candidate.file);
        const existing = regionsByTrip.get(trip);
        const existingSource = sourceByTrip.get(trip);
        if (existing?.length && existingSource && matchesBlurTripSource(existingSource, trip)) {
            for (const region of existing) carriedRegionIds.add(region.id);
            continue;
        }
        if (existing?.length) regionsByTrip.delete(trip);
        const first = cands[0];
        if (!first) continue;
        const carried = byFirstFile.get(first.file);
        if (!carried) continue;
        if (!matchesBlurTripSource(carried.source, trip)) continue;
        regionsByTrip.set(trip, carried.regions);
        sourceByTrip.set(trip, carried.source);
        for (const r of carried.regions) carriedRegionIds.add(r.id);
    }
    // A dropped region (merge/split invalidated its keyframe times, so it was not
    // carried) may still have a Follow pass decoding. Abort it, or the orphaned
    // pass keeps holding the tracker worker's single-pass gate and blocks the
    // next Follow until it drains. No-op for carried regions (same objects) and
    // when nothing is running.
    for (const id of oldRegionIds) {
        if (!carriedRegionIds.has(id)) droppedRegionPassCanceller?.(id);
    }
    const invalidatedRegionIds = new Set<string>();
    for (const { regions, source } of byFirstFile.values()) {
        if (!source.files.some(({ file }) => remainingFiles.has(file))) continue;
        for (const region of regions) {
            if (!carriedRegionIds.has(region.id)) invalidatedRegionIds.add(region.id);
        }
    }
    regroupListeners.emit(oldTrips, newTrips, invalidatedRegionIds.size);
    // Old trips HAD regions, so the active list identity changed either way -
    // carried over or (on a merge/split) legitimately dropped. Listeners must
    // re-read via activeBlurRegions() in both cases, or the panel keeps
    // rendering rows for zones that no longer exist.
    if (oldRegionIds.size > 0) notifyBlurRegionsChanged();
}

export function _resetForTests(): void {
    regionsByTrip = new WeakMap();
    sourceByTrip = new WeakMap();
    listeners.clear();
    droppedRegionPassCanceller = null;
}
