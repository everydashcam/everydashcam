import { initPlayerCameraFlip } from "./ui/player-camera-flip.js";
import { initMobileViewNav } from "./ui/mobile-view-nav.js";
// Frontend entry point. Vanilla DOM, no framework.
//
// Thin orchestrator shell: imports modules from ui/* and wires them via
// init callbacks. All meaningful logic lives in the modules:
//
//   ui/state.ts        - AppState singleton and helpers (activeFrame, activeCandidate)
//   ui/dom.ts          - DOM references, channelPlayers, $id/$sel
//   ui/format.ts       - pure formatters (formatTime, formatDuration, ...)
//   ui/theme.ts        - theme colors, getCssVar, refresh on prefers-color-scheme change
//   ui/notifications.ts - bell drawer + toast stack (replaces the old status bar)
//   ui/empty-state.ts  - empty-state and codec-unsupported overlay
//   ui/ingest-overlay.ts - blocking ingest overlay
//   ui/lang-switcher.ts - language toggle
//   ui/mobile-drawer.ts - mobile sidebar drawer
//   ui/sidebar-resize.ts / ui/player-resize.ts - drag-handle resizers
//   ui/sidebar.ts      - trip sidebar renderer
//   ui/ingest.ts       - discovery/sidecars plus progressive recording ingest
//   ui/file-sources.ts - <input webkitdirectory> + DnD
//   ui/map.ts          - map, mini-map, markers, popup, expand/collapse, marker rAF
//   ui/chart.ts        - chart.js strip, cursor plugin, no-gps tooltip
//   ui/export-panel.ts - inline range-export panel (options/progress/done/error)
//   ui/player.ts       - playFrame, multichannel grid, toolbar, keyboard, scrubber

// CSS import order matters:
//  1) maplibre-gl.css FIRST - our rules must override map defaults.
//  2) fonts.css SECOND - @font-face for self-hosted fonts; Vite inlines
//     them into the shared CSS bundle, avoiding render-blocking @import.
//     The woff2 files live in public/fonts/ and are fetched on first use.
//  3) tokens.css THIRD - all --dc-* design-system variables.
//  4) styles/index.css FOURTH - aggregator that @imports component
//     stylesheets in cascade order. Individual files live under
//     styles/components and styles/modals; the aggregator keeps imports
//     here trivial and lets Vite inline everything into one prod bundle.
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/index.css";

import { applyStaticI18n, getCurrentLang } from "./i18n/index.js";
import { createLogger, downloadLogBuffer, getLogBuffer, setLogRules } from "./log.js";
import { initSentry } from "./sentry.js";
import { APP_VERSION } from "./version.js";
import { initPortableUpdates } from "./portable/updates.js";

