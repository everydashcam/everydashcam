// Global mutable UI-state singleton. Vanilla DOM, no framework - a
// module-scope singleton is the natural "one per process" store. Fields are
// mutated directly by any UI module; see AppState below for field semantics.
//
// This module MUST NOT import anything from ui/* - it is the dependency-graph
// root among UI modules.

import type { Chart } from "chart.js";
import type * as maplibregl from "maplibre-gl";

import { recordsHaveGps } from "../parser.js";
import type { ParsedLog } from "../parser.js";
import type { ClassifiedFile } from "../parsers/registry.js";
import type { Channel, VendorFile } from "../parsers/types.js";
import type { IngestStructureEntry } from "../ingest-structure.js";
import type { PerFileMseBackend } from "../per-file-mse.js";
import type { RecordingAnalysisProgress } from "../recording-analysis-progress.js";
import type { TripFilters } from "../trip-filters.js";
import type { CropRect, SplitLayout } from "../transcode/compose.js";
import { pickFrameChannel } from "../trips.js";
import type { Trip, TripFrame, VideoCandidate } from "../trips.js";

/**
 * Folder a batch of files was picked from. Only the FSA picker can name one -
 * the classic input and drag-and-drop hand over plain File objects with no
 * reopenable handle. Declared here (the UI dependency root) so the ingest
 * queue can carry it without state.ts importing a ui/* module; the semantics
 * live in ui/folder-sources.ts.
 */
export interface IngestOrigin {
    handle: FileSystemDirectoryHandle;
    /** Remembered-folder id, "" when this folder is not remembered (yet). */
    folderId: string;
}

/** One drop waiting behind the running ingest, with the folder it came from. */
export interface QueuedIngest {
    files: VendorFile[];
    origin: IngestOrigin | null;
    structure?: IngestStructureEntry[];
}

export type TripSortKey = "date" | "distance" | "duration" | "size";
type TripSortDir = "desc" | "asc";
// What happens when the last clip of a trip ends. "advance" plays the next trip
// (chronologically) so the whole drive plays through.
type TripEndBehavior = "stop" | "loop" | "advance";

/**
 * Player composition layout. Defines how channels are arranged in the player
 * area, and identically describes the output frame composition for export
 * (player = WYSIWYG preview).
 *  - "single": one channel fills the output frame. Used on single-channel
 *    trips and as a "show me just one" option in multi-channel trips.
 *  - "h2"/"v2": two channels side-by-side / stacked, equal slots.
 *  - "left1right2"/"left2right1": three channels, asymmetric split.
 *  - "grid2x2": four channels in 2x2 grid.
 *  - "pip2"/"pip3"/"pip4": one main channel full-frame, N-1 small rounded
 *    overlays in the right column.
 */
export type Layout = SplitLayout;

// "chase": heading-up like "rotate", plus camera tilt + 3D buildings +
// (optionally) speed-adaptive zoom - the "dashcam / racing-game" view.
export type FollowMode = "off" | "follow" | "rotate" | "chase";

export type LngLatTuple = [number, number];

/**
 * Last known mini-map data snapshot. Stored in state so that on map style
 * reload (after a successful tile-server retry) the mini-map can be redrawn
 * with the same data without reaching into state.active.
 */
export interface MiniMapData {
    coords: LngLatTuple[];
    gradient: unknown[];
}

/**
 * Player composition state. Persistent across casual <-> export mode within a
 * session: the player is the WYSIWYG preview of the export, so layout/channels/
 * crops/audio choices apply to both the live playback and the saved file.
 *
 * Slot ordering: channelOrder[0] is the "main" slot (large tile in pip / first
 * in h2 / top-left in grid). audioChannel is independent of slot order - the
 * user may show front in slot 0 but pull audio from rear via the audio dropdown.
 *
 * Per-slot arrays (perSlotCrops/Scales/Aspects/PipPositions) all have length
 * equal to the slot count of the current layout. On layout change the arrays
 * are resized: trailing entries dropped, new entries filled with defaults.
 */
