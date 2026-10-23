// Blocking overlay over the full viewport during ingest. Shows the current
// stage (folder walk/classification/sidecar parsing), queue of additional drops,
// and a Cancel button that aborts state.ingestController.

import { t } from "../i18n/index.js";

import { dom } from "./dom.js";
import { activateModal, deactivateModal } from "./modal-helper.js";
import { state } from "./state.js";

// Pre-ingest "reading" phase ownership, as a REFCOUNT (not a bool). The overlay
// is raised the instant the user commits to a folder (picker click / folder
// drop) - before the real ingest starts, and for a drop even before the dropped
// tree is walked - so the page never sits blank while the browser enumerates a
// large card (which fires no JS callback until the change event). Two gestures
// can overlap (a second folder dropped while the first is still being walked),
// each holding its own claim; the overlay hides only when the LAST claim is
// released, so an early-finishing gesture cannot yank it out from under another
// still-running one. A real ingest taking over zeroes the count
// (showIngestOverlay).
let preIngestOwners = 0;

function openOverlay(): void {
    dom.ingestOverlay.hidden = false;
    dom.ingestOverlayCancel.disabled = false;
    dom.ingestOverlayCancel.textContent = t("ingestOverlay.cancel");
    activateModal(dom.ingestOverlay, {
        // Escape can dismiss a picker wait, but aborting real work requires
        // deliberately activating Cancel. Space/Enter on arrival must not stop
        // an import when the user was just controlling playback.
        onClose: () => {
            if (!state.ingestController) endPreIngestReading();
        },
        initialFocus: dom.ingestOverlay,
    });
}

function cancelIngest(): void {
    if (dom.ingestOverlayCancel.disabled) return;
    if (!state.ingestController) {
        // Dismissing this wait cannot close a native picker. A later file
        // selection starts ingest normally and reopens the overlay.
        endPreIngestReading();
        return;
    }
    state.ingestController.abort();
    // Abort cleanup is asynchronous. Disable repeat cancellation and show that
    // stopping is in progress until ingest's finally block hides the overlay.
    dom.ingestOverlayCancel.disabled = true;
    setIngestStage(t("ingestOverlay.stage.canceling"));
}

/**
 * Shows the overlay and re-enables the Cancel button - important when re-launching
 * ingest from the queue (a previous ingest may have ended via Cancel and left
 * the button disabled).
 */
export function showIngestOverlay(): void {
    // A real ingest is taking over the overlay (it now owns the hide via its
    // finally{}). Release ALL pre-ingest claims so a late endPreIngestReading()
    // from an overlapping gesture cannot pull the overlay out mid-ingest.
    preIngestOwners = 0;
    openOverlay();
}

/**
 * Raises the overlay for the pre-ingest "reading" phase (folder picker open /
 * browser enumeration / dropped-tree walk) and returns whether this call now
 * owns it.
 *
 * No-op returning false when an ingest is already running: that overlay belongs
 * to the in-flight ingest and its live stage text must not be clobbered (a
 * second drop during ingest just queues - see ingestFiles).
 *
 * Cancel stays ENABLED and, in this phase, just dismisses the waiting overlay
 * (see cancelIngest). The picker "cancel" event is the seamless auto-retract
 * on modern browsers, but Chrome/Edge 94-112 are within our support floor
 * (Chrome 94, docs/browser-support.md) and never fire it - a working button is
 * the guaranteed escape so a dismissed picker is never a reload-only dead end.
 * There is no AbortController yet, so the button cannot abort real work; the real
 * ingest re-points it at the controller via showIngestOverlay.
 */
export function beginPreIngestReading(): boolean {
    if (state.ingestController !== null) return false;
    preIngestOwners++;
    openOverlay();
    setIngestStage(t("ingestOverlay.stage.preparing"));
    showIngestProgress();
    // A queue may carry over from a previous run - keep the indicator honest.
    syncIngestQueueIndicator();
    return true;
}

/**
 * Releases one pre-ingest claim and hides the overlay once the last one is gone.
 * A no-op once the count is zero: a real ingest that started in the meantime
 * zeroed it (showIngestOverlay), so a late call from a still-walking overlapping
 * gesture must not yank the overlay out from under the running ingest. Safe on
 * any pre-ingest exit path (picker dismissed, empty selection, dropped-tree read
 * failure, the in-phase Cancel click).
 */
export function endPreIngestReading(): void {
    if (preIngestOwners === 0) return; // already handed off to a real ingest
    preIngestOwners = Math.max(0, preIngestOwners - 1);
    if (preIngestOwners > 0) return; // another overlapping gesture still needs it
    hideIngestOverlay();
    hideIngestProgress();
}

export function hideIngestOverlay(): void {
    dom.ingestOverlay.hidden = true;
    deactivateModal(dom.ingestOverlay);
    dom.ingestOverlayStatus.textContent = "";
    dom.ingestOverlayQueue.hidden = true;
}

// === UX-02: progress bar above the header =============================
// A thin 2px strip at the top of the viewport. Shows "not hung" even when
// the user has scrolled past the ingest overlay.
//
// States: hidden or an indeterminate running cursor. Recording-byte progress is
// shown per trip after this blocking phase, so this strip never fabricates one
// aggregate percentage across unrelated classification and sidecar work.
// showIngestOverlay/hideIngestOverlay do not touch the strip - they are
// independent UI entities.

const ingestProgressBar = (): HTMLElement | null => document.getElementById("ingest-progress-bar");

export function showIngestProgress(): void {
    const bar = ingestProgressBar();
    if (bar) bar.dataset.state = "indeterminate";
}

/** Hides the progress strip when the blocking discovery phase ends. */
export function hideIngestProgress(): void {
    const bar = ingestProgressBar();
    if (bar) bar.dataset.state = "hidden";
}

export function setIngestStage(text: string): void {
    dom.ingestOverlayStatus.textContent = text;
}

/**
 * Updates the queue indicator ("N more folders waiting"). Called:
 *  - from ingestFiles when a new drop arrived during an active ingest and was
 *    queued (update the UI immediately so the user sees confirmation).
 *  - at the start of each new ingest (if the queue is non-empty from the previous
 *    run - shows the decremented count correctly).
 */
export function syncIngestQueueIndicator(): void {
    const n = state.ingestQueue.length;
    if (n === 0) {
        dom.ingestOverlayQueue.hidden = true;
        return;
    }
    dom.ingestOverlayQueue.hidden = false;
    dom.ingestOverlayQueue.textContent = t("ingestOverlay.queued", { n });
}

/**
 * Attaches the Cancel handler. Call once on startup.
 */
export function initIngestOverlay(): void {
    dom.ingestOverlayCancel.addEventListener("click", cancelIngest);
}
