// VitTrack single-object tracker on onnxruntime-web (WASM EP, single thread; the
// build is chosen by the caller via createOrtSession - see VitTrackerSession.create).
//
// The ORT session is stateless (template is passed on every run - see the
// contract note below), so ONE VitTrackerSession can drive MANY VitTrack
// instances, each carrying its own template/last-box/size-cap. Their updates are
// serialized because the session owns one reusable search workspace. Follow
// creates a fresh track for each user-selected target without reloading the
// model. Sparse face/plate passes also use these tracks between detector anchors.
//
// Pre/post-processing is a TypeScript port of OpenCV's
// modules/video/src/tracking/tracker_vit.cpp (Apache-2.0); the model is
// opencv_zoo's object_tracking_vittrack (Apache-2.0, 715 KB fp32,
// sha256 2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d,
// from huggingface.co/opencv/object_tracking_vittrack). The port was sanity-
// checked against a synthetic scale-growth + occlusion scene: ~3 px mean center
// error, score drops below the 0.20 threshold under occlusion and recovers after
// (see private/research/vittrack-spike/). That verifies plumbing, not real-world
// tracking quality. OpenCV Zoo reports LaSOT AUC 48.6 for this model, but the
// product still has no labeled dashcam tracking benchmark.
//
// Contract: init() crops a 128x128 template around the seed box (factor 2),
// update() crops a 256x256 search window around the last box (factor 4), runs
// the model with BOTH tensors (ORT sessions are stateless - unlike OpenCV DNN,
// where setInput("template") persists across forward() calls) and decodes the
// 16x16 confidence/size/offset maps into the next box. Candidate ranking uses a
// softened Hann window. A response below the full Hann threshold still needs
// positive frozen-appearance confirmation: motion alone can depress that score.
// The caller decides when a low-score streak means the target is gone. We also reject
// a confident-but-physically-implausible step (teleport across the frame, sudden
// size jump, runaway that fills the frame) - a `rejected` update behaves like a
// low-score one (guards + rationale in track-guards.ts).
//
// Runs in a worker. No logging - per-frame hot path.

import type { OrtAssets } from "./ort-assets.js";
import { createOrtSession, type OrtModule, type OrtRuntime, runOrtSession } from "./ort-runtime.js";
import type { TrackBox } from "./track-guards.js";
import { TrackGeometry } from "./track-state.js";
import { packBgrPlanarStandardized } from "./vittrack-pixels.js";
import { captureTexture, TRACK_TEXTURE_SIZE, TrackTextureReference } from "./track-texture.js";
import { TrackAppearanceReference } from "./track-appearance.js";
import { TrackEdgeConsistency } from "./track-edge-consistency.js";
import { drawTrackingFrame, type TrackingFrame } from "./tracking-frame.js";

/** ort's Tensor instance type - both builds expose the same class. */
type OrtTensor = InstanceType<OrtModule["Tensor"]>;
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
type OrtOutputs = Awaited<ReturnType<OrtSession["run"]>>;

export type { TrackBox } from "./track-guards.js";

const TEMPLATE_SIZE = 128;
const SEARCH_SIZE = 256;
const MAP_SIZE = 16;
/** Blend the spatial prior halfway toward uniform confidence so a displaced
 * target can beat a weaker central response. */
const HANN_INFLUENCE = 0.5;
/** OpenCV default: "safe threshold to filter out black frames". */
export const VITTRACK_SCORE_THRESHOLD = 0.2;

/** hann2d(16, centered) flattened row-major - the confidence-map window that
 *  penalizes detections far from the previous position. */
function buildHannWindow(): Float32Array {
    const h1 = new Float32Array(MAP_SIZE);
    for (let i = 0; i < MAP_SIZE; i++) {
        h1[i] = 0.5 * (1 - Math.cos(((2 * Math.PI) / (MAP_SIZE + 1)) * (i + 1)));
    }
    const out = new Float32Array(MAP_SIZE * MAP_SIZE);
    for (let r = 0; r < MAP_SIZE; r++) {
        for (let c = 0; c < MAP_SIZE; c++) out[r * MAP_SIZE + c] = h1[r]! * h1[c]!;
    }
    return out;
}
const HANN = buildHannWindow();

interface CropResult {
    crop: OffscreenCanvas;
    cropSz: number;
    /** Crop origin in frame coordinates (may be negative - black padding). */
    x0: number;
    y0: number;
}