import { initCapabilityGate, surfaceDegradedCapabilities, surfaceMapUnavailable } from "./ui/capability-gate.js";
import { initConnectivity } from "./ui/connectivity.js";
import { initOfflineBanner } from "./ui/offline-banner.js";
import { scheduleServiceWorkerRegistration } from "./ui/sw-registration.js";
import { initLangSuggestionBanner } from "./ui/lang-suggestion-banner.js";
import { initLandingDock } from "./ui/landing-dock.js";
import { initLandingShot } from "./ui/landing-shot.js";
import { initLandingTopbar } from "./ui/landing-topbar.js";
import { dom } from "./ui/dom.js";
import { syncEmptyState } from "./ui/empty-state.js";
import { initFileSources } from "./ui/file-sources.js";
import { initFolderSources } from "./ui/folder-sources.js";
import { initPersistentFolders } from "./ui/persistent-folders.js";
import { initAnnotations, registerMarkersRestampedHook } from "./ui/annotations.js";
import { initTripMetaModal, openTripMetaModal } from "./ui/trip-meta-modal.js";
import { initTimelineMarkers, refreshTimelineMarkers } from "./ui/timeline-markers.js";
import { initMarkerListModal } from "./ui/marker-list-modal.js";
import { initMarkerModal } from "./ui/marker-modal.js";
import { initAnnotationsSidecar } from "./ui/annotations-sidecar.js";
import { initNotesNudge } from "./ui/notes-nudge.js";
import { registerTimelineOverlaySync } from "./ui/chart.js";
import { initIngestOverlay } from "./ui/ingest-overlay.js";
import { initNotifications, notify } from "./ui/notifications.js";
import { initPwaInstall } from "./ui/pwa-install.js";
import { initOfflineUse } from "./ui/offline-use.js";
import { initMapSettingsPopover } from "./ui/map-settings-popover.js";
import { initGpsSyncModal, openGpsSync } from "./ui/gps-sync-modal.js";
import { notifyUnmatchedDirectoryGps } from "./ui/gps-sync-nudge.js";
import { registerCameraTimezoneHandler } from "./ui/camera-timezone.js";
import { applyRecordingCameraTimezone } from "./ui/ingest-regroup.js";
import { initSettingsModal } from "./ui/settings-modal.js";
import { initNoRecordingsModal } from "./ui/no-recordings-modal.js";
import { isIntentionalNavigation } from "./ui/nav-intent.js";
import { initSwitchLangModal } from "./ui/switch-lang-modal.js";
import { initUnsupportedFormatsModal } from "./ui/unsupported-formats-modal.js";
import { initIosFolderWarningModal } from "./ui/ios-folder-warning-modal.js";
import { initUploadWarningModal } from "./ui/upload-warning-modal.js";
import { initWebglEnableModal } from "./ui/webgl-enable-modal.js";
import {
    abortDeferredGpsForTripOpen,
    loadDeferredGpsForTrip,
    isCurrentTripOpen,
    takeTripOpenToken,
} from "./ui/deferred-gps.js";
import {
    claimForegroundTripPreparation,
    getDeferredGpsConcurrency,
    prepareTripForPlayback,
} from "./ui/progressive-ingest.js";
import { initTripPreparation } from "./ui/trip-preparation.js";
import { initHotkeysModal } from "./ui/hotkeys-modal.js";
import { initWhatsNewModal } from "./ui/whats-new-modal.js";
import { openExportMode, setRange } from "./ui/export-state.js";
import { initExportMode } from "./ui/export-mode.js";
import { initExportPanel } from "./ui/export-panel.js";
import { initExportTrimBar } from "./ui/export-trim-bar.js";
import { initPlayerBlur } from "./ui/player-blur.js";
import { cancelTrackPass } from "./ui/blur-track.js";
import { setDroppedRegionPassCanceller, subscribeBlurTripRegroup } from "./ui/blur-regions-state.js";
import { initPlayerCrop } from "./ui/player-crop.js";
import { initPlayerOverlays } from "./ui/player-overlays.js";
import { initTimelineRange } from "./ui/timeline-range.js";
import { initTopPanel } from "./ui/top-panel.js";
import { initViewMenu } from "./ui/view-menu.js";
import { initFeedbackModal } from "./ui/feedback.js";
import { initRecognitionHelp } from "./ui/recognition-help.js";
import { initLangSwitcher } from "./ui/lang-switcher.js";
import { initBrandMark } from "./ui/brand-mark.js";
import { initTopbarOverflow } from "./ui/topbar-overflow.js";
import { prewarmIndexer } from "./indexer.js";
import { loadChart } from "./ui/chart.js";
import { prewarmGpsExtract } from "./ui/gps-extract-shim.js";
import { prewarmIngest } from "./ui/ingest-shim.js";
import { isMapAvailable, loadMaplibre, reloadMapStyleForCurrentTheme } from "./ui/map.js";
import { forceMapProvider, type MapProvider } from "./ui/map-provider.js";
import { getSharedMapTileCacheStats, type SharedTileCacheStats } from "./ui/map-tile-cache.js";
import { prewarmPreview } from "./ui/trip-preview.js";
import { initThemeToggle } from "./ui/theme-toggle.js";
import { initMobileDrawer } from "./ui/mobile-drawer.js";
import { registerRegroupAppliedListener } from "./ui/apply-regroup.js";
import {
    applyComposition,
    getTripCurrentTime,
    playFrame,
    playTripEvent,
    reconcileActiveTripAfterRegroup,
    seekThenPlay,
} from "./ui/player.js";
import { initTripUi } from "./ui/trip-ui-init.js";
import {
    captureTripOpenTarget,
    closestEventIndex,
    resolveTripOpenTarget,
    withPreparedRecordingKeys,
    type ResolvedTripOpen,
    type TripOpenTarget,
} from "./ui/trip-open-target.js";
import { initOnboarding, pickTripOpenTour, runTripOpenTour } from "./ui/onboarding.js";
import { initSupportPrompt } from "./ui/support-prompt.js";
import { resetVideoZoom } from "./ui/player-zoom.js";
import { clearOpeningTrip, initSidebar, renderTrips, syncSortControls } from "./ui/sidebar.js";
import { initSidebarResize } from "./ui/sidebar-resize.js";
import { activeTrip, state } from "./ui/state.js";
import type { AppState } from "./ui/state.js";
import { getThemeChoice, refreshThemeColors } from "./ui/theme.js";

// --- i18n bootstrap ---
//
// Apply translations to static [data-i18n] nodes once, before other
// handlers that may read button textContent etc. Also sync <html lang>
// to the resolved locale - the HTML ships as "en" (English baseline for
// search crawlers and social unfurl bots, see CLAUDE.md Localization).
applyStaticI18n();
document.documentElement.lang = getCurrentLang();

// groupTrips replaces Trip objects even when the selected file survives. Keep
// the already-open viewer on that file while refreshing every trip-scoped
// timeline consumer after the positional active index has been remapped.
registerRegroupAppliedListener(reconcileActiveTripAfterRegroup);

// --- crash reporting bootstrap ---
//
// Sentry (errors-only) kicked off as early as possible so its global handlers
// install before the user does anything. No-op unless VITE_SENTRY_DSN is built
// in AND the user has not opted out in settings (default ON). The SDK is
// dynamically imported, so an empty DSN ships nothing and the SEO landing entry
// stays lean. Privacy/scrubbing details live in src/sentry.ts + sentry-scrub.ts.
if (!__PORTABLE__) initSentry();

// --- browser capability gate ---
//
// Detect missing Web APIs, report the gaps to analytics, and - if a FATAL gap
// exists (no Web Workers / <video> / file load) - render a blocking gate
// explaining the problem and what to do. Runs after i18n + analytics bootstrap
// (so the gate is localized and the metric is sent) and before heavy init.
//
// On a fatal gap we still let the UI modules bind (harmless - the gate covers
// the whole viewport and the realistic fatal cap, "no Web Workers", breaks only
// ingest), but we skip the eager worker prewarm (prefetchDeferredLibs), which
// would otherwise throw `new Worker` on a Worker-less browser, and the proactive
// degraded notice (the gate already says everything). Degraded-but-usable
// browsers fall through to surfaceDegradedCapabilities() below.
const capabilityFatal = initCapabilityGate();

