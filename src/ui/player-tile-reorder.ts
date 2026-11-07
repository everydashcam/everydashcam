// Direct camera reorder on the video grid: drag a tile by its grip handle and
// drop it onto another tile. Onto or off the main camera the two trade places
// (the same swap a click makes); between smaller cameras, and in the equal
// grid, the camera is inserted at the target and the rest slide over, like
// reordering a list. Pointer Events (not HTML5 DnD) so the same gesture works
// on mouse, pen and touch. The handle shows only where the pointer can hover
// (viewer.css); touch-only screens reorder in the View menu's camera list.
//
// Why a grip handle (not whole-tile drag): the tile body already owns two
// gestures - tap = make main / play-pause (player-tile-input.ts), pan = move
// the zoomed video (player-zoom.ts). A dedicated hit target keeps all three
// unambiguous without movement-threshold heuristics.
//
// Feedback while dragging: a ghost label tracks the pointer (so the drag is not
// blind), the source tile dims, and the drop target shows a dashed "drops here"
// placeholder carrying the dragged camera's name.

import type { Channel } from "../parsers/types.js";
import { dom } from "./dom.js";
import { channelDisplayLabel } from "./format.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { makeMainCamera, moveCamera } from "./camera-arrangement.js";
import { activeTrip, state, visibleChannels } from "./state.js";

interface DragState {
    sourceCh: Channel;
    sourceTile: HTMLElement;
    /** Tile currently marked as the drop target, if any. */
    dropTile: HTMLElement | null;
    /** Set once the pointer actually moves - distinguishes a drag from a tap. */
    moved: boolean;
}

let drag: DragState | null = null;
// Set true after a real drag ends so the synthetic click the browser fires on
// pointerup does not reach the grid's audio-swap delegate. Cleared by the next
// click (capture phase) or the next pointerdown.
let swallowNextClick = false;

// Reused DOM affordances, created once on first drag and kept detached between
// drags. ghost = floating pill following the pointer; placeholder = dashed
// overlay inserted into the current drop-target tile.
let ghostEl: HTMLElement | null = null;
let placeholderEl: HTMLElement | null = null;

/** Wire the grid reorder. Call once from initPlayer after dom refs resolve. */
export function initTileReorder(): void {
    attachPointerDrag(dom.videoGrid, {
        onStart: onPointerDown,
        onMove: onPointerMove,
        onEnd: (_event, reason) => {
            if (reason === "up") onPointerUp();
            else cleanup();
        },
    });

    // Capture-phase so it runs before the bubble-phase tile click delegate on
    // the same grid element. Swallows: (a) the click after a real drag, and
    // (b) a plain tap on the handle - neither is a tile click.
    dom.videoGrid.addEventListener(
        "click",
        (ev) => {
            if (swallowNextClick) {
                swallowNextClick = false;
                ev.stopPropagation();
                ev.preventDefault();
                return;
            }
            const t = ev.target;
            if (t instanceof Element && t.closest(".tile-drag-handle")) {
                ev.stopPropagation();
                ev.preventDefault();
            }
        },
        true,
    );
}

function onPointerDown(ev: PointerEvent): boolean {
    // Element, not HTMLElement: the grip icon is an inline <svg>, and
    // SVGSVGElement does not extend HTMLElement - an instanceof HTMLElement
    // check would miss a click landing directly on the icon.
    const target = ev.target;
    if (!(target instanceof Element)) return false;
    const handle = target.closest(".tile-drag-handle") as HTMLElement | null;
    if (!handle) return false;
    swallowNextClick = false;
    if (visibleChannels().length <= 1) return false;
    const sourceTile = handle.closest(".video-tile") as HTMLElement | null;
    if (!sourceTile) return false;
    const sourceCh = sourceTile.dataset.channel as Channel | undefined;
    if (!sourceCh) return false;

    // Keep the gesture ours: no tile click, no zoom pan, no text selection.
    ev.preventDefault();
    ev.stopPropagation();
    drag = { sourceCh, sourceTile, dropTile: null, moved: false };
    dom.videoGrid.classList.add("reordering");
    sourceTile.classList.add("reorder-source");
    return true;
}

