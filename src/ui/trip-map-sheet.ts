// The phone sheet over the map of all trips. Without a place it carries only
// a hint and keeps its content height. With a place it holds the list of trips
// through it and rests at one of three heights: collapsed to the grip and the
// place bar, half the map, or nearly all of it. The grip and the place bar
// drag it; a tap there steps to the next height.
//
// The heights live here in pixels rather than in CSS: the drag clamps to them
// and picks the nearest one on release, and one formula keeps the two in step.

import { dom } from "./dom.js";
import { prefersReducedMotion } from "./media-queries.js";
import { attachPointerDrag } from "./pointer-drag.js";

export type TripMapSheetSnap = "collapsed" | "half" | "expanded";

export type TripMapSheetHeights = Record<TripMapSheetSnap, number>;

const SNAP_ORDER: readonly TripMapSheetSnap[] = ["collapsed", "half", "expanded"];
// A chosen place opens the sheet to this share of the map.
const HALF_SHARE = 0.52;
// Raised all the way, the sheet leaves this much of the map above it: the
// counter chip and the chosen place, which keepPlaceAboveSheet moves there.
const EXPANDED_MAP_STRIP_PX = 120;
// A release at least this fast carries the sheet on to the next height in
// that direction instead of the nearest one.
const FLICK_PX_PER_MS = 0.4;
// The release speed comes from the pointer's moves within this window.
const VELOCITY_WINDOW_MS = 100;
// A press that moves less than this is a tap, so the place bar's own button
// and a slightly shaky finger do not start a drag.
const TAP_SLOP_PX = 6;
// The drag starts only on these parts; the list keeps its own scrolling.
const GRAB_SELECTOR = ".trip-map-sheet__grip, .trip-map-sheet__head";
// Controls inside the grab zone keep their taps: capturing the pointer for
// them would send the click to the sheet instead.
const CONTROL_SELECTOR = "button, a, input, select, textarea";

/**
 * The resting heights for a map panel of `panelHeight` pixels. `chromeHeight`
 * is the sheet without its list: border, grip, place bar and the bottom inset.
 * The heights never decrease from collapsed to expanded, and none exceeds the
 * panel, so a low landscape panel may give two of them the same value.
 */
export function tripMapSheetHeights(panelHeight: number, chromeHeight: number): TripMapSheetHeights {
    const collapsed = Math.round(Math.min(chromeHeight, panelHeight));
    const half = Math.max(collapsed, Math.round(panelHeight * HALF_SHARE));
    const expanded = Math.max(half, Math.round(panelHeight - EXPANDED_MAP_STRIP_PX));
    return { collapsed, half, expanded };
}

/**
 * Where the sheet goes when released at `height`. `velocityPxPerMs` is
 * positive while the sheet rises. A flick moves on to the first height beyond
 * the release in its direction, or stays at the last one; a slow release
 * picks the nearest height, the lower one on a tie.
 */
export function releasedTripMapSheetSnap(
    heights: TripMapSheetHeights,
    height: number,
    velocityPxPerMs: number,
): TripMapSheetSnap {
    if (Math.abs(velocityPxPerMs) >= FLICK_PX_PER_MS) {
        const isRising = velocityPxPerMs > 0;
        const ordered = isRising ? SNAP_ORDER : [...SNAP_ORDER].reverse();
        const beyond = ordered.find((snap) => (isRising ? heights[snap] > height : heights[snap] < height));
        return beyond ?? ordered[ordered.length - 1]!;
    }
    let nearest: TripMapSheetSnap = "collapsed";
    for (const snap of SNAP_ORDER) {
        if (Math.abs(heights[snap] - height) < Math.abs(heights[nearest] - height)) nearest = snap;
    }
    return nearest;
}

/** A tap on the grip or the place bar steps up through the heights and wraps from the top to collapsed. */
export function tappedTripMapSheetSnap(current: TripMapSheetSnap): TripMapSheetSnap {
    return SNAP_ORDER[(SNAP_ORDER.indexOf(current) + 1) % SNAP_ORDER.length]!;
}

