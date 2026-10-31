// Remembers the user's multi-channel layout (focus/split + camera order) per
// physical camera set, so stepping through several trips off one card does not
// reset the arrangement every time (playFrame resets composition to the trip
// default on each trip change). Only layout + channelOrder are persisted - audio
// source and per-camera exclusions stay per-trip.
//
// Key is the trip's camera SET (sorted unique fingerprints, or sorted channels as
// a fallback for recorders with no fingerprint), so two trips from the same
// camera rig share an arrangement while a different rig gets its own.

import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
import type { Channel } from "../parsers/types.js";
import { createLogger } from "../log.js";
import { type Trip, tripAllCandidates } from "../trips.js";
import { CANONICAL_CHANNEL_ORDER, defaultLayoutForCount, type Layout, layoutSlotCount, state } from "./state.js";

const log = createLogger("player");
const STORAGE_KEY = "everydashcam:player:layoutByCameraSet";
// Keep the map bounded - a heavy user could otherwise accrete an entry per rig
// forever. LRU by recency (most-recently-saved first).
const MAX_ENTRIES = 40;

interface StoredLayout {
    layout: Layout;
    channelOrder: Channel[];
}
interface Entry extends StoredLayout {
    key: string;
}

/** Stable key for a trip's physical camera set. Prefers fingerprints (cross-
 *  channel, survives channel reordering); falls back to the channel set for
 *  recorders that expose no fingerprint. Pure. */
export function cameraSetKey(fingerprints: string[], channels: Channel[]): string {
    const fps = [...new Set(fingerprints)].filter(Boolean).sort();
    if (fps.length) return `fp:${fps.join("|")}`;
    const chs = [...new Set(channels)].sort();
    return `ch:${chs.join("|")}`;
}

/**
 * Given a stored arrangement and the trip's actual playable channels, computes
 * the layout + channelOrder to apply. Pure (testable):
 *  - keeps the stored order for channels that still exist, in the stored order;
 *  - appends any playable channel missing from the stored order (canonical
 *    order) so a camera is never hidden just because it wasn't saved;
 *  - keeps the stored layout only if its slot count matches the resulting count
 *    (so focus-vs-split and pipN survive), else falls back to the default layout.
 * Returns null when there is nothing meaningful to restore (single channel, or no
 * stored entry) - the caller then uses the trip default.
 */
export function reconcileStoredLayout(stored: StoredLayout | null, playableChannels: Channel[]): StoredLayout | null {
    if (!stored) return null;
    const playable = CANONICAL_CHANNEL_ORDER.filter((ch) => playableChannels.includes(ch));
    if (playable.length <= 1) return null;
    const kept = stored.channelOrder.filter((ch) => playable.includes(ch));
    const appended = playable.filter((ch) => !kept.includes(ch));
    const channelOrder = [...kept, ...appended];
    const layout =
        layoutSlotCount(stored.layout) === channelOrder.length
            ? stored.layout
            : defaultLayoutForCount(channelOrder.length);
    return { layout, channelOrder };
}

function loadEntries(): Entry[] {
    const parsed = readLocalStorageJson(STORAGE_KEY);
    if (!Array.isArray(parsed)) return [];
    // Layout/channel domains are reconciled downstream; only validate shapes here.
    return parsed.filter(
        (e): e is Entry =>
            e &&
            typeof e.key === "string" &&
            typeof e.layout === "string" &&
            Array.isArray(e.channelOrder) &&
            e.channelOrder.every((c: unknown) => typeof c === "string"),
    );
}

function saveEntries(entries: Entry[]): void {
    writeLocalStorageJson(STORAGE_KEY, entries.slice(0, MAX_ENTRIES));
}

/** Playable fingerprints + channels of a trip, for the camera-set key. */
function tripCameraSet(trip: Trip): { fingerprints: string[]; channels: Channel[] } {
    const fingerprints: string[] = [];
    const channels: Channel[] = [];
    for (const c of tripAllCandidates(trip)) {
        if (!c.canPlay) continue;
        if (c.fingerprint) fingerprints.push(c.fingerprint);
        if (c.channel) channels.push(c.channel);
    }
    return { fingerprints, channels };
}

/**
 * Restores a stored arrangement for a trip, or null to use the default. The
 * caller (playFrame) feeds the result into setLayoutAndChannels.
 */
export function restoreLayoutForTrip(trip: Trip, playableChannels: Channel[]): StoredLayout | null {
    if (playableChannels.length <= 1) return null;
    const { fingerprints, channels } = tripCameraSet(trip);
    const key = cameraSetKey(fingerprints, channels);
    const stored = loadEntries().find((e) => e.key === key) ?? null;
    return reconcileStoredLayout(stored, playableChannels);
}

/**
 * Persists the active trip's current layout + channelOrder under its camera-set
 * key. Called from the user-driven composition callsites (layout button, chip
 * reorder, tile drag-reorder, focus/split toggle) - NOT from the programmatic
 * trip-change reset. No-op on single-channel compositions.
 */
export function persistCurrentLayout(): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    if (state.composition.channelOrder.length <= 1) return;
    const { fingerprints, channels } = tripCameraSet(trip);
    const key = cameraSetKey(fingerprints, channels);
    const entry: Entry = {
        key,
        layout: state.composition.layout,
        channelOrder: state.composition.channelOrder.slice(),
    };
    const next = [entry, ...loadEntries().filter((e) => e.key !== key)];
    saveEntries(next);
    log.debug("persisted player layout", { key, layout: entry.layout });
}
