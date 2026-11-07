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
import type { LogVideoTimingHint } from "../gps-association.js";
import type { ClassifiedFile } from "../parsers/registry.js";
import type { Channel, VendorFile } from "../parsers/types.js";
import type { IngestStructureEntry } from "../ingest-structure.js";
import type { PerFileMseBackend } from "../per-file-mse.js";
import type { RecordingAnalysisProgress } from "../recording-analysis-progress.js";
import type { TripFilters } from "../trip-filters.js";
import { firstRecordingChannel, frameCameraAvailability } from "../camera-availability.js";
import type { CameraArrangementMode, OverlayPosition } from "../camera-layout.js";
import type { CropRect } from "../transcode/compose.js";
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
// Trip list layout: large preview cards or compact one-line rows for long
// libraries. Persisted by trip-density-pref.ts.
export type TripListDensity = "cards" | "rows";
// What happens when the last clip of a trip ends. "advance" plays the next trip
// (chronologically) so the whole drive plays through.
type TripEndBehavior = "stop" | "loop" | "advance";

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

/** Where the audio comes from: the main camera (or, when its files carry no
 *  sound, the next camera that has some), or one camera the user picked. */
export type AudioSource = "follow-main" | Channel;

/**
 * Camera arrangement shared by playback and export: the player is the WYSIWYG
 * preview of the export, so the mode, order, sizes, crops and audio choice
 * apply to both the live playback and the saved file. Persistent across the
 * export-mode toggle within a session; the arrangement part (not crops or
 * audio) is remembered per camera set by player-layout-pref.ts.
 *
 * Everything is keyed by channel, never by position: swapping cameras keeps
 * each camera's crop and overlay window with that camera.
 */
export interface CompositionState {
    mode: CameraArrangementMode;
    /** Every camera of the trip in display order, hidden ones included. The
     *  first visible one is the main camera (and the master clock). */
    order: Channel[];
    /** Cameras the user switched off. At least one camera stays visible. */
    hidden: Channel[];
    /** Smaller cameras' size relative to the main one; null = automatic. */
    thumbScale: number | null;
    /** Lets the smaller cameras sit over the main picture when a strip would
     *  shrink it ("main" mode only). */
    allowOverlay: boolean;
    overlayPositions: Partial<Record<Channel, OverlayPosition>>;
    /** Export crop per camera (visible-image coordinates). */
    crops: Partial<Record<Channel, CropRect>>;
    audio: AudioSource;
}

/**
 * Digital zoom of one camera tile. Only one camera is zoomed at a time, so a
 * single minimap, badge and reset key always refer to the same view.
 * scale is in [1, 8]; offsetX/offsetY are pixels relative to the tile
 * (transform-origin = 0 0 on the video element). channel is null exactly when
 * scale is 1.
 */
export interface VideoZoomState {
    channel: Channel | null;
    scale: number;
    offsetX: number;
    offsetY: number;
}

/** Unzoomed state. Copy it: state.videoZoom is replaced, never mutated. */
export const NO_VIDEO_ZOOM: Readonly<VideoZoomState> = { channel: null, scale: 1, offsetX: 0, offsetY: 0 };

