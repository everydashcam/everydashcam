// Physical-plausibility guards for the blur auto-tracking pass (identity-switch
// / balloon / frame-exit defense). Pure geometry - no ort import, so unit tests
// run without pulling the inference runtime.
//
// vittrack has a template frozen at init. On a target passing a similar
// distractor (an oncoming car) the confidence peak can jump identity; and the
// size regression has a positive-feedback loop (bigger box -> bigger search crop
// -> bigger box) that balloons the box onto a large nearby object (own bodywork
// on a close pass). A real target cannot teleport across the frame or change
// apparent size by a large factor between two adjacent analyzed frames, so a
// confident-but-implausible step is rejected - kept OUT of rectLast (so the next
// search stays anchored on the target, not the distractor) and reported so the
// caller freezes and counts it toward the loss streak. An uncertain Follow
// reports the last trusted position and marks it for review.
//
// A per-step rate guard cannot stop a GRADUAL balloon (every step plausible, the
// sum not): that failure is closed by two absolute mechanisms - the seed-derived
// size ceiling (seedSizeCap), and the frame-exit check - an approaching target
// always leaves through a frame edge, and ending the track there removes the
// window where the peak has only bodywork left to lock onto.
//
// The rate guards scale with the time since the last accepted box (dt), so
// they hold whatever the analysis rate is (the pass subsamples inference for
// speed - see tracker-worker's ANALYSIS_FPS). Tunables derived from pass
// geometry (closing speeds, apparent angular rates), not measured from a
// labeled corpus - iterate from real footage.

/** Axis-aligned box in frame pixels. */
export interface TrackBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Max center speed, frame-fractions per SECOND. A plate at the closest point of
 *  a near pass crosses the full frame in ~0.4s (~2.5/s); an identity jump onto
 *  nearby bodywork moves 10-30% of the frame between two analyzed frames
 *  (>= 3-4.5/s at 15 fps analysis). 3 sits between the two. */
export const MAX_CENTER_SPEED_PER_SEC = 3;
/** Max apparent-size change: a box dimension may grow/shrink at most by this
 *  fraction per SECOND (~1.2x per step at 15 fps analysis). Real size drifts
 *  gradually; a sudden step is a lock-on to a different-size object. An extreme
 *  close pass legitimately exceeds this in its last ~0.4s (growth is ~d/(d-v*dt),
 *  explosive at small d) - the box then freezes and under-covers that tail;
 *  accepted over the balloon it prevents, the frame-exit check ends the track
 *  right after anyway. */
export const MAX_SIZE_RATE_PER_SEC = 3;
/** Absolute per-step size slack, analysis-frame pixels. The size regression
 *  quantizes to a couple of pixels, so on a plate-sized box (~9 px tall at the
 *  854 px analysis width) measurement noise alone is +-20-30% per step - above
 *  the relative rate limit, which would freeze the track on pure jitter. Each
 *  dimension may always change by this many pixels per step even when the
 *  relative limit is smaller; the damage is bounded (a few px per step) and the
 *  seed cap + frame exit still rule the balloon. */
export const SIZE_JITTER_PX = 4;
/** Default ceiling of the per-pass size cap, in frame fraction. Larger manual
 *  seeds get bounded headroom instead of being rejected at their initial size. */
export const MAX_BOX_FRAME_FRACTION = 0.5;
const LARGE_SEED_CAP_GROWTH_FACTOR = 1.2;
/** Floor of the per-pass size cap, in frame fraction. Physical bound for the
 *  small targets this feature redacts: a 52 cm plate on a ~120deg dashcam lens
 *  tops out around 10-12% of frame width at 1.5 m (closer, it leaves the view),
 *  a face around 5% - 15% covers both with margin, and grants a tiny tight seed
 *  the 10-15x total growth a far-seeded approach really produces. */
export const SEED_CAP_MIN_FRACTION = 0.15;
/** Total growth budget from the original seed. The frame-fraction floor gives
 *  distant tiny targets room to approach; ordinary seeds must not grow into
 *  half-frame covers through a sequence of individually plausible steps. */
export const SEED_CAP_GROWTH_FACTOR = 3;

/** Per-dimension absolute size ceiling for one tracking pass, frame pixels. */
export interface SizeCap {
    maxW: number;
    maxH: number;
}

/** Shared by predictions and detector anchors: a fresh template must not reset
 *  the original object's total growth budget. */
export function fitsTrackSizeCap(box: TrackBox, cap: SizeCap): boolean {
    return (
        [box.x, box.y, box.w, box.h].every(Number.isFinite) &&
        box.w > 0 &&
        box.h > 0 &&
        box.w <= cap.maxW &&
        box.h <= cap.maxH
    );
}