export interface CompositionState {
    /** Active layout. "single" means only one channel is visible. */
    layout: Layout;
    /**
     * Channels in slot order. Length = slot count of layout. channelOrder[0] is
     * the visually main slot. Length 1 for layout="single".
     */
    channelOrder: Channel[];
    /**
     * Channel that plays audio. Defaults to channelOrder[0] on layout change;
     * the user can override via the audio-source dropdown in top-panel.
     */
    audioChannel: Channel;
    /** Per-slot crop rect (null = full source frame, no crop). */
    perSlotCrops: (CropRect | null)[];
    /**
     * Per-slot PiP scale (1.0 = default size). Meaningful only for slots 1+ in
     * pip layouts; ignored elsewhere but stored to survive layout flips.
     */
    perSlotScales: number[];
    /**
     * Per-slot PiP overlay positions in output coords (0..1 from top-left).
     * Used only for pip layouts. null = default position (bottom-right stack).
     */
    perSlotPipPositions: ({ xPct: number; yPct: number } | null)[];
}

export interface AppState {
    gpsLog: ParsedLog | null;
    // Session file identities (source + relativePath + size + mtime). The
    // metadata component lets a loop-recording overwrite at the same path join
    // the session instead of being mistaken for a repeated drop.
    addedKeys: Set<string>;
    trips: Trip[];
    unindexed: Set<File>;
    expandedTrips: Set<number>;
    // Active frame in the active trip. Channel + layout choice live in
    // `composition` because they survive frame changes and apply both to
    // playback and to the export composition.
    active: { trip: number; frame: number } | null;
    /**
     * Player composition (layout, slot channel order, audio source, per-slot
     * crops/scales/aspects/pip positions). Persistent across export-mode toggle
     * within a session. See CompositionState above for slot ordering semantics.
     */
    composition: CompositionState;
    /**
     * True while the export-mode is active (export-panel open, top-panel in
     * export config, sidebar hidden on desktop). Toggle via openExportMode /
     * closeExportMode in src/ui/export-state.ts.
     */
    exportModeOpen: boolean;
    tripSortKey: TripSortKey;
    tripSortDir: TripSortDir;
    tripFilters: TripFilters;
    preferredPlaybackRate: number;
    preferredVolume: number;
    // Mute stored separately from volume: <video>.muted and <video>.volume are
    // independent, and without explicit state mute would reset on every src change
    // (loadedmetadata overwrites volume but not muted) and on channel swap in
    // multichannel (which also sets muted=false on the active video).
    preferredMuted: boolean;
    tripEndBehavior: TripEndBehavior;
    map: maplibregl.Map | null;
    mapReady: boolean;
    marker: maplibregl.Marker | null;
    startMarker: maplibregl.Marker | null;
    endMarker: maplibregl.Marker | null;
    miniMap: maplibregl.Map | null;
    miniMapReady: boolean;
    miniMapMarker: maplibregl.Marker | null;
    miniMapData: MiniMapData | null;
    mapExpanded: boolean;
    hasTrack: boolean;
    hoverPopup: maplibregl.Popup | null;
    chart: Chart | null;
    chartTooltipEl: HTMLDivElement | null;
    chartHoverX: number | null;
    chartZoomed: boolean;
    // True only while the current chart zoom is a "Preview clip" window (the zoom
    // equals the export range, set via zoomTimelineToRange). It bounds playback to
    // the window - the seek clamp + stop/loop at the edge in player.ts. Any other
    // zoom (wheel/pinch/keyboard/drag/zoom-to-event) is inspection: false, and the
    // window follows the playhead instead of trapping it. Reset with the zoom.
    isPreviewZoom: boolean;
    // Digital zoom of the active video tile in focus-mode. scale is always in
    // [1, 8]; offsetX/offsetY are pixel offsets relative to the tile
    // (transform-origin = 0 0 on the video element). At scale === 1 the
    // transform is removed entirely. Ephemeral: not persisted, reset on trip
    // change, channel swap, and focus<->split toggle. Geometry and clamp
    // details in src/ui/player.ts (computeZoomGeometry / clampZoomOffset).
    videoZoom: { scale: number; offsetX: number; offsetY: number };
    followMode: FollowMode;
    // A non-null AbortController marks an active ingest and cancels it on a
    // Cancel click. Its signal is passed to
    // indexAllMp4Files and dispatchParseVideoEmbeddedGps, which exit on the next
    // worker iteration. The queue holds additional drops that arrived while the
    // current ingest is active; they run sequentially.
    ingestController: AbortController | null;
    // Each entry keeps the batch's origin folder next to its files - a drop
    // that waited here must still be attributable to the folder it came from.
    ingestQueue: QueuedIngest[];
    // Available File objects from the last ingest before path filtering, used
    // for report metadata and recognition help. Walkers omit excluded file
    // handles; their names remain in lastIngestStructure. Replaced each drop.
    lastIngestFiles: VendorFile[] | null;
    // Full observed structure, including excluded and empty/unreadable entries.
    lastIngestStructure: IngestStructureEntry[] | null;
    // True while the worker transcode/transcodeSplit is active. Map rAF-loop
    // and chart-render are skipped - the main thread must not spin UI updates
    // during export, otherwise the worker stalls waiting for FSA-write acks
    // (bridge is sequential, see src/ui/writable-bridge.ts).
    transcodeInProgress: boolean;
    // === Deferred embedded-GPS state ===
    // Files whose telemetry needs an expensive full scan land here until their
    // trip is opened. Key is vendorFileKey; value
    // is a ClassifiedFile (from the dispatcher - carries role + sidecar binding;
    // the video fingerprint is computed on demand via cameraFingerprint(file)).
    // The source/path/metadata key (not bare basename) keeps two same-named files -
    // e.g. FILE0001.MP4 reused across two SD cards in one/consecutive drops -
    // from aliasing. A trip-open scan removes completed files from this map.
    pendingHeavyEmbeddedGps: Map<string, ClassifiedFile>;
    // Files whose embedded GPS is currently being parsed, whether by the
    // progressive light pass or a deferred heavy scan. Key is vendorFileKey
    // (same file-identity key as pendingHeavyEmbeddedGps, so the sidebar's
    // per-card lookup never confuses two same-basename files).
    inflightEmbeddedGps: Map<string, number>;
    /** Confirmed failures from the last completed GPS attempt, keyed by recording identity. */
    failedEmbeddedGps: Set<string>;
    // Trip indices whose mandatory metadata read is in flight. Indices stay
    // stable until the closing regroup and are cleared on cancellation.
    readingTrips: Set<number>;
    // Pending mandatory recording details for the current pass. Completion is
    // represented by null even while embedded GPS or previews continue, so the
    // status cannot park at 100%. The sidebar never owns or retains File objects.
    recordingAnalysisProgress: RecordingAnalysisProgress | null;
    // === Per-channel MSE backends (see src/per-file-mse.ts) ===
    // Active per-file MSE backend per channel. Created when the current file
    // has cand.needsHevcRemux=true (BlackVue ELITE 9 / Vantrue N2X); disposed
    // on file change or trip close. For native files the backend is absent -
    // setVideoSrcFromFile (player.ts) sets <video>.src with a lazy blob URL.
    // Keyed by channel, not <video>: one <video> per channel, but cand changes
    // with every frame.
    channelBackends: Partial<Record<Channel, PerFileMseBackend>>;
}

