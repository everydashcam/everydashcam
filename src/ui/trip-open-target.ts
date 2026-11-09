// Stable intent captured when a trip, clip, or event is activated. Recording
// metadata can replace File objects (container repair) and regroup can replace
// every Trip object while viewer chunks load, so an open action follows the
// source-qualified recording key rather than either positional index.

import { frameChannels, frameMediaOffset, tripAllCandidates, type Trip } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";

export interface TripOpenTarget {
    /** Recording identities captured synchronously from the clicked control. */
    keys: string[];
    /** Whole clicked trip, used to preserve a same-trip deferred GPS session. */
    tripKeys: string[];
    /** Exact clip rows must not silently fall back to another frame. */
    exactFrame: boolean;
    /**
     * The moment to open at, an event or a pass through a place. Survives
     * event-list rebuilds and trip renumbering.
     */
    momentUtc: number | null;
}

export interface ResolvedTripOpen {
    tripIdx: number;
    frameIdx: number;
}

function uniqueCandidateKeys(candidates: ReturnType<typeof tripAllCandidates>): string[] {
    return [...new Set(candidates.map((candidate) => vendorFileKey(candidate)))];
}

export function captureTripOpenTarget(
    trips: readonly Trip[],
    tripIdx: number,
    frameIdx?: number,
    eventIndex?: number,
): TripOpenTarget | null {
    const trip = trips[tripIdx];
    if (!trip) return null;
    const tripKeys = uniqueCandidateKeys(tripAllCandidates(trip));
    const frame = frameIdx === undefined ? null : (trip.frames[frameIdx] ?? null);
    if (frameIdx !== undefined && frame === null) return null;
    const keys =
        frame === null
            ? tripKeys
            : [
                  ...new Set(
                      // A sidebar row can introduce an interior file while the
                      // front file continues from an earlier playback interval.
                      frameChannels(frame)
                          .sort((a, b) => frameMediaOffset(frame, a) - frameMediaOffset(frame, b))
                          .map((channel) => vendorFileKey(frame.channels[channel]!)),
                  ),
              ];
    if (keys.length === 0) return null;
    const momentUtc = eventIndex === undefined ? null : (trip.events[eventIndex]?.unixSeconds ?? null);
    if (eventIndex !== undefined && momentUtc === null) return null;
    return { keys, tripKeys, exactFrame: frameIdx !== undefined, momentUtc };
}

/** A whole trip opened at a moment on its clock, such as a pass through a place. */
export function captureTripMomentTarget(
    trips: readonly Trip[],
    tripIdx: number,
    momentUtc: number,
): TripOpenTarget | null {
    const target = captureTripOpenTarget(trips, tripIdx);
    return target && { ...target, momentUtc };
}

export function withPreparedRecordingKeys(target: TripOpenTarget, recordingKeys: readonly string[]): TripOpenTarget {
    const prepared = new Set(recordingKeys);
    return {
        ...target,
        // Metadata preparation lists channels in camera order. Keep the clicked
        // recording first even when another camera spans an earlier interval.
        keys: [...new Set([...target.keys.filter((key) => prepared.has(key)), ...recordingKeys])],
        exactFrame: true,
        momentUtc: null,
    };
}

/** Resolves a pre-await click against the latest regrouped trip list. */
export function resolveTripOpenTarget(trips: readonly Trip[], target: TripOpenTarget): ResolvedTripOpen | null {
    const locations = buildRecordingLocationMap(trips);
    const matches = target.keys.flatMap((key) => {
        const location = locations.get(key);
        return location ? [location] : [];
    });
    if (matches.length === 0) return null;
    if (target.momentUtc === null) {
        const first = matches[0]!;
        return { tripIdx: first.tripIdx, frameIdx: first.frameIdx };
    }

    let best = matches[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    const seenTrips = new Set<number>();
    for (const match of matches) {
        if (seenTrips.has(match.tripIdx)) continue;
        seenTrips.add(match.tripIdx);
        const trip = trips[match.tripIdx];
        if (!trip) continue;
        const distance =
            target.momentUtc < trip.startUtc
                ? trip.startUtc - target.momentUtc
                : target.momentUtc > trip.endUtc
                  ? target.momentUtc - trip.endUtc
                  : 0;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = match;
        }
    }
    return { tripIdx: best.tripIdx, frameIdx: best.frameIdx };
}

export function closestEventIndex(events: readonly { unixSeconds: number }[], targetUtc: number): number {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < events.length; index++) {
        const distance = Math.abs(events[index]!.unixSeconds - targetUtc);
        if (distance >= bestDistance) continue;
        best = index;
        bestDistance = distance;
    }
    return best;
}

function buildRecordingLocationMap(trips: readonly Trip[]): Map<string, { tripIdx: number; frameIdx: number }> {
    const locations = new Map<string, { tripIdx: number; frameIdx: number }>();
    for (let tripIdx = 0; tripIdx < trips.length; tripIdx++) {
        const trip = trips[tripIdx]!;
        for (let frameIdx = 0; frameIdx < trip.frames.length; frameIdx++) {
            for (const candidate of Object.values(trip.frames[frameIdx]!.channels)) {
                const key = vendorFileKey(candidate);
                if (!locations.has(key)) locations.set(key, { tripIdx, frameIdx });
            }
        }
    }
    return locations;
}
