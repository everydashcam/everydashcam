// Global player keyboard shortcuts. One central listener on document.keydown.
//
// Skipped when focus is in an editable control (input/select/textarea/
// [contenteditable]) so shortcuts don't break text input. Modifier combos
// (Cmd/Ctrl/Alt) are not intercepted - Shift is the only modifier we use
// (Shift+arrow = long seek step, Shift+. = >, Shift+I/O = jump to clip edge,
// Shift+S = copy a still image).
// Arrow seek steps are user-configurable in settings; defaults 5s / 30s.

import { cycleMainCamera, toggleArrangementMode } from "./camera-arrangement.js";
import { dom } from "./dom.js";
import { exportPanelState, setRangeEdge, toggleExportMode } from "./export-state.js";
import { isAnyModalOpen } from "./modal-helper.js";
import { stepFrame } from "./player-frame-step.js";
import { pausePlayback } from "./playback-pause.js";
import { getSeekStepSec, getSeekStepShiftSec } from "./seek-step-pref.js";
import { activeCandidate, state, visibleChannels } from "./state.js";
import { flashRangeTab } from "./timeline-range.js";

interface HotkeyDeps {
    getTripCurrentTime: () => number;
    seekTripTime: (sec: number) => void;
    /** Restart the trip from the first frame (used by play button at trip end too). */
    playFrameFromStart: () => void;
    isAtTripEnd: () => boolean;
    toggleMuted: () => void;
    toggleFullscreen: () => void;
    /** Toggles loop-vs-stop trip-end behavior (R). */
    toggleLoop: () => void;
    /** Flashes a center play/pause glyph on the active tile after a toggle.
     *  forcePlaying overrides the read for deferred restarts (trip-end). */
    flashPlaybackToggle: (forcePlaying?: boolean) => void;
    /** Zooms the timeline one step in (1) / out (-1) around the window centre. */
    zoomTimeline: (dir: 1 | -1) => void;
    cyclePlaybackRate: (dir: 1 | -1) => void;
    captureFrame: () => void;
    /** Copies the same still image to the clipboard (Shift+S). */
    copyFrame: () => void;
    resetVideoZoom: () => void;
    /** Pans a zoomed timeline window so `sec` is inside it (no-op otherwise).
     *  Pre-step for the Shift+I/O jumps: seeks clamp to the zoom window, so a
     *  clip boundary outside it would otherwise be unreachable. */
    panTimelineToInclude: (sec: number) => void;
    /** True iff the speed dropdown is currently open. */
    isSpeedMenuOpen: () => boolean;
    closeSpeedMenu: () => void;
    focusSpeedButton: () => void;
}

/** True if the event target is an editable element. */
function isEditableTarget(target: HTMLElement | null): boolean {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
    if (target.isContentEditable) return true;
    return false;
}

/** Controls outside the player toolbar keep their own Space/Enter activation. */
function isNativeActivationTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (tag === "A" && target.hasAttribute("href")) return true;
    const role = target.getAttribute("role");
    return role === "button" || role === "menuitem" || role === "tab" || role === "link";
}

function isPlayerToolbarButton(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLButtonElement) || !target.matches("#player-bar button")) return false;
    if (target.closest('[role="menu"]')) return false;
    const popup = target.getAttribute("aria-haspopup");
    return popup === null || popup === "false";
}