export function isTripSortKey(v: string): v is TripSortKey {
    return v === "date" || v === "distance" || v === "duration" || v === "size";
}

/**
 * Active frame resolved to a trip - for code that needs the frame itself
 * (clip boundaries on the chart, clip navigation).
 */
export function activeFrame(): { trip: Trip; frame: TripFrame } | null {
    if (!state.active) return null;
    const trip = state.trips[state.active.trip];
    if (!trip) return null;
    const frame = trip.frames[state.active.frame];
    if (!frame) return null;
    return { trip, frame };
}

/** Active trip, or null when nothing is open. Convenience accessor over the
 *  `state.active != null ? state.trips[state.active.trip] : null` idiom. */
export function activeTrip(): Trip | null {
    return state.active != null ? (state.trips[state.active.trip] ?? null) : null;
}

/** Whether the active trip carries any usable GPS fix - the single gate for
 *  every GPS-dependent feature: the export options (telemetry / .gpx / speed /
 *  coords / map overlays) and their player preview. Shared so the panel display,
 *  the preview, and the export pipeline can never disagree. */
export function activeTripHasGps(): boolean {
    return recordsHaveGps(activeTrip()?.records);
}

/**
 * Main visible channel = composition.channelOrder[0]. Convenience accessor;
 * call sites that pick a candidate for the "primary" player tile (largest in
 * pip, left in h2, top-left in grid) use this. Falls back to "front" only on
 * the (impossible-in-practice) empty channelOrder.
 */
export function mainChannel(): Channel {
    return state.composition.channelOrder[0] ?? "front";
}

