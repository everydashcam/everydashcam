// Remembers the user's camera arrangement (mode, order, hidden cameras, sizes
// and overlay windows) per physical camera set, so stepping through several
// trips off one card does not reset it every time (playFrame resets the
// composition on each trip change). Audio choice and crops stay per trip:
// crops are fractions of one trip's source frames.
//
// Key is the trip's camera SET (sorted unique fingerprints, or sorted channels as
// a fallback for recorders with no fingerprint), so two trips from the same
// camera rig share an arrangement while a different rig gets its own.

import {
    type CameraArrangementMode,
    type OverlayPosition,
    THUMB_SCALE_MAX,
    THUMB_SCALE_MIN,
} from "../camera-layout.js";
import { readLocalStorageJson, removeLocalStorage, writeLocalStorageJson } from "../local-storage.js";
import type { Channel } from "../parsers/types.js";
import { createLogger } from "../log.js";
import { type Trip, tripAllCandidates } from "../trips.js";
import { CANONICAL_CHANNEL_ORDER, state } from "./state.js";

const log = createLogger("player");
const STORAGE_KEY = "everydashcam:player:cameraArrangement";
// Arrangements of the preset-layout model. Not migrated: the model changed
// meaning (presets became modes), so the entries are dropped unread.
const RETIRED_STORAGE_KEY = "everydashcam:player:layoutByCameraSet";
// Keep the map bounded - a heavy user could otherwise accrete an entry per rig
// forever. LRU by recency (most-recently-saved first).
const MAX_ENTRIES = 40;

/** The remembered part of the composition. */
export interface StoredArrangement {
    mode: CameraArrangementMode;
    order: Channel[];
    hidden: Channel[];
    thumbScale: number | null;
    allowOverlay: boolean;
    overlayPositions: Partial<Record<Channel, OverlayPosition>>;
}
interface Entry extends StoredArrangement {
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
 * Fits a stored arrangement to the trip's playable channels. Pure (testable):
 *  - keeps the stored order for channels that still exist, then appends any
 *    playable channel the entry does not know (canonical order), so a camera
 *    is never lost just because it was not saved;
 *  - keeps hidden only cameras the trip has, and never all of them;
 *  - keeps overlay windows only for cameras the trip has.
 * Returns null when there is nothing meaningful to restore (single channel, or
 * no stored entry) - the caller then uses the trip default.
 */
export function reconcileStoredArrangement(
    stored: StoredArrangement | null,
    playableChannels: Channel[],
): StoredArrangement | null {
    if (!stored) return null;
    const playable = CANONICAL_CHANNEL_ORDER.filter((ch) => playableChannels.includes(ch));
    if (playable.length <= 1) return null;
    const kept = stored.order.filter((ch, index) => playable.includes(ch) && stored.order.indexOf(ch) === index);
    const order = [...kept, ...playable.filter((ch) => !kept.includes(ch))];
    let hidden = stored.hidden.filter((ch) => order.includes(ch));
    if (hidden.length >= order.length) hidden = [];
    const overlayPositions: Partial<Record<Channel, OverlayPosition>> = {};
    for (const ch of order) {
        const position = stored.overlayPositions[ch];
        if (position) overlayPositions[ch] = position;
    }
    return {
        mode: stored.mode,
        order,
        hidden,
        thumbScale: stored.thumbScale,
        allowOverlay: stored.allowOverlay,
        overlayPositions,
    };
}

const isChannelList = (value: unknown): value is Channel[] =>
    Array.isArray(value) && value.every((c) => typeof c === "string" && CANONICAL_CHANNEL_ORDER.includes(c as Channel));

function isFraction(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validates one stored entry's shape; anything unexpected drops the entry. */
function parseEntry(value: unknown): Entry | null {
    if (!value || typeof value !== "object") return null;
    const e = value as Record<string, unknown>;
    if (typeof e.key !== "string") return null;
    if (e.mode !== "main" && e.mode !== "equal") return null;
    if (!isChannelList(e.order) || !isChannelList(e.hidden)) return null;
    const thumbScale =
        typeof e.thumbScale === "number" && Number.isFinite(e.thumbScale)
            ? Math.min(THUMB_SCALE_MAX, Math.max(THUMB_SCALE_MIN, e.thumbScale))
            : null;
    const overlayPositions: Partial<Record<Channel, OverlayPosition>> = {};
    if (e.overlayPositions && typeof e.overlayPositions === "object") {
        for (const [channel, position] of Object.entries(e.overlayPositions as Record<string, unknown>)) {
            const p = position as Record<string, unknown> | null;
            if (CANONICAL_CHANNEL_ORDER.includes(channel as Channel) && p && isFraction(p.x) && isFraction(p.y)) {
                overlayPositions[channel as Channel] = { x: p.x, y: p.y };
            }
        }
    }
    return {
        key: e.key,
        mode: e.mode,
        order: e.order,
        hidden: e.hidden,
        thumbScale,
        allowOverlay: e.allowOverlay === true,
        overlayPositions,
    };
}

let retiredKeyRemoved = false;

function loadEntries(): Entry[] {
    if (!retiredKeyRemoved) {
        retiredKeyRemoved = true;
        removeLocalStorage(RETIRED_STORAGE_KEY);
    }
    const parsed = readLocalStorageJson(STORAGE_KEY);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseEntry).filter((e): e is Entry => e !== null);
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
 * caller (playFrame) feeds the result into updateComposition.
 */
export function restoreArrangementForTrip(trip: Trip, playableChannels: Channel[]): StoredArrangement | null {
    if (playableChannels.length <= 1) return null;
    const { fingerprints, channels } = tripCameraSet(trip);
    const key = cameraSetKey(fingerprints, channels);
    const stored = loadEntries().find((e) => e.key === key) ?? null;
    return reconcileStoredArrangement(stored, playableChannels);
}

/**
 * Persists the active trip's arrangement under its camera-set key. Called from
 * every user-driven arrangement change (mode, order, hiding a camera, sizes,
 * overlay windows) - NOT from the programmatic trip-change reset. No-op on
 * single-camera trips.
 */
export function persistCurrentArrangement(): void {
    if (!state.active) return;
    const trip = state.trips[state.active.trip];
    if (!trip) return;
    const c = state.composition;
    if (c.order.length <= 1) return;
    const { fingerprints, channels } = tripCameraSet(trip);
    const key = cameraSetKey(fingerprints, channels);
    const entry: Entry = {
        key,
        mode: c.mode,
        order: c.order.slice(),
        hidden: c.hidden.slice(),
        thumbScale: c.thumbScale,
        allowOverlay: c.allowOverlay,
        overlayPositions: { ...c.overlayPositions },
    };
    saveEntries([entry, ...loadEntries().filter((e) => e.key !== key)]);
    log.debug("persisted camera arrangement", { key, mode: entry.mode });
}

/** Test hook: forget that the retired key was already removed. */
export function _resetForTests(): void {
    retiredKeyRemoved = false;
}
