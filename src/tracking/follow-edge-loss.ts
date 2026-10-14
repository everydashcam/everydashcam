import { EXIT_CONFIRM_SEC, type TrackBox } from "./track-guards.js";

interface Observation {
    box: TrackBox;
    timeSec: number;
}

interface OutwardEdge {
    axis: "x" | "y";
    size: "w" | "h";
    direction: -1 | 1;
}

const MAX_HISTORY_SEC = 0.5;
const MIN_TRAVEL_TARGET_FRACTION = 0.05;
const MIN_TRAVEL_PX = 2;

/** A clipped, outward-moving target gets a short loss confirmation instead of
 * the central-occlusion recovery window. Losing it is uncertainty, not proof
 * that it has exited: the caller must flag the last trusted position for review.
 * Observe model updates only; a hand-drawn seed can shift while localization
 * settles and must not count as evidence of outward motion. */
export class FollowEdgeLoss {
    private readonly recent: Observation[] = [];
    private lossStartedSec: number | null = null;
    private recoveryStartedSec: number | null = null;
    private pendingEdge: OutwardEdge | null = null;

    get hasPendingLoss(): boolean {
        return this.lossStartedSec !== null;
    }

    observe(box: TrackBox, frameW: number, frameH: number, timeSec: number, accepted: boolean): boolean {
        const previous = this.recent[this.recent.length - 1];
        if (previous && timeSec - previous.timeSec > MAX_HISTORY_SEC) {
            this.clearLoss();
            this.recent.length = 0;
        }
        if (accepted) {
            const normalized = { x: box.x / frameW, y: box.y / frameH, w: box.w / frameW, h: box.h / frameH };
            if (this.pendingEdge && previous) {
                const { axis, size, direction } = this.pendingEdge;
                const frameSize = axis === "x" ? frameW : frameH;
                const center = normalized[axis] + normalized[size] / 2;
                const previousCenter = previous.box[axis] + previous.box[size] / 2;
                const clearance = direction < 0 ? normalized[axis] : 1 - normalized[axis] - normalized[size];
                const stillOutward = (center - previousCenter) * direction > MIN_TRAVEL_PX / frameSize;
                if (!stillOutward || clearance >= normalized[size]) {
                    this.clearLoss();
                } else {
                    // A clipped target can regress to its remaining visible
                    // fragment. One such accepted box does not prove recovery,
                    // even when its new extent lies just inside the frame.
                    this.recoveryStartedSec ??= timeSec;
                    if (timeSec - this.recoveryStartedSec >= EXIT_CONFIRM_SEC) this.clearLoss();
                }
            }
            this.recent.push({
                box: normalized,
                timeSec,
            });
            if (this.recent.length > 3) this.recent.shift();
        } else {
            this.recoveryStartedSec = null;
            // Accepted outward tracking can continue through the edge. Only
            // another rejected observation confirms the pending uncertainty.
            if (this.lossStartedSec !== null && timeSec - this.lossStartedSec >= EXIT_CONFIRM_SEC) return true;
            const edge = this.outwardEdge(frameW, frameH, timeSec);
            if (edge) {
                this.pendingEdge = edge;
                this.lossStartedSec ??= timeSec;
            }
        }
        return false;
    }

    private clearLoss(): void {
        this.lossStartedSec = null;
        this.recoveryStartedSec = null;
        this.pendingEdge = null;
    }

    private outwardEdge(frameW: number, frameH: number, timeSec: number): OutwardEdge | null {
        if (this.recent.length !== 3) return null;
        const [first, middle, last] = this.recent as [Observation, Observation, Observation];
        if (last.timeSec - first.timeSec > MAX_HISTORY_SEC || timeSec - last.timeSec > MAX_HISTORY_SEC) return null;
        const toward = (axis: "x" | "y", size: "w" | "h", direction: number, frameSize: number): boolean => {
            const center = (item: Observation) => item.box[axis] + item.box[size] / 2;
            const a = center(first);
            const b = center(middle);
            const c = center(last);
            // Two consistent moves plus bounded travel reject stationary edge
            // jitter. Clipping alone, including growth across an edge, is not
            // enough evidence to shorten ordinary occlusion recovery.
            return (
                (b - a) * direction > 0 &&
                (c - b) * direction > 0 &&
                (c - a) * direction > Math.max(MIN_TRAVEL_PX / frameSize, last.box[size] * MIN_TRAVEL_TARGET_FRACTION)
            );
        };
        const b = last.box;
        if (b.x < 0 && toward("x", "w", -1, frameW)) return { axis: "x", size: "w", direction: -1 };
        if (b.x + b.w > 1 && toward("x", "w", 1, frameW)) return { axis: "x", size: "w", direction: 1 };
        if (b.y < 0 && toward("y", "h", -1, frameH)) return { axis: "y", size: "h", direction: -1 };
        if (b.y + b.h > 1 && toward("y", "h", 1, frameH)) return { axis: "y", size: "h", direction: 1 };
        return null;
    }
}
