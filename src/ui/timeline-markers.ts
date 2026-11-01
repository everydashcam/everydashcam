// Timeline marker pins: UTC-anchored annotations rendered as flags over the
// shared timeline host (#player-chart), positioned by the same geometry as
// the playhead (timelineSecToFrac), plus inert notches on the whole-trip row
// so markers outside the zoom window stay findable. Refreshed by the chart's
// overlay-sync hook (trip change / zoom / pan / resize) and explicitly after
// edits.
//
// Interactions: the player-bar button drops a marker at the playhead and
// opens the editor; a pin click seeks; contextmenu (long-press on Android)
// opens the editor. iOS touch has no contextmenu - there the marker list
// (marker-list-modal.ts) is the way to rename and delete.

import { t } from "../i18n/index.js";
import { contentToWallUtc, wallToContentSec } from "../trips.js";
import { addMarker, markersForTrip } from "./annotations.js";
import { getTimelineView, timelineSecToFracInView } from "./chart.js";
import { dom } from "./dom.js";
import { syncMarkerListButton } from "./marker-list-modal.js";
import { openMarkerModal } from "./marker-modal.js";
import { getTripCurrentTime, seekTripTime } from "./player.js";
import { activeTrip } from "./state.js";

let layer: HTMLElement | null = null;
let overviewLayer: HTMLElement | null = null;

export function initTimelineMarkers(): void {
    layer = document.getElementById("player-chart-markers");
    overviewLayer = document.getElementById("player-chart-overview-markers");
    document.getElementById("player-add-marker")?.addEventListener("click", () => {
        const trip = activeTrip();
        if (!trip) return;
        // Pause BEFORE reading the playhead: the marker must name the frame the
        // user is looking at, and a running video moves on while the editor is
        // built. Playback resumes on close, so the pause is not a state the
        // user has to undo - and a paused player is left paused.
        const wasPlaying = !dom.player.paused;
        if (wasPlaying) dom.player.pause();
        const contentSec = getTripCurrentTime();
        const utcMs = contentToWallUtc(trip.timeline, contentSec) * 1000;
        const marker = addMarker(trip, utcMs, "");
        refreshTimelineMarkers();
        // Straight into the text editor - an unlabeled pin is rarely the goal.
        // createdNow: dismissing the editor drops the pin again, so a stray
        // click on this button is undone by Escape like any other dialog.
        openMarkerModal(marker.id, {
            createdNow: true,
            onClose: () => {
                if (wasPlaying) dom.player.play().catch(() => {});
            },
        });
    });
}

// Snapshot of what the layer currently renders. The overlay-sync hook fires
// per pointermove during an overview drag - identical content must not churn
// the DOM (and must not kill :hover on a pin mid-interaction).
let renderedSignature = "";
let renderedOverviewSignature = "";

/** Notches on the whole-trip row: every marker, at its place in the trip. */
function refreshOverviewMarkers(fracs: readonly number[]): void {
    if (!overviewLayer) return;
    const signature = fracs.map((frac) => frac.toFixed(4)).join(",");
    if (signature === renderedOverviewSignature) return;
    renderedOverviewSignature = signature;
    overviewLayer.replaceChildren(
        ...fracs.map((frac) => {
            const notch = document.createElement("span");
            notch.className = "range-overview-marker";
            notch.style.left = `${(frac * 100).toFixed(3)}%`;
            return notch;
        }),
    );
}

/** Rebuilds the pins for the active trip and the current zoom window. Cheap
 *  (a handful of DOM nodes); out-of-window markers are skipped, not clamped -
 *  a pile-up at the window edge reads as pins that are not there. */
export function refreshTimelineMarkers(): void {
    const trip = activeTrip();
    const markers = trip ? markersForTrip(trip) : [];
    // Ahead of the layer guard and the signature short-circuit below: the bar
    // button tracks the trip's whole marker set, not the zoom window's slice.
    syncMarkerListButton(markers.length);
    const durationSec = trip?.timeline.contentDurationSec ?? 0;
    refreshOverviewMarkers(
        trip && durationSec > 0
            ? markers.map((marker) => wallToContentSec(trip.timeline, marker.utc / 1000) / durationSec)
            : [],
    );
    if (!layer) return;
    const view = trip ? getTimelineView() : null;
    const visible: Array<{ id: string; text: string; contentSec: number; frac: number }> = [];
    if (trip && view) {
        for (const marker of markers) {
            const contentSec = wallToContentSec(trip.timeline, marker.utc / 1000);
            if (contentSec < view.startSec || contentSec > view.endSec) continue;
            const frac = timelineSecToFracInView(contentSec, view);
            visible.push({ id: marker.id, text: marker.text, contentSec, frac });
        }
    }
    const signature = visible.map((v) => `${v.id}${v.text}${v.frac.toFixed(4)}`).join("");
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    layer.replaceChildren();
    for (const v of visible) {
        // Wrapper (full height, inert): the hairline. Hit button (flag head
        // only): a full-height interactive column would sit over the seek
        // strip and steal its pointerdowns.
        const pin = document.createElement("span");
        pin.className = "timeline-marker";
        pin.style.left = `${(v.frac * 100).toFixed(3)}%`;
        const hit = document.createElement("button");
        hit.type = "button";
        hit.className = "timeline-marker-hit";
        const label = v.text || t("marker.untitled");
        hit.title = label;
        hit.setAttribute("aria-label", label);
        hit.addEventListener("click", () => seekTripTime(v.contentSec));
        hit.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            openMarkerModal(v.id);
        });
        pin.appendChild(hit);
        layer.appendChild(pin);
    }
}
