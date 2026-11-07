import { VideoSample } from "mediabunny";
import type { CameraFlip } from "../../src/camera-flip.js";
import {
    createBlurHelper,
    createRegionBlurHelper,
    drawCameraComposition,
    drawMain,
} from "../../src/transcode/compose.js";

export function renderFlippedFrames() {
    const source = new OffscreenCanvas(80, 60);
    const sourceCtx = source.getContext("2d")!;
    for (const [index, color] of ["#f00", "#0f0", "#00f", "#ff0"].entries()) {
        sourceCtx.fillStyle = color;
        sourceCtx.fillRect((index % 2) * 40, Math.floor(index / 2) * 30, 40, 30);
    }
    const sample = new VideoSample(source, { timestamp: 0 });
    const canvas = new OffscreenCanvas(160, 120);
    const ctx = canvas.getContext("2d")!;
    const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    const flips: CameraFlip[] = [
        { horizontal: false, vertical: false },
        { horizontal: true, vertical: false },
        { horizontal: false, vertical: true },
        { horizontal: true, vertical: true },
    ];
    try {
        const corners = flips.map((flip) => {
            drawMain(ctx, sample, null, 160, 120, undefined, undefined, flip);
            // An overlay drawn by the caller must retain its position and orientation.
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, 5, 5);
            return { corners: [pixel(20, 20), pixel(140, 20), pixel(20, 100), pixel(140, 100)], overlay: pixel(2, 2) };
        });
        drawMain(ctx, sample, { xPct: 0, yPct: 0, wPct: 0.5, hPct: 0.5 }, 160, 120, undefined, undefined, flips[3]);
        const crop = pixel(80, 60);
        const regions = [{ rect: { xPct: 0, yPct: 0, wPct: 0.5, hPct: 0.5 }, style: "fill" as const }];
        drawMain(ctx, sample, null, 160, 120, { regionBlurHelper: createRegionBlurHelper() }, regions, flips[3]);
        const privacy = [pixel(20, 20), pixel(140, 100)];
        drawMain(
            ctx,
            sample,
            null,
            160,
            120,
            { regionBlurHelper: createRegionBlurHelper() },
            [{ ...regions[0]!, style: "pixelate" }],
            flips[0],
        );
        const mosaicBefore = pixel(20, 20);
        drawMain(
            ctx,
            sample,
            null,
            160,
            120,
            { regionBlurHelper: createRegionBlurHelper() },
            [{ ...regions[0]!, style: "pixelate" }],
            flips[3],
        );
        const mosaicAfter = pixel(140, 100);
        // Two cameras side by side, the second as a rounded window, over a
        // blurred backdrop: each keeps its own reflection.
        drawCameraComposition(
            ctx,
            [
                { channel: "front", role: "equal", overlay: false, x: 0, y: 30, w: 80, h: 60 },
                { channel: "rear", role: "equal", overlay: true, x: 80, y: 30, w: 80, h: 60 },
            ],
            {
                front: { sample, crop: null, flip: flips[1], regionBlurs: null },
                rear: { sample, crop: null, flip: flips[2], regionBlurs: null },
            },
            "front",
            160,
            120,
            { fill: "blur", blurHelper: createBlurHelper() },
        );
        const split = [pixel(10, 40), pixel(70, 80), pixel(90, 40), pixel(150, 80)];
        return { corners, crop, privacy, mosaicBefore, mosaicAfter, split };
    } finally {
        sample.close();
    }
}
