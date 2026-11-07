// Top-panel: the trip name above the player in export mode, where the sidebar
// with the trip card is hidden. Camera controls live in the Cameras menu in
// the player bar (cameras-menu.ts) for both viewing and export.

import { displayClockDate } from "../trips.js";
import type { Trip } from "../trips.js";
import { formatDateTime, subscribeDateFormatChange } from "./date-format.js";
import { dom } from "./dom.js";
import { subscribeExportState } from "./export-state.js";
import { formatDuration } from "./format.js";
import { syncMobileViewNav } from "./mobile-view-nav.js";
import { scheduleRecognitionHelp } from "./recognition-help.js";
import { activeTrip, state } from "./state.js";

/** One-time wiring; call from app.ts after dom.ts has resolved its refs. */
export function initTopPanel(): void {
    subscribeExportState(syncTopPanel);
    subscribeDateFormatChange(syncTopPanel);
    syncTopPanel();
}

/**
 * Re-evaluates the panel. Called by every export-state tick and from player.ts
 * on trip change. Cheap - safe to call from any lifecycle hook.
 */
export function syncTopPanel(): void {
    scheduleRecognitionHelp();
    syncMobileViewNav();
    if (!dom.topPanel) return;
    const trip = activeTrip();
    const shouldShow = !!trip && state.exportModeOpen;
    dom.topPanel.hidden = !shouldShow;
    if (dom.topPanelTripName) dom.topPanelTripName.textContent = shouldShow && trip ? formatTripHeader(trip) : "";
}

/** Compact trip identifier: start time + duration. Sidebar header shows the
 *  same data in a richer card; we use a single line here for the slim panel. */
function formatTripHeader(trip: Trip): string {
    // Display clock (camera clock when known) - must match the sidebar card.
    const start = displayClockDate(trip.startUtc, trip.cameraTzSec);
    return `${formatDateTime(start, { year: true })} · ${formatDuration(trip.timeline.contentDurationSec)}`;
}
