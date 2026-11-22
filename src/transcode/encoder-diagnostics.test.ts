import { EncodedPacket } from "../mediabunny.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, getLogBuffer } from "../log.js";
import { createVideoEncodingDiagnostics } from "./encoder-diagnostics.js";

beforeEach(() => {
    _resetForTests();
    vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("video encoding diagnostics", () => {
    it("measures video packets by presentation span despite decode order and a nonzero origin", () => {
        const diagnostics = createVideoEncodingDiagnostics();
        diagnostics.onEncoderConfig({ codec: "avc1.640028", width: 1920, height: 1080, bitrate: 160_000 });
        const config = {
            codec: "avc1.640028",
            codedWidth: 1920,
            codedHeight: 1080,
            description: new Uint8Array([1, 2, 3]),
        };
        diagnostics.onEncodedPacket(new EncodedPacket(new Uint8Array(1200), "key", 10, 0.1), { decoderConfig: config });
        diagnostics.onEncodedPacket(new EncodedPacket(new Uint8Array(1000), "delta", 10.2, 0.1), undefined);
        diagnostics.onEncodedPacket(new EncodedPacket(new Uint8Array(800), "delta", 10.1, 0.1), undefined);
        const summary = diagnostics.summarize();
        expect(summary).toEqual({
            encoderConfigCount: 1,
            videoPackets: 3,
            videoKeyPackets: 1,
            videoBytes: 3000,
            videoDurationSec: 0.3,
            videoBitrateKbps: 80,
            videoTargetRatio: 0.5,
            encodedCodec: "avc1.640028",
            encodedWidth: 1920,
            encodedHeight: 1080,
        });
        expect(getLogBuffer(), "packets do not generate per-frame log records").toHaveLength(1);
        expect(getLogBuffer()[0]?.msg).toBe("video encoder config requested");
        expect(JSON.stringify(summary)).not.toContain("description");
    });

    it("does not claim a bitrate for empty or zero-duration output", () => {
        const diagnostics = createVideoEncodingDiagnostics();
        expect(diagnostics.summarize()).toMatchObject({
            videoPackets: 0,
            videoDurationSec: 0,
            videoBitrateKbps: null,
            videoTargetRatio: null,
        });
        diagnostics.onEncodedPacket(new EncodedPacket(new Uint8Array(100), "key", 0, 0), undefined);
        expect(diagnostics.summarize()).toMatchObject({ videoPackets: 1, videoDurationSec: 0, videoBitrateKbps: null });
    });

    it("keeps export counters separate and records repeated encoder configuration", () => {
        const first = createVideoEncodingDiagnostics();
        const second = createVideoEncodingDiagnostics();
        const config = { codec: "avc1.640028", width: 1920, height: 1080, bitrate: 1_000_000 };
        first.onEncoderConfig(config);
        first.onEncoderConfig(config);
        first.onEncodedPacket(new EncodedPacket(new Uint8Array(100), "key", 0, 0.04), undefined);
        expect(first.summarize()).toMatchObject({ encoderConfigCount: 2, videoPackets: 1 });
        expect(second.summarize()).toMatchObject({ encoderConfigCount: 0, videoPackets: 0 });
    });
});
