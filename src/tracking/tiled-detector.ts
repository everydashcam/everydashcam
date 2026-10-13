import type { OrtAssets } from "./ort-assets.js";
import {
    letterboxInto,
    type LetterboxMap,
    packRgbPlanarNormalized,
    type RawDetection,
    suppressOverlaps,
    type TileRect,
    tileRects,
} from "./detect-common.js";
import { createOrtSession, type OrtModule, type OrtRuntime } from "./ort-runtime.js";

type OrtTensor = InstanceType<OrtModule["Tensor"]>;
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

interface InputSlot {
    readonly data: Float32Array;
    readonly tensor: OrtTensor;
}

export interface DetectionTileOutput {
    data: Float32Array;
    dims: readonly number[];
    lb: LetterboxMap;
    tile: TileRect;
    frameW: number;
    frameH: number;
}

interface DetectorModel {
    name: string;
    inputSize: number;
    overlapIou: number;
    collect: (output: DetectionTileOutput, detections: RawDetection[]) => void;
}

/** Reuses a canvas and two input tensors, packing the next tile while the GPU
 *  processes the current one. Output decoding stays specific to each model. */
export class TiledDetector {
    private readonly scratch: OffscreenCanvas;
    private readonly inputSlots: readonly [InputSlot, InputSlot];

    private constructor(
        ort: OrtModule,
        private readonly session: OrtSession,
        private readonly model: DetectorModel,
    ) {
        const size = model.inputSize;
        this.scratch = new OffscreenCanvas(size, size);
        const makeSlot = (): InputSlot => {
            const data = new Float32Array(3 * size * size);
            return { data, tensor: new ort.Tensor("float32", data, [1, 3, size, size]) };
        };
        this.inputSlots = [makeSlot(), makeSlot()];
    }

    static async create(
        runtime: OrtRuntime,
        modelUrl: string,
        assets: OrtAssets,
        model: DetectorModel,
    ): Promise<TiledDetector> {
        const { ort, session } = await createOrtSession(runtime, assets, modelUrl, {
            executionProviders: [runtime],
            // In-graph NMS can fall back to CPU; per-node warnings are expected.
            logSeverityLevel: 3,
        });
        return new TiledDetector(ort, session, model);
    }

    async detect(
        frame: CanvasImageSource,
        frameW: number,
        frameH: number,
        tiles: readonly TileRect[] = tileRects(frameW, frameH),
    ): Promise<RawDetection[]> {
        const detections: RawDetection[] = [];
        let inFlight: { outputs: ReturnType<OrtSession["run"]>; lb: LetterboxMap; tile: TileRect } | null = null;
        const collect = async (): Promise<void> => {
            if (!inFlight) return;
            const { outputs, lb, tile } = inFlight;
            inFlight = null;
            let resolved: Awaited<typeof outputs> | null = null;
            try {
                resolved = await outputs;
                const out = resolved[this.session.outputNames[0]!];
                if (out) {
                    this.model.collect(
                        { data: out.data as Float32Array, dims: out.dims, lb, tile, frameW, frameH },
                        detections,
                    );
                }
            } finally {
                if (resolved) {
                    for (const tensor of Object.values(resolved)) tensor.dispose();
                }
            }
        };
        try {
            for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
                const tile = tiles[tileIdx]!;
                const lb = letterboxInto(
                    this.scratch,
                    frame,
                    tile.sx,
                    tile.sy,
                    tile.sw,
                    tile.sh,
                    this.model.inputSize,
                    "rgb(114,114,114)",
                    true,
                );
                const tensor = this.toTensor(this.inputSlots[tileIdx & 1]!);
                // The other slot remains owned by ORT until collect resolves.
                await collect();
                inFlight = { outputs: this.session.run({ [this.session.inputNames[0]!]: tensor }), lb, tile };
            }
            await collect();
        } catch (error) {
            // Packing can fail while the previous inference is still running.
            try {
                await collect();
            } catch {
                // Preserve the original failure after draining its outputs.
            }
            throw error;
        }
        return suppressOverlaps(detections, this.model.overlapIou);
    }

    private toTensor(slot: InputSlot): OrtTensor {
        const ctx = this.scratch.getContext("2d", { alpha: false });
        if (!ctx) throw new Error(`${this.model.name}-detector: scratch ctx unavailable`);
        const rgba = ctx.getImageData(0, 0, this.model.inputSize, this.model.inputSize).data;
        packRgbPlanarNormalized(rgba, slot.data);
        return slot.tensor;
    }
}
