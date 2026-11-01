// Per-trip GPS/video calibration panel. Edits are persisted immediately and
// rebuild every GPS-derived surface from immutable candidate records, so the
// user can safely try several offsets without accumulating shifts or losing
// points hidden by an earlier trim.

import {
    applyStoredGpsSyncToTrip,
    GPS_OFFSET_MAX_SEC,
    gpsSyncPeerTrips,
    gpsTrackOverhangSec,
    normalizeGpsOffsetSec,
    rawGpsStartUnix,
    resolvedGpsSyncForTrip,
    setTripGpsOffsetSec,
    setTripGpsTrimToVideo,
    tripHasRawGps,
} from "../gps-sync.js";
import { t } from "../i18n/index.js";
import { contentToWallUtc, type Trip } from "../trips.js";

import { getTripCameraTimezoneState, setTripCameraTimezone } from "./camera-timezone.js";
import { formatDateTime, subscribeDateFormatChange } from "./date-format.js";
import { dom } from "./dom.js";
import { initGpsSyncLaunchers } from "./gps-sync-controls.js";
import { requestGpsSyncSurfaceRefresh } from "./gps-sync-refresh.js";
import { MOBILE_LAYOUT_QUERY } from "./media-queries.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";
import { notify } from "./notifications.js";
import { activeTrip, state } from "./state.js";

let getTripCurrentTime: () => number = () => 0;
let initialized = false;
let isModalPresentation: boolean | null = null;
let returnFocus: HTMLElement | null = null;

function initialControl(): HTMLElement {
    if (!dom.gpsSyncTimezoneSection.hidden) return dom.gpsSyncTimezoneSelect;
    return tripHasRawGps(activeTrip()) ? dom.gpsSyncOffsetInput : dom.gpsSyncClose;
}

function closeGpsSync(): void {
    dom.gpsSyncModal.hidden = true;
    if (isModalPresentation === true) deactivateModal(dom.gpsSyncModal);
    else returnFocus?.focus?.();
    isModalPresentation = null;
    returnFocus = null;
}

/** Refreshes surfaces whose data is snapshotted on trip activation. */
function refreshGpsSyncSurfaces(): void {
    requestGpsSyncSurfaceRefresh();
}

function shouldUseModalPresentation(): boolean {
    return (
        (document.fullscreenElement ?? document.querySelector(".player-expanded")) !== null ||
        window.matchMedia(MOBILE_LAYOUT_QUERY).matches
    );
}

function syncPresentationMode(): void {
    if (dom.gpsSyncModal.hidden) return;
    const nextIsModal = shouldUseModalPresentation();
    dom.gpsSyncModal.classList.toggle("is-modeless", !nextIsModal);
    dom.gpsSyncModal.classList.toggle("is-modal", nextIsModal);
    dom.gpsSyncModal.setAttribute("aria-modal", String(nextIsModal));
    if (nextIsModal === isModalPresentation) return;

    if (isModalPresentation === true) deactivateModal(dom.gpsSyncModal);
    isModalPresentation = nextIsModal;
    if (isModalPresentation) {
        activateModal(dom.gpsSyncModal, {
            onClose: closeGpsSync,
            initialFocus: initialControl(),
        });
    }
}