// Sync theme colors and map style when the user changes prefers-color-scheme
// in the OS or DevTools. Without this the color cache and canvas colors
// would stay frozen on the original theme.
const appLog = createLogger("app");
if (typeof window !== "undefined" && window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (ev) => {
        // Only the "auto" choice follows the OS. With an explicit light/dark
        // override the CSS vars and the canvas palette are fixed, so an OS
        // scheme flip changes nothing - skip the cache flush + map/chart repaint.
        if (getThemeChoice() !== "auto") return;
        refreshThemeColors();
        reloadMapStyleForCurrentTheme();
        // The inferred-event strip repaints via its own theme subscription
        // (subscribeThemeChange in initChart), which refreshThemeColors fires -
        // same path applyTheme relies on, so no explicit redraw is needed here.
        // Theme change doesn't reload the page, so the entry stays in
        // the ring buffer for bug reports ("switched to dark, then broke").
        appLog.info("theme changed", { theme: ev.matches ? "dark" : "light" });
    });
}

// --- startup ---

// DevTools convenience handle. Not used in application code.
// dumpLog/downloadLog are the primary local diagnostic channel for bug
// reports: no backend - the ~500-entry ring buffer is the local way to get
// logs out of a user's session (optional Sentry augments it). See
// src/log.ts + src/sentry.ts.
declare global {
    interface Window {
        __everydashcam: {
            state: AppState;
            dom: typeof dom;
            dumpLog: typeof getLogBuffer;
            downloadLog: typeof downloadLogBuffer;
            setLogRules: typeof setLogRules;
            setMapProvider: (provider: MapProvider) => MapProvider;
            mapTileCacheStats: () => SharedTileCacheStats;
        };
        /** Shows the "updating the app" line over the splash/landing. Defined
         *  by the dc-bootstrap inline script in index.html; the asset-retry
         *  reload path below reuses it so both retry layers announce
         *  themselves the same way. */
        __dcRetryNote?: () => void;
    }
}
window.__everydashcam = {
    state,
    dom,
    dumpLog: getLogBuffer,
    downloadLog: downloadLogBuffer,
    setLogRules,
    setMapProvider: forceMapProvider,
    mapTileCacheStats: getSharedMapTileCacheStats,
};

// Global uncaught-error hooks. Regular try/catch misses sync throws from
// event listeners and unhandled promise rejections. We route both through
// logger("uncaught") so they end up in the ring buffer for bug reports.
// Errors from cross-origin scripts and browser extensions arrive with an
// empty filename or a filename outside our origin - discard as noise.
const uncaughtLog = createLogger("uncaught");

// Known noise from DevTools panels (Performance Insights, Lighthouse) and
// browser extensions. These arrive with an empty filename ("<anonymous>"
// eval script), pollute the ring buffer, and look like our bugs in reports.
const NOISE_MESSAGE_PATTERNS: readonly RegExp[] = [
    /__chromium_devtools_/, // Chrome DevTools metrics reporter
    /__lighthouse_/, // Lighthouse extension
    /chrome-extension:\/\//, // any extension leaking through the stack
    // Benign browser behaviour: ResizeObserver fires this when an observer's
    // callback synchronously triggers another resize within the same frame,
    // so the browser defers the next notifications. It's a soft warning that
    // surfaces via window.onerror in Chrome - not an actual exception.
    // See https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver#observation_errors
    /^ResizeObserver loop /,
];
function isNoise(message: string, stack: string | undefined): boolean {
    for (const re of NOISE_MESSAGE_PATTERNS) {
        if (re.test(message)) return true;
        if (stack && re.test(stack)) return true;
    }
    return false;
}

window.addEventListener("error", (ev) => {
    const fn = ev.filename;
    if (fn && location.origin && !fn.startsWith(location.origin) && !fn.startsWith("/")) return;
    const message = ev.message || "error";
    const stack = ev.error instanceof Error ? ev.error.stack : undefined;
    if (isNoise(message, stack)) return;
    uncaughtLog.error(message, ev.error ?? { filename: fn, lineno: ev.lineno, colno: ev.colno });
});
window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    if (isNoise(message, stack)) return;
    uncaughtLog.error("unhandled promise rejection", reason);
});

// Hand-mirrored with the boot-time asset retry in index.html (dc-bootstrap):
// same key, same cap, same backoff ladder - reloads spent there and here
// draw from one budget. The budget returns only after 30s of uptime AND
// with no retry pending (dc-bootstrap checks #dc-retry-note - the note this
// handler shows below doubles as that signal). Clearing on dc:ready alone
// would let a boot that succeeds moments before a lazy chunk 404s keep
// resetting the counter - an unbounded reload loop through the whole
// edge-propagation window; clearing on a bare 30s timer would do the same
// past the ladder rungs that outwait it.
const ASSET_RETRY_STORAGE_KEY = "dc-asset-retry";
const ASSET_RETRY_MAX_ATTEMPTS = 4;
const ASSET_RETRY_BACKOFF_MS = [4000, 15000, 45000, 90000];

