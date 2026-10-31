// Timeline range overlay: pull-tabs + masks span the viewport-mapped timeline
// rows (chart, event strip and progress bar) and let the user pick the export
// clip range. The whole-trip navigator below remains a separate control with a
// separate coordinate basis. Visible only in export-mode.
//
// Coordinate basis. The overlay lives inside #player-chart but stops above the
// navigator, so the masks dim only rows mapped through the visible window. The
// same getTimelineView() transform keeps it aligned with chart zoom and working
// when the chart canvas is hidden.
//
// Drag model. Pointer-events on the tab elements; pointermove/up are captured
// on the tab so the user can drag past the edge without losing the grab. A drag
// funnels through setRangeEdge (export-state), the same clamp the trim bar's
// numeric range inputs use, so both controls enforce identical bounds +
// MIN_RANGE_SEC and never diverge; the rest of the system reads the resulting
// exportPanelState.range (trim bar, Save logic).

import { getTimelineView, timelineFracToSec, timelineSecToFracInView } from "./chart.js";
import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import {
    exportPanelState,
    getExportRangeEdgeBounds,
    notifyExportStateChanged,
    setRangeEdge,
    subscribeExportState,
} from "./export-state.js";
import { formatTime } from "./format.js";
import { attachPointerDrag, suppressEdgeSwipeNav } from "./pointer-drag.js";
import { state } from "./state.js";

/** Slack (sec) before a range boundary counts as outside the zoom window.
 *  Big enough to absorb float drift when the window was derived FROM the range
 *  ("Preview clip"), far below anything a zoom gesture produces. */
const OFFSCREEN_EPSILON_SEC = 0.05;

let container: HTMLDivElement | null = null;
let tabStart: HTMLButtonElement | null = null;
let tabEnd: HTMLButtonElement | null = null;
let maskLeft: HTMLDivElement | null = null;
let maskRight: HTMLDivElement | null = null;
// Floating timecode readout above the dragged/hovered tab. Body-attached and
// position:fixed so the timeline stack's overflow never clips it (same reason
// the scrubber tooltip re-parents to body).
let bubble: HTMLDivElement | null = null;
let bubbleHideTimer: ReturnType<typeof setTimeout> | null = null;

export function initTimelineRange(): void {
    const wrap = dom.playerChartEl;
    if (!wrap) return;

    container = document.createElement("div");
    container.id = "timeline-range";
    container.className = "timeline-range";
    container.hidden = true;

    maskLeft = document.createElement("div");
    maskLeft.className = "timeline-range__mask timeline-range__mask--left";
    container.appendChild(maskLeft);

    maskRight = document.createElement("div");
    maskRight.className = "timeline-range__mask timeline-range__mask--right";
    container.appendChild(maskRight);

    tabStart = document.createElement("button");
    tabStart.type = "button";
    tabStart.className = "timeline-range__tab timeline-range__tab--start";
    tabStart.setAttribute("role", "slider");
    tabStart.setAttribute("aria-orientation", "horizontal");
    tabStart.setAttribute("aria-label", t("export.range.tabStart"));
    container.appendChild(tabStart);

    tabEnd = document.createElement("button");
    tabEnd.type = "button";
    tabEnd.className = "timeline-range__tab timeline-range__tab--end";
    tabEnd.setAttribute("role", "slider");
    tabEnd.setAttribute("aria-orientation", "horizontal");
    tabEnd.setAttribute("aria-label", t("export.range.tabEnd"));
    container.appendChild(tabEnd);

    wrap.appendChild(container);

    bubble = document.createElement("div");
    bubble.className = "timeline-range__bubble mono";
    bubble.hidden = true;
    document.body.appendChild(bubble);

    attachTabDrag(tabStart, "start");
    attachTabDrag(tabEnd, "end");
    attachTabHoverBubble(tabStart, "start");
    attachTabHoverBubble(tabEnd, "end");

    subscribeExportState(syncTimelineRange);
    // The pixel anchor for each tab moves with the visible window. Two sources
    // keep it in sync: chart zoom/pan/reset re-anchors via chart's onViewChanged
    // -> syncTimelineRange (wired in trip-ui-init), and this ResizeObserver
    // covers viewport resize. The export-state subscription above handles range
    // edits from the tabs themselves.
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => syncTimelineRange());
        ro.observe(wrap);
    }

    syncTimelineRange();
}

