// Real worker entry with native-resource instrumentation and one-shot hardware
// faults. The production RPC handler and Mediabunny decoding run unchanged.
import "../../src/workers/frame-extract-worker.js";

const NativeDecoder = globalThis.VideoDecoder;
const nativeBitmap = globalThis.createImageBitmap.bind(globalThis);
const decoders = new Set<VideoDecoder>();
const frames = new Set<VideoFrame>();
const bitmaps: ImageBitmap[] = [];
let decodeCalls = 0;
let failAtDecode = 0;
let pauseBitmap = false;
let releaseBitmap: (() => void) | null = null;
let injectedFailures = 0;

globalThis.VideoDecoder = class extends NativeDecoder {
    constructor(init: VideoDecoderInit) {
        super({
            ...init,
            output(frame) {
                frames.add(frame);
                const close = frame.close.bind(frame);
                frame.close = () => {
                    frames.delete(frame);
                    close();
                };
                init.output(frame);
            },
        });
        decoders.add(this);
    }
    override decode(chunk: EncodedVideoChunk): void {
        decodeCalls++;
        if (decodeCalls === failAtDecode) {
            injectedFailures++;
            throw new DOMException("injected decoder failure", "EncodingError");
        }
        super.decode(chunk);
    }
    override close(): void {
        decoders.delete(this);
        super.close();
    }
};

Object.defineProperty(globalThis, "createImageBitmap", {
    value: async (source: ImageBitmapSource, options?: ImageBitmapOptions): Promise<ImageBitmap> => {
        const bitmap = await nativeBitmap(source, options);
        bitmaps.push(bitmap);
        if (pauseBitmap) {
            pauseBitmap = false;
            await new Promise<void>((resolve) => {
                releaseBitmap = resolve;
                globalThis.postMessage({ test: "bitmap-created" });
            });
        }
        return bitmap;
    },
});

globalThis.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (message?.test === "configure") {
        failAtDecode = message.failAtDecode ?? 0;
        pauseBitmap = message.pauseBitmap ?? false;
        globalThis.postMessage({ test: "configured" });
    } else if (message?.test === "release-bitmap") {
        releaseBitmap?.();
        releaseBitmap = null;
    } else if (message?.test === "stats") {
        globalThis.postMessage({
            test: "stats",
            openDecoders: [...decoders].filter((decoder) => decoder.state !== "closed").length,
            openFrames: frames.size,
            ownedBitmaps: bitmaps.filter((bitmap) => bitmap.width > 0).length,
            decodeCalls,
            injectedFailures,
        });
    }
});
