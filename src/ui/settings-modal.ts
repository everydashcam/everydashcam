// Settings modal. Opened by the gear icon #settings-btn in the header.
// Includes ordinary preferences, a portable notes-backup section, optional
// crash-report privacy controls, diagnostics/cache actions and the destructive
// reset section.
//
// Lifecycle:
//  - settings-btn icon is always shown (Danger zone is universal).
//  - Crash-reports toggle.checked mirrors the stored choice - synced
//    on open. Flipping it spins Sentry up / tears it down at runtime.
//  - Modal closes on the "Close" button, backdrop click, or Escape.
//  - "Reset everything" opens #reset-confirm-modal; confirmation triggers
//    resetAllAppState() from src/ui/reset.ts, which wipes storage and reloads.

import {
    BRAKE_G_THRESHOLD_MAX,
    BRAKE_G_THRESHOLD_MIN,
    detectEvents,
    getBrakeThresholdG,
    setBrakeThresholdG,
} from "../events.js";
import { t } from "../i18n/index.js";
import { getEncoderPreference, isEncoderPreference, setEncoderPreference } from "../encoder-pref.js";
import { createLogger, downloadLogBuffer } from "../log.js";
import { crashReportingEnabled, isCrashReportingBuilt, setCrashReportingEnabled } from "../sentry.js";
import { setTripGapSec, tripAllCandidates, getTripGapSec, projectEventsOntoTimeline } from "../trips.js";
import {
    DEFAULT_INDEX_CACHE_LIMIT_BYTES,
    getIndexCacheLimitBytes,
    INDEX_CACHE_LIMIT_MAX_BYTES,
    INDEX_CACHE_LIMIT_MIN_BYTES,
    setIndexCacheLimitBytes,
} from "../persist/cache-limit.js";
import { clearIndexCache, getIndexCacheStats, pruneIndexCacheToLimit } from "../persist/index-cache.js";
import { getUnits, setUnits, type Units } from "../units-pref.js";
import { APP_VERSION } from "../version.js";
import { rebuildChartFromTrip } from "./chart.js";
import {
    downloadPortableNotesBackup,
    flushPendingSidecarWrites,
    importPortableNotesBackup,
} from "./annotations-sidecar.js";
import { commitRecordingTripsWhilePreservingIngest } from "./ingest-regroup.js";
import { formatBytes } from "./format.js";
import { reapplyMapLabelPrefs, refreshMap } from "./map.js";
import {
    getMapLabelScale,
    getStreetLabelDensity,
    MAP_LABEL_SCALE_VALUES,
    setMapLabelScale,
    setStreetLabelDensity,
    STREET_LABEL_DENSITY_VALUES,
} from "./map-label-scale.js";
import { renderMapMarkerControl } from "./map-marker-control.js";
import { getMapMarkerAppearance, setMapMarkerAppearance } from "./map-marker-pref.js";
import { getMapProvider, subscribeMapProvider } from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { initMapViewControls } from "./map-view-controls.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";
import { notify } from "./notifications.js";
import { initMigrationBanner, migrationAddress, migrationRecoveryUrl } from "./migration-banner.js";
import { initMigrationRestore } from "./migration-restore.js";
import { resetOnboarding } from "./onboarding.js";
import { clearServiceWorkerAndCaches, resetAllAppState } from "./reset.js";
import {
    DEFAULT_SEEK_STEP_SEC,
    DEFAULT_SEEK_STEP_SHIFT_SEC,
    SEEK_STEP_MAX_SEC,
    SEEK_STEP_MIN_SEC,
    getSeekStepSec,
    getSeekStepShiftSec,
    setSeekStepSec,
    setSeekStepShiftSec,
} from "./seek-step-pref.js";
import { renderTrips, updateTripPreview } from "./sidebar.js";
import { state } from "./state.js";
import { schedulePopulateTripPreviews } from "./trip-preview.js";

const log = createLogger("settings-modal");

function modalEl(): HTMLElement | null {
    return document.getElementById("settings-modal");
}

function resetModalEl(): HTMLElement | null {
    return document.getElementById("reset-confirm-modal");
}

function crashToggleEl(): HTMLInputElement | null {
    return document.getElementById("settings-crash-toggle") as HTMLInputElement | null;
}

