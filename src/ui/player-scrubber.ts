// Seeking from the timeline: the whole-trip row on top of the stack (thumb,
// hover-tooltip with a frame preview, drag-to-seek, keyboard arrows, and the
// pan gesture on its zoom-window frame) and the playhead grip, which drags the
// current moment at the zoom window's precision. Also owns
// updatePlayerProgressUi (the per-timeupdate UI sync) because it writes to the
// same DOM nodes. Zoom-window state and the frame's edge handles belong to
// chart.ts.
//
// Depends on the playback core only through two callables passed at init:
// getTripCurrentTime() and seekTripTime(sec). Keeps the cycle one-directional
// (scrubber -> player), so the player module never has to know about scrubber
// internals.

import { getDateLocale, t } from "../i18n/index.js";
import { contentToFrame, frameMediaOffset, pickFrameChannel } from "../trips.js";
import {
    beginTimelineWindowGesture,
    finishTimelineWindowGesture,
    getTimelineView,
    getTimelineZoomWindow,
    isOverOverviewThumb,
    overviewSecAtClientX,
    panTimelineWindowTo,
    revealSecInTimelineWindow,
    setPlayerCursorRelSec,
    timelineFracToSec,
    timelineSecToFracInView,
} from "./chart.js";
import { dom } from "./dom.js";
import { formatTime } from "./format.js";
import { extractFrameAt } from "./frame-extract.js";
import { attachPointerDrag, suppressEdgeSwipeNav } from "./pointer-drag.js";
import { getSeekStepSec, getSeekStepShiftSec } from "./seek-step-pref.js";
import { activeTrip, mainChannel, state } from "./state.js";

// Init-time injected callables. The scrubber needs them in DOM event handlers
// installed during initPlayerScrubber; instead of importing from player.ts
// (cycle) we ask the host to provide them once.
//
// Stubs throw rather than silently return 0: if updatePlayerProgressUi or a
// scrubber event handler ever fires before initPlayerScrubber, we want a loud
// failure in the log, not a UI quietly stuck at "0:00" with a chart cursor at
// the trip start.
let getTripCurrentTimeFn: () => number = () => {
    throw new Error("player-scrubber: initPlayerScrubber not called before use");
};
let seekTripTimeFn: (sec: number, precision?: SeekPrecision) => void = () => {
    throw new Error("player-scrubber: initPlayerScrubber not called before use");
};

/** "exact" decodes up to the requested frame. "keyframe" lets the browser
 *  land on the nearest key frame instead (HTMLMediaElement.fastSeek: Safari
 *  and Firefox; Chromium has none and seeks exactly). */
export type SeekPrecision = "exact" | "keyframe";

/** Updates the progress text and DOM playhead on each timeupdate. */
export function updatePlayerProgressUi(): void {
    if (!state.active) {
        dom.playerBar.current.textContent = "0:00";
        dom.playerBar.total.textContent = "0:00";
        setPlayerCursorRelSec(null, null);
        updateMiniProgress(null, null);
        return;
    }
    const cur = getTripCurrentTimeFn();
    const currentTime = formatTime(cur);
    if (dom.playerBar.current.textContent !== currentTime) dom.playerBar.current.textContent = currentTime;
    // Single playhead DOM overlay spans ruler + chart; one visual element, no
    // risk of misalignment between a chart-drawn line and a DOM line.
    setPlayerCursorRelSec(cur, getTimelineView());
    updateMiniProgress(cur, activeTrip()?.timeline.contentDurationSec ?? null, currentTime);
}

let shownProgressTime: string | null = null;
let shownProgressTotal: string | null = null;
let shownProgressLocale: string | null = null;

/**
 * Updates the seek thumb position on the whole-trip row: the row maps the
 * whole trip at every zoom level, so the thumb never leaves it. null resets to
 * 0. Cheap - one style write, no computed-style read.
 */
