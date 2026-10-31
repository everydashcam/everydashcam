// Heavy UI init, deferred until the first ingest.
//
// Why not at startup: before the first trip the user only sees the landing page. Map, Chart.js,
// the player, and the marker rAF loop are not needed - but initializing them in app.ts would
// make MapLibre immediately fetch vector tiles, sprite, and Noto Sans glyph atlas (15+ requests),
// create a WebGL context, and start its render loop. Profiler on the landing shows 39% of time
// in "Animation frame fired" - all MapLibre ticking for nothing. Deferred: CPU baseline ~0% on the landing.
//
// Idempotency: initTripUi() returns a memoized promise, so repeated calls run the work exactly
// once. Required because renderTrips() can be called many times as ingest progressively adds trips.
//
// Call site: src/ui/landing.ts exitLanding() - as soon as state.trips.length > 0. It is now async
// (it lazy-loads maplibre-gl ~1MB, T9) and is fired WITHOUT awaiting, so the landing->app FLIP is
// not blocked on the download. The viewer DOM nodes are static HTML; the map/chart populate a beat
// later. The sidebar play-callback (app.ts) awaits this promise before playFrame, so a trip never
// renders against a half-initialized viewer.

import { applyChartLayout, initChart, loadChart, setHoverCursorRelSec } from "./chart.js";
import { dom } from "./dom.js";
import {
    applyMapLayout,
    ensureMap,
    ensureMiniMap,
    initMap,
    loadMaplibre,
    startMarkerLoop,
    syncMapFollowButton,
} from "./map.js";
import {
    driftSyncSlaves,
    getTripCurrentTime,
    initPlayer,
    seekTripTime,
    syncCaptureButton,
    syncExportButton,
    syncFullscreenButton,
    syncLoopButton,
    syncMuteButton,
    syncPlayButton,
    syncSpeedButton,
    updatePlayerProgressUi,
} from "./player.js";
import { syncRangeZoomBridge } from "./export-trim-bar.js";
import { initPlayerBarOverflow } from "./player-bar-overflow.js";
import { initPlayerResize } from "./player-resize.js";
import { syncTimelineRange } from "./timeline-range.js";

let initPromise: Promise<void> | null = null;

/**
 * Lazily initializes the heavy trip UI (map, chart, player, rAF loop). Returns a
 * memoized promise: safe to call many times (progressive-ingest renderTrips, the
 * sidebar play-callback) - the work runs exactly once and callers can await
 * readiness before touching the viewer.
 */
export function initTripUi(): Promise<void> {
    if (!initPromise) initPromise = runTripUiInit();
    return initPromise;
}

/**
 * The actual init. Async only because it lazy-loads maplibre-gl (~1MB) up front
 * (T9) - the lib is fetched on first ingest, not on the landing page. Everything
 * after the load stays synchronous, so the ordering invariants are preserved:
 *  - initChart must come AFTER ensureMap/ensureMiniMap (refreshThemeColors via initMap fires chart-related syncs through theme callbacks).
 *  - initPlayer must come AFTER initChart (player ratechange/timeupdate listeners talk to the chart).
 *  - sync*Button and updatePlayerProgressUi must come after their respective inits.
 */
async function runTripUiInit(): Promise<void> {
    // Single async hop: bring the heavy viewer libs (maplibre-gl ~1MB, chart.js
    // ~240KB) into memory in parallel before any map/chart is created. The sync
    // inits below (ensureMap, initChart, ...) then run against the loaded holders.
    await Promise.all([loadMaplibre(), loadChart()]);

    initPlayerResize();

    ensureMap();
    ensureMiniMap();
    initMap({
        onSeekTripTime: (sec) => seekTripTime(sec),
        onChartLayoutChange: () => applyChartLayout(),
        onHoverTripTime: setHoverCursorRelSec,
    });
    applyMapLayout();
    // At startup hasTrack = false - applyChartLayout adds no-gps to player-wrap so the chart is not visible before a trip is selected.
    applyChartLayout();

    initChart({
        getTripCurrentTime,
        onSeekTripTime: seekTripTime,
        onPause: () => {
            if (dom.player) dom.player.pause();
        },
        // On any visible-window change (zoom / reset / programmatic zoom)
        // refresh the export button AND re-position the range pull-tabs:
        // their pixel anchors move with the chart's zoomed x-window, so a
        // zoom without this re-sync leaves the tabs/masks stale. The trim
        // bar's from-zoom bridge button tracks the zoom state here too -
        // zoom changes never tick the export-state bus.
        onSelectionChange: () => {
            syncExportButton();
            syncTimelineRange();
            syncRangeZoomBridge();
        },
        // Every zoom/pan step moves the visible window: re-position the player
        // playhead + progress thumb (else the current position stays anchored
        // to the old window) and the export range pull-tabs.
        onViewChanged: () => {
            updatePlayerProgressUi();
            syncTimelineRange();
        },
    });
    initPlayer();
    // Overflow menu for the player-bar: on a narrow bar capture/loop/view-mode/help
    // move into the kebab. Must run AFTER initPlayer - that wires click handlers
    // onto the original buttons, and the menu clone forwards the click to them.
    initPlayerBarOverflow();

    // Sync DOM to current state. Most of these read state into attributes/textContent and are idempotent.
    syncPlayButton();
    syncMuteButton();
    syncSpeedButton();
    syncFullscreenButton();
    syncLoopButton();
    syncMapFollowButton();
    syncExportButton();
    syncCaptureButton();
    updatePlayerProgressUi();

    startMarkerLoop({ onAfterTick: driftSyncSlaves });
}