/**
 * Current active VideoCandidate - the frame selected by state.active.frame,
 * channel resolved via the main composition slot with fallback (see
 * pickFrameChannel). Returns null if active is invalid or the frame is empty.
 */
export function activeCandidate(): VideoCandidate | null {
    const af = activeFrame();
    if (!af) return null;
    return pickFrameChannel(af.frame, mainChannel())?.candidate ?? null;
}

/**
 * Slot count for a given layout. Source of truth: getSplitSlots in compose.ts,
 * but we duplicate the small map here so the UI module can compute slot count
 * without importing the heavy compose module path.
 */
export function layoutSlotCount(layout: Layout): number {
    switch (layout) {
        case "single":
            return 1;
        case "h2":
        case "v2":
        case "pip2":
            return 2;
        case "left1right2":
        case "left2right1":
        case "pip3":
            return 3;
        case "grid2x2":
        case "pip4":
            return 4;
    }
}

/** True for layouts where one slot is the main full-frame and others are small
 *  rounded overlays (pip2/pip3/pip4). Used to differentiate edit-mode UX:
 *  in pip layouts slot 1+ gets a resize handle, in tile layouts (h2/grid) it
 *  does not. */
export function isPipLayout(layout: Layout): boolean {
    return layout === "pip2" || layout === "pip3" || layout === "pip4";
}

/** True for "focus" layouts: a single main tile owns the frame and any extra
 *  channels are pip overlays (single + pip2/pip3/pip4), as opposed to tiled
 *  split layouts (h2/v2/grid/...). Many call sites gate digital zoom, crop and
 *  audio routing on "is this focus or split" - keep that predicate here so it
 *  has one definition. */
export function isFocusLayout(layout: Layout): boolean {
    return layout === "single" || isPipLayout(layout);
}

/**
 * Builds a default composition for a trip given its set of channels. Layout
 * picked by channel count: 1 = single, 2/3/4 = corresponding pip layout (focus
 * mode, matches the previous viewMode="focus" default). channelOrder seeds
 * from the channel list in canonical order (front/rear/interior/side); the
 * order is fed into the layout so the front camera lands in the main slot.
 */
export function defaultCompositionForChannels(channels: Channel[]): CompositionState {
    const ordered = CANONICAL_CHANNEL_ORDER.filter((c) => channels.includes(c));
    const count = Math.min(4, Math.max(1, ordered.length));
    const layout = defaultLayoutForCount(count);
    const slots = layoutSlotCount(layout);
    const order = ordered.slice(0, slots);
    return {
        layout,
        channelOrder: order,
        audioChannel: order[0] ?? "front",
        perSlotCrops: Array.from({ length: slots }, () => null),
        perSlotScales: Array.from({ length: slots }, () => 1),
        perSlotPipPositions: Array.from({ length: slots }, () => null),
    };
}

/** Canonical channel order used to seed channelOrder defaults so front (the
 *  conventional "main camera") lands in slot 0 even when the trip exposes
 *  rear/interior in arbitrary order. */
export const CANONICAL_CHANNEL_ORDER: Channel[] = ["front", "rear", "interior", "side"];

/**
 * Default layout for a given visible-channel count, matching the app's
 * focus-first default (1 = single, 2/3/4 = pipN). Used for the initial
 * composition and when the channel-include toggles change the visible count.
 */
export function defaultLayoutForCount(count: number): Layout {
    const n = Math.min(4, Math.max(1, count));
    return n === 1 ? "single" : n === 2 ? "pip2" : n === 3 ? "pip3" : "pip4";
}

/**
 * Insert-reorder for the channel slot order: removes `ch` and re-inserts it at
 * slot `toIndex`, sliding the rest. This is the single model behind both reorder
 * affordances - dragging a video tile (player-tile-reorder.ts) and dragging a
 * top-panel chip - so they never diverge. Pure: returns a new array, does not
 * mutate the input.
 *
 * `toIndex` is the slot index the dragged channel should occupy in the result,
 * expressed against the ORIGINAL order's indices (i.e. the slot the user dropped
 * onto); it is clamped to the valid range after removal, so dropping onto the
 * last slot lands the channel at the end. Returns the input unchanged (a copy)
 * if `ch` is absent or the move is a no-op.
 */
export function moveChannelInOrder(order: Channel[], ch: Channel, toIndex: number): Channel[] {
    const from = order.indexOf(ch);
    if (from < 0) return order.slice();
    const without = order.slice(0, from).concat(order.slice(from + 1));
    const insertAt = Math.max(0, Math.min(toIndex, without.length));
    without.splice(insertAt, 0, ch);
    return without;
}