/** tracker_vit.cpp crop_image: square side ceil(sqrt(w*h)*factor) centered on
 *  the box center, black-padded where it leaves the frame. C++ integer
 *  division truncates toward zero - Math.trunc, not floor. */
function cropImage(
    frame: TrackingFrame,
    frameW: number,
    frameH: number,
    box: TrackBox,
    factor: number,
    crop: OffscreenCanvas,
): CropResult {
    const cropSz = Math.ceil(Math.sqrt(box.w * box.h) * factor);
    const x1 = box.x + Math.trunc((box.w - cropSz) / 2);
    const y1 = box.y + Math.trunc((box.h - cropSz) / 2);
    const x2 = x1 + cropSz;
    const y2 = y1 + cropSz;
    const x1pad = Math.max(0, -x1);
    const y1pad = Math.max(0, -y1);
    const x2pad = Math.max(x2 - frameW + 1, 0);
    const y2pad = Math.max(y2 - frameH + 1, 0);
    const roiW = x2 - x2pad - x1 - x1pad;
    const roiH = y2 - y2pad - y1 - y1pad;
    const side = Math.max(1, cropSz);
    if (crop.width !== side) crop.width = side;
    if (crop.height !== side) crop.height = side;
    const ctx = crop.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("vittrack: crop canvas ctx unavailable");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, crop.width, crop.height);
    if (roiW > 0 && roiH > 0) {
        drawTrackingFrame(ctx, frame, x1 + x1pad, y1 + y1pad, roiW, roiH, x1pad, y1pad, roiW, roiH);
    }
    return { crop, cropSz, x0: x1, y0: y1 };
}

interface PreprocessWorkspace {
    readonly size: number;
    readonly ctx: OffscreenCanvasRenderingContext2D;
    readonly data: Float32Array;
    readonly tensor: OrtTensor;
}

function createPreprocessWorkspace(ort: OrtModule, size: number): PreprocessWorkspace {
    const scratch = new OffscreenCanvas(size, size);
    const ctx = scratch.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("vittrack: preprocess ctx unavailable");
    const data = new Float32Array(3 * size * size);
    return { size, ctx, data, tensor: new ort.Tensor("float32", data, [1, 3, size, size]) };
}