export interface PointerSample {
    timeMs: number;
    clientY: number;
}

/**
 * Release speed from the pointer's recent moves, in pixels per millisecond,
 * positive while the pointer goes up (the sheet rises). Zero without two
 * samples apart in time within the window before the last one.
 */
export function releaseVelocity(samples: readonly PointerSample[]): number {
    const last = samples[samples.length - 1];
    const first = samples.find((sample) => last !== undefined && last.timeMs - sample.timeMs <= VELOCITY_WINDOW_MS);
    if (!first || !last || last.timeMs <= first.timeMs) return 0;
    return (first.clientY - last.clientY) / (last.timeMs - first.timeMs);
}

interface SheetGesture {
    startClientY: number;
    startHeight: number;
    heights: TripMapSheetHeights;
    samples: PointerSample[];
    isDragging: boolean;
}

let snap: TripMapSheetSnap = "half";
let hasPlace = false;
let gesture: SheetGesture | null = null;
let settling: Animation | null = null;
let onSettle: () => void = () => {};

/** True while a finger moves the sheet or it glides to its height: its size is not final yet. */
export function isTripMapSheetMoving(): boolean {
    return gesture?.isDragging === true || settling !== null;
}

/**
 * Shows the sheet for a place or for the hint. A newly chosen place opens it
 * at half the map; a place that moves or changes its radius keeps the height
 * the user left it at.
 */
export function syncTripMapSheet(nextHasPlace: boolean): void {
    if (nextHasPlace !== hasPlace) {
        // A place chosen or cleared mid-drag ends the drag: the sheet changes
        // its content under the finger.
        stopMotion();
        gesture = null;
        dom.tripMapSheet.classList.remove("is-dragging");
        if (nextHasPlace) snap = "half";
    }
    hasPlace = nextHasPlace;
    applySnap();
}

/**
 * Wires the drag once at startup. `settled` runs when a drag or its glide has
 * brought the sheet to rest; size changes while it moves are not final.
 */
export function initTripMapSheet(settled: () => void): void {
    onSettle = settled;
    const sheet = dom.tripMapSheet;
    attachPointerDrag(sheet, {
        onStart: (event) => {
            if (!isGrabTarget(event.target)) return false;
            const startHeight = sheet.getBoundingClientRect().height;
            stopMotion();
            sheet.style.height = `${startHeight}px`;
            gesture = {
                startClientY: event.clientY,
                startHeight,
                heights: measureHeights(),
                samples: [{ timeMs: event.timeStamp, clientY: event.clientY }],
                isDragging: false,
            };
            return true;
        },
        onMove: (event) => {
            if (!gesture) return;
            const rise = gesture.startClientY - event.clientY;
            if (!gesture.isDragging) {
                if (Math.abs(rise) < TAP_SLOP_PX) return;
                gesture.isDragging = true;
                sheet.classList.add("is-dragging");
            }
            const { collapsed, expanded } = gesture.heights;
            sheet.style.height = `${Math.min(expanded, Math.max(collapsed, gesture.startHeight + rise))}px`;
            gesture.samples.push({ timeMs: event.timeStamp, clientY: event.clientY });
            const recent = event.timeStamp - VELOCITY_WINDOW_MS;
            while (gesture.samples.length > 2 && gesture.samples[0]!.timeMs < recent) gesture.samples.shift();
        },
        onEnd: (_event, reason) => {
            const finished = gesture;
            gesture = null;
            sheet.classList.remove("is-dragging");
            if (!finished) return;
            if (!finished.isDragging) {
                if (reason === "up") glideTo(tappedTripMapSheetSnap(snap));
                else applySnap();
                return;
            }
            // A cancelled pointer (a system gesture took over) carries no
            // intent: settle at the nearest height, never fling.
            const velocity = reason === "up" ? releaseVelocity(finished.samples) : 0;
            glideTo(releasedTripMapSheetSnap(finished.heights, sheet.getBoundingClientRect().height, velocity));
        },
    });
    // A touch on the grab zone belongs to the sheet, yet the browser still
    // follows it with a compatibility click. WebKit moves that click to the
    // nearest clickable node, and the map right above a collapsed sheet takes
    // it as a click away from the routes, clearing the place. Cancelling the
    // touchend drops the click; the place bar's own button keeps its tap.
    sheet.addEventListener(
        "touchend",
        (event) => {
            if (isGrabTarget(event.target)) event.preventDefault();
        },
        { passive: false },
    );
    // The heights follow the panel (rotation, the browser's toolbars) and the
    // place bar (a longer radius label may wrap).
    const observer = new ResizeObserver(() => applySnap());
    observer.observe(dom.tripMapPanel);
    observer.observe(dom.tripMapSheetHead);
    // A keyboard reaching the list of a collapsed sheet would focus trips it
    // cannot see. Only visible focus counts: a tap or the list's own focus
    // restore after a rebuild must not reopen a sheet the user lowered.
    dom.tripMapSheetList.addEventListener("focusin", (event) => {
        if (!hasPlace || snap !== "collapsed") return;
        if (event.target instanceof Element && event.target.matches(":focus-visible")) glideTo("half");
    });
}