function syncDialog(trip: Trip | null): void {
    const hasGps = tripHasRawGps(trip);
    const timezone = getTripCameraTimezoneState(trip);
    dom.gpsSyncTimezoneSection.hidden = timezone === null;
    dom.gpsSyncTimezoneNoMatch.hidden = hasGps || timezone === null;
    if (timezone !== null) {
        dom.gpsSyncTimezoneSelect.value = timezone.overrideSec === null ? "auto" : String(timezone.overrideSec);
        dom.gpsSyncTimezoneReset.disabled = timezone.overrideSec === null;
        const sourceKey =
            timezone.overrideSec !== null
                ? "gpsSync.timezone.source.manual"
                : timezone.fromDevice
                  ? "gpsSync.timezone.source.device"
                  : "gpsSync.timezone.source.recordings";
        dom.gpsSyncTimezoneSource.textContent = t(sourceKey, { offset: formatTimezoneOffset(timezone.effectiveSec) });
        const format = (unixSec: number): string =>
            formatDateTime(new Date(unixSec * 1000), { year: true, seconds: true });
        dom.gpsSyncTimezonePreview.textContent = t("gpsSync.timezone.preview", {
            camera: format(timezone.cameraUnix),
            utc: format(timezone.utcUnix),
        });
    }
    dom.gpsSyncNoTrack.hidden = hasGps || timezone !== null;
    dom.gpsSyncControls.hidden = !hasGps;
    if (!trip || !hasGps) return;

    const resolved = resolvedGpsSyncForTrip(trip);
    dom.gpsSyncOffsetInput.value = String(resolved.offsetSec);
    dom.gpsSyncTrimToggle.checked = resolved.trimToVideo;
    dom.gpsSyncReset.disabled = !resolved.hasOffsetOverride;
    const peers = gpsSyncPeerTrips(trip, state.trips);
    dom.gpsSyncApplyCamera.hidden = peers.length === 0;
    dom.gpsSyncApplyCamera.disabled = resolved.offsetSec === 0;

    const outsideSec = gpsTrackOverhangSec(trip, resolved.offsetSec);
    dom.gpsSyncOutsideStatus.hidden = outsideSec < 0.5;
    if (outsideSec >= 0.5) {
        dom.gpsSyncOutsideStatus.textContent = t(
            resolved.trimToVideo ? "gpsSync.outside.hidden" : "gpsSync.outside.shown",
            { duration: formatOutsideDuration(outsideSec) },
        );
    } else {
        dom.gpsSyncOutsideStatus.textContent = "";
    }
}

/** Reads the current Trip again after regrouping or changing the active trip. */
export function syncGpsSyncDialog(): void {
    if (!dom.gpsSyncModal.hidden) syncDialog(activeTrip());
}

function formatTimezoneOffset(offsetSec: number): string {
    const minutes = Math.round(Math.abs(offsetSec) / 60);
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    const remainder = String(minutes % 60).padStart(2, "0");
    return `UTC${offsetSec < 0 ? "−" : "+"}${hours}:${remainder}`;
}

function initTimezoneOptions(): void {
    const options = document.createDocumentFragment();
    for (let offsetSec = -12 * 3600; offsetSec <= 14 * 3600; offsetSec += 15 * 60) {
        const option = document.createElement("option");
        option.value = String(offsetSec);
        option.textContent = formatTimezoneOffset(offsetSec);
        options.append(option);
    }
    dom.gpsSyncTimezoneSelect.append(options);
}

function applyTimezone(offsetSec: number | null): void {
    const trip = activeTrip();
    if (!trip || getTripCameraTimezoneState(trip) === null) return;
    setTripCameraTimezone(trip, offsetSec);
    // Changing the clock may replace the Trip during regrouping.
    syncGpsSyncDialog();
}

function formatOutsideDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const days = Math.floor(total / 86_400);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    if (days > 0) return `${days}${t("units.d")} ${hours % 24}${t("units.h")}`;
    if (hours > 0) return `${hours}${t("units.h")} ${minutes}${t("units.m")}`;
    if (minutes > 0) return `${minutes}${t("units.m")} ${remainder}${t("units.s")}`;
    return `${remainder}${t("units.s")}`;
}

function applyOffset(trip: Trip, value: number): void {
    const normalized = normalizeGpsOffsetSec(value);
    setTripGpsOffsetSec(trip, normalized);
    applyStoredGpsSyncToTrip(trip);
    refreshGpsSyncSurfaces();
    syncDialog(trip);
}

function commitOffsetInput(): void {
    const trip = activeTrip();
    if (!trip || !tripHasRawGps(trip)) return;
    const parsed = Number.parseFloat(dom.gpsSyncOffsetInput.value);
    if (!Number.isFinite(parsed)) {
        syncDialog(trip);
        return;
    }
    applyOffset(trip, parsed);
}

export function openGpsSync(): void {
    const trip = activeTrip();
    if (!trip) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    syncDialog(trip);
    dom.gpsSyncModal.hidden = false;
    isModalPresentation = null;
    syncPresentationMode();
    if (isModalPresentation === false) {
        initialControl().focus({ preventScroll: true });
    }
}

