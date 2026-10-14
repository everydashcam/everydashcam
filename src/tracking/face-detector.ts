// Face detector (YOLO26n-face) on onnxruntime-web. WebGPU-only by product
// decision, shared with plate detection: machines without a WebGPU adapter do
// not get the faces checkbox (the worker refuses a wasm fallback).
//
// Model: akanametov/yolo-face yolo26n-face.pt, exported at static 640 with
// FP16 compute and FP32 I/O and Resize. The source Pose head also predicts
// landmarks; the unused landmark branch is removed from this detection-only
// export. Source hashes, conversion details and licenses are shipped in
// public/models/face/NOTICE.
//
// This lightweight model trades some small-face detections for faster browser
// inference. The score floor remains provisional pending labelled video
// evaluation; confident background false positives still need review.
//
// Output decode: ultralytics export, [1, 5, N] channels-first (cx, cy, w, h,
// score) in input pixels, no in-graph NMS - suppressOverlaps handles both
// model duplicates and cross-tile seams.
//
// Runs in a worker. No logging - per-frame hot path.

import type { OrtAssets } from "./ort-assets.js";
import type { RawDetection } from "./detect-common.js";
import { FACE_SCORE_MIN } from "./detector-policy.js";
import type { OrtRuntime } from "./ort-runtime.js";
import { type DetectionTileOutput, TiledDetector } from "./tiled-detector.js";

/** The re-export's static input side (see header). */
const INPUT_SIZE = 640;
/** Duplicate suppression across tiles and model leftovers. */
const NMS_IOU = 0.45;

/** Decodes the model's channels-first [1, 5, N] boxes into frame pixels. Small
 * faces remain eligible: exploratory stills do not establish a safe native-pixel cutoff. */
export function collectFaceDetections(
    { data, dims, lb, tile, scoreMin = FACE_SCORE_MIN }: DetectionTileOutput,
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
        detections.push({
            x: (cx - w / 2 - lb.dx) / lb.scale + tile.sx,
            y: (cy - h / 2 - lb.dy) / lb.scale + tile.sy,
            w: w / lb.scale,
            h: h / lb.scale,
            score,
        });
    }
}

export function createFaceDetector(runtime: OrtRuntime, modelUrl: string, assets: OrtAssets): Promise<TiledDetector> {
    return TiledDetector.create(runtime, modelUrl, assets, {
        name: "face",
        inputSize: INPUT_SIZE,
        overlapIou: NMS_IOU,
        collect: collectFaceDetections,
    });
}