export function initPlayerHotkeys(deps: HotkeyDeps): void {
    // Click on the player-bar play button also lives here so the "restart at
    // trip end" branch shares the same playFrameFromStart hook as Space/K.
    dom.playerBar.play.addEventListener("click", () => {
        if (!state.active) return;
        if (dom.player.paused) {
            // At trip end (last frame finished, tripEndBehavior=stop) the play
            // button restarts from the beginning of the whole trip rather
            // than resuming the last file. Standard YouTube/VLC pattern.
            if (deps.isAtTripEnd()) {
                deps.playFrameFromStart();
                return;
            }
            dom.player.play().catch(() => {});
        } else {
            pausePlayback();
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.defaultPrevented) return;

        // Escape closes the speed menu ALWAYS, before any other filter - even
        // if focus moved into a speed-menu li, Escape must close it.
        if (e.key === "Escape" && deps.isSpeedMenuOpen()) {
            e.preventDefault();
            deps.closeSpeedMenu();
            deps.focusSpeedButton();
            return;
        }

        // A modal owns the keyboard while open. modal-helper's capture-phase
        // trap only swallows Escape/Tab; every other key (F/U/S/E, digits,
        // arrows) would otherwise reach here and mutate the player behind the
        // backdrop - e.g. F focused on a modal button toggles fullscreen.
        if (isAnyModalOpen()) return;

        // Skip when focus is in an editable control.
        if (e.target instanceof HTMLElement && isEditableTarget(e.target)) return;

        // Space stays a playback shortcut after clicking a toolbar action.
        // Enter still activates that focused action; menus keep both keys.
        if (
            isNativeActivationTarget(e.target) &&
            (e.key === "Enter" || (e.code === "Space" && !isPlayerToolbarButton(e.target)))
        )
            return;

        // Skip system/browser combos - Cmd+R, Ctrl+T, etc. Allow Shift through.
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        // Don't touch the player while the speed menu is open.
        if (deps.isSpeedMenuOpen()) return;

        // Player shortcuts require an active recording.
        const hasActive = state.active !== null;

        // e.code is layout-independent (KeyM fires on a Russian 'ь' too);
        // for Space/arrows we need e.key.
        const code = e.code;
        const key = e.key;

        // Space and K: play/pause. Space scrolls the page by default.
        if (code === "Space" || code === "KeyK") {
            if (!hasActive) return;
            e.preventDefault();
            if (e.repeat) return;
            if (dom.player.paused) {
                // Same restart-at-trip-end branch as the play button above -
                // without it Space at trip end replays only the LAST file
                // (HTMLMediaElement.play() rewinds the ended element), while
                // the button restarts the whole trip.
                if (deps.isAtTripEnd()) {
                    deps.playFrameFromStart();
                    // Restart starts playback (deferred), so force the play glyph -
                    // reading dom.player.paused here would still be true.
                    deps.flashPlaybackToggle(true);
                    return;
                }
                dom.player.play().catch(() => {});
            } else {
                pausePlayback();
            }
            deps.flashPlaybackToggle();
            return;
        }

        // Arrows: seek. Step (in sec) is user-configurable via settings.
        if (key === "ArrowLeft" || key === "ArrowRight") {
            if (!hasActive) return;
            e.preventDefault();
            const step = e.shiftKey ? getSeekStepShiftSec() : getSeekStepSec();
            const sign = key === "ArrowLeft" ? -1 : 1;
            deps.seekTripTime(deps.getTripCurrentTime() + sign * step);
            return;
        }

        // J / L - YouTube-style +-10s.
        if (code === "KeyJ" || code === "KeyL") {
            if (!hasActive) return;
            e.preventDefault();
            const sign = code === "KeyJ" ? -1 : 1;
            deps.seekTripTime(deps.getTripCurrentTime() + sign * 10);
            return;
        }

        // U - mute toggle (was M; relocated so M can drive view-menu mini-map toggle).
        // Guarded by hasActive like the other media keys: muting an empty player
        // on the landing screen silently flips the persisted mute preference with
        // no visible feedback (the mute icon lives in the hidden player bar).
        if (code === "KeyU") {
            if (!hasActive) return;
            e.preventDefault();
            deps.toggleMuted();
            return;
        }

        // F - fullscreen toggle.
        if (code === "KeyF") {
            if (!hasActive || e.repeat) return;
            e.preventDefault();
            deps.toggleFullscreen();
            return;
        }

        // R - loop on/off. Guarded by hasActive like the other media keys so it
        // doesn't flip the persisted preference on the empty landing player.
        if (code === "KeyR") {
            if (!hasActive) return;
            e.preventDefault();
            deps.toggleLoop();
            return;
        }

        // V: main camera + others <-> all cameras equal. N: the next camera
        // takes the main place. Both need two cameras on screen; with one,
        // the key is left to the page.
        if (code === "KeyV" || code === "KeyN") {
            if (!hasActive || e.repeat || visibleChannels().length < 2) return;
            e.preventDefault();
            if (code === "KeyV") toggleArrangementMode();
            else cycleMainCamera();
            return;
        }

        // + / - : zoom the timeline in/out around the window centre (keyboard
        // counterpart of the wheel/pinch zoom). Matched by e.key (the produced
        // character), NOT e.code: unlike letters, the +/- characters move
        // between physical keys across layouts (German QWERTZ has "+" on
        // BracketRight and "-" on Slash), so the code match left the documented
        // keys dead there. "=" keeps the unshifted US key zooming in; numpad
        // +/- produce the same e.key. Reset is the overview button / dblclick.
        if (key === "+" || key === "=") {
            if (!hasActive) return;
            e.preventDefault();
            deps.zoomTimeline(1);
            return;
        }
        if (key === "-") {
            if (!hasActive) return;
            e.preventDefault();
            deps.zoomTimeline(-1);
            return;
        }

        // Z: reset digital zoom. At scale=1 do not swallow the key - it may
        // be needed for future shortcuts.
        if (code === "KeyZ") {
            if (state.videoZoom.scale === 1) return;
            e.preventDefault();
            deps.resetVideoZoom();
            return;
        }

        // S: save a still image of the player as JPG; Shift+S: copy it.
        // Only fires when there is a playable active file (same logic as the
        // player-bar button).
        if (code === "KeyS") {
            if (!state.active) return;
            const video = activeCandidate();
            if (!video?.canPlay) return;
            e.preventDefault();
            if (e.repeat) return;
            if (e.shiftKey) deps.copyFrame();
            else deps.captureFrame();
            return;
        }

        // E: toggle export-mode (open/close the export panel + chrome).
        // The view-menu strip toggle moved to KeyT (was KeyE) to free this up.
        if (code === "KeyE") {
            if (!hasActive) return;
            e.preventDefault();
            toggleExportMode();
            return;
        }

        // I / O: set the clip start/end to the playhead (the mark-in/mark-out
        // convention from NLEs); Shift+I / Shift+O: jump the playhead to that
        // boundary to inspect the cut. Export-mode only - outside it the range
        // chrome is not on screen and a stray press would edit invisible state.
        if (code === "KeyI" || code === "KeyO") {
            if (!hasActive || !state.exportModeOpen) return;
            const range = exportPanelState.range;
            if (!range) return;
            e.preventDefault();
            const which = code === "KeyI" ? "start" : "end";
            if (e.shiftKey) {
                const target = which === "start" ? range.startTripSec : range.endTripSec;
                // Zoomed timeline clamps every seek to its window - pan it over
                // the boundary first so the jump lands on the real edge.
                deps.panTimelineToInclude(target);
                deps.seekTripTime(target);
            } else {
                // Save already snapshotted the clip. Do not flash a range edge
                // as if it moved while the shared mutation boundary is locked.
                if (exportPanelState.configurationLocked) return;
                // Crossing the opposite edge is absorbed by the shared
                // MIN_RANGE_SEC clamp; the flash marks which tab moved (the
                // only other trace is the mask jumping).
                setRangeEdge(which, deps.getTripCurrentTime());
                flashRangeTab(which);
            }
            return;
        }

        // Comma / Period - dual role:
        //   with Shift (i.e. < / >) - cycle speed down/up
        //   without Shift - frame-step (pauses first when playing); shared
        //   with the player-bar step buttons, see player-frame-step.ts
        if (code === "Comma" || code === "Period") {
            if (!hasActive) return;
            e.preventDefault();
            if (e.shiftKey) {
                deps.cyclePlaybackRate(code === "Period" ? 1 : -1);
            } else {
                stepFrame(code === "Period" ? 1 : -1);
            }
            return;
        }

        // Digits 0..9: jump to 0..90% of trip duration.
        if (code.startsWith("Digit") && code.length === 6) {
            if (!state.active) return;
            const digit = Number(code.slice(5));
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) return;
            e.preventDefault();
            const trip = state.trips[state.active.trip];
            if (!trip) return;
            deps.seekTripTime((trip.timeline.contentDurationSec * digit) / 10);
            return;
        }
    });
}