export function initGpsSyncModal(opts: { getTripCurrentTime: () => number }): void {
    if (initialized) return;
    initialized = true;
    getTripCurrentTime = opts.getTripCurrentTime;
    dom.gpsSyncOffsetInput.min = String(-GPS_OFFSET_MAX_SEC);
    dom.gpsSyncOffsetInput.max = String(GPS_OFFSET_MAX_SEC);
    initTimezoneOptions();
    initGpsSyncLaunchers(openGpsSync, syncGpsSyncDialog);
    subscribeDateFormatChange(syncGpsSyncDialog);
    dom.gpsSyncTimezoneSelect.addEventListener("change", () => {
        const value = dom.gpsSyncTimezoneSelect.value;
        if (value === "auto") applyTimezone(null);
        else {
            const offsetSec = Number(value);
            if (Number.isFinite(offsetSec)) applyTimezone(offsetSec);
        }
    });
    dom.gpsSyncTimezoneReset.addEventListener("click", () => applyTimezone(null));
    dom.gpsSyncClose.addEventListener("click", closeGpsSync);
    wireBackdropDismiss(dom.gpsSyncModal, closeGpsSync, { cardSelector: ".gps-sync-card" });
    window.matchMedia(MOBILE_LAYOUT_QUERY).addEventListener("change", syncPresentationMode);
    document.addEventListener("fullscreenchange", syncPresentationMode);
    document.addEventListener("playerexpansionchange", syncPresentationMode);
    document.addEventListener(
        "keydown",
        (event) => {
            if (dom.gpsSyncModal.hidden || isModalPresentation !== false || event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeGpsSync();
        },
        true,
    );

    dom.gpsSyncOffsetInput.addEventListener("change", commitOffsetInput);
    dom.gpsSyncOffsetInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commitOffsetInput();
    });

    for (const button of dom.gpsSyncModal.querySelectorAll<HTMLButtonElement>("[data-gps-delta]")) {
        button.addEventListener("click", () => {
            const trip = activeTrip();
            if (!trip || !tripHasRawGps(trip)) return;
            const delta = Number(button.dataset.gpsDelta);
            if (!Number.isFinite(delta)) return;
            applyOffset(trip, (trip.gpsOffsetSec ?? 0) + delta);
        });
    }

    dom.gpsSyncAlignPlayhead.addEventListener("click", () => {
        const trip = activeTrip();
        if (!trip || !tripHasRawGps(trip)) return;
        const gpsStart = rawGpsStartUnix(trip);
        if (gpsStart === null) return;
        const playheadWall = contentToWallUtc(trip.timeline, getTripCurrentTime());
        applyOffset(trip, playheadWall - gpsStart);
    });

    dom.gpsSyncTrimToggle.addEventListener("change", () => {
        const trip = activeTrip();
        if (!trip || !tripHasRawGps(trip)) return;
        setTripGpsTrimToVideo(trip, dom.gpsSyncTrimToggle.checked);
        applyStoredGpsSyncToTrip(trip);
        refreshGpsSyncSurfaces();
        syncDialog(trip);
    });

    dom.gpsSyncReset.addEventListener("click", () => {
        const trip = activeTrip();
        if (!trip || !tripHasRawGps(trip)) return;
        setTripGpsOffsetSec(trip, null);
        applyStoredGpsSyncToTrip(trip);
        refreshGpsSyncSurfaces();
        syncDialog(trip);
    });

    dom.gpsSyncApplyCamera.addEventListener("click", () => {
        const trip = activeTrip();
        if (!trip || !tripHasRawGps(trip)) return;
        const offsetSec = trip.gpsOffsetSec ?? 0;
        const peers = gpsSyncPeerTrips(trip, state.trips);
        if (offsetSec === 0 || peers.length === 0) return;
        for (const peer of peers) {
            setTripGpsOffsetSec(peer, offsetSec);
            applyStoredGpsSyncToTrip(peer);
        }
        refreshGpsSyncSurfaces();
        syncDialog(trip);
        notify({ severity: "info", messageKey: "status.gpsCameraApplied" });
    });
}