// A lazy chunk that fails to load means the deployment changed under this
// session: the CF-edge propagation window right after a release, or a
// long-lived tab importing a chunk the new deployment no longer ships
// (docs/deploy.md, "Deployment pipeline"). Reload only while there is
// nothing to lose - with trips loaded or an ingest running a reload would
// destroy the tab's in-memory state, so the import rejection flows to the
// caller's error path instead (and gets logged by the handlers above). The
// reload waits out the same ladder as the boot-time retry and shows the
// same "updating" note: the skew window lasts seconds to minutes, so an
// immediate reload would just burn the budget into a visible flicker.
let assetRetryReloadArmed = false;
if (!__PORTABLE__)
    window.addEventListener("vite:preloadError", (ev) => {
        if (state.trips.length > 0 || state.ingestController !== null) return;
        // Offline a reload cannot fetch the missing chunk anyway - don't burn a
        // retry from the budget; the failure surfaces through the usual error
        // paths (the boot-time retry in dc-bootstrap waits for `online` instead).
        if (navigator.onLine === false) return;
        if (assetRetryReloadArmed) {
            // A reload is already scheduled; a second failing chunk changes
            // nothing - just keep Vite from rethrowing.
            ev.preventDefault();
            return;
        }
        let attempts = 0;
        try {
            attempts = Number.parseInt(sessionStorage.getItem(ASSET_RETRY_STORAGE_KEY) ?? "0", 10) || 0;
            if (attempts >= ASSET_RETRY_MAX_ATTEMPTS) return;
            sessionStorage.setItem(ASSET_RETRY_STORAGE_KEY, String(attempts + 1));
        } catch {
            // Storage unavailable: no way to cap - a visible failure beats a
            // potential reload loop.
            return;
        }
        assetRetryReloadArmed = true;
        ev.preventDefault();
        window.__dcRetryNote?.();
        setTimeout(() => {
            // The backoff wait opened a window for the user to start something:
            // re-check, and step down (note included) rather than destroy it.
            if (state.trips.length > 0 || state.ingestController !== null) {
                document.getElementById("dc-retry-note")?.remove();
                return;
            }
            location.reload();
            // In-bounds by construction: attempts < MAX_ATTEMPTS = ladder length.
        }, ASSET_RETRY_BACKOFF_MS[attempts]!);
    });

// Warn before close/reload. No backend: loaded trips and the index live
// only in the current tab's memory - reload resets state, files on disk
// remain but need re-indexing. The browser shows its own generic prompt
// ("Leave site?"), we can't customize the text. iOS Safari does not fire
// beforeunload - no warning there, known limitation.
// Triggers when trips are loaded OR an ingest is in progress.
window.addEventListener("beforeunload", (ev) => {
    if (state.trips.length === 0 && state.ingestController === null) return;
    // A deliberate language switch already confirmed the loss via its own modal -
    // don't stack the browser's generic prompt on top.
    if (isIntentionalNavigation()) return;
    ev.preventDefault();
    // returnValue = "" for legacy compat (some engines ignore preventDefault
    // without it). The text is not shown; the browser uses its own prompt.
    ev.returnValue = "";
});