/**
 * Re-positions the pull-tabs and mask div widths from the current
 * exportPanelState.range. Hides the overlay outside of export-mode and
 * when chart isn't ready. Cheap and idempotent.
 */
export function syncTimelineRange(): void {
    if (!container) return;
    const range = exportPanelState.range;
    const host = dom.playerChartEl;
    const isEditable = isRangeEditable();
    if (!state.exportModeOpen || !range || !host) {
        syncTabState(tabStart, "start", false, false, 0);
        syncTabState(tabEnd, "end", false, false, 0);
        container.hidden = true;
        hideBubble();
        return;
    }
    const view = getTimelineView();
    if (!view) {
        syncTabState(tabStart, "start", false, false, 0);
        syncTabState(tabEnd, "end", false, false, 0);
        container.hidden = true;
        hideBubble();
        return;
    }
    const startFrac = timelineSecToFracInView(range.startTripSec, view);
    const endFrac = timelineSecToFracInView(range.endTripSec, view);
    const w = host.clientWidth;
    if (w <= 0) {
        container.hidden = true;
        return;
    }
    const startX = startFrac * w;
    const endX = endFrac * w;
    const startSide = offscreenSide(range.startTripSec, view);
    const endSide = offscreenSide(range.endTripSec, view);
    // When the whole clip is beyond one side of the viewport both boundaries
    // clamp to the same pixel. Keep only the nearer boundary actionable: end
    // for a clip to the left, start for a clip to the right. One directional
    // chevron says "the clip is over there" without stacked, ambiguous tabs.
    const suppressStart = endSide < 0;
    const suppressEnd = startSide > 0;
    syncTabState(tabStart, "start", isEditable, suppressStart, startSide);
    syncTabState(tabEnd, "end", isEditable, suppressEnd, endSide);

    container.hidden = false;
    // Close boundaries share two adjacent targets instead of letting the later
    // end button cover the start. Spines retain the real boundary positions;
    // CSS keeps each grip wholly inside its own target. Keep the split between
    // the anchors even near the viewport edges, with the host clipping overflow.
    const startWidth = tabStart?.offsetWidth ?? 0;
    const endWidth = tabEnd?.offsetWidth ?? 0;
    let startLeft = startX - startWidth / 2;
    let endLeft = endX - endWidth / 2;
    if (!suppressStart && !suppressEnd && endLeft < startLeft + startWidth) {
        const splitX = (startX + endX) / 2;
        startLeft = splitX - startWidth;
        endLeft = splitX;
    }
    if (tabStart) {
        tabStart.style.left = `${startLeft}px`;
        tabStart.style.setProperty("--range-tab-anchor-x", `${startX - startLeft}px`);
    }
    if (tabEnd) {
        tabEnd.style.left = `${endLeft}px`;
        tabEnd.style.setProperty("--range-tab-anchor-x", `${endX - endLeft}px`);
    }
    // Masks dim everything left/right of the range (incl. the axis gutters)
    // across the viewport-mapped rows above the whole-trip navigator.
    if (maskLeft) {
        maskLeft.style.left = "0";
        maskLeft.style.width = `${Math.max(0, startX)}px`;
    }
    if (maskRight) {
        maskRight.style.left = `${endX}px`;
        maskRight.style.width = `${Math.max(0, w - endX)}px`;
    }
}

type OffscreenSide = -1 | 0 | 1;

