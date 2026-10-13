// License-plate detector on onnxruntime-web. WebGPU-only by product decision
// (shared with the face detector - see blur-detect.ts): the wasm path misses the
// detection-pass budget, so machines without an adapter do not get the plates
// checkbox at all.
//
// Model: ankandrew/open-image-models yolo-v9-s-608-license-plates-end2end.onnx
// (MIT), converted to FP16 compute with FP32 input, postprocess and output; exact
// source/conversion hashes are in public/models/plate/NOTICE. "end2end" means NMS
// is inside the graph via the standard NonMaxSuppression op, so the output is
// already a short list of boxes. On 31 local day/night dashcam stills at the 0.6
// product seed floor, this variant added seven boxes over t512 and all seven were
// manually labeled as plates; no additional false positive appeared. Median
// WebGPU inference was 36.5 ms over 184 tiles. This is a small targeted
// regression sample, not an exhaustive precision/recall benchmark.
//
// Contract: detect() runs the model over (a subset of) an overlapping tile
// grid (small plates vanish in a whole-frame letterbox - see detect-common.ts),
// remaps boxes to frame pixels and suppresses cross-tile duplicates.
//
// Runs in a worker. No logging - per-frame hot path.

import type { OrtAssets } from "./ort-assets.js";
import type { RawDetection } from "./detect-common.js";
import type { OrtRuntime } from "./ort-runtime.js";
import { type DetectionTileOutput, TiledDetector } from "./tiled-detector.js";

/** The model variant's static input side. */
const INPUT_SIZE = 608;
/** Raw score floor - junk cut only. The PRODUCT floor - what may seed a track or
 *  count as confirmation evidence - is DETECT_SEED_SCORE_MIN in
 *  tracker-worker.ts. The band between the two floors is returned on purpose:
 *  it may re-anchor an already-live track but cannot create one. Only the 0.6+
 *  delta was manually labeled; this lower band remains exploratory. */
export const PLATE_SCORE_MIN = 0.25;
/** Cross-tile duplicate suppression. */
const DEDUPE_IOU = 0.5;

/** Whole-vehicle false-positive gate: the model sometimes claims an entire
 *  side-on car as one "plate" - a PERSISTENT detection temporal corroboration
 *  cannot kill (it does not flicker; it parks in the frame for seconds). Real
 *  plates are bounded by optics: at a dashcam's wide FOV a plate wider than
 *  ~15% of the frame puts the camera well under a meter from the bumper, and
 *  the spike's readable plates top out far below both caps. Anything bigger is
 *  bodywork - drop it before it can seed a track. (Aspect is deliberately NOT
 *  gated: a side-on car is ~2.5:1, same as a US plate.) */
export const PLATE_MAX_WIDTH_FRAC = 0.15;
export const PLATE_MAX_AREA_FRAC = 0.015;

/** True when a raw box is geometrically plausible as a license plate (see the
 *  caps above). Degenerate frame dims pass - corroboration owns those. */
export function plateBoxPlausible(box: RawDetection, frameW: number, frameH: number): boolean {
    if (!(frameW > 0) || !(frameH > 0)) return true;
    return box.w / frameW <= PLATE_MAX_WIDTH_FRAC && (box.w * box.h) / (frameW * frameH) <= PLATE_MAX_AREA_FRAC;
}

/** Decodes the model's rows of [batch, x1, y1, x2, y2, class, score]. */
export function collectPlateDetections(
    { data, dims, lb, tile, frameW, frameH }: DetectionTileOutput,
    detections: RawDetection[],
): void {
    const cols = dims[dims.length - 1]!;
    for (let r = 0; r * cols < data.length; r++) {
        const score = data[r * cols + 6]!;
        if (!(score >= PLATE_SCORE_MIN)) continue;
        const x1 = (data[r * cols + 1]! - lb.dx) / lb.scale + tile.sx;
        const y1 = (data[r * cols + 2]! - lb.dy) / lb.scale + tile.sy;
        const x2 = (data[r * cols + 3]! - lb.dx) / lb.scale + tile.sx;
        const y2 = (data[r * cols + 4]! - lb.dy) / lb.scale + tile.sy;
        const box: RawDetection = { x: x1, y: y1, w: x2 - x1, h: y2 - y1, score };
        if (plateBoxPlausible(box, frameW, frameH)) detections.push(box);
    }
}

export function createPlateDetector(runtime: OrtRuntime, modelUrl: string, assets: OrtAssets): Promise<TiledDetector> {
    return TiledDetector.create(runtime, modelUrl, assets, {
        name: "plate",
        inputSize: INPUT_SIZE,
        overlapIou: DEDUPE_IOU,
        collect: collectPlateDetections,
    });
}
