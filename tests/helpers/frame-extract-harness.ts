import { wrap } from "comlink";
import { BlobSource, CanvasSink, Input } from "mediabunny";
import { getInputTimeOrigin } from "../../src/media-time.js";
import { VIDEO_INPUT_FORMATS } from "../../src/video-formats.js";
import { getCanvasNearestForward } from "../../src/workers/canvas-seek.js";
import type { WorkerService } from "../../src/workers/_protocol/worker-rpc.js";
import type { ExtractResult } from "../../src/workers/frame-extract-protocol.js";

interface ResourceStats {
    openDecoders: number;
    openFrames: number;
    ownedBitmaps: number;
    decodeCalls: number;
    injectedFailures: number;
}

function fingerprint(image: ImageBitmap): number {
    const canvas = new OffscreenCanvas(32, 18);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, 32, 18);
    const pixels = context.getImageData(0, 0, 32, 18).data;
    return pixels.reduce((sum, byte, index) => (sum + byte * (index + 1)) >>> 0, 0);
}

export async function runFrameExtractRegression(
    workerUrl: string,
    bytes: number[],
    mode: "ordered" | "unordered" | "failure" | "cancel-bitmap",
) {
    const worker = new Worker(workerUrl, { type: "module" });
    const remote = wrap<WorkerService>(worker);
    const waitFor = <T>(test: string): Promise<T> =>
        new Promise((resolve) => {
            const listener = (event: MessageEvent): void => {
                if (event.data?.test !== test) return;
                worker.removeEventListener("message", listener);
                resolve(event.data);
            };
            worker.addEventListener("message", listener);
        });
    const file = new File([new Uint8Array(bytes)], "frame-extract.mp4");
    const input = new Input({ source: new BlobSource(file), formats: VIDEO_INPUT_FORMATS });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) return { supported: false as const };
        const timeOrigin = await getInputTimeOrigin(input);
        const duration = (await track.computeDuration()) - timeOrigin;
        const times = [0, duration * 0.15, duration * 0.3, duration * 0.6, duration * 0.8];
        const timestamps =
            mode === "unordered"
                ? [times[3]!, Number.NaN, times[0]!, times[2]!, times[2]!]
                : [-0.1, times[0]!, Number.NaN, ...times.slice(1)];
        const expected: (number | null)[] = [];
        const sink = new CanvasSink(track, { width: Math.min(await track.getDisplayWidth(), 960), poolSize: 1 });
        for (const time of timestamps) {
            if (!Number.isFinite(time)) {
                expected.push(null);
                continue;
            }
            const canvas = await getCanvasNearestForward(sink, time + timeOrigin);
            const bitmap = canvas ? await createImageBitmap(canvas.canvas) : null;
            expected.push(bitmap ? fingerprint(bitmap) : null);
            bitmap?.close();
        }
        const configured = waitFor("configured");
        worker.postMessage({
            test: "configure",
            failAtDecode: mode === "failure" ? 18 : 0,
            pauseBitmap: mode === "cancel-bitmap",
        });
        await configured;
        const bitmapCreated = mode === "cancel-bitmap" ? waitFor("bitmap-created") : null;
        const result = remote.run(1, "extract", { file, timestamps }) as Promise<ExtractResult>;
        if (bitmapCreated) {
            await bitmapCreated;
            await remote.cancel(1);
            worker.postMessage({ test: "release-bitmap" });
        }
        const { bitmaps } = await result;
        const actual = bitmaps.map((bitmap) => (bitmap ? fingerprint(bitmap) : null));
        for (const bitmap of bitmaps) bitmap?.close();
        // Check iterator cleanup before disposing the cached Input, which would
        // otherwise hide a leaked decoder or prefetched VideoFrame.
        const settledStatsPromise = waitFor<ResourceStats>("stats");
        worker.postMessage({ test: "stats" });
        const settledStats = await settledStatsPromise;
        await remote.notify("dispose-all", undefined);
        // The second request is ordered behind dispose-all and has no decode work.
        await remote.run(2, "extract", { file, timestamps: [] });
        const statsPromise = waitFor<ResourceStats>("stats");
        worker.postMessage({ test: "stats" });
        const stats = await statsPromise;
        return { supported: true as const, actual, expected, settledStats, stats };
    } finally {
        input.dispose();
        worker.terminate();
    }
}