/**
 * Mutates state.composition atomically. Callsites that change layout /
 * channelOrder / audioChannel MUST go through this helper so per-slot arrays
 * get resized in sync with layout. Per-slot arrays preserve entries by
 * index (trailing entries dropped on shrink, defaults appended on grow).
 */
export function setLayoutAndChannels(args: {
    layout?: Layout;
    channelOrder?: Channel[];
    audioChannel?: Channel;
}): void {
    const next = { ...state.composition };
    if (args.layout && args.layout !== next.layout) {
        next.layout = args.layout;
        const slots = layoutSlotCount(args.layout);
        next.perSlotCrops = resizeSlotArray(next.perSlotCrops, slots, null);
        next.perSlotScales = resizeSlotArray(next.perSlotScales, slots, 1);
        next.perSlotPipPositions = resizeSlotArray(next.perSlotPipPositions, slots, null);
    }
    if (args.channelOrder) {
        next.channelOrder = args.channelOrder.slice(0, layoutSlotCount(next.layout));
    }
    // If channelOrder shrank and audioChannel is no longer present, fall back
    // to the new slot 0; the audio dropdown enforces "audio source must be
    // a visible channel" so this stays a safe default.
    const audio = args.audioChannel ?? next.audioChannel;
    next.audioChannel = next.channelOrder.includes(audio) ? audio : (next.channelOrder[0] ?? "front");
    state.composition = next;
}

/** Resets per-slot crops / scales / PiP positions to defaults for the current
 *  slot count. Called on trip change: these are expressed in fractions of a
 *  specific source frame, so carrying them onto a different trip lands them
 *  wrong. setLayoutAndChannels only resizes them on a layout CHANGE, so a trip
 *  whose layout matches the previous one would otherwise inherit stale values. */
export function resetPerSlotComposition(): void {
    const slots = layoutSlotCount(state.composition.layout);
    state.composition.perSlotCrops = Array.from({ length: slots }, () => null);
    state.composition.perSlotScales = Array.from({ length: slots }, () => 1);
    state.composition.perSlotPipPositions = Array.from({ length: slots }, () => null);
}

function resizeSlotArray<T>(arr: T[], targetLen: number, fillWith: T): T[] {
    if (arr.length === targetLen) return arr;
    if (arr.length > targetLen) return arr.slice(0, targetLen);
    return [...arr, ...Array.from({ length: targetLen - arr.length }, () => fillWith)];
}

export const state: AppState = {
    gpsLog: null,
    addedKeys: new Set(),
    trips: [],
    unindexed: new Set(),
    expandedTrips: new Set(),
    active: null,
    composition: defaultCompositionForChannels(["front"]),
    exportModeOpen: false,
    tripSortKey: "date",
    tripSortDir: "desc",
    tripFilters: { kind: "all", event: false, manual: false, notes: false, favorites: false },
    preferredPlaybackRate: 1,
    preferredVolume: 1,
    preferredMuted: false,
    tripEndBehavior: "stop",
    map: null,
    mapReady: false,
    marker: null,
    startMarker: null,
    endMarker: null,
    miniMap: null,
    miniMapReady: false,
    miniMapMarker: null,
    miniMapData: null,
    mapExpanded: false,
    hasTrack: false,
    hoverPopup: null,
    chart: null,
    chartTooltipEl: null,
    chartHoverX: null,
    chartZoomed: false,
    isPreviewZoom: false,
    videoZoom: { scale: 1, offsetX: 0, offsetY: 0 },
    // Default to the 3D "chase" follow on the big map (tilt + buildings + speed-
    // adaptive zoom). The tilt/buildings are engaged when the big map is first
    // shown (see ensureChaseEngaged in map.ts), since the hot follow loop only
    // maintains center/bearing/zoom, not pitch.
    followMode: "chase",
    ingestController: null,
    ingestQueue: [],
    lastIngestFiles: null,
    lastIngestStructure: null,
    transcodeInProgress: false,
    pendingHeavyEmbeddedGps: new Map(),
    inflightEmbeddedGps: new Map(),
    failedEmbeddedGps: new Set(),
    readingTrips: new Set(),
    recordingAnalysisProgress: null,
    channelBackends: {},
};