/** Derives the pass's size ceiling from the seed box: the seed tells the
 *  target's scale (a plate/face zone is a few % of the frame, a whole-vehicle
 *  zone tens of %), so the runaway ceiling scales with it instead of granting
 *  every zone half the frame. A balloon starting from a plate-sized seed is now
 *  bounded near the floor, not at half the frame. */
export function seedSizeCap(seed: TrackBox, frameW: number, frameH: number): SizeCap {
    const dimensionCap = (size: number, frameSize: number): number => {
        const ceiling = Math.min(
            frameSize,
            Math.max(frameSize * MAX_BOX_FRAME_FRACTION, size * LARGE_SEED_CAP_GROWTH_FACTOR),
        );
        return Math.min(ceiling, Math.max(frameSize * SEED_CAP_MIN_FRACTION, size * SEED_CAP_GROWTH_FACTOR));
    };
    return {
        maxW: dimensionCap(seed.w, frameW),
        maxH: dimensionCap(seed.h, frameH),
    };
}
/** Skip the size-rate guard for the first few analyzed frames so the box can
 *  settle from a loosely-drawn seed to the model's scale, instead of a stuck
 *  reject loop freezing it at the seed (which would reproduce the "box never
 *  follows" failure). Center + absolute-size guards apply from frame one. */
export const SIZE_GUARD_WARMUP_FRAMES = 2;

/** Below this visible-area fraction the target has effectively left the frame:
 *  a half-cut plate (visible ~0.5) is still readable and must stay covered, a
 *  two-thirds-cut one is where the peak starts hunting for distractors. */
export const EXIT_VISIBLE_FRACTION = 0.35;
/** The exit condition must hold this long before the pass ends - one noisy step
 *  (vibration clipping a box at the edge) must not terminate a live track. */
export const EXIT_CONFIRM_SEC = 0.1;

/** True when `cand` is a physically plausible step from `prev` after `dtSec`
 *  seconds. `cap` is the pass's seed-derived size ceiling (seedSizeCap).
 *  `sinceInit` gates the size-rate guard through the scale-settling warmup. The
 *  position/size limits scale with dt (clamped) so they hold at any analysis
 *  rate. */
export function isPlausibleStep(
    prev: TrackBox,
    cand: TrackBox,
    cap: SizeCap,
    frameW: number,
    frameH: number,
    sinceInit: number,
    dtSec: number,
): boolean {
    // Runaway: a box past the seed-derived ceiling is a lock-on to a large
    // nearby object. This is what bounds a GRADUAL balloon - the rate guard
    // below cannot (every step plausible, the sum not).
    if (!fitsTrackSizeCap(cand, cap)) return false;
    // Clamp dt: a long gap between analyzed frames must not divide oddly nor fully
    // open the guard.
    const dt = Math.min(Math.max(dtSec, 1e-3), 0.5);
    // Center teleport - per-axis normalized so frame aspect does not bias it.
    const dx = (cand.x + cand.w / 2 - (prev.x + prev.w / 2)) / Math.max(1, frameW);
    const dy = (cand.y + cand.h / 2 - (prev.y + prev.h / 2)) / Math.max(1, frameH);
    if (Math.hypot(dx, dy) > MAX_CENTER_SPEED_PER_SEC * dt) return false;
    // Sudden scale jump - skipped during the warmup so the seed can settle.
    // The allowance per dimension is the LARGER of the relative rate limit and
    // the absolute pixel slack: relative alone is meaningless below the
    // regression's quantization noise on few-px (plate-sized) boxes.
    if (sinceInit > SIZE_GUARD_WARMUP_FRAMES) {
        const rate = MAX_SIZE_RATE_PER_SEC * dt;
        const growW = Math.max(prev.w * rate, SIZE_JITTER_PX);
        const growH = Math.max(prev.h * rate, SIZE_JITTER_PX);
        if (Math.abs(cand.w - prev.w) > growW) return false;
        if (Math.abs(cand.h - prev.h) > growH) return false;
    }
    return true;
}

/** Fraction of the box area that lies inside the frame (0..1). The tracker box
 *  is unclamped frame coordinates, so a target sliding off an edge shows up as a
 *  shrinking visible fraction - the signal the frame-exit check runs on. */
export function boxVisibleFraction(box: TrackBox, frameW: number, frameH: number): number {
    const area = box.w * box.h;
    if (area <= 0) return 0;
    const visW = Math.min(box.x + box.w, frameW) - Math.max(box.x, 0);
    const visH = Math.min(box.y + box.h, frameH) - Math.max(box.y, 0);
    if (visW <= 0 || visH <= 0) return 0;
    return (visW * visH) / area;
}
