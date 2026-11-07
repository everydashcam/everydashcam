// Video-tile clicks. With one camera, or on the main camera, a click plays or
// pauses. On a smaller camera (or any camera in "equal" mode) it makes that
// camera the main one. Clicks share one delay so a fullscreen double-click
// toggles neither playback nor the arrangement. Export-mode double-clicks
// belong to the crop editor.

import type { Channel } from "../parsers/types.js";
import { makeMainCamera } from "./camera-arrangement.js";
import { dom, forEachVideoSlot, isActiveSlot, onActivePlayerEvent } from "./dom.js";
import { pausePlayback } from "./playback-pause.js";
import { activeTrip, state, visibleChannels } from "./state.js";

interface TileInputDeps {
    toggleFullscreen: () => void;
    /** Drag-click suppression: returns true if a pan drag just ended (the
     *  pointerup-after-drag should not toggle play/pause). Single read clears
     *  the flag. */
    consumeDragClickSuppress: () => boolean;
    /** Flashes a center play/pause glyph on the active tile after a toggle. */
    flashPlaybackToggle: () => void;
}

// The browser fires click TWICE before dblclick - a double-click would toggle
// fullscreen and also toggle play/pause. Fix: debounce single click via a
// ~250ms timer; if dblclick arrives in that window, cancel the pending click.
// Standard YouTube/VLC pattern.
let pendingSingleClick: ReturnType<typeof setTimeout> | null = null;
const DBLCLICK_THRESHOLD_MS = 250;

// Controls painted inside a tile own their clicks.
const TILE_CONTROLS = "button, a, input, select, .crop-editor, .blur-draw-layer, .camera-settings-menu";

function cancelSingleClick(): void {
    if (pendingSingleClick !== null) clearTimeout(pendingSingleClick);
    pendingSingleClick = null;
}

function scheduleSingleClick(action: () => void): void {
    cancelSingleClick();
    const trip = activeTrip();
    pendingSingleClick = setTimeout(() => {
        pendingSingleClick = null;
        if (state.active && activeTrip() === trip) action();
    }, DBLCLICK_THRESHOLD_MS);
}

/** Whether a click on `tile` hands it the main place rather than toggling
 *  playback: a smaller camera, or any camera of the equal grid. A tile
 *  without a picture (no recording now, or unplayable) stays where it is -
 *  swapping it in would leave the main place without a picture. */
function clickMakesMain(tile: HTMLElement): boolean {
    if (visibleChannels().length <= 1) return false;
    const role = tile.dataset.role;
    if (role !== "thumb" && role !== "equal") return false;
    return !tile.classList.contains("tile-absent") && !tile.classList.contains("tile-unplayable");
}

export function initPlayerTileInput(deps: TileInputDeps): void {
    dom.videoGrid.addEventListener("click", (ev) => {
        if (!state.active) return;
        const target = ev.target;
        if (!(target instanceof Element)) return;
        // A pan-drag on a zoomed tile ends with a synthetic click; consume the
        // flag first so a pan is never read as a play/pause or a camera swap.
        if (deps.consumeDragClickSuppress()) return;
        if (target.closest(TILE_CONTROLS)) return;
        if (target instanceof HTMLVideoElement && !isActiveSlot(target)) return;
        const tile = target.closest<HTMLElement>(".video-tile");
        if (!tile || tile.hidden) return;
        const ch = tile.dataset.channel as Channel | undefined;
        if (!ch) return;
        if (clickMakesMain(tile)) {
            scheduleSingleClick(() => {
                if (!tile.hidden && visibleChannels().includes(ch)) makeMainCamera(ch);
            });
            return;
        }
        scheduleSingleClick(() => {
            if (dom.player.paused) dom.player.play().catch(() => {});
            else pausePlayback();
            deps.flashPlaybackToggle();
        });
    });

    // Installed on BOTH slots per channel (see forEachVideoSlot): after a
    // preload swap the ex-preload element is the visible one.
    forEachVideoSlot((v) => {
        v.addEventListener("dblclick", (event) => {
            if (!state.active || !isActiveSlot(v) || v.closest<HTMLElement>(".video-tile")?.hidden) return;
            cancelSingleClick();
            // In export-mode dblclick enters per-camera crop edit (handled by
            // the delegated listener in player-crop.ts), not fullscreen.
            if (state.exportModeOpen) return;
            event.preventDefault();
            deps.toggleFullscreen();
        });
    });

    // Suppress native video context menu (Chrome's "Show controls" item
    // force-enables native controls regardless of the attribute).
    onActivePlayerEvent("contextmenu", (e) => e.preventDefault());
}