/** True for the grip and the place bar of a sheet with a place, outside the bar's controls. */
function isGrabTarget(target: EventTarget | null): boolean {
    if (!hasPlace || !(target instanceof Element)) return false;
    return target.closest(GRAB_SELECTOR) !== null && target.closest(CONTROL_SELECTOR) === null;
}

/** The sheet without its list, measured in any state: the list is its only flexible part. */
function chromeHeight(): number {
    const sheet = dom.tripMapSheet;
    const paddingBottom = Number.parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
    return sheet.clientTop + dom.tripMapSheetList.offsetTop + paddingBottom;
}

function measureHeights(): TripMapSheetHeights {
    return tripMapSheetHeights(dom.tripMapPanel.clientHeight, chromeHeight());
}

/** Sets the height for the current state at once; a drag or a glide owns it while it runs. */
function applySnap(): void {
    const sheet = dom.tripMapSheet;
    if (gesture || settling) return;
    if (!hasPlace) {
        delete sheet.dataset.snap;
        sheet.style.height = "";
        return;
    }
    sheet.dataset.snap = snap;
    // The map tab is hidden: its panel has no height to share. The panel's
    // observer applies the height when the tab shows again.
    if (dom.tripMapPanel.clientHeight === 0) return;
    sheet.style.height = `${measureHeights()[snap]}px`;
}

/** Moves the sheet from where it is now to `next`, animated unless motion is reduced. */
function glideTo(next: TripMapSheetSnap): void {
    const sheet = dom.tripMapSheet;
    const from = sheet.getBoundingClientRect().height;
    stopMotion();
    snap = next;
    applySnap();
    const to = sheet.getBoundingClientRect().height;
    if (prefersReducedMotion() || Math.abs(to - from) < 1 || typeof sheet.animate !== "function") {
        onSettle();
        return;
    }
    // The glide is a sheet entrance: the motion tokens of tokens.css.
    const tokens = getComputedStyle(sheet);
    const glide = sheet.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: Number.parseFloat(tokens.getPropertyValue("--dc-dur-entrance")) || 0,
        easing: tokens.getPropertyValue("--dc-ease-out").trim() || "ease-out",
    });
    settling = glide;
    glide.finished.then(
        () => {
            if (settling !== glide) return;
            settling = null;
            onSettle();
        },
        // Cancelled by a new drag or a cleared place; that path settles itself.
        () => {},
    );
}

/** Ends a glide where it is; the caller sets the next height. */
function stopMotion(): void {
    const glide = settling;
    settling = null;
    glide?.cancel();
}
