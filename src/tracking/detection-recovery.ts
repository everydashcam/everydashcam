import type { CropRect } from "../transcode/compose.js";
import type { RawDetection, TileRect } from "./detect-common.js";
import { canSeedDetection } from "./detector-policy.js";
import type { TrackBox } from "./track-guards.js";

export interface DetectionRecoveryRegion {
    /** Last trusted raw box, before frame clipping or coverage padding. */
    box: TrackBox;
    /** Visible portion of the tracker's search square. */
    roi: TileRect;
}

export interface DetectionRecoveryPlan {
    regions: DetectionRecoveryRegion[];
    /** Original detector grid entries, in grid order, without duplicates. */
    tiles: TileRect[];
}

const SEARCH_FACTOR = 4;
const MAX_SIZE_RATIO = 2;

function validFrame(frameW: number, frameH: number): boolean {
    return Number.isFinite(frameW) && Number.isFinite(frameH) && frameW > 0 && frameH > 0;
}

function validTile(tile: TileRect): boolean {
    return [tile.sx, tile.sy, tile.sw, tile.sh].every(Number.isFinite) && tile.sw > 0 && tile.sh > 0;
}

function intersects(a: TileRect, b: TileRect): boolean {
    return a.sx < b.sx + b.sw && a.sx + a.sw > b.sx && a.sy < b.sy + b.sh && a.sy + a.sh > b.sy;
}

/** Select existing grid tiles around an actually lost object's last trusted
 * position. Keep the ViT crop geometry, including fractional origins and
 * truncation toward zero; changing tile crops would change detector scores. */
export function planDetectionRecovery(
    rects: readonly CropRect[],
    frameW: number,
    frameH: number,
    tiles: readonly TileRect[],
): DetectionRecoveryPlan {
    const plan: DetectionRecoveryPlan = { regions: [], tiles: [] };
    if (!validFrame(frameW, frameH)) return plan;
    for (const rect of rects) {
        const box = { x: rect.xPct * frameW, y: rect.yPct * frameH, w: rect.wPct * frameW, h: rect.hPct * frameH };
        if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) continue;
        // An already invisible target must not search back into the frame.
        if (
            Math.min(frameW, box.x + box.w) <= Math.max(0, box.x) ||
            Math.min(frameH, box.y + box.h) <= Math.max(0, box.y)
        )
            continue;
        const side = Math.ceil(Math.sqrt(box.w * box.h) * SEARCH_FACTOR);
        const x = box.x + Math.trunc((box.w - side) / 2);
        const y = box.y + Math.trunc((box.h - side) / 2);
        if (![side, x, y].every(Number.isFinite)) continue;
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(frameW, x + side);
        const bottom = Math.min(frameH, y + side);
        if (right <= left || bottom <= top) continue;
        plan.regions.push({ box, roi: { sx: left, sy: top, sw: right - left, sh: bottom - top } });
    }
    for (const tile of tiles) {
        if (!validTile(tile) || !plan.regions.some(({ roi }) => intersects(tile, roi))) continue;
        if (
            plan.tiles.some(
                (selected) =>
                    selected.sx === tile.sx &&
                    selected.sy === tile.sy &&
                    selected.sw === tile.sw &&
                    selected.sh === tile.sh,
            )
        )
            continue;
        plan.tiles.push(tile);
    }
    return plan;
}

/** Recovery can create only ordinary seed-eligible detections near a lost
 * target of compatible size. Compare raw sizes so frame clipping does not
 * redefine either object's scale. This does not assert identity or reanchor. */
export function filterRecoveryDetections(
    detections: readonly RawDetection[],
    plan: DetectionRecoveryPlan,
    seedScoreMin: number,
    frameW: number,
    frameH: number,
): RawDetection[] {
    if (!validFrame(frameW, frameH) || !Number.isFinite(seedScoreMin) || seedScoreMin < 0 || seedScoreMin > 1)
        return [];
    return detections.filter((detection) => {
        if (
            !canSeedDetection(detection.score, { seedScoreMin }) ||
            ![detection.x, detection.y, detection.w, detection.h].every(Number.isFinite) ||
            detection.w <= 0 ||
            detection.h <= 0
        )
            return false;
        const cx = detection.x + detection.w / 2;
        const cy = detection.y + detection.h / 2;
        if (!(cx >= 0 && cx < frameW && cy >= 0 && cy < frameH)) return false;
        return plan.regions.some(
            ({ box, roi }) =>
                cx >= roi.sx &&
                cx < roi.sx + roi.sw &&
                cy >= roi.sy &&
                cy < roi.sy + roi.sh &&
                detection.w >= box.w / MAX_SIZE_RATIO &&
                detection.w <= box.w * MAX_SIZE_RATIO &&
                detection.h >= box.h / MAX_SIZE_RATIO &&
                detection.h <= box.h * MAX_SIZE_RATIO,
        );
    });
}
