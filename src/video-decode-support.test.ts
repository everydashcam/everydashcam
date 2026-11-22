import { afterEach, describe, expect, it, vi } from "vitest";
import { canDecodeVideoStream, videoStreamDecodeKey } from "./video-decode-support.js";

// Node has no WebCodecs; each test supplies the platform probe it needs.
function stubVideoDecoder(supportedCodecs: readonly string[]): VideoDecoderConfig[] {
    const probed: VideoDecoderConfig[] = [];
    vi.stubGlobal("VideoDecoder", {
        isConfigSupported: async (config: VideoDecoderConfig) => {
            probed.push(config);
            return { supported: supportedCodecs.includes(config.codec), config };
        },
    });
    return probed;
}

describe("canDecodeVideoStream", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("probes the indexed codec string at the coded frame size", async () => {
        const probed = stubVideoDecoder(["avc1.640028"]);
        const supported = await canDecodeVideoStream({
            codec: "avc",
            codecString: "avc1.640028",
            width: 1920,
            height: 1080,
        });
        expect(supported).toBe(true);
        expect(probed).toEqual([{ codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080 }]);
    });

    it("reports a codec string the decoder rejects", async () => {
        stubVideoDecoder([]);
        expect(
            await canDecodeVideoStream({ codec: "hevc", codecString: "hvc1.2.4.L153", width: 3840, height: 2160 }),
        ).toBe(false);
    });

    it("leaves the frame size out when the indexer has none", async () => {
        const probed = stubVideoDecoder(["vp09.00.10.08"]);
        await canDecodeVideoStream({ codec: "vp9", codecString: "vp09.00.10.08", width: null, height: 0 });
        expect(probed).toEqual([{ codec: "vp09.00.10.08" }]);
    });

    it("stays optimistic without a codec string", async () => {
        const probed = stubVideoDecoder([]);
        expect(await canDecodeVideoStream({ codec: "avc", codecString: null, width: 1280, height: 720 })).toBe(true);
        expect(probed, "no probe without a codec string").toEqual([]);
    });

    it("reports no support without WebCodecs", async () => {
        vi.stubGlobal("VideoDecoder", undefined);
        expect(await canDecodeVideoStream({ codec: "avc", codecString: "avc1.42e01e", width: 640, height: 360 })).toBe(
            false,
        );
    });
});

describe("videoStreamDecodeKey", () => {
    it("separates equal codec strings at different frame sizes", () => {
        const fullHd = videoStreamDecodeKey({ codec: "avc", codecString: "avc1.640033", width: 1920, height: 1080 });
        const uhd = videoStreamDecodeKey({ codec: "avc", codecString: "avc1.640033", width: 3840, height: 2160 });
        expect(fullHd).not.toBe(uhd);
    });

    it("falls back to the codec enum without a codec string", () => {
        expect(videoStreamDecodeKey({ codec: "vp9", codecString: null, width: null, height: null })).toBe("vp9@0x0");
    });
});
