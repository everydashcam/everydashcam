import { type BlurRegion, regionRectAt } from "../../src/blur-regions.js";
import { PerFileMseBackend } from "../../src/per-file-mse.js";
import { paintRegionBlur } from "../../src/transcode/compose.js";

interface MotionFixture {
    width: number;
    height: number;
    durationSec: number;
    frames: Array<{ contentSec: number; box: { x: number; y: number; w: number; h: number } }>;
}

/** Known geometry is input data. MSE, compositor timestamps, HOLD selection and painting stay real. */
export async function checkMseBlurPreview(bytes: number[], motion: MotionFixture) {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.width = motion.width;
    video.height = motion.height;
    const canvas = document.createElement("canvas");
    canvas.width = motion.width;
    canvas.height = motion.height;
    document.body.append(video, canvas);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas unavailable");
    const file = new File([new Uint8Array(bytes)], "moving-card.TS", { type: "video/mp2t" });
    const backend = new PerFileMseBackend({ file, durationSec: motion.durationSec });
    const region: BlurRegion = {
        id: "known-moving-card",
        channel: "front",
        style: "fill",
        startSec: 0,
        endSec: motion.durationSec,
        autoEnd: false,
        lastTrackLost: false,
        interpolation: "hold",
        keyframes: motion.frames.map(({ contentSec, box }) => ({
            contentSec,
            pinned: false,
            rect: {
                xPct: box.x / motion.width,
                yPct: box.y / motion.height,
                wPct: box.w / motion.width,
                hPct: box.h / motion.height,
            },
        })),
    };
    const ready = new Promise<void>((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("mse video failed")), { once: true });
    });
    // loadeddata can precede the first compositor submission. Consume that
    // frame before seeking so its callback cannot satisfy the target-frame wait.
    const firstPresented = new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
    const results = [];
    try {
        await backend.attach(video);
        await Promise.all([ready, firstPresented]);
        video.pause();
        for (const index of [4, 5]) {
            const target = motion.frames[index]!;
            const previous = motion.frames[index - 1]!;
            const presented = new Promise<VideoFrameCallbackMetadata>((resolve) =>
                video.requestVideoFrameCallback((_, metadata) => resolve(metadata)),
            );
            const seeked = new Promise<void>((resolve) =>
                video.addEventListener("seeked", () => resolve(), { once: true }),
            );
            // Consecutive paused source frames, with a seek safely inside each
            // frame's interval. Geometry still uses the actual compositor PTS.
            video.currentTime = target.contentSec + 0.001;
            const [metadata] = await Promise.all([presented, seeked]);
            ctx.drawImage(video, 0, 0, motion.width, motion.height);
            const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
            const rawLeadingPixel = pixel(target.box.x + target.box.w - 5, target.box.y + 10);
            const previousOnly = { x: previous.box.x + 5, y: previous.box.y + 10 };
            const rawPreviousPixel = pixel(previousOnly.x, previousOnly.y);
            const rect = regionRectAt(region, metadata.mediaTime);
            if (!rect) throw new Error("held region missing");
            const box = {
                x: rect.xPct * motion.width,
                y: rect.yPct * motion.height,
                w: rect.wPct * motion.width,
                h: rect.hPct * motion.height,
            };
            paintRegionBlur(ctx, video, box, box, "fill", null);
            const pixels = ctx.getImageData(target.box.x + 2, target.box.y + 2, target.box.w - 4, target.box.h - 4);
            let blackPixels = 0;
            for (let offset = 0; offset < pixels.data.length; offset += 4) {
                if (pixels.data[offset] === 0 && pixels.data[offset + 1] === 0 && pixels.data[offset + 2] === 0)
                    blackPixels++;
            }
            results.push({
                sourceTime: target.contentSec,
                mediaTime: metadata.mediaTime,
                paused: video.paused,
                selectedBox: box,
                expectedBox: target.box,
                rawLeadingPixel,
                rawPreviousPixel,
                paintedPreviousPixel: pixel(previousOnly.x, previousOnly.y),
                coveredFraction: blackPixels / (pixels.width * pixels.height),
            });
        }
        return results;
    } finally {
        await backend.dispose();
        video.remove();
    }
}
