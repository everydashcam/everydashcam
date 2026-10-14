// License-plate detector on onnxruntime-web. WebGPU-only by product decision
// (shared with the face detector - see blur-detect.ts): the wasm path misses the
// detection-pass budget, so machines without an adapter do not get the plates
// checkbox at all.
//
// Model: ishaqinu/yolo26n-license-plate-detection (AGPL-3.0), converted to
// FP16 compute with FP32 I/O and Resize. Source and conversion details are in
// public/models/plate/NOTICE. This export emits raw channels-first [1, 5, 8400]
// (cx, cy, w, h, score) in input pixels, without in-graph NMS. Shared overlap
// suppression handles both model duplicates and cross-tile seams.
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
const INPUT_SIZE = 640;
/** Raw candidate floor; the temporal pass owns confirmation. */
export const PLATE_SCORE_MIN = 0.25;
/** Duplicate suppression across tiles and raw model candidates. */
export const PLATE_DEDUPE_IOU = 0.5;

/** Decodes the model's channels-first [1, 5, N] boxes into frame pixels. */
export function collectPlateDetections(
    { data, dims, lb, tile, scoreMin = PLATE_SCORE_MIN }: DetectionTileOutput,
    detections: RawDetection[],
): void {
    const n = dims[2]!;
    for (let i = 0; i < n; i++) {
        const score = data[4 * n + i]!;
        if (!(score >= scoreMin)) continue;
        const cx = data[i]!;
        const cy = data[n + i]!;
        const w = data[2 * n + i]!;
        const h = data[3 * n + i]!;
        // Frame-relative size cannot distinguish a close or cropped plate from
        // a whole-car false positive without knowing the camera geometry.
        detections.push({
            x: (cx - w / 2 - lb.dx) / lb.scale + tile.sx,
            y: (cy - h / 2 - lb.dy) / lb.scale + tile.sy,
            w: w / lb.scale,
            h: h / lb.scale,
            score,
        });
    }
}

export function createPlateDetector(runtime: OrtRuntime, modelUrl: string, assets: OrtAssets): Promise<TiledDetector> {
    return TiledDetector.create(runtime, modelUrl, assets, {
        name: "plate",
        inputSize: INPUT_SIZE,
        overlapIou: PLATE_DEDUPE_IOU,
        collect: collectPlateDetections,
    });
}