function updateMiniProgress(
    curSec: number | null,
    durationSec: number | null = activeTrip()?.timeline.contentDurationSec ?? null,
    currentTime: string | null = null,
): void {
    if (!dom.miniProgress) return;
    if (curSec === null || durationSec === null || durationSec <= 0) {
        dom.miniProgressThumb.style.left = "0";
        dom.miniProgress.setAttribute("aria-valuenow", "0");
        dom.miniProgress.removeAttribute("aria-valuetext");
        shownProgressTime = null;
        shownProgressTotal = null;
        shownProgressLocale = null;
        return;
    }
    const curFrac = Math.max(0, Math.min(1, curSec / durationSec));
    dom.miniProgressThumb.style.left = `${curFrac * 100}%`;
    dom.miniProgress.setAttribute("aria-valuenow", String(Math.round(curFrac * 100)));
    // The bare percentage is meaningless to a screen reader; announce a human
    // time instead ("4:03 of 12:40"). Its second-resolution text changes less
    // often than the subsecond playhead and needs no formatting between ticks.
    const cur = currentTime ?? formatTime(curSec);
    const total = formatTime(durationSec);
    const locale = getDateLocale();
    if (cur === shownProgressTime && total === shownProgressTotal && locale === shownProgressLocale) return;
    shownProgressTime = cur;
    shownProgressTotal = total;
    shownProgressLocale = locale;
    dom.miniProgress.setAttribute(
        "aria-valuetext",
        t("player.progress.position", {
            cur,
            total,
        }),
    );
}

/** Movement (CSS px) that turns a press into a drag. Below it the press is a
 *  click: a press on the zoom-window frame seeks instead of panning, and a
 *  press on the playhead grip seeks to its spot. */
const DRAG_THRESHOLD_PX = 3;

/**
 * Wires seeking from the whole-trip row (click/drag, frame pan, keyboard
 * arrows on its track) and from the playhead grip. Listeners are registered
 * once - they no-op when state.active is null.
 *
 * `deps` carries the playback callables; saved into module-level slots so
 * updatePlayerProgressUi (called from outside the closure) can reach
 * getTripCurrentTime without re-importing.
 */