/** Sync the checkbox with the stored choice and this site's default. */
function syncCrashToggleFromState(): void {
    const toggle = crashToggleEl();
    if (!toggle) return;
    toggle.checked = crashReportingEnabled();
}

function initMigrationSection(): void {
    const section = document.getElementById("settings-migration-section");
    if (!section) return;
    const address = migrationAddress(window.location.hostname);
    const isNewAddress = address === "new";
    const isOldAddress = address === "old";
    section.hidden = !isOldAddress && !isNewAddress;
    const oldAddress = document.getElementById("settings-migration-old");
    const newAddress = document.getElementById("settings-migration-new");
    if (oldAddress) oldAddress.hidden = !isOldAddress;
    if (newAddress) newAddress.hidden = !isNewAddress;
    document.getElementById("settings-migration-recover")?.setAttribute("href", migrationRecoveryUrl());
}

function isOpen(el: HTMLElement | null): boolean {
    return !!el && !el.hidden;
}

function openSettings(): void {
    const m = modalEl();
    if (!m) return;
    if (!__PORTABLE__) syncCrashToggleFromState();
    syncUnitsSelect();
    syncEncoderSelect();
    syncMapLabelScaleSelect();
    syncMapMarkerControl();
    syncSeekStepInputs();
    syncEventsThresholdInputs();
    syncTripGapInput();
    syncCacheSection();
    syncAboutInfo();
    m.hidden = false;
    // [hidden] preserves the card's scrollTop from the previous open -
    // settings must always start at the top, not where the user left off.
    const card = m.querySelector(".modal-card");
    if (card) card.scrollTop = 0;
    const settingsButton = document.getElementById("settings-btn");
    activateModal(m, {
        onClose: closeSettings,
        initialFocus: document.getElementById("settings-modal-header-close"),
        // Safari pointer clicks can leave body focused. The collapsed button
        // is invoked through the overflow menu, whose trigger stays visible.
        returnFocus:
            settingsButton?.dataset.overflowHidden === "true"
                ? document.getElementById("topbar-overflow")
                : settingsButton,
    });
}

function syncSeekStepInputs(): void {
    const arrow = document.getElementById("settings-seek-step-input") as HTMLInputElement | null;
    const shift = document.getElementById("settings-seek-step-shift-input") as HTMLInputElement | null;
    if (arrow) arrow.value = String(getSeekStepSec());
    if (shift) shift.value = String(getSeekStepShiftSec());
}

/**
 * Pre-fills the events-threshold controls. The "off" checkbox mirrors the
 * trip-gap "never" pattern: when checked, the number input is disabled and
 * shows the last finite value (or default) for when the user toggles it back.
 */
function syncEventsThresholdInputs(): void {
    const input = document.getElementById("settings-events-threshold-input") as HTMLInputElement | null;
    const off = document.getElementById("settings-events-threshold-off") as HTMLInputElement | null;
    if (!input || !off) return;
    const g = getBrakeThresholdG();
    if (!Number.isFinite(g)) {
        off.checked = true;
        input.disabled = true;
        // Keep a sensible value visible for when the user toggles it back on.
        if (!input.value) input.value = "0.5";
        return;
    }
    off.checked = false;
    input.disabled = false;
    input.value = String(g);
}

function syncUnitsSelect(): void {
    const sel = document.getElementById("settings-units-select") as HTMLSelectElement | null;
    if (sel) sel.value = getUnits();
}

function syncEncoderSelect(): void {
    const select = document.getElementById("settings-encoder-select") as HTMLSelectElement | null;
    const hint = document.getElementById("settings-encoder-hint");
    const preference = getEncoderPreference();
    if (select) select.value = preference;
    if (hint) {
        const key = `settings.export.encoder.${preference}Hint` as const;
        hint.dataset.i18n = key;
        hint.textContent = t(key);
    }
}

function syncMapLabelScaleSelect(): void {
    const sel = document.getElementById("settings-map-label-scale-select") as HTMLSelectElement | null;
    if (sel) sel.value = String(getMapLabelScale());
    const density = document.getElementById("settings-map-street-names-select") as HTMLSelectElement | null;
    if (density) density.value = getStreetLabelDensity();
}