/** Resize crop and normalize into a fixed CHW/BGR tensor workspace. */
function preprocessInto(cropCanvas: OffscreenCanvas, workspace: PreprocessWorkspace): OrtTensor {
    const { ctx, data, size } = workspace;
    ctx.drawImage(cropCanvas, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    packBgrPlanarStandardized(rgba, data);
    return workspace.tensor;
}

/** Shared model + crop/search workspaces. The worker serializes track updates, but
 *  keep the invariant executable: overlapping calls would mutate the same
 *  Float32Array while ORT owns it. Outputs stay inside the guarded callback and
 *  are always disposed after decoding. */
class VitTrackerRuntime {
    private readonly searchWorkspace: PreprocessWorkspace;
    private readonly cropCanvas = new OffscreenCanvas(1, 1);
    private inUse = false;

    constructor(
        private readonly ort: OrtModule,
        private readonly session: OrtSession,
    ) {
        this.searchWorkspace = createPreprocessWorkspace(ort, SEARCH_SIZE);
    }

    createTemplateWorkspace(): PreprocessWorkspace {
        return createPreprocessWorkspace(this.ort, TEMPLATE_SIZE);
    }

    /** Borrowed until the next crop; preprocessing consumes it before inference yields. */
    crop(frame: TrackingFrame, frameW: number, frameH: number, box: TrackBox, factor: number): CropResult {
        return cropImage(frame, frameW, frameH, box, factor, this.cropCanvas);
    }

    async runSearch<T>(template: OrtTensor, crop: OffscreenCanvas, consume: (outputs: OrtOutputs) => T): Promise<T> {
        if (this.inUse) throw new Error("vittrack: concurrent session use");
        this.inUse = true;
        let outputs: OrtOutputs | null = null;
        try {
            const search = preprocessInto(crop, this.searchWorkspace);
            outputs = await runOrtSession(this.session, { template, search });
            return consume(outputs);
        } finally {
            try {
                if (outputs) {
                    for (const tensor of Object.values(outputs)) tensor.dispose();
                }
            } finally {
                this.inUse = false;
            }
        }
    }
}

/** A loaded model that spawns independent tracks sharing one serialized
 *  inference session and search workspace. */
export class VitTrackerSession {
    private constructor(private readonly runtime: VitTrackerRuntime) {}

    /** Loads a WASM execution session. Follow uses the plain runtime build;
     *  thread count and asset paths belong to createOrtSession. */
    static async create(ortRuntime: OrtRuntime, modelUrl: string, assets: OrtAssets): Promise<VitTrackerSession> {
        const { ort, session } = await createOrtSession(ortRuntime, assets, modelUrl, { executionProviders: ["wasm"] });
        return new VitTrackerSession(new VitTrackerRuntime(ort, session));
    }

    /** A fresh single-object track bound to this session. init() before update(). */
    newTrack(): VitTrack {
        return new VitTrack(this.runtime);
    }
}

/** One Follow target: template, last box, and size cap. */
export class VitTrack {
    private readonly templateWorkspace: PreprocessWorkspace;
    private geometry: TrackGeometry | null = null;
    private readonly textureReference = new TrackTextureReference();
    private readonly appearanceReference = new TrackAppearanceReference();
    private readonly edgeConsistency = new TrackEdgeConsistency();
    private elapsedSec = 0;
    private uncertain = false;
    private readonly textureCtx: OffscreenCanvasRenderingContext2D;
    constructor(private readonly runtime: VitTrackerRuntime) {
        // Templates differ per tracked object and persist across updates; search
        // storage is larger but transient, so it lives once on the runtime.
        this.templateWorkspace = runtime.createTemplateWorkspace();
        const textureCtx = new OffscreenCanvas(TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE).getContext("2d", {
            alpha: false,
        });
        if (!textureCtx) throw new Error("vittrack: texture canvas ctx unavailable");
        this.textureCtx = textureCtx;
    }

    /** Current box (last confident position). */
    get box(): TrackBox {
        if (!this.geometry) throw new Error("vittrack: box before init");
        return this.geometry.box;
    }

    /** Seeds an independent object with its own frozen appearance and size cap. */
    init(frame: TrackingFrame, frameW: number, frameH: number, box: TrackBox): void {
        const { crop } = this.runtime.crop(frame, frameW, frameH, box, 2);
        preprocessInto(crop, this.templateWorkspace);
        this.geometry = new TrackGeometry(box, frameW, frameH);
        const sample = captureTexture(this.textureCtx, frame, frameW, frameH, box);
        this.textureReference.setSeed(sample);
        this.appearanceReference.setSeed(sample?.appearance ?? null);
        this.edgeConsistency.reset();
        this.elapsedSec = 0;
        this.uncertain = false;
    }

    /** Advances by one analyzed frame, `dtSec` seconds after the previous one.
     *  Guards accumulate time since the last accepted box. Returns the score,
     *  the box in this frame's pixels, and whether the prediction was rejected.
     *  Low-score and rejected predictions hold the last normalized position;
     *  resolution changes rebase the search geometry without replacing the template. */
    async update(
        frame: TrackingFrame,
        frameW: number,
        frameH: number,
        dtSec: number,
    ): Promise<{
        box: TrackBox;
        score: number;
        rejected: boolean;
        lost: boolean;
        diagnostics: { reason: "low-score" | "texture-collapse" | "appearance" | "geometry" | null };
    }> {
        const geometry = this.geometry;
        if (!geometry) throw new Error("vittrack: update before init");
        geometry.advanceFrame(frameW, frameH, dtSec);
        this.elapsedSec += Math.max(0, dtSec);
        if (this.edgeConsistency.lost)
            return {
                box: geometry.box,
                score: 0,
                rejected: true,
                lost: true,
                diagnostics: { reason: "appearance" },
            };
        const { crop, cropSz, x0, y0 } = this.runtime.crop(frame, frameW, frameH, geometry.box, 4);
        return this.runtime.runSearch(this.templateWorkspace.tensor, crop, (outs) => {
            const conf = outs.output1!.data as Float32Array;
            const sizeMap = outs.output2!.data as Float32Array;
            const offMap = outs.output3!.data as Float32Array;

            let maxVal = Number.NEGATIVE_INFINITY;
            let maxIdx = 0;
            for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
                const v = conf[i]! * (1 - HANN_INFLUENCE + HANN_INFLUENCE * HANN[i]!);
                if (v > maxVal) {
                    maxVal = v;
                    maxIdx = i;
                }
            }
            let rejected = false;
            let edgeReversal = false;
            let score = maxVal;
            // Relaxed ranking must not promote a distant lookalike past identity
            // checks. Keep the full Hann prior as the appearance-verification
            // gate, even when the relaxed score already clears the threshold.
            const motionPenalized =
                conf[maxIdx]! * HANN[maxIdx]! < VITTRACK_SCORE_THRESHOLD && conf[maxIdx]! >= VITTRACK_SCORE_THRESHOLD;
            let reason: "low-score" | "texture-collapse" | "appearance" | "geometry" | null =
                maxVal < VITTRACK_SCORE_THRESHOLD ? "low-score" : null;
            if (maxVal >= VITTRACK_SCORE_THRESHOLD || motionPenalized) {
                const mx = maxIdx % MAP_SIZE;
                const my = Math.trunc(maxIdx / MAP_SIZE);
                const plane = MAP_SIZE * MAP_SIZE;
                const cx = (mx + offMap[my * MAP_SIZE + mx]!) / MAP_SIZE;
                const cy = (my + offMap[plane + my * MAP_SIZE + mx]!) / MAP_SIZE;
                const w = sizeMap[my * MAP_SIZE + mx]!;
                const h = sizeMap[plane + my * MAP_SIZE + mx]!;
                const cand: TrackBox = {
                    x: Math.floor((cx - w / 2) * cropSz + x0),
                    y: Math.floor((cy - h / 2) * cropSz + y0),
                    w: Math.floor(w * cropSz),
                    h: Math.floor(h * cropSz),
                };
                // A high response after a loss, or beside an image boundary,
                // can belong to the remaining background. Verify spatial
                // appearance against the frozen seed before accepting it.
                const searchSide = Math.ceil(Math.sqrt(cand.w * cand.h) * 4);
                const cxPx = cand.x + cand.w / 2;
                const cyPx = cand.y + cand.h / 2;
                edgeReversal = this.edgeConsistency.needsVerification(cand, frameW, frameH, this.elapsedSec);
                const verifyAppearance =
                    motionPenalized ||
                    this.uncertain ||
                    this.appearanceReference.needsVerification ||
                    edgeReversal ||
                    cxPx - searchSide / 2 < 0 ||
                    cyPx - searchSide / 2 < 0 ||
                    cxPx + searchSide / 2 > frameW ||
                    cyPx + searchSide / 2 > frameH;
                const checkTexture = this.textureReference.needsCapture(cand, frameW, frameH);
                const sample =
                    checkTexture || verifyAppearance
                        ? captureTexture(this.textureCtx, frame, frameW, frameH, cand, verifyAppearance)
                        : null;
                // Confident localization, but an implausible step (teleport / balloon)
                // means the peak landed on a distractor: reject it and keep the last
                // good box so the next search stays anchored on the target.
                // A confident response on a smooth occluder can pass geometry.
                // Check the frozen appearance before moving the trusted search
                // box. The texture-collapse check skips low-texture or clipped
                // targets; appearance comparison masks off-frame padding.
                if (checkTexture && this.textureReference.rejects(sample)) {
                    rejected = true;
                    reason = "texture-collapse";
                } else if (
                    verifyAppearance &&
                    this.appearanceReference.rejects(sample?.appearance ?? null, {
                        requireConfirmation: edgeReversal,
                        provisional: motionPenalized && !edgeReversal,
                    })
                ) {
                    rejected = true;
                    reason = "appearance";
                } else {
                    rejected = !geometry.acceptCandidate(cand);
                    if (rejected) reason = "geometry";
                }
                if (!rejected && motionPenalized) {
                    score = conf[maxIdx]!;
                    reason = null;
                }
                // A weak response alone retains ordinary occlusion behavior.
                // An independently rejected reversal still arms the edge-loss
                // deadline before a distractor can inherit a larger travel budget.
                if (rejected && motionPenalized && !edgeReversal) {
                    reason = "low-score";
                }
            }
            this.uncertain = reason !== null;
            if (!this.uncertain) this.edgeConsistency.observeAccepted(geometry.box, frameW, frameH, this.elapsedSec);
            else this.edgeConsistency.observeRejected(this.elapsedSec, edgeReversal);
            return {
                box: geometry.box,
                score,
                rejected,
                lost: this.edgeConsistency.lost,
                diagnostics: { reason },
            };
        });
    }
}