function offscreenSide(valueSec: number, view: { startSec: number; endSec: number }): OffscreenSide {
    if (valueSec < view.startSec - OFFSCREEN_EPSILON_SEC) return -1;
    if (valueSec > view.endSec + OFFSCREEN_EPSILON_SEC) return 1;
    return 0;
}

function syncTabState(
    tab: HTMLButtonElement | null,
    which: "start" | "end",
    isEditable: boolean,
    isSuppressed: boolean,
    offscreen: OffscreenSide,
): void {
    if (!tab) return;
    const bounds = getExportRangeEdgeBounds(which);
    const isDisabled = !isEditable || bounds === null || isSuppressed;
    tab.hidden = isSuppressed;
    tab.disabled = isDisabled;
    tab.inert = isDisabled;
    tab.setAttribute("aria-disabled", String(isDisabled));
    tab.classList.toggle("is-offscreen", offscreen !== 0);
    tab.classList.toggle("is-offscreen-left", offscreen < 0);
    tab.classList.toggle("is-offscreen-right", offscreen > 0);
    if (!bounds) {
        tab.removeAttribute("aria-valuemin");
        tab.removeAttribute("aria-valuemax");
        tab.removeAttribute("aria-valuenow");
        tab.removeAttribute("aria-valuetext");
        return;
    }
    const value = Math.max(bounds.minTripSec, Math.min(bounds.valueTripSec, bounds.maxTripSec));
    tab.setAttribute("aria-valuemin", String(bounds.minTripSec));
    tab.setAttribute("aria-valuemax", String(bounds.maxTripSec));
    tab.setAttribute("aria-valuenow", String(value));
    tab.setAttribute("aria-valuetext", formatTime(value));
}

function isRangeEditable(): boolean {
    return state.exportModeOpen && exportPanelState.phase === "options" && !exportPanelState.configurationLocked;
}

function attachTabDrag(tab: HTMLButtonElement, which: "start" | "end"): void {
    // The tabs park at the timeline gutter, which is close to the screen edge
    // when the range covers the whole trip - exactly where iOS arms swipe-back.
    suppressEdgeSwipeNav(tab);
    // A button synthesizes click for Space/Enter with no meaningful pointer X.
    // Never let that bubble into the chart's delegated seek handler.
    tab.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
    });
    let grabOffset = 0;
    attachPointerDrag(tab, {
        onStart: (ev) => {
            if (!isRangeEditable()) return false;
            ev.preventDefault();
            tab.classList.add("is-dragging");
            showBubbleFor(tab, which);
            // Preserve the distance between a compact target and its boundary.
            grabOffset = ev.clientX - tabBoundaryClientX(tab);
            return true;
        },
        onMove: (mv) => {
            // A split target can be farther from its spine than the timeline
            // gutter is wide. Reaching the host edge must still reach the view
            // edge, even when the preserved grab offset would stop short.
            const hostRect = dom.playerChartEl?.getBoundingClientRect();
            const x =
                hostRect && mv.clientX <= hostRect.left + 1
                    ? hostRect.left
                    : hostRect && mv.clientX >= hostRect.right - 1
                      ? hostRect.right
                      : mv.clientX - grabOffset;
            updateRangeFromPointer(x, which);
            // setRangeEdge notified synchronously; read the committed position.
            showBubbleFor(tab, which);
        },
        onEnd: () => {
            tab.classList.remove("is-dragging");
            // Short linger so the final value is readable after the finger lifts.
            hideBubbleSoon();
            // Settle geometry-changing actions once the pointer is released.
            notifyExportStateChanged();
        },
    });

    tab.addEventListener("keydown", (ev) => {
        if (!isRangeEditable() || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
        const bounds = getExportRangeEdgeBounds(which);
        if (!bounds) return;
        ev.preventDefault();
        ev.stopPropagation();
        const stepSec = ev.shiftKey ? 10 : 1;
        const direction = ev.key === "ArrowLeft" ? -1 : 1;
        setRangeEdge(which, bounds.valueTripSec + direction * stepSec);
        showBubbleFor(tab, which);
        hideBubbleSoon();
    });
}