function syncMapMarkerControl(): void {
    const host = document.getElementById("settings-map-marker-control");
    if (!host) return;
    renderMapMarkerControl(host, {
        appearance: getMapMarkerAppearance(),
        onChange: setMapMarkerAppearance,
        idPrefix: "settings",
    });
}

/**
 * Pre-fills the trip-gap controls from stored state. The "never split"
 * checkbox owns the input's disabled state: when checked, input shows the
 * last finite value (or default) but is grey'd out, so re-enabling restores
 * a sensible number instead of an empty field.
 */
function syncTripGapInput(): void {
    const input = document.getElementById("settings-trip-gap-input") as HTMLInputElement | null;
    const never = document.getElementById("settings-trip-gap-never") as HTMLInputElement | null;
    if (!input || !never) return;
    const sec = getTripGapSec();
    if (!Number.isFinite(sec)) {
        never.checked = true;
        input.disabled = true;
        // Keep something in the field for when the user unchecks. Default
        // is 0.5 min (= the original 30s).
        if (!input.value) input.value = "0.5";
        return;
    }
    never.checked = false;
    input.disabled = false;
    // Display seconds → minutes. Trim trailing zeros so "30 sec" reads as
    // "0.5" not "0.500" but "5 min" stays "5".
    const minutes = sec / 60;
    input.value = String(Number(minutes.toFixed(2)));
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Pre-fills the Recordings-cache section: the limit input (stored in bytes,
 * displayed in whole MB) synchronously, the usage readout async. An
 * unavailable IndexedDB (private mode, storage disabled) leaves the static
 * "—" placeholder - the cache degrades to session-only there anyway.
 */
function syncCacheSection(): void {
    const limitInput = document.getElementById("settings-cache-limit-input") as HTMLInputElement | null;
    if (limitInput) limitInput.value = String(Math.round(getIndexCacheLimitBytes() / BYTES_PER_MB));
    refreshCacheUsageValue();
}

/** Re-reads the cache footprint into the usage row. Fire-and-forget async;
 *  called on open and after every action that changes the footprint. */
function refreshCacheUsageValue(): void {
    const value = document.getElementById("settings-cache-usage-value");
    if (!value) return;
    value.textContent = "…";
    getIndexCacheStats()
        .then((stats) => {
            value.textContent = t("settings.cache.usage.value", {
                used: formatBytes(stats.totalBytes),
                limit: formatBytes(getIndexCacheLimitBytes()),
                n: stats.entryCount,
            });
        })
        .catch((err: unknown) => {
            log.warn("index cache stats failed", { err: err instanceof Error ? err.message : String(err) });
            value.textContent = "—";
        });
}

/** Writes version + storage estimate into the About section. Called on open. */
function syncAboutInfo(): void {
    const v = document.getElementById("settings-version-value");
    if (v) v.textContent = __PORTABLE__ ? `${APP_VERSION} · ${t("portable.label")}` : APP_VERSION;

    const s = document.getElementById("settings-storage-value");
    if (!s) return;
    if (!navigator.storage?.estimate) {
        s.textContent = t("settings.about.storage.unknown");
        return;
    }
    s.textContent = "…";
    navigator.storage
        .estimate()
        .then((est) => {
            const used = formatBytes(est.usage ?? 0);
            const total = formatBytes(est.quota ?? 0);
            s.textContent = t("settings.about.storage.value", { used, total });
        })
        .catch((err: unknown) => {
            log.warn("storage estimate failed", err);
            s.textContent = t("settings.about.storage.unknown");
        });
}

/**
 * Re-groups loaded trips with the new gap threshold while preserving positional
 * UI state through the shared regroup commit.
 *
 * No-op when no trips are loaded yet (the next ingest will use the new value).
 */
function regroupLoadedTrips(): void {
    if (state.trips.length === 0) return;

    const allCandidates = state.trips.flatMap((trip) => tripAllCandidates(trip));
    commitRecordingTripsWhilePreservingIngest(allCandidates);
    renderTrips();
    schedulePopulateTripPreviews(state.trips, updateTripPreview);
}

/** Re-renders event-dependent surfaces after an in-place event update. */
function refreshActiveTripSurfaces(): void {
    renderTrips();
    if (state.active) {
        const trip = state.trips[state.active.trip];
        if (trip) {
            rebuildChartFromTrip(trip);
            refreshMap(trip);
        }
    }
}

/**
 * Re-runs event detection over already-loaded trips. Called when the user
 * changes the brake-threshold setting - lighter than regroupLoadedTrips
 * (no re-grouping, just events). Mutates trip.events in place, then
 * refreshes the surfaces that draw event markers: sidebar chips, and the
 * chart + map for the currently active trip.
 */
function recomputeEventsForLoadedTrips(): void {
    if (state.trips.length === 0) return;
    for (const trip of state.trips) {
        // Project onto the footage axis (chart x-coordinate), same as finalizeTrip.
        trip.events = projectEventsOntoTimeline(detectEvents(trip.records, trip.startUtc), trip.timeline);
    }
    refreshActiveTripSurfaces();
}

function closeSettings(): void {
    const m = modalEl();
    if (!m) return;
    m.hidden = true;
    deactivateModal(m);
}

function openResetConfirm(): void {
    closeSettings();
    const m = resetModalEl();
    if (!m) return;
    m.hidden = false;
    activateModal(m, {
        // Escape must land the user back in settings, same as Cancel and the
        // backdrop click do - reset-confirm REPLACES settings (closeSettings
        // above), it does not stack on top, so a bare close would dump the
        // user out of the settings flow entirely.
        onClose: () => {
            closeResetConfirm();
            openSettings();
        },
        initialFocus: document.getElementById("reset-confirm-cancel"),
    });
}

function closeResetConfirm(): void {
    const m = resetModalEl();
    if (!m) return;
    m.hidden = true;
    deactivateModal(m);
}

/**
 * Initializes the settings modal and reset-confirm modal. Idempotent;
 * must be called exactly once from app.ts.
 */
export function initSettingsModal(): void {
    const settingsBtn = document.getElementById("settings-btn");

    const m = modalEl();
    if (!m) {
        log.warn("settings modal element not found");
        return;
    }

    if (!__PORTABLE__) {
        initMigrationSection();
        initMigrationBanner();
        initMigrationRestore();
        document.getElementById("settings-migration-import")?.addEventListener("click", () => {
            closeSettings();
            location.hash = "restore-notes";
        });
    }

    // Privacy section holds the crash-reports toggle (Sentry build flag).
    // Hidden entirely when crash reporting is not built into this
    // bundle, so a fork without a Sentry DSN sees no dangling Privacy header.
    const crashBuilt = !__PORTABLE__ && isCrashReportingBuilt();
    if (!crashBuilt) {
        const crashRow = document.getElementById("settings-crash-row");
        if (crashRow) crashRow.hidden = true;
        const privacySection = document.getElementById("settings-privacy-section");
        if (privacySection) privacySection.hidden = true;
        log.debug("privacy section hidden (no crash reporting)");
    }

    settingsBtn?.addEventListener("click", () => {
        if (isOpen(m)) closeSettings();
        else openSettings();
    });

    document.getElementById("settings-modal-close")?.addEventListener("click", closeSettings);
    document.getElementById("settings-modal-header-close")?.addEventListener("click", closeSettings);

    // Backdrop click closes the active modal; the card stops its own clicks.
    wireBackdropDismiss(m, closeSettings, { cardSelector: ".export-modal-card" });

    // Escape is handled centrally by the modal manager (activateModal). Note
    // reset-confirm does NOT stack on settings - openResetConfirm closes
    // settings first and its onClose reopens them, so Escape walks back one
    // step instead of dropping out of the flow.

    // Crash reporting toggle. Flipping it persists the choice and
    // spins up / tears down Sentry at runtime - no reload needed.
    if (!__PORTABLE__)
        crashToggleEl()?.addEventListener("change", (ev) => {
            const target = ev.target as HTMLInputElement;
            setCrashReportingEnabled(target.checked);
        });

    // --- Playback: units select ---

    document.getElementById("settings-units-select")?.addEventListener("change", (ev) => {
        const sel = ev.target as HTMLSelectElement;
        const v = sel.value;
        if (v === "metric" || v === "imperial") {
            setUnits(v as Units);
        }
    });

    document.getElementById("settings-encoder-select")?.addEventListener("change", (ev) => {
        const value = (ev.target as HTMLSelectElement).value;
        if (isEncoderPreference(value)) setEncoderPreference(value);
        syncEncoderSelect();
    });

    // --- Map provider ---

    const mapViewControl = document.getElementById("settings-map-view-control");
    if (mapViewControl) initMapViewControls(mapViewControl, "settings-map");

    subscribeMapProvider((provider) => {
        for (const id of ["settings-map-label-scale-select", "settings-map-street-names-select"]) {
            const select = document.getElementById(id) as HTMLSelectElement | null;
            if (!select) continue;
            select.disabled = !MAP_PROVIDER_REGISTRY[provider].supportsAppearanceSettings;
            if (select.disabled) select.setAttribute("aria-describedby", "settings-map-style-unavailable");
            else select.removeAttribute("aria-describedby");
        }
    });

    // --- Map labels ---
    // Both apply immediately to the live maps. The export overlay map has
    // its own per-export text-size control.

    document.getElementById("settings-map-label-scale-select")?.addEventListener("change", (ev) => {
        if (!MAP_PROVIDER_REGISTRY[getMapProvider()].supportsAppearanceSettings) return;
        const sel = ev.target as HTMLSelectElement;
        const parsed = Number(sel.value);
        const match = MAP_LABEL_SCALE_VALUES.find((v) => v === parsed);
        if (match === undefined) return;
        setMapLabelScale(match);
        reapplyMapLabelPrefs();
    });

    document.getElementById("settings-map-street-names-select")?.addEventListener("change", (ev) => {
        if (!MAP_PROVIDER_REGISTRY[getMapProvider()].supportsAppearanceSettings) return;
        const sel = ev.target as HTMLSelectElement;
        const match = STREET_LABEL_DENSITY_VALUES.find((v) => v === sel.value);
        if (match === undefined) return;
        setStreetLabelDensity(match);
        reapplyMapLabelPrefs();
    });

    // --- Playback: arrow-key seek step ---
    //
    // Two independent inputs. Empty / invalid input restores the default so
    // an accidentally-cleared field doesn't leave the player with NaN as a
    // step (which would seek nowhere). Clamping is done by the pref setter.

    const seekInput = document.getElementById("settings-seek-step-input") as HTMLInputElement | null;
    const seekShiftInput = document.getElementById("settings-seek-step-shift-input") as HTMLInputElement | null;

    function applySeekStep(input: HTMLInputElement | null, fallback: number, write: (sec: number) => void): void {
        if (!input) return;
        const raw = Number.parseFloat(input.value);
        const next = Number.isFinite(raw) && raw > 0 ? raw : fallback;
        const clamped = Math.min(SEEK_STEP_MAX_SEC, Math.max(SEEK_STEP_MIN_SEC, next));
        if (clamped !== raw) input.value = String(clamped);
        write(clamped);
    }

    seekInput?.addEventListener("change", () => applySeekStep(seekInput, DEFAULT_SEEK_STEP_SEC, setSeekStepSec));
    seekShiftInput?.addEventListener("change", () =>
        applySeekStep(seekShiftInput, DEFAULT_SEEK_STEP_SHIFT_SEC, setSeekStepShiftSec),
    );

    // --- Events: brake/impact detection threshold ---
    //
    // Number input + "off" checkbox (mirrors the trip-gap pattern). On any
    // change we recompute trip.events for ALL loaded trips and refresh the
    // surfaces that show event markers: sidebar chip (renderTrips), and -
    // if a trip is currently active - the chart and the map.

    const eventsInput = document.getElementById("settings-events-threshold-input") as HTMLInputElement | null;
    const eventsOff = document.getElementById("settings-events-threshold-off") as HTMLInputElement | null;

    function storeEventsThresholdFromInput(): boolean {
        if (!eventsInput) return false;
        const raw = Number.parseFloat(eventsInput.value);
        if (!Number.isFinite(raw) || raw <= 0) return false;
        const clamped = Math.min(BRAKE_G_THRESHOLD_MAX, Math.max(BRAKE_G_THRESHOLD_MIN, raw));
        if (clamped !== raw) eventsInput.value = String(clamped);
        setBrakeThresholdG(clamped);
        return true;
    }

    function applyEventsThresholdFromInput(): void {
        if (!storeEventsThresholdFromInput()) return;
        recomputeEventsForLoadedTrips();
    }

    eventsInput?.addEventListener("change", applyEventsThresholdFromInput);

    eventsOff?.addEventListener("change", () => {
        if (!eventsOff) return;
        if (eventsOff.checked) {
            if (eventsInput) eventsInput.disabled = true;
            setBrakeThresholdG(Number.POSITIVE_INFINITY);
        } else {
            if (eventsInput) eventsInput.disabled = false;
            // An empty / invalid field does not write a value. Guarantee a
            // finite threshold when the user turns detection back on.
            if (!storeEventsThresholdFromInput()) {
                setBrakeThresholdG(0.5);
                if (eventsInput) eventsInput.value = "0.5";
            }
        }
        recomputeEventsForLoadedTrips();
    });

    // --- Ingest: trip grouping threshold ---
    //
    // Two controls sharing state: a minutes-number input and a "never split"
    // checkbox. The checkbox is authoritative on storage (when checked,
    // we persist Infinity); when unchecked, the input value (in minutes,
    // converted to seconds) is persisted. Both trigger regroup of loaded
    // trips so the sidebar reflects the change immediately.

    const tripInput = document.getElementById("settings-trip-gap-input") as HTMLInputElement | null;
    const tripNever = document.getElementById("settings-trip-gap-never") as HTMLInputElement | null;

    // Min/max mirror the HTML input attributes. Native validation surfaces
    // a tooltip on submit but doesn't block the `change` event, so we clamp
    // here too - otherwise a typed "5000" would land 83 hours into storage.
    const TRIP_GAP_MIN_MINUTES = 0.5;
    const TRIP_GAP_MAX_MINUTES = 180;

    function storeTripGapFromInput(): boolean {
        if (!tripInput) return false;
        const raw = Number.parseFloat(tripInput.value);
        if (!Number.isFinite(raw) || raw <= 0) return false;
        const minutes = Math.min(TRIP_GAP_MAX_MINUTES, Math.max(TRIP_GAP_MIN_MINUTES, raw));
        // Echo the clamped value back so the user sees what was actually saved.
        if (minutes !== raw) tripInput.value = String(minutes);
        setTripGapSec(minutes * 60);
        return true;
    }

    function applyTripGapFromInput(): void {
        if (!storeTripGapFromInput()) return;
        regroupLoadedTrips();
    }

    // "input" fires on every keystroke; "change" only on blur. We use "change"
    // so the user can type "12" without intermediate regroups when they hit "1".
    tripInput?.addEventListener("change", applyTripGapFromInput);

    tripNever?.addEventListener("change", () => {
        if (!tripNever) return;
        if (tripNever.checked) {
            if (tripInput) tripInput.disabled = true;
            setTripGapSec(Number.POSITIVE_INFINITY);
        } else {
            if (tripInput) tripInput.disabled = false;
            storeTripGapFromInput();
        }
        regroupLoadedTrips();
    });

    // --- Notes backup ---

    document.getElementById("settings-notes-export-btn")?.addEventListener("click", downloadPortableNotesBackup);
    const notesImportInput = document.getElementById("settings-notes-import-input") as HTMLInputElement | null;
    const notesImportButton = document.getElementById("settings-notes-import-btn") as HTMLButtonElement | null;
    notesImportButton?.addEventListener("click", () => notesImportInput?.click());
    notesImportInput?.addEventListener("change", () => {
        const file = notesImportInput.files?.[0];
        notesImportInput.value = "";
        if (!file) return;
        if (notesImportButton) notesImportButton.disabled = true;
        void importPortableNotesBackup(file).finally(() => {
            if (notesImportButton) notesImportButton.disabled = false;
        });
    });

    // --- Recordings cache ---
    //
    // Limit input follows the seek-step pattern: empty / invalid restores the
    // default, out-of-range clamps and echoes back. Shrinking must reclaim the
    // space immediately (pruneIndexCacheToLimit) - the ordinary prune only
    // runs on an ingest write-back, which may be days away.

    const cacheLimitInput = document.getElementById("settings-cache-limit-input") as HTMLInputElement | null;
    cacheLimitInput?.addEventListener("change", () => {
        const raw = Number.parseFloat(cacheLimitInput.value);
        const requestedBytes = Number.isFinite(raw) && raw > 0 ? raw * BYTES_PER_MB : DEFAULT_INDEX_CACHE_LIMIT_BYTES;
        const clampedBytes = Math.min(
            INDEX_CACHE_LIMIT_MAX_BYTES,
            Math.max(INDEX_CACHE_LIMIT_MIN_BYTES, requestedBytes),
        );
        cacheLimitInput.value = String(Math.round(clampedBytes / BYTES_PER_MB));
        setIndexCacheLimitBytes(clampedBytes);
        pruneIndexCacheToLimit()
            .then(refreshCacheUsageValue)
            .catch((err: unknown) => {
                log.warn("prune after limit change failed", {
                    err: err instanceof Error ? err.message : String(err),
                });
                // The stored limit is applied either way - the next write-back prunes.
                refreshCacheUsageValue();
            });
    });

    document.getElementById("settings-cache-clear-btn")?.addEventListener("click", () => {
        const btn = document.getElementById("settings-cache-clear-btn") as HTMLButtonElement | null;
        if (btn) btn.disabled = true;
        clearIndexCache()
            .then(() => {
                notify({ severity: "info", messageKey: "settings.cache.clear.done" });
            })
            .catch((err: unknown) => {
                // Unavailable IndexedDB means there was nothing to clear; any
                // other failure leaves the cache as it was. Either way the
                // refreshed readout below shows the actual state.
                log.warn("clear index cache failed", { err: err instanceof Error ? err.message : String(err) });
            })
            .finally(() => {
                if (btn) btn.disabled = false;
                refreshCacheUsageValue();
            });
    });

    // --- About & diagnostics ---

    document.getElementById("settings-download-log-btn")?.addEventListener("click", () => {
        downloadLogBuffer();
    });

    if (!__PORTABLE__)
        document.getElementById("settings-clear-cache-btn")?.addEventListener("click", () => {
            const btn = document.getElementById("settings-clear-cache-btn") as HTMLButtonElement | null;
            if (btn) btn.disabled = true;
            // Lighter than the full Danger zone reset: only Cache Storage + SW.
            // Preferences and language remain intact. Reload (success path only)
            // picks up the freshly downloaded shell.
            void clearServiceWorkerAndCaches()
                .then(() => location.reload())
                .catch((err) => {
                    // Re-enable on failure: we did NOT reload, so leaving the button
                    // disabled would strand the control with no way to retry.
                    log.warn("clear offline cache failed", err);
                    if (btn) btn.disabled = false;
                });
        });

    // --- Reset / Danger zone ---

    // Replay tips: clear the onboarding-tour seen-state so the tours fire again
    // at their next trigger (ingest / trip open / export open). No reload - the
    // toast confirms, and the tours surface as the user navigates.
    document.getElementById("settings-reset-onboarding-btn")?.addEventListener("click", () => {
        resetOnboarding();
        notify({ severity: "info", messageKey: "settings.danger.onboarding.done" });
    });

    document.getElementById("settings-reset-btn")?.addEventListener("click", openResetConfirm);

    document.getElementById("reset-confirm-cancel")?.addEventListener("click", () => {
        closeResetConfirm();
        // Return the user to settings - they came from there, no point
        // sending them back to an empty viewport.
        openSettings();
    });

    document.getElementById("reset-confirm-go")?.addEventListener("click", async () => {
        // Disable the button so the user does not double-click during the
        // ~hundreds-of-ms wipe. The page is about to reload anyway, but a
        // second click could fire a parallel reset on the same caches/idb
        // and surface confusing errors.
        const goBtn = document.getElementById("reset-confirm-go") as HTMLButtonElement | null;
        const cancelBtn = document.getElementById("reset-confirm-cancel") as HTMLButtonElement | null;
        if (goBtn) goBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        // The external backup is the recovery path after this destructive
        // local wipe, so finish queued writes before deleting IndexedDB.
        await flushPendingSidecarWrites();
        void resetAllAppState().catch((err) => {
            log.warn("reset failed, reloading anyway", err);
            location.reload();
        });
    });

    // Reset-confirm backdrop click cancels (treats it like Cancel).
    const resetEl = resetModalEl();
    if (resetEl) {
        wireBackdropDismiss(
            resetEl,
            () => {
                closeResetConfirm();
                openSettings();
            },
            { cardSelector: ".export-modal-card" },
        );
    }
}