export interface AppState {
    gpsLog: ParsedLog | null;
    // Video timing from logs (openpilot qlog), kept across drops with each
    // log's reference so a video loaded after its log still receives it.
    logVideoTimingHints: LogVideoTimingHint[];
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
    tripListDensity: TripListDensity;
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
    // Digital zoom of one camera tile. Ephemeral: not persisted, reset on trip
    // change, channel reorder and focus<->split toggle. Owned by
    // src/ui/player-zoom.ts.
    videoZoom: VideoZoomState;
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

/** Cameras shown, in display order (the composition order without the
 *  hidden ones). Never empty for a composition built by this module. */
export function visibleChannels(composition: CompositionState = state.composition): Channel[] {
    return composition.order.filter((channel) => !composition.hidden.includes(channel));
}

/**
 * Main camera = first visible camera. It is the large tile in "main" mode,
 * the first tile in "equal" mode, and the preferred master clock. Falls back
 * to "front" only for an empty composition.
 */
export function mainChannel(): Channel {
    return visibleChannels()[0] ?? "front";
}

/**
 * Camera that plays as the master clock in `frame`: the first visible camera
 * with footage there (the main one, or the camera standing in for it - see
 * camera-availability.ts), else any camera of the frame so time keeps running
 * while every visible camera shows a placeholder. Null only for an empty frame.
 */
export function frameMasterChannel(frame: TripFrame): Channel | null {
    return firstRecordingChannel(frame, visibleChannels()) ?? pickFrameChannel(frame, mainChannel())?.channel ?? null;
}

/** frameMasterChannel with its file - for surfaces that show "the" picture of
 *  a moment (hover thumbnails, file names) the way the player shows it. */
export function frameMasterCandidate(frame: TripFrame): { channel: Channel; candidate: VideoCandidate } | null {
    const channel = frameMasterChannel(frame);
    const candidate = channel ? frame.channels[channel] : undefined;
    return channel && candidate ? { channel, candidate } : null;
}

/**
 * Current active VideoCandidate - the master camera's file in the frame
 * selected by state.active.frame. Returns null if active is invalid or the
 * frame is empty.
 */
export function activeCandidate(): VideoCandidate | null {
    const af = activeFrame();
    return af ? (frameMasterCandidate(af.frame)?.candidate ?? null) : null;
}

/**
 * Default composition for a trip's playable channels: canonical order (front
 * first), every camera visible, the main camera with the others beside it.
 */
export function defaultCompositionForChannels(channels: Channel[]): CompositionState {
    const order = CANONICAL_CHANNEL_ORDER.filter((c) => channels.includes(c));
    return {
        mode: "main",
        order: order.length ? order : ["front"],
        hidden: [],
        thumbScale: null,
        allowOverlay: false,
        overlayPositions: {},
        crops: {},
        audio: "follow-main",
    };
}

/** Canonical channel order used to seed the order so front (the conventional
 *  "main camera") comes first even when the trip lists rear/interior first. */
export const CANONICAL_CHANNEL_ORDER: Channel[] = ["front", "rear", "interior", "side"];

/**
 * Insert-reorder: removes `ch` and re-inserts it at `toIndex`, sliding the
 * rest. Reorders cameras within the strip and in "equal" mode. Pure: returns a
 * new array, does not mutate the input.
 *
 * `toIndex` is expressed against the ORIGINAL order's indices (the position
 * the user dropped onto); it is clamped to the valid range after removal, so
 * dropping onto the last position lands the channel at the end. Returns the
 * input unchanged (a copy) if `ch` is absent or the move is a no-op.
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
 * Swap-reorder: `a` and `b` trade places and every other channel stays put.
 * Making a smaller camera the main one swaps it with the main camera - an
 * insert would also shift the cameras between them ([A,B,C] with C to the
 * front becomes [C,B,A], not [C,A,B]). Pure; returns a copy unchanged when
 * either channel is absent.
 */
export function swapChannelsInOrder(order: readonly Channel[], a: Channel, b: Channel): Channel[] {
    const next = order.slice();
    const ia = next.indexOf(a);
    const ib = next.indexOf(b);
    if (ia < 0 || ib < 0) return next;
    next[ia] = b;
    next[ib] = a;
    return next;
}

/**
 * Replaces state.composition with `patch` applied and its invariants
 * restored: `hidden` only names cameras of `order` and never hides all of
 * them, and an explicit audio camera must be visible (else the audio follows
 * the main camera again). Every composition change goes through here.
 */
export function updateComposition(patch: Partial<CompositionState>): void {
    const next: CompositionState = { ...state.composition, ...patch };
    next.hidden = next.hidden.filter(
        (channel, index) => next.order.includes(channel) && next.hidden.indexOf(channel) === index,
    );
    if (next.hidden.length >= next.order.length)
        next.hidden = next.hidden.filter((channel) => channel !== next.order[0]);
    if (next.audio !== "follow-main" && !visibleChannels(next).includes(next.audio)) next.audio = "follow-main";
    state.composition = next;
}

/**
 * Whether a camera's recordings carry sound. A recording whose metadata is
 * still pending counts as having sound, so the audio follows the main camera
 * until the files prove otherwise.
 */
export function channelHasAudio(trip: Trip, channel: Channel): boolean {
    return trip.frames.some((frame) => {
        const candidate = frame.channels[channel];
        return !!candidate && (candidate.audio !== null || candidate.metadataReady === false);
    });
}

/**
 * Camera whose sound plays: the user's pick, else the first of `order` whose
 * files carry sound, else the first of `order`. `order` defaults to the
 * visible cameras; the viewer passes the layout order of the current moment so
 * the sound follows a camera standing in for the main one.
 */
export function audioChannel(order: readonly Channel[] = visibleChannels()): Channel {
    const audio = state.composition.audio;
    if (audio !== "follow-main" && visibleChannels().includes(audio)) return audio;
    const trip = activeTrip();
    const first = order[0] ?? mainChannel();
    if (!trip) return first;
    return order.find((channel) => channelHasAudio(trip, channel)) ?? first;
}

/**
 * Camera whose sound plays at `frame`: the user's pick, else the first camera
 * of that moment's layout order with footage and sound - a camera standing in
 * for a main one without footage brings its sound along.
 */
export function audioChannelAt(frame: TripFrame): Channel {
    const order = frameCameraAvailability(frame, visibleChannels(), state.composition.mode).order;
    const recording = order.filter((channel) => frame.channels[channel]);
    return audioChannel(recording.length ? recording : order);
}

export const state: AppState = {
    gpsLog: null,
    logVideoTimingHints: [],
    addedKeys: new Set(),
    trips: [],
    unindexed: new Set(),
    expandedTrips: new Set(),
    active: null,
    composition: defaultCompositionForChannels(["front"]),
    exportModeOpen: false,
    tripSortKey: "date",
    tripSortDir: "desc",
    tripListDensity: "cards",
    tripFilters: { kind: "all", event: false, manual: false, notes: false, favorites: false, query: "" },
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
    videoZoom: { ...NO_VIDEO_ZOOM },
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
