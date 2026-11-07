// Frame-by-frame stepping: one shared helper behind the , / . hotkeys and the
// step buttons in the player bar. Catching a sharp frame of a passing plate by
// hammering pause is nearly impossible - the user pauses roughly at the moment
// and creeps up on the exact frame from there.

import { activeCandidate, state } from "./state.js";
import { dom } from "./dom.js";
import { FRAME_STEP_HOLD_DELAY_MS, FRAME_STEP_REPEAT_MS, heldFrameStepCount } from "./frame-step-repeat.js";
import { initButtonRepeat } from "./player-button-repeat.js";
import { pausePlayback } from "./playback-pause.js";

interface FrameStepDeps {
    getTripCurrentTime: () => number;
    seekTripTime: (sec: number) => void;
}

// Fallback when the active clip's probed fps is unknown: 30 fps is the typical
// dashcam rate; more precision would require decoding.
const FALLBACK_FPS = 30;

// Hold-to-repeat pacing. 150ms ≈ 6-7 steps/s - fast enough to walk a second of
// footage in a short hold without flooding the seek path. The target is derived
// from total elapsed time, so delayed timer callbacks still catch up exactly.
/** Seconds of one frame step for a clip probed at `fps`. The clamp guards a
 *  garbage probe (VFR spike, broken header) from turning a "frame" into a
 *  microscopic or multi-second jump; null/absent fps falls back to 1/30. */
function frameStepSeconds(fps: number | null): number {
    if (!fps || !Number.isFinite(fps) || fps <= 0) return 1 / FALLBACK_FPS;
    return 1 / Math.min(120, Math.max(5, fps));
}

let deps: FrameStepDeps | null = null;

/** Steps the player one frame back (-1) / forward (1). Pauses first when
 *  playing - a frame being hunted is by definition not one flying past - so
 *  the control is meaningful in both states (mpv semantics, not YouTube's
 *  paused-only). No-op before initFrameStep or with no active trip. */
export function stepFrame(direction: 1 | -1): void {
    if (!deps || !state.active) return;
    pausePlayback();
    deps.seekTripTime(deps.getTripCurrentTime() + direction * frameStepSeconds(activeCandidate()?.fps ?? null));
}

function wireStepButton(btn: HTMLButtonElement, direction: 1 | -1): void {
    initButtonRepeat(btn, {
        delayMs: FRAME_STEP_HOLD_DELAY_MS + FRAME_STEP_REPEAT_MS,
        repeatMs: FRAME_STEP_REPEAT_MS,
        activate: () => stepFrame(direction),
        start: () => {
            if (!deps || !state.active) return null;
            const trip = state.trips[state.active.trip];
            pausePlayback();
            const baseTime = deps.getTripCurrentTime();
            const stepSeconds = frameStepSeconds(activeCandidate()?.fps ?? null);
            let appliedSteps = 1;
            deps.seekTripTime(baseTime + direction * stepSeconds);
            return (elapsedMs) => {
                if (!deps || !state.active || state.trips[state.active.trip] !== trip) return false;
                const requestedSteps = heldFrameStepCount(elapsedMs);
                if (requestedSteps <= appliedSteps) return;
                pausePlayback();
                deps.seekTripTime(baseTime + direction * requestedSteps * stepSeconds);
                appliedSteps = requestedSteps;
            };
        },
    });
}

/** Wires the player-bar step buttons and arms stepFrame for the hotkeys.
 *  Called once from initPlayer. */
export function initFrameStep(frameStepDeps: FrameStepDeps): void {
    deps = frameStepDeps;
    wireStepButton(dom.playerBar.stepBack, -1);
    wireStepButton(dom.playerBar.stepFwd, 1);
}