// --- startup info log ---
//
// Logged once per page load as the FIRST ring-buffer entry, so every
// subsequent error in a bug report has context: build version, browser,
// viewport, theme, locale, hardware. Without this, "something is broken
// for this user" investigations stall immediately.
//
// Level=info; prod default min=warn, so it doesn't appear in the console
// but is always captured in the buffer. Visible via __everydashcam.downloadLog().
{
    let localStorageWorks = false;
    try {
        const k = "__everydashcam:probe";
        localStorage.setItem(k, "1");
        localStorage.removeItem(k);
        localStorageWorks = true;
    } catch {
        // localStorage blocked - private mode on some browsers.
    }
    appLog.info("app started", {
        version: APP_VERSION,
        edition: __PORTABLE__ ? "portable" : "web",
        userAgent: navigator.userAgent,
        lang: navigator.language,
        resolvedLang: getCurrentLang(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        screen: { w: screen.width, h: screen.height },
        theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
        online: navigator.onLine,
        hardwareConcurrency: navigator.hardwareConcurrency,
        // deviceMemory is Chromium-only (W3C Device Memory API, not
        // implemented in FF/Safari). Undefined on non-Chrome is correct.
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        localStorageWorks,
        serviceWorkerSupported: "serviceWorker" in navigator,
    });
}

// Async storage estimate. Separate log entry - doesn't block startup.
// navigator.storage.estimate is absent on Safari < 16.4 - just no entry.
if (navigator.storage?.estimate) {
    navigator.storage
        .estimate()
        .then((est) => {
            appLog.info("storage estimate", { quota: est.quota, usage: est.usage });
        })
        .catch((err: unknown) => {
            appLog.warn("storage estimate failed", err);
        });
}

// Initialize PRE-TRIP modules - everything needed on the landing page
// (body.no-trips). Heavy modules (map, Chart.js, player, rAF loop) are
// lazily initialized in src/ui/trip-ui-init.ts on first ingest - MapLibre
// on the landing page would otherwise burn ~6% CPU for nothing.

// UX-24: init theme-toggle FIRST so applyTheme sets the class on <html>
// before the rest of the UI renders. Without this, users with stored=dark
// and system=light see a light-palette flash.
initThemeToggle({
    onThemeChange: () => {
        reloadMapStyleForCurrentTheme();
    },
});

if (!__PORTABLE__) initLangSwitcher();
// Footer build id: which release this copy serves - tells the mirror and a
// self-host apart from production at a glance. Filled at runtime so the
// prerendered HTML stays build-agnostic; hidden when the build had no git.
const footerVersion = document.getElementById("footer-version");
if (footerVersion && APP_VERSION !== "unknown") {
    footerVersion.textContent = APP_VERSION;
    footerVersion.hidden = false;
}
initBrandMark();
// Topbar overflow-bar: when the header shrinks, low-priority buttons
// (theme/feedback/install) move into the kebab menu. Must run after
// initThemeToggle/initLangSwitcher - they bind handlers to the original
// buttons, and the clone in the overflow menu forwards the click to the
// original.
initTopbarOverflow();
// Notifications: wires up the bell button + toast container. Safe to call
// before any notify() - the store buffers entries and the UI catches up.
initNotifications();
// Connectivity tracking + the offline banner. initConnectivity seeds state and
// binds online/offline; initOfflineBanner subscribes and reflects it (the
// subscription fires immediately, so an offline launch shows the banner at once).
initConnectivity();
if (!__PORTABLE__) initOfflineBanner();
// GPS calibration stays scoped to the open trip or an explicit set of loaded
// trips from the same camera.
initGpsSyncModal({ getTripCurrentTime });
registerCameraTimezoneHandler((trip, offsetSec) => {
    applyRecordingCameraTimezone(trip, offsetSec);
    renderTrips();
});
initSettingsModal();
initMapSettingsPopover();
initIngestOverlay();
initUnsupportedFormatsModal();
initNoRecordingsModal();
// Upload-warning and the iOS folder warning must be initialized BEFORE
// initFileSources - file-sources binds click handlers to CTA buttons that call
// showUploadWarning / showIosFolderWarning; these inits only attach close
// listeners to the modals' own buttons.
initUploadWarningModal();
initIosFolderWarningModal();
if (!__PORTABLE__) initSwitchLangModal();
initTripPreparation();
initHotkeysModal();
if (!__PORTABLE__) initWhatsNewModal();
// "View" dropdown - chart/strip/readout toggles plus the map's off/mini/large
// control. Reads visibility from localStorage; map.ts registers the layout
// transition handler once MapLibre is ready.
initViewMenu({
    button: dom.viewMenuButton,
    popover: dom.viewMenuPopover,
    panels: {
        // Hide ONLY the canvas (not the whole .player-chart box), otherwise
        // the strip and ruler inside would also disappear when "unchecking the
        // chart". chart-axis-labels are tied to the canvas via :has() in CSS -
        // they hide by cascade. The ruler stays visible - the time-scale is
        // useful even without the speed chart. The .player-chart height is
        // recomputed via :has(...) in viewer.css.
        chart: dom.chartCanvas,
        strip: dom.chartInferredStripWrap,
        // We do NOT pass the map element - view-menu only stores the
        // preference and notifies subscribers. The only writer for
        // .mini-map.hidden is applyMapLayout in map.ts, subscribed via
        // subscribeViewPanels, which accounts for map-expanded / no-gps /
        // preference in one place.
        map: null,
        // The whole readout row: its grid track is `auto`, so hiding the
        // element collapses the row to nothing.
        readout: dom.metrics.readout,
    },
});
initExportMode();
initMobileViewNav((index, saveClip) => {
    if (state.active) void openTripEvent(state.active.trip, index, saveClip);
});
initTopPanel({ onCompositionApply: applyComposition, resetZoom: resetVideoZoom });
initExportPanel({ onCompositionApply: applyComposition });
initExportTrimBar({ getTripCurrentTime, seekThenPlay });
initTimelineRange();
initPlayerOverlays();
initPlayerCrop();
initPlayerCameraFlip();
initPlayerBlur();
// A regroup that drops a blur zone (merge/split changed its file set) must also
// abort that zone's in-flight Follow pass, or the orphaned pass keeps holding
// the tracker worker's single-pass gate. Wired here (not a direct import in
// blur-regions-state) to keep that module out of blur-track's import graph.
if (!__PORTABLE__) setDroppedRegionPassCanceller(cancelTrackPass);
subscribeBlurTripRegroup((_oldTrips, _newTrips, invalidatedRegionCount) => {
    if (invalidatedRegionCount > 0) notify({ severity: "warn", messageKey: "export.blur.regroupChanged" });
});
initFeedbackModal();
initRecognitionHelp();
// Hero-shot lightbox: landing right-column thumb -> full-size screenshot.
if (!__PORTABLE__) initLandingShot();
// The topbar shares the landing background until the landing starts scrolling.
initLandingTopbar();
// Docked CTA: keeps the drop/open action reachable at any landing scroll depth.
if (!__PORTABLE__) initLandingDock();
// Wire the "turn the map on" guide before surfaceDegradedCapabilities() below
// may auto-open it on a recoverable WebGL gap.
initWebglEnableModal();
initSidebarResize();
initMobileDrawer();
// Onboarding tours: only wires live re-localization here; the tours themselves
// fire from their own seams (ingest done, trip open, export open).
initOnboarding();
if (!__PORTABLE__) initSupportPrompt();
initFileSources();
// The folder rows above the trip list: where the loaded trips came from and
// whether that folder is remembered. Wired before the first ingest can
// register a source into it.
initFolderSources();
// Persistent-folder mode (Chromium): recent-folder chips on the landing.
// Needs notifications and the ingest overlay, both initialized above. Its
// first IndexedDB read can add a variable-height block above the capability
// list, so returning users keep the splash until that geometry is settled.
// First visits can reveal prerendered content earlier because the bootstrap
// verifies there is no stored database. A failed read leaves an empty block.
void initPersistentFolders()
    .catch((err: unknown) => {
        appLog.warn("recent folders init failed", {
            err: err instanceof Error ? err.message : String(err),
        });
    })
    .then(() => {
        // For returning users, rAF lets settled folder geometry paint before
        // the splash fades. dc:ready also marks runtime readiness after an
        // early static reveal. The inline watchdog covers a failed bundle or
        // stuck storage.
        requestAnimationFrame(() => {
            dispatchEvent(new Event("dc:ready"));
            if (__PORTABLE__) initPortableUpdates(APP_VERSION, getCurrentLang());
        });
    });
// Trip annotations: load the stored records before the first ingest can
// render cards; wire the name/note editor, the timeline-marker layer (pins
// reposition through the chart's overlay-sync hook), the marker editor and the
// per-trip marker list.
// The store answers async - if the index-cache restore painted trip cards
// first, this repaints them with their names/stars/notes.
initAnnotations(() => {
    renderTrips();
    refreshTimelineMarkers();
});
initTripMetaModal();
initTimelineMarkers();
initMarkerModal({ onChanged: refreshTimelineMarkers });
initMarkerListModal({ onChanged: refreshTimelineMarkers });
registerTimelineOverlaySync(refreshTimelineMarkers);
// Progressive clock refinement can move a provisional marker's UTC; repaint
// timeline pins after it is re-stamped.
registerMarkersRestampedHook(refreshTimelineMarkers);
// Notes-file replica of all annotations (Chromium): a file discovered in the
// opened recording folder takes priority, otherwise the last-used file stays.
initAnnotationsSidecar();
// One-shot offer of that notes file at the user's first annotation.
initNotesNudge();

function reportTripOpenFailure(openToken: number, tripIdx: number, err?: unknown): void {
    if (err !== undefined) appLog.error(`trip open failed (trip ${tripIdx})`, err);
    if (!isCurrentTripOpen(openToken)) return;
    clearOpeningTrip();
    notify({ severity: "error", messageKey: "status.tripOpenFailed" });
}

/**
 * Completes the shared asynchronous front half of every trip-open action.
 * The token is minted before the first await, so a newer click always wins.
 */
async function prepareTripOpen(
    target: TripOpenTarget,
    originalTripIdx: number,
    openToken: number,
): Promise<ResolvedTripOpen | null> {
    const initialLocation = resolveTripOpenTarget(state.trips, target);
    if (!initialLocation) {
        reportTripOpenFailure(openToken, originalTripIdx);
        return null;
    }

    const releasePriority = claimForegroundTripPreparation();
    // A failed viewer download can finish this open while the independent data
    // branch still runs. Its late completion must not start GPS or change the UI.
    let isPreparing = true;
    const prepareData = async (): Promise<TripOpenTarget | null> => {
        const preparation = await prepareTripForPlayback(
            initialLocation.tripIdx,
            target.exactFrame ? initialLocation.frameIdx : undefined,
        );
        if (!isPreparing || !isCurrentTripOpen(openToken)) return null;
        if (preparation.status === "ready") {
            // The read gate may skip a damaged leading clip, replace a repaired File
            // object and finish before viewer initialization. Resolve its stable keys
            // against the latest trip list instead of trusting the original indices.
            const playableTarget = withPreparedRecordingKeys(target, preparation.recordingKeys);
            const readyLocation = resolveTripOpenTarget(state.trips, playableTarget);
            if (!readyLocation) {
                reportTripOpenFailure(openToken, originalTripIdx);
                return null;
            }

            // A selected trip is one atomic viewer payload: do not start video while
            // a deferred full-file GPS scan can still add the map and chart later.
            const gpsResult = await loadDeferredGpsForTrip(readyLocation.tripIdx, {
                concurrency: getDeferredGpsConcurrency(),
            });
            if (!isPreparing || !isCurrentTripOpen(openToken)) return null;
            if (gpsResult !== "ready") {
                if (gpsResult === "failed") {
                    reportTripOpenFailure(openToken, originalTripIdx);
                    return null;
                }
                clearOpeningTrip();
                return null;
            }

            return playableTarget;
        }

        clearOpeningTrip();
        if (preparation.status === "unreadable") {
            notify({ severity: "error", messageKey: "status.tripOpenFailed" });
        }
        return null;
    };

    // Storage priority belongs to the recording read, including cancellation
    // cleanup. A pending or failed viewer download must not extend or cut it short.
    const dataPreparation = prepareData().finally(releasePriority);
    let hasViewerFailure = false;
    // Handle the viewer outcome even when data cancellation returns first. A
    // later network failure must not turn that completed cancellation into a toast.
    const viewerInitialization = initTripUi().then(
        () => ({ status: "ready" }) as const,
        (err: unknown) => {
            hasViewerFailure = true;
            if (isPreparing) {
                isPreparing = false;
                abortDeferredGpsForTripOpen(openToken);
            }
            return { status: "failed", err } as const;
        },
    );
    try {
        // Run the complete metadata → GPS chain alongside viewer initialization;
        // a slow map/chart download must not leave selected-trip analysis idle.
        const playableTarget = await dataPreparation;
        if (!isCurrentTripOpen(openToken)) return null;
        if (!playableTarget && !hasViewerFailure) return null;
        const viewer = await viewerInitialization;
        if (viewer.status === "failed") throw viewer.err;
        if (!playableTarget || !isCurrentTripOpen(openToken)) return null;

        // GPS clock evidence or background metadata can regroup trips while the
        // viewer loads. Resolve stable recording identities only after both finish.
        const finalLocation = resolveTripOpenTarget(state.trips, playableTarget);
        if (finalLocation) return finalLocation;
        reportTripOpenFailure(openToken, originalTripIdx);
        return null;
    } finally {
        isPreparing = false;
    }
}

async function openTripFrame(tripIdx: number, requestedFrameIdx?: number): Promise<void> {
    const target = captureTripOpenTarget(state.trips, tripIdx, requestedFrameIdx);
    const openToken = takeTripOpenToken(target?.tripKeys);
    if (!target) {
        reportTripOpenFailure(openToken, tripIdx);
        return;
    }
    try {
        const prepared = await prepareTripOpen(target, tripIdx, openToken);
        if (!prepared) return;

        // First-run onboarding introduces the controls before the clip rolls.
        // With a tour, playback starts paused and resumes on any tour exit.
        const trip = state.trips[prepared.tripIdx];
        const tour = trip ? pickTripOpenTour(trip) : null;
        playFrame(prepared.tripIdx, prepared.frameIdx, undefined, /* autoPlay */ tour === null);
        notifyUnmatchedDirectoryGps(activeTrip(), openGpsSync);
        if (tour) {
            runTripOpenTour(tour, () => void dom.player.play().catch(() => {}));
        } else if (!isMapAvailable()) {
            // Contextual WebGL guidance is intentionally delayed until the user
            // opens footage, and never stacked over first-run onboarding.
            void surfaceMapUnavailable();
        }
    } catch (err) {
        reportTripOpenFailure(openToken, tripIdx, err);
    }
}

async function openTripEvent(tripIdx: number, eventIndex: number, saveClip = false): Promise<void> {
    const target = captureTripOpenTarget(state.trips, tripIdx, undefined, eventIndex);
    const openToken = takeTripOpenToken(target?.tripKeys);
    if (!target) {
        reportTripOpenFailure(openToken, tripIdx);
        return;
    }
    try {
        const prepared = await prepareTripOpen(target, tripIdx, openToken);
        if (!prepared) return;

        // prepareTripOpen has already completed GPS extraction. Resolve the
        // event against the final event list produced by that data.
        const resolved = resolveTripOpenTarget(state.trips, target);
        const trip = resolved ? state.trips[resolved.tripIdx] : null;
        const nextEventIndex = trip && target.eventUtc !== null ? closestEventIndex(trip.events, target.eventUtc) : -1;
        if (!resolved || nextEventIndex < 0) {
            reportTripOpenFailure(openToken, tripIdx);
            return;
        }
        playTripEvent(resolved.tripIdx, nextEventIndex);
        notifyUnmatchedDirectoryGps(activeTrip(), openGpsSync);
        if (saveClip && trip) {
            const event = trip.events[nextEventIndex]!;
            openExportMode();
            setRange(event.relSec - 10, event.relSec + 10);
        }
        // Seeking inside the already-active trip does not call playFrame, so it
        // needs to release the click-feedback spinner explicitly.
        clearOpeningTrip();
    } catch (err) {
        reportTripOpenFailure(openToken, tripIdx, err);
    }
}

initSidebar({
    onEditTripMeta: openTripMetaModal,
    onPlayTrip: openTripFrame,
    onPlayFrame: openTripFrame,
    onPlayTripEvent: openTripEvent,
});

// Sort-controls and empty-state sync on sidebar DOM nodes (visible in
// landing mode via their own styles, but body.no-trips hides the sidebar
// entirely - safe no-op for the landing page).
syncSortControls();
syncEmptyState();

// Service worker for the offline PWA precache (app shell; see src/sw.ts).
// Requires HTTPS or localhost. Registration is best-effort - if it fails or is
// disabled (incognito), the app still works fully online, just without the
// offline cache.
//
// BASE_URL ensures correct registration when deployed to a subdirectory
// (e.g. example.com/everydashcam/); a hardcoded "/sw.js" would 404.
if (!__PORTABLE__ && !import.meta.env.DEV && "serviceWorker" in navigator) {
    const swUrl = `${import.meta.env.BASE_URL || "/"}sw.js`;
    const swLog = createLogger("sw");
    // updateViaCache:"none" - the browser's SW update check must bypass the HTTP
    // cache for sw.js. Cloudflare serves /sw.js with max-age=14400 (its Browser
    // Cache TTL overrides our `_headers` max-age=0), so with the default
    // ("imports", script subject to HTTP cache) a freshly deployed SW is not
    // picked up for up to 4h. "none" makes the update check always revalidate,
    // so the new SW installs (pre-caching the new build) on the next load; it
    // then waits and takes over on the next full launch - see the update
    // handover rationale in src/sw.ts.
    //
    // Registration is DEFERRED to window load + an idle slot: a fresh install
    // kicks off the multi-MB precache download, and started at module-eval it
    // competes with the landing render (and the user's first ingest) for
    // bandwidth on slow networks. An already-installed SW is unaffected - the
    // browser routes fetches through it before any register() call runs, so
    // offline boot does not depend on this timing; deferral only shifts WHEN a
    // new install/update check starts. The scheduler bounds both the load and
    // idle waits, and retries registration on reconnect after a failed install.
    let registration: ServiceWorkerRegistration | undefined;
    let hasNotifiedUpdate = false;
    const registerSw = async (): Promise<void> => {
        if (registration) {
            try {
                await registration.update();
                return;
            } catch (err) {
                // A failed first install removes its registration. Workbox
                // registers once per instance, so reconnect needs a new one.
                if (!(err instanceof DOMException && err.name === "InvalidStateError")) throw err;
                registration = undefined;
            }
        }
        const { Workbox } = await import("workbox-window");
        const worker = new Workbox(swUrl, { updateViaCache: "none" });
        worker.addEventListener("waiting", () => {
            if (hasNotifiedUpdate) return;
            hasNotifiedUpdate = true;
            notify({ severity: "info", messageKey: "status.update.ready" });
        });
        worker.addEventListener("installed", (event) => {
            swLog.info("installed", { isUpdate: event.isUpdate === true });
        });
        worker.addEventListener("redundant", () => swLog.warn("worker became redundant"));
        registration = await worker.register({ immediate: true });
        swLog.info("registered", { scope: registration?.scope });
    };
    scheduleServiceWorkerRegistration(registerSw);

    // Persistent storage. The offline shell (and the SW registration itself)
    // live in this origin's quota-managed storage, which the browser may evict
    // under storage/memory pressure - on Android that can leave an installed app
    // unable to load offline at all (no cache AND no service worker) until the
    // next online visit re-registers and re-precaches. A persist() grant is the
    // ONLY documented exemption from that eviction; an installed PWA should get
    // it. We request it, and re-assert on focus/online because the install/
    // engagement signal that unlocks the grant can arrive after first paint.
    // The {already, granted} log line is the single diagnostic that tells an
    // "offline died after backgrounding" report whether the grant was the gap.
    const storageLog = createLogger("storage");
    let persistState: boolean | null = null; // null = not yet attempted
    const ensurePersistentStorage = async (): Promise<void> => {
        if (persistState === true || !navigator.storage?.persist) return;
        try {
            const already = (await navigator.storage.persisted?.()) ?? false;
            const granted = already || (await navigator.storage.persist());
            if (granted !== persistState) {
                storageLog.info("persistence", { already, granted });
                persistState = granted;
            }
        } catch (err) {
            storageLog.warn("persistence request failed", err);
        }
    };
    void ensurePersistentStorage();
    // Retry while still ungranted: a denied grant can flip once the WebAPK /
    // engagement signal settles. Once granted, ensurePersistentStorage no-ops.
    addEventListener("online", () => void ensurePersistentStorage());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void ensurePersistentStorage();
    });
}

