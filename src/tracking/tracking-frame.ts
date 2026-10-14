import type { VideoSample } from "mediabunny";

/** A borrowed decoded sample. The caller keeps it open until all tracking on
 * this frame has finished. Coordinates always refer to the displayed image. */
export class NativeTrackingFrame {
    readonly width: number;
    readonly height: number;
    private readonly id = Symbol();

    constructor(
        private readonly sample: VideoSample,
        private readonly workspace: NativeTrackingFrameWorkspace,
    ) {
        this.width = sample.displayWidth;
        this.height = sample.displayHeight;
    }

    drawCrop(
        target: OffscreenCanvasRenderingContext2D,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
    ): void {
        this.workspace.drawCrop(this.sample, this.id, target, sx, sy, sw, sh, dx, dy, dw, dh);
    }
}

/** Reuse the small raster workspace across serialized frames and objects.
 * It retains pixels and a cache identity, never a sample or decoder resource. */
export class NativeTrackingFrameWorkspace {
    private canvas: OffscreenCanvas | null = null;
    private ctx: OffscreenCanvasRenderingContext2D | null = null;
    private displayId: symbol | null = null;

    drawCrop(
        sample: VideoSample,
        id: symbol,
        target: OffscreenCanvasRenderingContext2D,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
    ): void {
        const frameW = sample.displayWidth;
        const frameH = sample.displayHeight;
        if (!this.canvas) {
            this.canvas = new OffscreenCanvas(1, 1);
            // Mediabunny's CanvasSink also uses alpha for Firefox: drawing a
            // VideoFrame into an opaque canvas can produce incorrect pixels.
            this.ctx = this.canvas.getContext("2d");
            if (!this.ctx) throw new Error("tracking frame canvas context is unavailable");
        }
        const ctx = this.ctx!;
        const canvas = this.canvas;
        const scaledOutsideCrop =
            (dw !== sw || dh !== sh) && (sx < 0 || sy < 0 || sx + sw > frameW || sy + sh > frameH);
        const fractionalCrop = ![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isInteger);
        if (
            this.displayId === id ||
            sample.rotation !== 0 ||
            sample.flip ||
            sample.pixelAspectRatio.num !== sample.pixelAspectRatio.den ||
            scaledOutsideCrop ||
            fractionalCrop
        ) {
            // PAR resampling and transformed rasterization must precede the
            // crop, just as they do for CanvasSink. Fractional and scaled
            // out-of-bounds crops also retain the original texture dimensions
            // to avoid GPU interpolation and source-clipping rounding changes.
            // Model predictions and their search crops use integer pixels.
            // Cache this fallback for every object on the same frame.
            if (this.displayId !== id) {
                if (canvas.width !== frameW) canvas.width = frameW;
                if (canvas.height !== frameH) canvas.height = frameH;
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, frameW, frameH);
                sample.draw(ctx, 0, 0, frameW, frameH);
                this.displayId = id;
            }
            target.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
            return;
        }

        // Convert a pixel-aligned source region before fractional cropping or
        // resizing. This keeps VideoFrame color conversion in the same order
        // as the full display canvas; the halo retains interpolation neighbors.
        const left = Math.max(0, Math.floor(sx) - 1);
        const top = Math.max(0, Math.floor(sy) - 1);
        const right = Math.min(frameW, Math.ceil(sx + sw) + 1);
        const bottom = Math.min(frameH, Math.ceil(sy + sh) + 1);
        const width = right - left;
        const height = bottom - top;
        if (!(width > 0 && height > 0)) return;
        this.displayId = null;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        sample.draw(ctx, left, top, width, height, 0, 0, width, height);
        target.drawImage(canvas, sx - left, sy - top, sw, sh, dx, dy, dw, dh);
    }
}

export type TrackingFrame = CanvasImageSource | NativeTrackingFrame;

export function createNativeTrackingFrame(
    sample: VideoSample,
    workspace = new NativeTrackingFrameWorkspace(),
): NativeTrackingFrame {
    return new NativeTrackingFrame(sample, workspace);
}

/** Draw the same display-coordinate crop from a legacy canvas or a native
 * sample. Legacy calls retain their original Canvas API path. */
export function drawTrackingFrame(
    target: OffscreenCanvasRenderingContext2D,
    frame: TrackingFrame,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
): void {
    if (frame instanceof NativeTrackingFrame) frame.drawCrop(target, sx, sy, sw, sh, dx, dy, dw, dh);
    else target.drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh);
}
