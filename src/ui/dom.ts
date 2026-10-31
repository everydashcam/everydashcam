// DOM references singleton. All static nodes from index.html live here;
// dynamically created nodes (popups, markers, chips) live in their own modules.
//
// Imports state from ./state.ts for the dom.player getter and activePlayer() -
// the active <video> is determined by mainChannel(). The dependency
// graph stays tree-shaped: state -> dom -> everything else.

import type { Channel } from "../parsers/types.js";
import { pickFrameChannel } from "../trips.js";

import { activeFrame, mainChannel } from "./state.js";

/**
 * Strict querySelector helper with an explicit result type - reduces DOM cast
 * boilerplate in the dom object below.
 */
function $id<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} not found`);
    return el as T;
}

function $sel<T extends HTMLElement>(selector: string): T {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`element ${selector} not found`);
    return el as T;
}

/**
 * Player channels in a fixed order. Used when populating the grid in playFrame:
 * for each channel we check whether it is present in the frame.
 */
export const ALL_CHANNELS: readonly Channel[] = ["front", "rear", "interior", "side"];

/**
 * Video slots per channel: [active-slot, preload-slot]. Active plays the current
 * file; preload holds a "hot" decoder for the next file so a swap on the "ended"
 * event happens without a micro-pause (see promotePreloadAsActive in player.ts).
 * On swap, activeSlotIdx[ch] flips - the physical <video> elements stay put, only
 * the pointer "who is active" changes. The CSS class .preload-slot is moved
 * synchronously via syncSlotRoles so visibility/pointer-events apply to the right one.
 *
 * Slave channels get the same treatment when the device can afford the extra
 * decoders (see canPreloadSlaveChannels / promoteSlavePreload in player.ts);
 * otherwise their slot[1] stays empty and they reload at each file change.
 */
const channelPlayerSlots: Record<Channel, [HTMLVideoElement, HTMLVideoElement]> = {
    front: [$id<HTMLVideoElement>("player"), $id<HTMLVideoElement>("player-preload")],
    rear: [$id<HTMLVideoElement>("player-rear"), $id<HTMLVideoElement>("player-rear-preload")],
    interior: [$id<HTMLVideoElement>("player-interior"), $id<HTMLVideoElement>("player-interior-preload")],
    side: [$id<HTMLVideoElement>("player-side"), $id<HTMLVideoElement>("player-side-preload")],
};

const activeSlotIdx: Record<Channel, 0 | 1> = { front: 0, rear: 0, interior: 0, side: 0 };

/**
 * Flips the active slot for a channel. Called when promoting preload to active
 * on the previous file's "ended" event. After the flip, channelPlayers[ch] and
 * dom.player immediately point to the new <video>; the .preload-slot class moves
 * to the ex-active slot.
 */
export function swapActiveSlot(ch: Channel): void {
    activeSlotIdx[ch] = activeSlotIdx[ch] === 0 ? 1 : 0;
    syncSlotRoles(ch);
}

/**
 * Syncs the .preload-slot CSS class with the current activeSlotIdx[ch].
 * Called after a swap; HTML init does not need this - initial markup is already
 * correct (slot[0] without the class, slot[1] with it).
 */
function syncSlotRoles(ch: Channel): void {
    const pair = channelPlayerSlots[ch];
    const activeIdx = activeSlotIdx[ch];
    const preloadIdx: 0 | 1 = activeIdx === 0 ? 1 : 0;
    pair[activeIdx].classList.remove("preload-slot");
    pair[preloadIdx].classList.add("preload-slot");
}

/**
 * The <video> element in the preload slot of the channel (the one that is NOT
 * currently active). Used in setPreloadSrc/clearPreloadSlot - we load the next
 * file there and promote it from there on swap.
 */
export function preloadPlayer(ch: Channel): HTMLVideoElement {
    const pair = channelPlayerSlots[ch];
    return pair[activeSlotIdx[ch] === 0 ? 1 : 0];
}

/**
 * Iterates over ALL <video> elements from both slots of all channels (8 total).
 * Required for listener installation: on swap the logically active <video>
 * becomes a different physical element, so a filter `v === activePlayer()` will
 * correctly pass its handler through. Without installation on both slots, the
 * listener would never fire on the swapped-in element.
 */
export function forEachVideoSlot(fn: (v: HTMLVideoElement, ch: Channel, slotIdx: 0 | 1) => void): void {
    for (const ch of ALL_CHANNELS) {
        const pair = channelPlayerSlots[ch];
        fn(pair[0], ch, 0);
        fn(pair[1], ch, 1);
    }
}

/**
 * Tile DOM element for a channel. Shared between the playback core (which
 * toggles .active / .hidden) and the zoom subsystem (which toggles .zoomed).
 * Lives here rather than in player.ts so player-zoom.ts can use it without
 * pulling in the playback core.
 */
export function channelTileFor(ch: Channel): HTMLElement {
    switch (ch) {
        case "front":
            return dom.videoTileFront;
        case "rear":
            return dom.videoTileRear;
        case "interior":
            return dom.videoTileInterior;
        case "side":
            return dom.videoTileSide;
    }
}

/**
 * Maximum allowed drift between slave channels and master. Excess triggers a
 * hard resync (`slave.currentTime = master.currentTime`). 150ms is noticeable
 * but wide enough to avoid nudging slaves every rAF (setting currentTime
 * decodes a frame and causes a mini-stutter).
 *
 * Same threshold used by the zoom mini-preview to drift-sync the duplicate
 * <video> against master - keep the constant in one place.
 */
export const SLAVE_DRIFT_MAX_SEC = 0.15;

/**
 * Returns true if v is the current active slot of any channel. Used in the
 * slave loadedmetadata listener to distinguish "loadedmetadata from the current
 * active slave" (sync with master) from "loadedmetadata from the preload slot"
 * (no sync needed - preload must stay at the beginning).
 */
export function isActiveSlot(v: HTMLVideoElement): boolean {
    for (const ch of ALL_CHANNELS) {
        if (channelPlayerSlots[ch][activeSlotIdx[ch]] === v) return true;
    }
    return false;
}

/**
 * Public API: returns the current active slot for each channel. Implemented as
 * a Proxy so that existing code such as `channelPlayers[ch]` and
 * `Object.values(channelPlayers)` sees the new elements immediately after a swap
 * without any changes at call sites.
 *
 * ownKeys + getOwnPropertyDescriptor are needed so Object.keys / Object.values /
 * for...in work correctly (a Proxy does not provide this by default).
 */
export const channelPlayers: Record<Channel, HTMLVideoElement> = new Proxy({} as Record<Channel, HTMLVideoElement>, {
    get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const pair = channelPlayerSlots[prop as Channel];
        if (!pair) return undefined;
        return pair[activeSlotIdx[prop as Channel]];
    },
    has(_t, prop) {
        return typeof prop === "string" && prop in channelPlayerSlots;
    },
    ownKeys() {
        return Object.keys(channelPlayerSlots);
    },
    getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const pair = channelPlayerSlots[prop as Channel];
        if (!pair) return undefined;
        return {
            value: pair[activeSlotIdx[prop as Channel]],
            enumerable: true,
            configurable: true,
            writable: false,
        };
    },
});

/**
 * Channel of the actually playing master video. If the current frame has
 * mainChannel(), that is used. Otherwise falls back via pickFrameChannel
 * (same logic as activeCandidate in state.ts) - needed when the preferred
 * channel was saved from a previous multi-channel trip but the current
 * single-channel trip only has a different channel. Without the fallback,
 * activePlayer would return an empty <video>, breaking captureCurrentFrame,
 * dom.player.play()/.currentTime, and other operations that assume "master
 * is playing".
 */
export function effectiveMasterChannel(): Channel {
    const main = mainChannel();
    const af = activeFrame();
    if (!af) return main;
    return pickFrameChannel(af.frame, main)?.channel ?? main;
}

/** The active (master) <video> - the one currently playing video. */
export function activePlayer(): HTMLVideoElement {
    return channelPlayers[effectiveMasterChannel()];
}

/**
 * Attaches a media event handler to ALL video elements (both slots of all channels
 * = 8 total), but calls the handler only when the event came from the active player.
 * This lets callers write listeners as if targeting dom.player, without worrying
 * about swaps: when preferredChannel or the active slot changes, the "active" video
 * automatically becomes a different element and the handler fires on it.
 */
export function onActivePlayerEvent<E extends keyof HTMLVideoElementEventMap>(
    eventName: E,
    handler: (e: HTMLVideoElementEventMap[E]) => void,
): void {
    forEachVideoSlot((v) => {
        v.addEventListener(eventName, (ev) => {
            // Compare against the closure variable v (the video that owns the listener),
            // not ev.target - target could be a nested element (if video gains children
            // via shadow DOM or future attributes) and the comparison would fail.
            if (v !== activePlayer()) return;
            handler(ev as HTMLVideoElementEventMap[E]);
        });
    });
}

export const dom = {
    folderInput: $id<HTMLInputElement>("folder-input"),
    /** Plain multi-file input - the iOS escape hatch from the folder-copy trap
     *  (see ios-folder-warning-modal.ts). */
    fileInput: $id<HTMLInputElement>("file-input"),
    videoGrid: $id<HTMLElement>("video-grid"),
    viewModeBtn: $id<HTMLButtonElement>("player-view-mode"),
    videoTileFront: $sel<HTMLElement>('.video-tile[data-channel="front"]'),
    videoTileRear: $sel<HTMLElement>('.video-tile[data-channel="rear"]'),
    videoTileInterior: $sel<HTMLElement>('.video-tile[data-channel="interior"]'),
    videoTileSide: $sel<HTMLElement>('.video-tile[data-channel="side"]'),
    /** Nullable like the other landing refs below: landing.ts nulls them on
     *  landing removal so the detached subtree can be GC'd - consumers must
     *  null-check. */
    landingCta: $id<HTMLElement>("landing-cta") as HTMLElement | null,
    /** Wrapping <label> of the drop CTA. Click target for upload-warning gate -
     *  see file-sources.ts. Separate from landingCta because the inner button
     *  is the FLIP source; clicks elsewhere inside the label (codecs, hint
     *  text) must still go through the gate. */
    landingDrop: $id<HTMLLabelElement>("landing-drop") as HTMLLabelElement | null,
    /** Docked CTA pill (visible when the drop card scrolls out of view). Wired
     *  through the same picker gate as landingDrop - label-for semantics skip
     *  clicks on the inner <button>, so the explicit handler is what makes the
     *  button work (see file-sources.ts). */
    landingDock: document.getElementById("landing-dock") as HTMLLabelElement | null,
    sidebarCta: $id<HTMLElement>("sidebar-cta"),
    landingRoot: document.getElementById("landing") as HTMLElement | null,
    tripAnalysisStatus: $id<HTMLElement>("trip-analysis-status"),
    tripAnalysisPercent: $id<HTMLElement>("trip-analysis-percent"),
    tripAnalysisProgressbar: $id<HTMLElement>("trip-analysis-progressbar"),
    tripAnalysisProgressFill: $id<HTMLElement>("trip-analysis-progress-fill"),
    tripAnalysisProgress: $id<HTMLElement>("trip-analysis-progress"),
    list: $id<HTMLElement>("trip-list"),
    tripFilters: $id<HTMLElement>("trip-filters"),
    tripFilterKinds: $id<HTMLElement>("trip-filter-kinds"),
    tripFilterOptions: $id<HTMLElement>("trip-filter-options"),
    tripFilterResult: $id<HTMLElement>("trip-filter-result"),
    tripFilterReset: $id<HTMLButtonElement>("trip-filter-reset"),
    tripSearch: $id<HTMLInputElement>("trip-search"),
    tripFilterToggle: $id<HTMLButtonElement>("trip-filter-toggle"),
    tripFilterCount: $id<HTMLElement>("trip-filter-count"),
    tripFilterTray: $id<HTMLElement>("trip-filter-tray"),
    tripJump: $id<HTMLButtonElement>("trip-jump"),
    tripJumpPanel: $id<HTMLElement>("trip-jump-panel"),
    sortKey: $id<HTMLSelectElement>("trip-sort-key"),
    sortDir: $id<HTMLButtonElement>("trip-sort-dir"),
    tripDensity: $id<HTMLElement>("trip-density"),
    sidebarResize: $id<HTMLDivElement>("sidebar-resize"),
    sidebarToggle: $id<HTMLButtonElement>("sidebar-toggle"),
    sidebar: $sel<HTMLElement>(".sidebar"),
    drawerScrim: $id<HTMLElement>("drawer-scrim"),
    topbarBurger: $id<HTMLButtonElement>("topbar-burger"),
    videoMapResize: $id<HTMLDivElement>("video-map-resize"),
    mapWrap: $sel<HTMLDivElement>(".map-wrap"),
    /**
     * UX-18: follow mode is now a segmented control (3 buttons instead of one
     * cyclic button). The old #map-follow was removed; access via querySelectorAll
     * on data-follow-mode inside .map-follow-segments.
     */
    mapFollowSegments: $sel<HTMLDivElement>(".map-follow-segments"),
    // Chase-mode sub-controls (tilt slider + speed-adaptive-zoom toggle). Hidden
    // unless followMode === "chase" (see syncChaseControls in map.ts).
    mapChaseControls: $id<HTMLDivElement>("map-chase-controls"),
    mapChaseTilt: $id<HTMLInputElement>("map-chase-tilt"),
    mapChaseAdaptive: $id<HTMLButtonElement>("map-chase-adaptive"),
    mapRecenterBtn: $id<HTMLButtonElement>("map-recenter"),
    // Gear popover with map view preferences (see src/ui/map-settings-popover.ts).
    mapSettingsToggle: $id<HTMLButtonElement>("map-settings-toggle"),
    mapSettingsPopover: $id<HTMLDivElement>("map-settings-popover"),
    mapViewControl: $id<HTMLDivElement>("map-view-control"),
    mapMarkerControl: $id<HTMLDivElement>("map-marker-control"),
    mapLabelScaleSegment: $id<HTMLDivElement>("map-label-scale-segment"),
    mapStreetNamesSegment: $id<HTMLDivElement>("map-street-names-segment"),
    mapGpsSyncBtn: $id<HTMLButtonElement>("map-gps-sync-btn"),
    mapGpsSyncLabel: $id<HTMLElement>("map-gps-sync-label"),
    mapCollapseBtn: $id<HTMLButtonElement>("map-collapse"),
    playerMapBtn: $id<HTMLButtonElement>("player-map"),
    miniMap: $id<HTMLDivElement>("mini-map"),
    videoMinimap: $id<HTMLDivElement>("video-minimap"),
    videoMinimapCanvas: $id<HTMLCanvasElement>("video-minimap-canvas"),
    videoMinimapFrame: $id<HTMLDivElement>("video-minimap-frame"),
    videoLoadingOverlay: $id<HTMLDivElement>("video-loading-overlay"),
    viewer: $sel<HTMLElement>(".viewer"),
    dropOverlay: $id<HTMLElement>("drop-overlay"),
    ingestOverlay: $id<HTMLElement>("ingest-overlay"),
    ingestOverlayStatus: $id<HTMLElement>("ingest-overlay-status"),
    ingestOverlayQueue: $id<HTMLElement>("ingest-overlay-queue"),
    ingestOverlayCancel: $id<HTMLButtonElement>("ingest-overlay-cancel"),
    // dom.player - always the currently active <video> (effectiveMasterChannel:
    // preferred with fallback to pickFrameChannel if preferred channel is absent
    // in the current frame). A getter so existing code can keep using
    // `dom.player.src/.currentTime/.play()` unchanged. On channel or slot swap,
    // dom.player automatically points to the new <video>.
    get player(): HTMLVideoElement {
        return channelPlayers[effectiveMasterChannel()];
    },
    playerWrap: $id<HTMLElement>("player-wrap"),
    playerBar: {
        play: $id<HTMLButtonElement>("player-play"),
        seekBack: $id<HTMLButtonElement>("player-seek-back"),
        seekFwd: $id<HTMLButtonElement>("player-seek-fwd"),
        stepBack: $id<HTMLButtonElement>("player-step-back"),
        stepFwd: $id<HTMLButtonElement>("player-step-fwd"),
        mute: $id<HTMLButtonElement>("player-mute"),
        muteWrap: $sel<HTMLDivElement>(".player-mute-wrap"),
        volumePopover: $id<HTMLDivElement>("player-volume-popover"),
        volumeSlider: $id<HTMLInputElement>("player-volume"),
        speed: $id<HTMLButtonElement>("player-speed"),
        speedMenu: $id<HTMLUListElement>("player-speed-menu"),
        capture: $id<HTMLButtonElement>("player-capture"),
        loop: $id<HTMLButtonElement>("player-loop"),
        fullscreen: $id<HTMLButtonElement>("player-fullscreen"),
        fullscreenExit: $id<HTMLButtonElement>("player-fullscreen-exit"),
        current: $id<HTMLElement>("player-current"),
        total: $id<HTMLElement>("player-total"),
    },
    miniMapClose: $id<HTMLButtonElement>("mini-map-close"),
    mapStyleError: $id<HTMLDivElement>("map-style-error"),
    mapStyleRetry: $id<HTMLButtonElement>("map-style-retry"),
    mapStyleDismiss: $id<HTMLButtonElement>("map-style-dismiss"),
    chartCanvas: $id<HTMLCanvasElement>("player-chart-canvas"),
    playerChartEl: $id<HTMLElement>("player-chart"),
    playerChartRulerTop: $id<HTMLDivElement>("player-chart-ruler-top"),
    playerChartZoomRow: $id<HTMLDivElement>("player-chart-zoom-row"),
    playerChartOverview: $id<HTMLDivElement>("player-chart-overview"),
    playerChartOverviewViewport: $id<HTMLDivElement>("player-chart-overview-viewport"),
    playerChartOverviewStart: $id<HTMLDivElement>("player-chart-overview-start"),
    playerChartOverviewEnd: $id<HTMLDivElement>("player-chart-overview-end"),
    playerChartZoomStatus: $id<HTMLDivElement>("player-chart-zoom-status"),
    playerChartZoomFactor: $id<HTMLSpanElement>("player-chart-zoom-factor"),
    playerChartZoomRange: $id<HTMLSpanElement>("player-chart-zoom-range"),
    playerChartZoomOut: $id<HTMLButtonElement>("player-chart-zoom-out"),
    playerChartZoomIn: $id<HTMLButtonElement>("player-chart-zoom-in"),
    playerChartOverviewReset: $id<HTMLButtonElement>("player-chart-overview-reset"),
    exportBtn: $id<HTMLButtonElement>("player-export"),
    // === New side-drawer export panel + top-panel (replace export-modal). ===
    // Visibility tied to state.exportModeOpen via body.export-mode + the
    // top-panel matrix (see src/ui/top-panel.ts). Skeleton in index.html, content
    // rendered by src/ui/top-panel.ts and src/ui/export-panel.ts.
    topPanel: $id<HTMLDivElement>("top-panel"),
    topPanelTripName: $id<HTMLDivElement>("top-panel-trip-name"),
    topPanelLayout: $id<HTMLDivElement>("top-panel-layout"),
    topPanelChannels: $id<HTMLDivElement>("top-panel-channels"),
    topPanelAudio: $id<HTMLDivElement>("top-panel-audio"),
    exportPanel: $id<HTMLElement>("export-panel"),
    // Trim bar between the video and the timeline stack (clip-range controls).
    // Skeleton in index.html, content rendered by src/ui/export-trim-bar.ts.
    exportTrimBar: $id<HTMLDivElement>("export-trim-bar"),
    exportPanelClose: $id<HTMLButtonElement>("export-panel-close"),
    exportPanelOptions: $id<HTMLDivElement>("export-panel-options"),
    exportPanelActions: $id<HTMLDivElement>("export-panel-actions"),
    exportPanelProgress: $id<HTMLDivElement>("export-panel-progress"),
    exportPanelDone: $id<HTMLDivElement>("export-panel-done"),
    exportPanelError: $id<HTMLDivElement>("export-panel-error"),
    // Export-mode preview overlays burned into the player frame. Updated by
    // src/ui/player-overlays.ts from the current GPS record.
    playerOverlayFrame: $id<HTMLDivElement>("player-overlay-frame"),
    playerWatermark: $id<HTMLDivElement>("player-watermark"),
    // Canvas that paints scrim + every non-map widget via the shared export
    // draw code (preview == burned output). Sits behind the drag hit-boxes.
    playerTelemetryCanvas: $id<HTMLCanvasElement>("player-telemetry-canvas"),
    // speed/coords are transparent drag hit-boxes; the visible readout is on
    // the telemetry canvas. The other widgets' hit-boxes live in the container.
    playerSpeedOverlay: $id<HTMLDivElement>("player-speed-overlay"),
    playerCoordsOverlay: $id<HTMLDivElement>("player-coords-overlay"),
    playerOverlayHitboxes: $id<HTMLDivElement>("player-overlay-hitboxes"),
    playerMapOverlay: $id<HTMLDivElement>("player-map-overlay"),
    playerMapOverlayCanvas: $id<HTMLCanvasElement>("player-map-overlay-canvas"),
    playerMapOverlayResize: $id<HTMLButtonElement>("player-map-overlay-resize"),
    // Fallback-progress scrubber, visible when both chart canvas and events
    // strip are hidden via the "View" menu. Drag/click → seek; fill width
    // updated from updatePlayerProgressUi.
    miniProgress: $id<HTMLDivElement>("player-mini-progress"),
    miniProgressThumb: $id<HTMLDivElement>("player-mini-progress-thumb"),
    miniProgressTooltip: $id<HTMLDivElement>("player-mini-progress-tooltip"),
    miniProgressThumbCanvas: $id<HTMLCanvasElement>("player-mini-progress-thumb-canvas"),
    miniProgressTime: $id<HTMLSpanElement>("player-mini-progress-time"),
    unsupportedModal: $id<HTMLElement>("unsupported-modal"),
    unsupportedModalList: $id<HTMLUListElement>("unsupported-modal-list"),
    unsupportedModalClose: $id<HTMLButtonElement>("unsupported-modal-close"),
    chromiumBrowsersModal: $id<HTMLElement>("chromium-browsers-modal"),
    chromiumBrowsersModalClose: $id<HTMLButtonElement>("chromium-browsers-modal-close"),
    uploadWarningModal: $id<HTMLElement>("upload-warning-modal"),
    uploadWarningModalContinue: $id<HTMLButtonElement>("upload-warning-modal-continue"),
    uploadWarningModalCancel: $id<HTMLButtonElement>("upload-warning-modal-cancel"),
    iosFolderWarningModal: $id<HTMLElement>("ios-folder-warning-modal"),
    iosFolderWarningModalFiles: $id<HTMLButtonElement>("ios-folder-warning-modal-files"),
    iosFolderWarningModalFolder: $id<HTMLButtonElement>("ios-folder-warning-modal-folder"),
    iosFolderWarningModalCancel: $id<HTMLButtonElement>("ios-folder-warning-modal-cancel"),
    switchLangModal: document.getElementById("switch-lang-modal") as HTMLElement | null,
    switchLangModalConfirm: document.getElementById("switch-lang-modal-confirm") as HTMLButtonElement | null,
    switchLangModalCancel: document.getElementById("switch-lang-modal-cancel") as HTMLButtonElement | null,
    tripPreparation: $id<HTMLElement>("trip-preparation"),
    tripPreparationTitle: $id<HTMLElement>("trip-preparation-title"),
    tripPreparationProgress: $id<HTMLElement>("trip-preparation-progress"),
    tripPreparationProgressbar: $id<HTMLElement>("trip-preparation-progressbar"),
    tripPreparationProgressFill: $id<HTMLElement>("trip-preparation-progress-fill"),
    tripPreparationCancel: $id<HTMLButtonElement>("trip-preparation-cancel"),
    gpsSyncModal: $id<HTMLElement>("gps-sync-modal"),
    gpsSyncTimezoneSection: $id<HTMLElement>("gps-sync-timezone-section"),
    gpsSyncTimezoneSelect: $id<HTMLSelectElement>("gps-sync-timezone-select"),
    gpsSyncTimezoneSource: $id<HTMLElement>("gps-sync-timezone-source"),
    gpsSyncTimezonePreview: $id<HTMLElement>("gps-sync-timezone-preview"),
    gpsSyncTimezoneReset: $id<HTMLButtonElement>("gps-sync-timezone-reset"),
    gpsSyncTimezoneNoMatch: $id<HTMLElement>("gps-sync-timezone-no-match"),
    gpsSyncControls: $id<HTMLElement>("gps-sync-controls"),
    gpsSyncNoTrack: $id<HTMLElement>("gps-sync-no-track"),
    gpsSyncOffsetInput: $id<HTMLInputElement>("gps-sync-offset-input"),
    gpsSyncTrimToggle: $id<HTMLInputElement>("gps-sync-trim-toggle"),
    gpsSyncOutsideStatus: $id<HTMLElement>("gps-sync-outside-status"),
    gpsSyncAlignPlayhead: $id<HTMLButtonElement>("gps-sync-align-playhead"),
    gpsSyncReset: $id<HTMLButtonElement>("gps-sync-reset"),
    gpsSyncApplyCamera: $id<HTMLButtonElement>("gps-sync-apply-camera"),
    gpsSyncClose: $id<HTMLButtonElement>("gps-sync-close"),
    // GPS readouts for the playhead. `speed`/`unit`/`speedToggle` live in the
    // readout row; `barSpeed`/`barUnit`/`barSpeedToggle` are the speed-only
    // copy the player bar keeps for phones, where the row is not shown. Both
    // copies are written and wired by player-metrics.ts - the row is absent
    // from neither DOM, only from one viewport.
    metrics: {
        readout: $id<HTMLElement>("player-readout"),
        fixLabel: $id<HTMLElement>("readout-fix-label"),
        speed: $id<HTMLElement>("pm-speed"),
        unit: $id<HTMLElement>("pm-unit"),
        speedToggle: $id<HTMLButtonElement>("pm-speed-toggle"),
        coords: $id<HTMLButtonElement>("pm-coords"),
        time: $id<HTMLElement>("pm-time"),
        distance: $id<HTMLElement>("pm-distance-value"),
        distanceUnit: $id<HTMLElement>("pm-distance-unit"),
        file: $id<HTMLButtonElement>("readout-file"),
        barSpeed: $id<HTMLElement>("pm-bar-speed"),
        barUnit: $id<HTMLElement>("pm-bar-unit"),
        barSpeedToggle: $id<HTMLButtonElement>("pm-bar-speed-toggle"),
        gpsSyncPill: $id<HTMLButtonElement>("gps-sync-pill"),
        gpsSyncPillLabel: $id<HTMLElement>("gps-sync-pill-label"),
        gpsSyncPillMobile: $id<HTMLButtonElement>("gps-sync-pill-mobile"),
        gpsSyncPillMobileLabel: $id<HTMLElement>("gps-sync-pill-mobile-label"),
    },
    chartInferredStrip: $id<HTMLCanvasElement>("player-chart-inferred-strip"),
    chartInferredStripWrap: $id<HTMLDivElement>("player-chart-inferred-strip-wrap"),
    playerChartPlayhead: $id<HTMLDivElement>("player-chart-playhead"),
    playerChartHoverCursor: $id<HTMLDivElement>("player-chart-hover-cursor"),
    viewMenuButton: $id<HTMLButtonElement>("player-view-menu"),
    viewMenuPopover: $id<HTMLDivElement>("player-view-menu-popover"),
    langToggle: document.getElementById("lang-toggle") as HTMLButtonElement | null,
    langMenu: document.getElementById("lang-menu") as HTMLUListElement | null,
};