// Installation detection must be ready before the offline-use chooser subscribes.
if (!__PORTABLE__) {
    initPwaInstall();
    initOfflineUse();
}

// Lang-suggestion banner. Shown when the URL has an explicit locale segment
// but navigator.language points at a different supported locale - the
// share-link scenario where a Russian user kicked /ru/cameras/70mai/ to an
// English friend. Dismissable forever via localStorage. No-op on the root
// stub (bootstrap already redirected) and on privacy.html.
if (!__PORTABLE__) initLangSuggestionBanner();

// T9 pulled the heavy viewer libs (maplibre ~1MB, chart) and the ingest worker
// chunks off the landing critical path - lazy on first use. That keeps the
// landing light, but "lazy on first use" must not become "make the user wait
// at the seam": on a slow connection the just-in-time fetch is visible right
// when the user drops a folder (worker chunks) or opens a trip (map/chart). So
// after the landing's load event, warm the whole ingest -> view path in the
// background at idle priority. Vendor loaders are memoized and worker prewarm
// keeps the spawned slot, so the real ingest and first trip-open reuse warm
// chunks instead of starting a fresh download. An idle main thread can still
// be waiting for images and fonts; wait for load before allowing speculative
// downloads to compete with those critical resources.
//
// mediabunny is NOT in this list: its main-thread graph is materially heavy and
// only needed after the user supplies a recording (codec probe) or starts an
// export. Keep that as a real capability boundary instead of downloading it for
// every landing-page visit; worker prewarm is independent because each worker
// self-bundles its media code.
function prefetchDeferredLibs(): void {
    const warm = (): void => {
        // Viewer libs (trip-open).
        void loadMaplibre().catch(() => {});
        void loadChart().catch(() => {});
        // Ingest path (drop folder): the four worker chunks the pipeline
        // spawns (classify, GPS extract, MP4 index, first-frame preview).
        // Each prewarm spawns one slot and keeps it for reuse. Guarded: a
        // synchronous throw in one prewarm (e.g. `new Worker` on a
        // half-broken engine the capability gate did not flag fatal) would
        // otherwise skip the rest AND escape warm() uncaught from the
        // rIC/timeout callback. Prewarm is best-effort - the real ingest
        // respawns on demand - so swallow with a log.
        try {
            prewarmIngest();
            prewarmGpsExtract();
            prewarmIndexer();
            prewarmPreview();
        } catch (err) {
            appLog.warn("deferred prewarm threw", { err: String(err) });
        }
    };
    const ric = (
        window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        }
    ).requestIdleCallback;
    if (ric) {
        ric(warm, { timeout: 4000 });
    } else {
        // Safari < 17 has no requestIdleCallback - a short timeout keeps the
        // warm-up off the critical first paint without it.
        setTimeout(warm, 1500);
    }
}
// Skip eager worker prewarm on a fatal browser - `new Worker` would throw on a
// Worker-less engine and the gate already blocks all interaction.
if (!capabilityFatal) {
    if (!__PORTABLE__) {
        if (document.readyState === "complete") {
            prefetchDeferredLibs();
        } else {
            window.addEventListener("load", prefetchDeferredLibs, { once: true });
        }
    }
    // Proactive heads-up for user-visible degraded gaps (no map / no editor /
    // no H.264 decode). Notifications are initialized above; this fires once per
    // gap-set (persisted) so it does not nag every session.
    surfaceDegradedCapabilities();
}
