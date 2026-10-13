// Face detector (yolov9s-face) on onnxruntime-web. WebGPU-only by product
// decision: this model at 960 input costs ~600 ms/tile on wasm single-thread,
// unusable at pass cadence - machines without a WebGPU adapter do not get the
// faces checkbox at all (gated in the UI; the worker refuses a wasm fallback).
//
// Model: lindevs/yolov9-face 1.0.0 yolov9s-face-lindevs.pt (GPL-3.0 - the
// repo's MIT badge does not survive the GPL-3.0 WongKinYiu base weights it was
// fine-tuned from; license shipped next to the model), re-exported by us:
// ultralytics ONNX at STATIC imgsz=960, then fp16 weight conversion with fp32
// IO and Resize kept fp32 (onnxconverter-common chokes on Resize otherwise).
// sha256 of the shipped fp16 file:
// e3c117a93584f7d3cf595f97df7391c3ad4c4a7e88b8e38149e1b18014e4005d
//
// Why this model and why 960: an exploratory bake-off on 22 real dashcam stills
// (private/research/face-detector-spike/) found substantially fewer obvious
// static false positives than the old 2023 YuNet and more permissive-threshold
// small-face hits at an effective ~960 scale. This was NOT a validation set: it
// has no ground-truth boxes, little scene diversity and originally no night
// coverage. The old "10 verified faces" count was manual review at the raw
// research floor; after the production width + seed gates, only one of those
// stored snapshots can seed a new face track. Treat the model and thresholds as
// provisional until they are measured on labeled dashcam sequences. Known
// residual FP classes include traffic-light lenses, red-man pictograms and
// printed faces; temporal corroboration cannot reject a persistent static FP.
//
// Output decode: ultralytics export, [1, 5, N] channels-first (cx, cy, w, h,
// score) in input pixels, no in-graph NMS - suppressOverlaps handles both
// model duplicates and cross-tile seams.
//
// Runs in a worker. No logging - per-frame hot path.

import type { OrtAssets } from "./ort-assets.js";
import type { RawDetection } from "./detect-common.js";
import type { OrtRuntime } from "./ort-runtime.js";
import { type DetectionTileOutput, TiledDetector } from "./tiled-detector.js";

/** The re-export's static input side (see header). */
const INPUT_SIZE = 960;
/** Raw score floor - junk cut only. In the small exploratory bake-off, manually
 *  reviewed face candidates sat at 0.2-0.66 at this scale and the residual FP
 *  class (traffic-light lenses) topped out at
 *  0.59; the 0.2-0.25 sliver is flicker junk plus tiny/far faces below the
 *  identifiability bar (FACE_MIN_WIDTH_PX). The PRODUCT floor - what may seed
 *  a track or count as confirmation evidence - is DETECT_SEED_SCORE_MIN in
 *  tracker-worker.ts; the band between the two floors is returned on purpose,
 *  it re-anchors already-live tracks (see the seed-floor note there). A
 *  PRINTED face on a billboard scores like a real one: no threshold separates
 *  it (the detector is right - it IS a face). */
export const FACE_SCORE_MIN = 0.25;
/** Identifiability floor, native px: a face narrower than this cannot be
 *  recognized by a human (crop-sheet review in
 *  face-detector-spike/results-blazeface: even 9-17 px faces read as a person
 *  but not an identity) - covering it is not a privacy need, and the tiny-box
 *  band is where the residual FP classes (traffic-light lenses, pictograms)
 *  live. */
export const FACE_MIN_WIDTH_PX = 20;
/** Duplicate suppression across tiles and model leftovers. */
const NMS_IOU = 0.45;

/** Decodes the model's channels-first [1, 5, N] boxes into frame pixels. */
export function collectFaceDetections({ data, dims, lb, tile }: DetectionTileOutput, detections: RawDetection[]): void {
    const n = dims[2]!;
    for (let i = 0; i < n; i++) {
        const score = data[4 * n + i]!;
        if (!(score >= FACE_SCORE_MIN)) continue;
        const cx = data[i]!;
        const cy = data[n + i]!;
        const w = data[2 * n + i]!;
        const h = data[3 * n + i]!;
        if (w / lb.scale < FACE_MIN_WIDTH_PX) continue;
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
