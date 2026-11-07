// Video-tile gestures share one click delay so a fullscreen double-click
// preserves playback and audio routing. Export-mode double-clicks belong to
// the crop editor.

import type { Channel } from "../parsers/types.js";
import { activePlayer, dom, forEachVideoSlot, isActiveSlot, onActivePlayerEvent } from "./dom.js";
import { pausePlayback } from "./playback-pause.js";
import { activeTrip, setLayoutAndChannels, state } from "./state.js";

interface TileInputDeps {
    toggleFullscreen: () => void;
    toggleViewMode: () => void;
    /** Re-applies composition (audio routing, view-mode button). Called after
     *  the click handler updates state.composition.audioChannel so the change
     *  reaches the DOM video grid in one tick. */
    applyComposition: () => void;
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

export function initPlayerTileInput(deps: TileInputDeps): void {
    // Click delegation on the grid. UX:
    //   - multi-channel: click on any tile swaps audio source to that
    //     channel's audio (visual layout doesn't change).
    //   - single-channel: bypass - the per-video listener below handles
    //     play/pause via active-tile click.
    //
    // The legacy "click on non-active = visual master swap" is removed: now
    // the channel-order chip in the top-panel controls slot ordering, and
    // tile click is dedicated to audio routing.
    dom.videoGrid.addEventListener("click", (ev) => {
        if (!state.active) return;
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;
        // Reorder grip owns its own clicks (player-tile-reorder.ts swallows
        // them in the capture phase); never read a handle click as an audio
        // swap. Guarded here too in case listener order ever shifts.
        if (target.closest(".tile-drag-handle")) return;
        if (target instanceof HTMLVideoElement && !isActiveSlot(target)) return;
        const tile = target.closest(".video-tile") as HTMLElement | null;
        if (!tile || tile.hidden) return;
        const ch = tile.dataset.channel as Channel | undefined;
        if (!ch) return;
        if (state.composition.channelOrder.length <= 1) return;
        // A pan-drag on the active tile ends with a synthetic click that
        // bubbles here (the per-video listener bails early in multi-channel
        // without consuming the flag). Consume it and bail so a zoom-pan does
        // not get reinterpreted as an audio-channel swap. Placed before the
        // audioChannel check so the flag is cleared even when the panned tile
        // already owns the audio.
        if (deps.consumeDragClickSuppress()) return;
        if (state.composition.audioChannel === ch) return;
        ev.stopPropagation();
        scheduleSingleClick(() => {
            if (tile.hidden || !state.composition.channelOrder.includes(ch)) return;
            setLayoutAndChannels({ audioChannel: ch });
            deps.applyComposition();
        });
    });

    // Direct listener on each <video>, without the onActivePlayerEvent
    // wrapper. In split-mode a delegated listener on .video-grid caused
    // ordering issues: the click on the active tile was caught by the grid
    // delegate in the bubble phase before the at-target listener fired. A
    // direct at-target listener fires first; the v vs activePlayer() filter
    // ensures non-active tiles ignore the click (those go to the grid
    // swap-delegate above).
    //
    // Installed on BOTH slots per channel (see forEachVideoSlot). The
    // preload slot is invisible (CSS visibility:hidden + pointer-events:none)
    // so users can't click it, but after a swap the ex-preload becomes active
    // and must receive clicks.
    forEachVideoSlot((v) => {
        v.addEventListener("click", () => {
            if (!state.active) return;
            if (v !== activePlayer()) return;
            // Multi-channel: tile click is consumed by the grid-level audio
            // swap handler. Single-channel keeps the legacy play/pause toggle
            // on active-tile click.
            if (state.composition.channelOrder.length > 1) return;
            // Pan drag just ended - do NOT interpret pointerup-after-drag as
            // a play/pause toggle.
            if (deps.consumeDragClickSuppress()) return;
            scheduleSingleClick(() => {
                if (v !== activePlayer() || state.composition.channelOrder.length > 1) return;
                if (dom.player.paused) dom.player.play().catch(() => {});
                else pausePlayback();
                deps.flashPlaybackToggle();
            });
        });
        v.addEventListener("dblclick", (event) => {
            if (!state.active || !isActiveSlot(v) || v.closest<HTMLElement>(".video-tile")?.hidden) return;
            cancelSingleClick();
            // In export-mode dblclick enters per-slot crop edit (handled by the
            // delegated listener in player-crop.ts), not fullscreen.
            if (state.exportModeOpen) return;
            event.preventDefault();
            deps.toggleFullscreen();
        });
    });

    // Suppress native video context menu (Chrome's "Show controls" item
    // force-enables native controls regardless of the attribute).
    onActivePlayerEvent("contextmenu", (e) => e.preventDefault());
}
