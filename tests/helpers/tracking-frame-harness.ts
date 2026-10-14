import { type Rotation, VideoSample } from "mediabunny";
import {
    createNativeTrackingFrame,
    drawTrackingFrame,
    NativeTrackingFrameWorkspace,
} from "../../src/tracking/tracking-frame.js";

interface SampleConfig {
    format: "RGBA" | "I420" | "NV12";
    rotation: Rotation;
    flip: boolean;
    par: number;
    width: number;
    height: number;
}

function makeSample({ format, rotation, flip, par, width, height }: SampleConfig, phase: number): VideoSample {
    const plane = width * height;
    const bytes = new Uint8Array(format === "RGBA" ? plane * 4 : (plane * 3) / 2);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (format === "RGBA")
                bytes.set(
                    [(x * 11 + phase) % 256, (y * 13 + phase) % 256, (x * 7 + y * 3 + phase) % 256, 255],
                    index * 4,
                );
            else bytes[index] = 32 + ((x * 3 + y * 5 + phase) % 192);
        }
    }
    if (format === "I420") {
        for (let index = 0; index < plane / 4; index++) {
            bytes[plane + index] = 64 + ((index * 7) % 128);
            bytes[plane + plane / 4 + index] = 64 + ((index * 11) % 128);
        }
    }
    if (format === "NV12") {
        for (let index = 0; index < plane / 4; index++) {
            bytes[plane + index * 2] = 64 + ((index * 7) % 128);
            bytes[plane + index * 2 + 1] = 64 + ((index * 11) % 128);
        }
    }
    const frame = new VideoFrame(bytes, {
        format,
        codedWidth: width,
        codedHeight: height,
        displayWidth: width * par,
        displayHeight: height,
        timestamp: 0,
        colorSpace:
            format === "RGBA"
                ? { primaries: "bt709", transfer: "iec61966-2-1", matrix: "rgb", fullRange: true }
                : { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    });
    return new VideoSample(frame, { rotation, flip });
}

export function compareTrackingFrameCrops() {
    const results: Array<{
        format: string;
        rotation: number;
        flip: boolean;
        par: number;
        width: number;
        height: number;
        expectedWidth: number;
        expectedHeight: number;
        comparisons: number;
        differentBytes: number;
        maxError: number;
        errors: Array<{ crop: number[]; size: number[]; differentBytes: number; maxError: number }>;
    }> = [];
    const configs: SampleConfig[] = [];
    for (const format of ["RGBA", "I420"] as const) {
        for (const rotation of [0, 90, 180, 270] as const) {
            for (const flip of [false, true]) {
                for (const par of [1, 1.5]) configs.push({ format, rotation, flip, par, width: 128, height: 96 });
            }
        }
        configs.push({ format, rotation: 0, flip: false, par: 1, width: 3840, height: 2160 });
    }
    const workspace = new NativeTrackingFrameWorkspace();
    configs.push(
        { format: "NV12", rotation: 0, flip: false, par: 1, width: 128, height: 96 },
        { format: "NV12", rotation: 90, flip: true, par: 1.5, width: 128, height: 96 },
        { format: "NV12", rotation: 0, flip: false, par: 1, width: 3840, height: 2160 },
    );
    for (const [phase, config] of configs.entries()) {
        const { format, rotation, flip, par } = config;
        const sample = makeSample(config, phase * 17);
        try {
            const native = createNativeTrackingFrame(sample, workspace);
            const display = new OffscreenCanvas(native.width, native.height);
            const displayCtx = display.getContext("2d")!;
            displayCtx.fillStyle = "#000";
            displayCtx.fillRect(0, 0, display.width, display.height);
            sample.draw(displayCtx, 0, 0, display.width, display.height);
            const crops = [
                [8, 10, 48, 36],
                [7.25, 9.75, 37.5, 25.25],
                [native.width / 2 + 0.17, native.height / 2 + 0.39, 45, 37],
                [-6.25, 5, 42, 33],
                [5, -6.25, 42, 33],
                [native.width - 12.5, native.height - 10.25, 30, 25],
                [native.width + 2, 5, 20, 20],
            ];
            let differentBytes = 0;
            let maxError = 0;
            let comparisons = 0;
            const errors = [];
            const draws = crops.flatMap((crop) =>
                [
                    [32, 32, 0, 0, 32, 32],
                    [128, 128, 0, 0, 128, 128],
                    [256, 256, 0, 0, 256, 256],
                    [Math.ceil(crop[2]!), Math.ceil(crop[3]!), 0, 0, crop[2]!, crop[3]!],
                    [128, 128, 3.25, 4.75, crop[2]!, crop[3]!],
                ].map((layout) => ({ crop, layout, reuse: false })),
            );
            // The same wrapper must survive ROI -> full-display fallback ->
            // another ROI without treating the old small canvas as a frame.
            draws.push(
                { crop: [8, 10, 48, 36], layout: [64, 64, 0, 0, 64, 64], reuse: true },
                { crop: [-6.25, 5, 42, 33], layout: [64, 64, 0, 0, 64, 64], reuse: true },
                { crop: [native.width / 2, native.height / 2, 40, 30], layout: [64, 64, 0, 0, 64, 64], reuse: true },
            );
            for (const { crop, layout, reuse } of draws) {
                const [width, height, dx, dy, dw, dh] = layout;
                const expected = new OffscreenCanvas(width!, height!);
                const actual = new OffscreenCanvas(width!, height!);
                const expectedCtx = expected.getContext("2d", { alpha: false })!;
                const actualCtx = actual.getContext("2d", { alpha: false })!;
                for (const ctx of [expectedCtx, actualCtx]) {
                    ctx.fillStyle = "#000";
                    ctx.fillRect(0, 0, width!, height!);
                }
                const [x, y, w, h] = crop as [number, number, number, number];
                // The old path rasterizes the displayed frame
                // before either crop or resize takes place.
                expectedCtx.drawImage(display, x, y, w, h, dx!, dy!, dw!, dh!);
                drawTrackingFrame(
                    actualCtx,
                    reuse ? native : createNativeTrackingFrame(sample, workspace),
                    x,
                    y,
                    w,
                    h,
                    dx!,
                    dy!,
                    dw!,
                    dh!,
                );
                const a = expectedCtx.getImageData(0, 0, width!, height!).data;
                const b = actualCtx.getImageData(0, 0, width!, height!).data;
                let caseDifferent = 0;
                let caseMax = 0;
                for (let index = 0; index < a.length; index++) {
                    const error = Math.abs(a[index]! - b[index]!);
                    if (error !== 0) differentBytes++;
                    if (error !== 0) caseDifferent++;
                    maxError = Math.max(maxError, error);
                    caseMax = Math.max(caseMax, error);
                }
                if (caseDifferent)
                    errors.push({
                        crop,
                        size: [width!, height!],
                        differentBytes: caseDifferent,
                        maxError: caseMax,
                    });
                comparisons++;
            }
            results.push({
                format,
                rotation,
                flip,
                par,
                width: native.width,
                height: native.height,
                expectedWidth: rotation % 180 === 0 ? config.width * par : config.height,
                expectedHeight: rotation % 180 === 0 ? config.height : config.width * par,
                comparisons,
                differentBytes,
                maxError,
                errors,
            });
        } finally {
            sample.close();
        }
    }
    return results;
}