function onPointerMove(ev: PointerEvent): void {
    if (!drag) return;
    if (!drag.moved) {
        drag.moved = true;
        showGhost(drag.sourceCh);
    }
    moveGhost(ev.clientX, ev.clientY);

    const tile = tileUnderPoint(ev.clientX, ev.clientY);
    if (tile === drag.dropTile) return;
    clearDropTarget();
    // The drop target is any different, channel-bearing tile. Dropping the
    // source onto its own tile is a no-op (no placeholder, no reorder).
    if (tile && tile !== drag.sourceTile && tile.dataset.channel) {
        drag.dropTile = tile;
        tile.classList.add("reorder-drop-target");
        showPlaceholder(tile, drag.sourceCh);
    }
}

function onPointerUp(): void {
    if (!drag) return;
    const { sourceCh, dropTile } = drag;
    const targetCh = dropTile?.dataset.channel as Channel | undefined;
    cleanup();
    // Capture is on the grid; even a tap on the grip must not reach the tiles.
    swallowNextClick = true;
    if (!targetCh || targetCh === sourceCh) return;
    dropChannel(sourceCh, targetCh);
}

function cleanup(): void {
    if (!drag) return;
    drag.sourceTile.classList.remove("reorder-source");
    clearDropTarget();
    removeGhost();
    dom.videoGrid.classList.remove("reordering");
    drag = null;
}

function clearDropTarget(): void {
    if (!drag?.dropTile) return;
    drag.dropTile.classList.remove("reorder-drop-target");
    placeholderEl?.remove();
    drag.dropTile = null;
}

/** Visible video-tile under the viewport point, or null. Geometric hit-test by
 *  bounding rect (not elementFromPoint) so overlays painted above the grid - the
 *  route mini-map, zoom mini-map, loading spinner, the drag ghost itself - never
 *  steal the drop target. When tiles overlap (overlay windows sit on top of the
 *  main camera) the smallest containing tile wins, i.e. the window, which is
 *  the visually topmost. */
function tileUnderPoint(clientX: number, clientY: number): HTMLElement | null {
    let best: HTMLElement | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const tile of dom.videoGrid.querySelectorAll<HTMLElement>(".video-tile")) {
        if (tile.hidden || !tile.dataset.channel) continue;
        const r = tile.getBoundingClientRect();
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
        const area = r.width * r.height;
        if (area < bestArea) {
            bestArea = area;
            best = tile;
        }
    }
    return best;
}

/** Drops `ch` onto `targetCh`: a swap when either is the main camera, an
 *  insert otherwise (see the file header). */
function dropChannel(ch: Channel, targetCh: Channel): void {
    const main = visibleChannels()[0];
    if (state.composition.mode === "main" && (ch === main || targetCh === main)) {
        makeMainCamera(ch === main ? targetCh : ch);
        return;
    }
    moveCamera(ch, targetCh);
}

/* ------------------------------ ghost + placeholder ------------------------------ */

/** Trip-aware channel label, matching the tile overlay / top-panel naming. */
function labelFor(ch: Channel): string {
    const trip = activeTrip();
    return trip ? channelDisplayLabel(ch, trip) : ch;
}

function showGhost(ch: Channel): void {
    if (!ghostEl) {
        ghostEl = document.createElement("div");
        ghostEl.className = "tile-drag-ghost";
    }
    ghostEl.textContent = labelFor(ch);
    document.body.appendChild(ghostEl);
}

function moveGhost(clientX: number, clientY: number): void {
    if (!ghostEl) return;
    // Offset from the pointer so the finger/cursor does not cover the label.
    ghostEl.style.left = `${clientX + 12}px`;
    ghostEl.style.top = `${clientY + 12}px`;
}

function removeGhost(): void {
    ghostEl?.remove();
}

function showPlaceholder(tile: HTMLElement, ch: Channel): void {
    if (!placeholderEl) {
        placeholderEl = document.createElement("div");
        placeholderEl.className = "tile-drop-placeholder";
    }
    placeholderEl.textContent = labelFor(ch);
    // Lives inside the target tile (position:relative) so it tracks the tile's
    // box across layouts without manual geometry.
    tile.appendChild(placeholderEl);
}