function tabBoundaryClientX(tab: HTMLButtonElement): number {
    return tab.getBoundingClientRect().left + Number.parseFloat(tab.style.getPropertyValue("--range-tab-anchor-x"));
}

/** Desktop affordance: hovering a tab shows its current timecode without
 *  starting a drag. Mouse only - on touch the bubble appears with the drag. */
function attachTabHoverBubble(tab: HTMLButtonElement, which: "start" | "end"): void {
    tab.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType !== "mouse") return;
        showBubbleFor(tab, which);
    });
    tab.addEventListener("pointerleave", (ev) => {
        if (ev.pointerType !== "mouse") return;
        // No linger on hover-out; an active drag re-shows on every move anyway.
        if (ev.buttons === 0) hideBubble();
    });
}

/** Positions the bubble over `tab` showing the current committed value of the
 *  edge. Viewport-clamped; no-op when there is no range. */
function showBubbleFor(tab: HTMLButtonElement, which: "start" | "end"): void {
    const range = exportPanelState.range;
    if (!bubble || !range) return;
    if (bubbleHideTimer) {
        clearTimeout(bubbleHideTimer);
        bubbleHideTimer = null;
    }
    bubble.textContent = formatTime(which === "start" ? range.startTripSec : range.endTripSec);
    bubble.hidden = false;
    const rect = tab.getBoundingClientRect();
    // offsetWidth is valid now that hidden=false. Clamp inside the viewport so
    // the start bubble is not cut at the left edge (nor end at the right).
    const w = bubble.offsetWidth;
    const left = Math.max(4, Math.min(tabBoundaryClientX(tab) - w / 2, window.innerWidth - w - 4));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${rect.top - bubble.offsetHeight - 6}px`;
}

function hideBubble(): void {
    if (!bubble) return;
    if (bubbleHideTimer) {
        clearTimeout(bubbleHideTimer);
        bubbleHideTimer = null;
    }
    bubble.hidden = true;
}

function hideBubbleSoon(): void {
    if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
    bubbleHideTimer = setTimeout(hideBubble, 600);
}

/** Pending flash-removal timers, one per tab. */
const flashTimers: Record<"start" | "end", ReturnType<typeof setTimeout> | null> = { start: null, end: null };

/**
 * One-shot highlight of a pull-tab. Feedback for indirect range edits (the
 * I/O set-to-playhead actions), whose only other trace is the mask jumping.
 * No-op while the overlay is hidden.
 *
 * Cleanup is a timer, not animationend: under prefers-reduced-motion the CSS
 * disables the animation, animationend never fires, and a once-listener would
 * leak (and leave the class stuck) on every call.
 */
export function flashRangeTab(which: "start" | "end"): void {
    const tab = which === "start" ? tabStart : tabEnd;
    if (!tab || tab.hidden || container?.hidden) return;
    tab.classList.remove("is-flash");
    // Force a reflow so re-adding the class restarts the animation on rapid repeats.
    void tab.offsetWidth;
    tab.classList.add("is-flash");
    const prev = flashTimers[which];
    if (prev) clearTimeout(prev);
    // Slightly past the 0.6s animation so removal never truncates it.
    flashTimers[which] = setTimeout(() => {
        tab.classList.remove("is-flash");
        flashTimers[which] = null;
    }, 700);
}

function updateRangeFromPointer(clientX: number, which: "start" | "end"): void {
    const host = dom.playerChartEl;
    if (!isRangeEditable() || !exportPanelState.range || !host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return;
    const tripSec = timelineFracToSec((clientX - rect.left) / rect.width);
    if (tripSec === null) return;
    // Shared clamp (bounds + MIN_RANGE_SEC) + notify - identical to the panel's
    // numeric inputs, so drag and type never produce different results.
    setRangeEdge(which, tripSec);
}