export function initPlayerScrubber(deps: {
    getTripCurrentTime: () => number;
    seekTripTime: (sec: number, precision?: SeekPrecision) => void;
}): void {
    getTripCurrentTimeFn = deps.getTripCurrentTime;
    seekTripTimeFn = deps.seekTripTime;

    const bar = dom.miniProgress;
    if (!bar) return;
    // The track's whole row: the thumb, the zoom-window frame and its handles
    // sit over the track, so pointer gestures are read on the row itself.
    const row = dom.playerChartOverview;
    const tooltip = dom.miniProgressTooltip;
    // Re-parent the tooltip to <body> so .player-chart's overflow:hidden cannot
    // clip it when the timeline stack is compact (chart hidden). It is
    // position:fixed; showTooltipAt sets its viewport coords.
    if (tooltip) document.body.appendChild(tooltip);

    // Frame preview in the tooltip canvas. Idle-debounced 180ms so a fast
    // scrub does not spawn N synchronous decoders. Race-token guards against
    // out-of-order resolves (a slow extract finishing after a fast one).
    let thumbExtractToken = 0;
    let thumbExtractTimer: ReturnType<typeof setTimeout> | null = null;
    let lastThumbSec = -1;

    function cancelPendingThumb(): void {
        if (thumbExtractTimer) {
            clearTimeout(thumbExtractTimer);
            thumbExtractTimer = null;
        }
        // Invalidate any in-flight extract too: one that is past its debounce and
        // awaiting the worker would otherwise pass its token guard and draw onto
        // the canvas after hideTooltip. scheduleThumbExtract re-bumps the token
        // right after calling this, so a freshly scheduled extract stays valid.
        thumbExtractToken++;
    }

    function clearThumbCanvas(): void {
        const cv = dom.miniProgressThumbCanvas;
        if (cv) {
            const c = cv.getContext("2d");
            if (c) c.clearRect(0, 0, cv.width, cv.height);
        }
        if (tooltip) tooltip.classList.remove("has-thumb");
    }

    function scheduleThumbExtract(sec: number): void {
        cancelPendingThumb();
        const myToken = ++thumbExtractToken;
        thumbExtractTimer = setTimeout(() => {
            thumbExtractTimer = null;
            void extractAndDraw(sec, myToken);
        }, 180);
    }

    async function extractAndDraw(sec: number, token: number): Promise<void> {
        if (!state.active) return;
        const trip = state.trips[state.active.trip];
        if (!trip) return;
        // Frame containing sec + offset inside it (footage-axis resolver).
        const at = contentToFrame(trip.timeline, sec);
        const frame = trip.frames[at.index]!;
        const picked = pickFrameChannel(frame, mainChannel());
        if (!picked) return;
        const fileSec = frameMediaOffset(frame, picked.channel) + at.offsetInFrame;
        try {
            const bitmap = await extractFrameAt(picked.candidate.file, fileSec);
            if (!bitmap || token !== thumbExtractToken) {
                bitmap?.close?.();
                return;
            }
            const cv = dom.miniProgressThumbCanvas;
            if (!cv) {
                bitmap.close?.();
                return;
            }
            const ctx = cv.getContext("2d");
            if (!ctx) {
                bitmap.close?.();
                return;
            }
            ctx.clearRect(0, 0, cv.width, cv.height);
            // Cover-fit: keep aspect, fill canvas.
            const aspectCanvas = cv.width / cv.height;
            const aspectBitmap = bitmap.width / bitmap.height;
            let sx = 0;
            let sy = 0;
            let sw = bitmap.width;
            let sh = bitmap.height;
            if (aspectBitmap > aspectCanvas) {
                sw = bitmap.height * aspectCanvas;
                sx = (bitmap.width - sw) / 2;
            } else {
                sh = bitmap.width / aspectCanvas;
                sy = (bitmap.height - sh) / 2;
            }
            ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
            bitmap.close?.();
            tooltip?.classList.add("has-thumb");
            lastThumbSec = sec;
        } catch {
            /* decoder fail - leave placeholder background; non-critical */
        }
    }

    /** Tooltip position + label for the moment `sec` (by default the one under
     *  clientX on the whole-trip row). The horizontal position is clamped so it
     *  doesn't fly off the edge on a short bar. */
    function showTooltipAt(clientX: number, sec: number | null = overviewSecAtClientX(clientX)): void {
        if (!tooltip) return;
        if (sec === null) {
            tooltip.hidden = true;
            return;
        }
        if (dom.miniProgressTime) dom.miniProgressTime.textContent = formatTime(sec);
        tooltip.hidden = false;
        // Fixed-positioned in viewport coords (the tooltip lives on <body>).
        // Center on the cursor, clamp to the viewport, sit just above the row.
        const barRect = row.getBoundingClientRect();
        const ttHalf = tooltip.offsetWidth / 2;
        const clampedX = Math.max(ttHalf + 4, Math.min(window.innerWidth - ttHalf - 4, clientX));
        tooltip.style.left = `${clampedX}px`;
        tooltip.style.top = `${barRect.top - tooltip.offsetHeight - 8}px`;
        // Schedule thumb extract only on significant movement (>0.2s). Micro
        // cursor movements should not re-decode the same frame.
        if (Math.abs(sec - lastThumbSec) > 0.2) {
            scheduleThumbExtract(sec);
        }
    }

    function hideTooltip(): void {
        if (tooltip) tooltip.hidden = true;
        cancelPendingThumb();
        clearThumbCanvas();
        lastThumbSec = -1;
    }

    // Gestures on the row, by where the press lands:
    //  - on the thumb: drag to seek; a zoom window follows so the moment stays
    //    in view;
    //  - inside the zoom-window frame (zoomed only): drag to pan the window,
    //    release without moving to seek there;
    //  - anywhere else, including the whole row at full view: seek there and
    //    keep dragging to scrub; outside the frame the window jumps to it.
    // The frame's edge handles are chart.ts's (resize, tap = seek); they leave
    // a press on the thumb to this handler.
    type RowGesture = "scrub" | "pan";
    let gesture: RowGesture | null = null;
    let gestureStartX = 0;
    let gestureMoved = false;
    let panGrabOffsetSec = 0;
    // Drag moves seek to key frames, so a long-GOP 4K clip does not decode up
    // to every intermediate frame; the release seeks exactly to the last spot.
    let lastDragSec: number | null = null;

    /** Seeks to `sec` from the whole-trip row. A zoom window is panned first so
     *  the moment is in view - the pan also ends a clip preview's playback
     *  bounds, which would otherwise clamp the seek back into the old window. */
    function seekFromRow(sec: number, placement: "nearest" | "center", precision?: SeekPrecision): void {
        revealSecInTimelineWindow(sec, placement);
        seekTripTimeFn(sec, precision);
    }

    // The bar spans the full row width, so a scrub started at the screen edge
    // is also an iOS swipe-back candidate. Seek runs on pointerdown (below),
    // not on click, so cancelling the edge touchstart loses nothing.
    suppressEdgeSwipeNav(row);
    attachPointerDrag(row, {
        onStart: (e) => {
            if (!state.active) return false;
            const sec = overviewSecAtClientX(e.clientX);
            const zoom = getTimelineZoomWindow();
            if (sec === null || !zoom) return false;
            if (!beginTimelineWindowGesture(e.pointerId)) return false;
            gestureStartX = e.clientX;
            gestureMoved = false;
            lastDragSec = null;
            if (isOverOverviewThumb(e.clientX)) {
                // Grabbing the thumb does not jump it to the pointer.
                gesture = "scrub";
            } else if (!zoom.isFullView && sec >= zoom.startSec && sec <= zoom.endSec) {
                gesture = "pan";
                panGrabOffsetSec = sec - zoom.startSec;
                row.classList.add("is-panning");
                return true;
            } else {
                gesture = "scrub";
                seekFromRow(sec, "center");
            }
            row.classList.add("is-dragging");
            showTooltipAt(e.clientX);
            return true;
        },
        onMove: (e) => {
            if (!gestureMoved && Math.abs(e.clientX - gestureStartX) < DRAG_THRESHOLD_PX) return;
            gestureMoved = true;
            const sec = overviewSecAtClientX(e.clientX);
            if (sec === null) return;
            if (gesture === "pan") {
                panTimelineWindowTo(sec - panGrabOffsetSec);
                return;
            }
            showTooltipAt(e.clientX, sec);
            lastDragSec = sec;
            seekFromRow(sec, "nearest", "keyframe");
        },
        onEnd: (e, reason) => {
            const wasPan = gesture === "pan";
            gesture = null;
            row.classList.remove("is-dragging", "is-panning");
            if (wasPan) {
                // A click inside the frame is a seek, not a pan.
                const sec = overviewSecAtClientX(e.clientX);
                if (!gestureMoved && reason === "up" && sec !== null) seekTripTimeFn(sec);
            } else if (lastDragSec !== null) {
                seekTripTimeFn(lastDragSec);
            }
            lastDragSec = null;
            finishTimelineWindowGesture();
            // Mouse keeps its hover preview after a normal release.
            if (e.pointerType !== "mouse" || reason !== "up" || wasPan) hideTooltip();
        },
    });

    /** Pointer affordance for what a press would do at clientX. */
    function syncRowCursor(clientX: number): void {
        const sec = overviewSecAtClientX(clientX);
        const zoom = getTimelineZoomWindow();
        const overThumb = isOverOverviewThumb(clientX);
        const overFrame =
            !overThumb &&
            sec !== null &&
            zoom !== null &&
            !zoom.isFullView &&
            sec >= zoom.startSec &&
            sec <= zoom.endSec;
        row.classList.toggle("is-over-thumb", overThumb);
        row.classList.toggle("is-over-frame", overFrame);
    }

    row.addEventListener("pointermove", (e) => {
        if (gesture) return;
        syncRowCursor(e.clientX);
        // Hovering the frame previews where a click would seek; a pan hides it.
        showTooltipAt(e.clientX);
    });
    row.addEventListener("pointerenter", (e) => {
        // Touch events give pointerdown without enter, but on mouse enter the
        // tooltip should pre-appear.
        if (e.pointerType === "mouse") showTooltipAt(e.clientX);
    });
    row.addEventListener("pointerleave", () => {
        row.classList.remove("is-over-thumb", "is-over-frame");
        if (!gesture) hideTooltip();
    });

    // The playhead grip: drag the current moment across the ruler and chart at
    // the zoom window's precision. The whole-trip row cannot give that - its
    // thumb moves over the whole trip.
    const grip = dom.playerChartPlayheadGrip;
    let gripStartX = 0;
    let gripMoved = false;
    let gripLastSec: number | null = null;
    /** Trip-seconds under clientX on the zoom window, clamped into it. */
    function windowSecAtClientX(clientX: number): number | null {
        const rect = dom.playerChartEl.getBoundingClientRect();
        if (rect.width <= 0) return null;
        return timelineFracToSec((clientX - rect.left) / rect.width);
    }
    /** A click on the grip is a click on the chart under it. The playhead often
     *  rests on an event marker - a jump to an event lands there - and the grip
     *  must not hide it: replaying the click on the element beneath lets the
     *  marker open its popup and an event lane snap to its event, as anywhere
     *  else on the chart. */
    function clickChartUnderGrip(clientX: number, clientY: number): void {
        const under = document.elementsFromPoint(clientX, clientY).find((el) => el !== grip);
        if (under && dom.playerChartEl.contains(under)) {
            under.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX, clientY }),
            );
            return;
        }
        const sec = windowSecAtClientX(clientX);
        if (sec !== null) seekTripTimeFn(sec);
    }
    suppressEdgeSwipeNav(grip);
    attachPointerDrag(grip, {
        onStart: (e) => {
            if (!state.active) return false;
            e.preventDefault();
            gripStartX = e.clientX;
            gripMoved = false;
            gripLastSec = null;
            grip.classList.add("is-dragging");
            // The chart's hover tooltip would trail the drag next to the frame
            // preview; close it for the duration.
            dom.chartCanvas.dispatchEvent(new MouseEvent("mouseleave"));
            return true;
        },
        onMove: (e) => {
            if (!gripMoved && Math.abs(e.clientX - gripStartX) < DRAG_THRESHOLD_PX) return;
            gripMoved = true;
            const sec = windowSecAtClientX(e.clientX);
            const view = getTimelineView();
            if (sec === null || !view) return;
            gripLastSec = sec;
            grip.style.left = `${timelineSecToFracInView(sec, view) * 100}%`;
            showTooltipAt(e.clientX, sec);
            seekTripTimeFn(sec, "keyframe");
        },
        onEnd: (e, reason) => {
            grip.classList.remove("is-dragging");
            hideTooltip();
            if (gripMoved && gripLastSec !== null) {
                seekTripTimeFn(gripLastSec);
            } else if (reason === "up") {
                clickChartUnderGrip(e.clientX, e.clientY);
            }
            gripLastSec = null;
            updatePlayerProgressUi();
        },
    });
    // The gesture above already seeked or replayed the click on the chart; the
    // native click must not reach the chart a second time (on the MSE pipeline
    // every seek restarts the feed).
    grip.addEventListener("click", (e) => e.stopPropagation());

    // Keyboard accessibility. Arrows seek by the user's configured step (Shift =
    // long step), PageUp/PageDown = long step, Home/End jump to trip ends - the
    // same step model as the global hotkeys, so focus state no longer silently
    // changes the seek granularity (was a fixed 5% before).
    //
    // stopPropagation is the real fix for the toolbar-vs-slider conflict: the
    // global document keydown ALSO seeks on Arrow (the scrubber is a div, not an
    // editable target, so it isn't skipped there), which double-seeked when the
    // scrubber had focus. Owning the keypress here prevents the second seek.
    bar.addEventListener("keydown", (e) => {
        if (!state.active) return;
        const trip = state.trips[state.active.trip];
        if (!trip || trip.timeline.contentDurationSec <= 0) return;
        const cur = getTripCurrentTimeFn();
        const step = e.shiftKey ? getSeekStepShiftSec() : getSeekStepSec();
        if (e.key === "ArrowLeft") {
            seekTripTimeFn(cur - step);
        } else if (e.key === "ArrowRight") {
            seekTripTimeFn(cur + step);
        } else if (e.key === "PageDown") {
            seekTripTimeFn(cur - getSeekStepShiftSec());
        } else if (e.key === "PageUp") {
            seekTripTimeFn(cur + getSeekStepShiftSec());
        } else if (e.key === "Home") {
            seekTripTimeFn(0);
        } else if (e.key === "End") {
            seekTripTimeFn(trip.timeline.contentDurationSec);
        } else {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
    });
}
