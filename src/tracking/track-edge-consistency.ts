import { EXIT_CONFIRM_SEC, type TrackBox } from "./track-guards.js";

interface Observation {
    box: TrackBox;
    timeSec: number;
}

const MAX_HISTORY_SEC = 0.5;
const MIN_INWARD_PX = 2;
const MIN_INWARD_TARGET_FRACTION = 0.1;

function normalize(box: TrackBox, frameW: number, frameH: number, timeSec: number): TrackBox | null {
    if (
        ![box.x, box.y, box.w, box.h, frameW, frameH, timeSec].every(Number.isFinite) ||
        box.w <= 0 ||
        box.h <= 0 ||
        frameW <= 0 ||
        frameH <= 0
    ) {
        return null;
    }
    const normalized = { x: box.x / frameW, y: box.y / frameH, w: box.w / frameW, h: box.h / frameH };
    return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

/** Flags a possible switch to an inward distractor after outward edge motion.
 * A real target can reverse too: the query requests independent verification.
 * Only rejected suspicious transitions start a short recovery window; continued
 * rejection then latches a loss until a trusted reanchor. Observe accepted model
 * updates only, excluding the seed's initial localization. Time advances in
 * tracking order, including when source frames run backward. */
export class TrackEdgeConsistency {
    private readonly recent: Observation[] = [];
    private lossStartedSec: number | null = null;
    private isLost = false;

    get lost(): boolean {
        return this.isLost;
    }

    reset(): void {
        this.recent.length = 0;
        this.lossStartedSec = null;
        this.isLost = false;
    }

    observeAccepted(box: TrackBox, frameW: number, frameH: number, timeSec: number): void {
        if (this.isLost) return;
        const normalized = normalize(box, frameW, frameH, timeSec);
        if (!normalized) {
            this.recent.length = 0;
            return;
        }
        const last = this.recent[this.recent.length - 1];
        if (last && timeSec === last.timeSec) return;
        if (last && timeSec < last.timeSec) this.reset();
        this.lossStartedSec = null;
        while (this.recent.length && timeSec - this.recent[0]!.timeSec > MAX_HISTORY_SEC) this.recent.shift();
        this.recent.push({ box: normalized, timeSec });
    }

    /** Low scores alone retain the ordinary occlusion policy. An independently
     * rejected edge reversal starts this shorter window; later rejected frames
     * need not repeat the original geometry alarm to confirm the loss. */
    observeRejected(timeSec: number, suspiciousReversal = false): boolean {
        if (this.isLost) return true;
        if (!Number.isFinite(timeSec)) return false;
        if (suspiciousReversal) this.lossStartedSec ??= timeSec;
        if (this.lossStartedSec !== null && timeSec - this.lossStartedSec >= EXIT_CONFIRM_SEC) this.isLost = true;
        return this.isLost;
    }

    needsVerification(candidate: TrackBox, frameW: number, frameH: number, timeSec: number): boolean {
        if (this.isLost) return false;
        const normalized = normalize(candidate, frameW, frameH, timeSec);
        const last = this.recent[this.recent.length - 1];
        if (!normalized || !last || timeSec <= last.timeSec || timeSec - last.timeSec > MAX_HISTORY_SEC) return false;

        const reverses = (axis: "x" | "y", size: "w" | "h", direction: -1 | 1, frameSize: number): boolean => {
            const b = last.box;
            const clipped = direction < 0 ? b[axis] < 0 : b[axis] + b[size] > 1;
            if (!clipped) return false;
            const center = (box: TrackBox): number => box[axis] + box[size] / 2;
            const inward = (center(b) - center(normalized)) * direction;
            if (inward <= Math.max(MIN_INWARD_PX / frameSize, b[size] * MIN_INWARD_TARGET_FRACTION)) return false;

            // A noisy localization can interrupt the most recent pair of moves.
            // Retain the preceding outward evidence, but only within this short
            // window; querying a rejected candidate must not change that history.
            for (let i = 2; i < this.recent.length; i++) {
                const first = this.recent[i - 2]!;
                if (timeSec - first.timeSec > MAX_HISTORY_SEC) continue;
                const middle = this.recent[i - 1]!;
                const end = this.recent[i]!;
                if (
                    (center(middle.box) - center(first.box)) * direction > 0 &&
                    (center(end.box) - center(middle.box)) * direction > 0
                ) {
                    return true;
                }
            }
            return false;
        };

        return (
            reverses("x", "w", -1, frameW) ||
            reverses("x", "w", 1, frameW) ||
            reverses("y", "h", -1, frameH) ||
            reverses("y", "h", 1, frameH)
        );
    }
}
