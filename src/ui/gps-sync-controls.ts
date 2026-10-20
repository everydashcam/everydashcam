// The three entry points into per-trip GPS calibration: desktop readout pill,
// phone player-bar pill, and map-settings action. They share one renderer so a
// stored/default shift cannot be highlighted in one surface and stale in
// another.

import { getDateLocale, t } from "../i18n/index.js";

import { getTripCameraTimezoneState, tripCanSyncGps } from "./camera-timezone.js";
import { dom } from "./dom.js";
import { formatTime } from "./format.js";
import { activeTrip } from "./state.js";

let syncOpenDialog: (() => void) | null = null;

function formatSignedOffset(offsetSec: number): string {
    const sign = offsetSec < 0 ? "−" : "+";
    const abs = Math.abs(offsetSec);
    if (abs >= 86_400) {
        const days = new Intl.NumberFormat(getDateLocale(), { maximumFractionDigits: 1 }).format(abs / 86_400);
        return `${sign}${days}${t("units.d")}`;
    }
    if (abs >= 60) return `${sign}${formatTime(abs)}`;
    const value = new Intl.NumberFormat(getDateLocale(), { maximumFractionDigits: 3 }).format(abs);
    return `${sign}${value}${t("units.s")}`;
}

/** Re-renders all launchers from the currently active derived Trip. */
export function syncGpsSyncLaunchers(): void {
    const trip = activeTrip();
    const canSync = tripCanSyncGps(trip);
    const offsetSec = trip?.gpsOffsetSec ?? 0;
    const hasTrackShift = canSync && offsetSec !== 0;
    const hasTimezoneOverride = getTripCameraTimezoneState(trip)?.overrideSec != null;
    const shifted = hasTrackShift || hasTimezoneOverride;
    const label = hasTrackShift ? t("gpsSync.badge", { offset: formatSignedOffset(offsetSec) }) : t("gpsSync.open");

    for (const pill of [dom.metrics.gpsSyncPill, dom.metrics.gpsSyncPillMobile]) {
        pill.hidden = !canSync;
        pill.classList.toggle("is-shifted", shifted);
        pill.title = label;
        pill.setAttribute("aria-label", label);
    }
    dom.metrics.gpsSyncPillLabel.textContent = label;
    // Icon-only is intentionally the quiet zero state on narrow player bars.
    dom.metrics.gpsSyncPillMobileLabel.textContent = hasTrackShift ? formatSignedOffset(offsetSec) : "";

    dom.mapGpsSyncBtn.disabled = !canSync;
    dom.mapGpsSyncBtn.classList.toggle("is-shifted", shifted);
    dom.mapGpsSyncBtn.setAttribute("aria-label", label);
    dom.mapGpsSyncLabel.textContent = label;
    syncOpenDialog?.();
}

/** Wires every launcher once. The callback owns modal behavior. */
export function initGpsSyncLaunchers(open: () => void, syncDialog: () => void): void {
    syncOpenDialog = syncDialog;
    for (const button of [dom.metrics.gpsSyncPill, dom.metrics.gpsSyncPillMobile, dom.mapGpsSyncBtn]) {
        button.addEventListener("click", open);
    }
    syncGpsSyncLaunchers();
}
