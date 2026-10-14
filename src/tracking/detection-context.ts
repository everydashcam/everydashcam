import { iouOf, type RawDetection } from "./detect-common.js";

// Match the packaged plate model's 640-pixel input. Context is useful only
// when a proposal remains clearly resolved after fitting the entire frame;
// smaller objects still rely on native-detail tiles without this extra gate.
const CONTEXT_INPUT_SIZE = 640;
const MIN_CONTEXT_DIMENSION_PX = 64;
const MIN_CONTEXT_IOU = 0.5;
const MAX_CONTEXT_SIZE_RATIO = 2;

function validateFrame(frameW: number, frameH: number): void {
    if (!Number.isFinite(frameW) || !Number.isFinite(frameH) || frameW <= 0 || frameH <= 0) {
        throw new Error("detection context frame dimensions are invalid");
    }
}

function visibleDetection(box: RawDetection, frameW: number, frameH: number): RawDetection | null {
    if (
        ![box.x, box.y, box.w, box.h, box.score].every(Number.isFinite) ||
        box.w <= 0 ||
        box.h <= 0 ||
        box.score < 0 ||
        box.score > 1
    ) {
        return null;
    }
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const right = Math.min(frameW, box.x + box.w);
    const bottom = Math.min(frameH, box.y + box.h);
    if (!(right > x && bottom > y)) return null;
    return { x, y, w: right - x, h: bottom - y, score: box.score };
}

function isContextSized(box: RawDetection, frameW: number, frameH: number): boolean {
    const scale = CONTEXT_INPUT_SIZE / Math.max(frameW, frameH);
    return box.w * scale >= MIN_CONTEXT_DIMENSION_PX && box.h * scale >= MIN_CONTEXT_DIMENSION_PX;
}

/** Large tile proposals can mistake a cropped vehicle for a plate. Request
 * whole-frame class evidence only when both visible dimensions remain at
 * least 64 pixels in that model input; this never caps a plate's size. */
export function shouldVerifyPlateContext(box: RawDetection, frameW: number, frameH: number): boolean {
    validateFrame(frameW, frameH);
    const visible = visibleDetection(box, frameW, frameH);
    return visible !== null && isContextSized(visible, frameW, frameH);
}

function matchesContext(a: RawDetection, b: RawDetection): boolean {
    return (
        Math.max(a.w, b.w) <= Math.min(a.w, b.w) * MAX_CONTEXT_SIZE_RATIO &&
        Math.max(a.h, b.h) <= Math.min(a.h, b.h) * MAX_CONTEXT_SIZE_RATIO &&
        iouOf(a, b) >= MIN_CONTEXT_IOU
    );
}

/** A corroborated whole-frame box restores extent lost at tile seams. Preserve
 * the strongest same-frame score without creating another detector hit.
 * Context proposals come from the plate detector with its raw floor applied;
 * no context box can seed an object without a matching large tile proposal.
 * Compare visible portions so uncertainty outside the frame cannot reject a
 * real clipped plate. Small tiled objects keep their original geometry unless
 * an emitted context box already covers all of their detected extent. */
export function resolvePlateContextDetections(
    boxes: readonly RawDetection[],
    contextBoxes: readonly RawDetection[],
    frameW: number,
    frameH: number,
): RawDetection[] {
    validateFrame(frameW, frameH);
    const small: Array<{ original: RawDetection; visible: RawDetection }> = [];
    const large: RawDetection[] = [];
    for (const original of boxes) {
        const visible = visibleDetection(original, frameW, frameH);
        if (!visible) continue;
        if (isContextSized(visible, frameW, frameH)) large.push(visible);
        else small.push({ original, visible });
    }
    const resolved: Array<{ box: RawDetection; visible: RawDetection }> = [];
    for (const context of contextBoxes) {
        const visible = visibleDetection(context, frameW, frameH);
        if (!visible) continue;
        const matches = large.filter((candidate) => matchesContext(candidate, visible));
        if (matches.length === 0) continue;
        resolved.push({
            box: { ...context, score: Math.max(context.score, ...matches.map((candidate) => candidate.score)) },
            visible,
        });
    }
    const uncoveredSmall = small.filter(({ original, visible }) => {
        const covering = resolved.find(
            ({ visible: context }) =>
                matchesContext(visible, context) &&
                context.x <= visible.x &&
                context.y <= visible.y &&
                context.x + context.w >= visible.x + visible.w &&
                context.y + context.h >= visible.y + visible.h,
        );
        if (!covering) return true;
        // Deduplicating a strong fragment must not remove the only eligible
        // seed when the large tile and context proposals have weaker scores.
        covering.box.score = Math.max(covering.box.score, original.score);
        return false;
    });
    return [...uncoveredSmall.map(({ original }) => original), ...resolved.map(({ box }) => box)];
}
