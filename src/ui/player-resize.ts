// Resizable proportions inside the player. One drag handle remains:
//   - .player-col-resize (vertical) between video and map - controls --map-width,
//     the video-vs-map width ratio (expanded mode only).
//
// The event strip, chart, ruler and overview have fixed proportions. A
// resizable handle would let users squish the chart canvas under the strip,
// breaking legibility. We freeze the panel at a sensible default in CSS
// instead (see --chart-height in viewer.css).

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { dom } from "./dom.js";
import { isMobileLayout } from "./media-queries.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { state } from "./state.js";

const MAP_PCT_KEY = "everydashcam:map-pct";
// Map width as a percentage of player width. fr units with calc on CSS variables
// break in Chrome (track sizing does not work), so percentage is used.
const MAP_PCT_MIN = 15;
const MAP_PCT_MAX = 70;
// Keyboard step on the divider (Arrow = fine, Shift+Arrow = coarse), mirroring
// the sidebar-resize handle so the two splitters behave the same.
const MAP_PCT_STEP = 2;
const MAP_PCT_STEP_SHIFT = 5;

// The divider lives only in the expanded desktop layout; in the stacked
// layouts the map is a full-screen toggle and --map-width is unused, so
// keyboard resize is a no-op there (shared predicate: media-queries.ts).

/** Reads the live --map-width as a number. When the variable is unset the CSS
 *  default is clamp(280px, 34%, 480px) (viewer.css), which can render far from
 *  any hardcoded percent on wide screens - so measure the actual pane instead,
 *  else the first keyboard nudge would jump the map to the guessed midpoint.
 *  The clamp midpoint (34) remains the last resort while the pane has no
 *  layout (map not expanded). */
function currentMapPct(): number {
    const raw = getComputedStyle(dom.playerWrap).getPropertyValue("--map-width").trim();
    const cur = parseFloat(raw);
    if (Number.isFinite(cur)) return cur;
    const wrapWidth = dom.playerWrap.getBoundingClientRect().width;
    const mapWidth = dom.mapWrap.getBoundingClientRect().width;
    if (wrapWidth > 0 && mapWidth > 0) return (mapWidth / wrapWidth) * 100;
    return 34;
}

function setMapPct(pct: number): number {
    const clamped = Math.max(MAP_PCT_MIN, Math.min(MAP_PCT_MAX, pct));
    // --map-width is the variable the map-expanded grid templates consume
    // (viewer.css); a percentage there resolves against the player-wrap width.
    dom.playerWrap.style.setProperty("--map-width", `${clamped}%`);
    // Keep the separator's announced value in sync with the visual ratio so a
    // screen reader reads the real position, not a stale one.
    dom.videoMapResize.setAttribute("aria-valuenow", String(Math.round(clamped)));
    return clamped;
}

function restoreResizeState(): void {
    const raw = readLocalStorage(MAP_PCT_KEY);
    const savedMapPct = parseFloat(raw || "");
    if (Number.isFinite(savedMapPct) && savedMapPct >= MAP_PCT_MIN && savedMapPct <= MAP_PCT_MAX) {
        dom.playerWrap.style.setProperty("--map-width", `${savedMapPct}%`);
    }
}

export function initPlayerResize(): void {
    restoreResizeState();

    // The handle advertises role=separator + tabindex=0 in the HTML, so it must
    // be operable from the keyboard - otherwise it is a focus stop that traps the
    // user with no action. Seed the slider-range semantics once.
    dom.videoMapResize.setAttribute("aria-valuemin", String(MAP_PCT_MIN));
    dom.videoMapResize.setAttribute("aria-valuemax", String(MAP_PCT_MAX));
    dom.videoMapResize.setAttribute("aria-valuenow", String(Math.round(currentMapPct())));
    // At init the map pane usually has no layout yet, so the seed above is the
    // static fallback; refresh from the real geometry when the separator is
    // actually reached, so the announced value matches what is on screen.
    dom.videoMapResize.addEventListener("focus", () => {
        dom.videoMapResize.setAttribute("aria-valuenow", String(Math.round(currentMapPct())));
    });

    /** Currently dragged handle (only "map" remains; "chart" was removed). */
    let resizeDragging: "map" | null = null;

    // rAF throttle: set a pending flag on each mousemove; the actual
    // MapLibre/Chart resize happens once per frame. Without this MapLibre
    // canvas keeps the pixel dimensions of the old container, producing
    // stretched bitmap artifacts.
    // Resize every live surface (chart strip + map + mini-map) once. Guarded so
    // it is safe before any of them exist; order is irrelevant (no cross-dep).
    function resizeSurfaces(): void {
        if (state.chart) state.chart.resize();
        if (state.map) state.map.resize();
        if (state.miniMap && !dom.miniMap.hidden) state.miniMap.resize();
    }
    let liveResizePending = false;
    function scheduleLiveResize(): void {
        if (liveResizePending) return;
        liveResizePending = true;
        requestAnimationFrame(() => {
            liveResizePending = false;
            resizeSurfaces();
        });
    }

    // Pointer events (not mouse) for touch parity - every other drag in the
    // player works by touch, and the divider is reachable on wide touch
    // layouts (iPad landscape). The shared helper adds pointer capture, so
    // the document-level move/up listeners are gone too.
    attachPointerDrag(dom.videoMapResize, {
        onStart: (e) => {
            e.preventDefault();
            resizeDragging = "map";
            dom.videoMapResize.classList.add("dragging");
            document.body.classList.add("col-resizing");
            return true;
        },
        onMove: (e) => {
            if (!resizeDragging) return;
            // Map-pct = map width as a percentage of player-wrap total width.
            // The cursor is between video and map, so everything to the right
            // of the cursor is the map. Compute percentage from the right edge.
            const wrapRect = dom.playerWrap.getBoundingClientRect();
            const x = e.clientX - wrapRect.left;
            const mapW = wrapRect.width - x;
            setMapPct((mapW / wrapRect.width) * 100);
            scheduleLiveResize();
        },
        onEnd: () => {
            if (!resizeDragging) return;
            // Store as a number (without "%") - restore adds "%" back.
            const raw = getComputedStyle(dom.playerWrap).getPropertyValue("--map-width").trim();
            const cur = parseFloat(raw);
            if (Number.isFinite(cur)) {
                writeLocalStorage(MAP_PCT_KEY, String(cur));
            }
            resizeDragging = null;
            dom.videoMapResize.classList.remove("dragging");
            document.body.classList.remove("col-resizing");
            requestAnimationFrame(resizeSurfaces);
        },
    });

    // Arrow keys when the handle is focused nudge the ratio (Shift = coarse),
    // Home/End jump to the extremes. Persist on each keydown - keyboard gives no
    // pointer onEnd, and the pointer onEnd is gated on resizeDragging which the
    // keyboard path never sets (same shape as sidebar-resize.ts).
    dom.videoMapResize.addEventListener("keydown", (e) => {
        if (isMobileLayout()) return;
        const isLeft = e.key === "ArrowLeft";
        const isRight = e.key === "ArrowRight";
        const isHome = e.key === "Home";
        const isEnd = e.key === "End";
        if (!isLeft && !isRight && !isHome && !isEnd) return;
        e.preventDefault();
        // Own the keypress: the global document keydown (player-hotkeys) also seeks
        // on Arrow, and a focused separator is neither editable nor a native-
        // activation target, so without this an arrow both resizes AND seeks.
        e.stopPropagation();
        let next: number;
        if (isHome)
            next = MAP_PCT_MAX; // Home = widest map (separator far left)
        else if (isEnd) next = MAP_PCT_MIN;
        else {
            const step = e.shiftKey ? MAP_PCT_STEP_SHIFT : MAP_PCT_STEP;
            // ArrowRight shrinks the map (separator moves right), ArrowLeft grows it.
            next = currentMapPct() + (isRight ? -step : step);
        }
        const applied = setMapPct(next);
        writeLocalStorage(MAP_PCT_KEY, String(applied));
        scheduleLiveResize();
    });

    // Also trigger on window resize - the chart strip has a fixed height but the
    // map changes with the viewport. ResizeObserver would be more precise, but
    // window.resize is sufficient for minimal support.
    window.addEventListener("resize", () => {
        requestAnimationFrame(resizeSurfaces);
    });
}
