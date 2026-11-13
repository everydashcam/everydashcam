import { describe, expect, it } from "vitest";

import { formatVideoTrack, probePlayback, serializePlaybackProbe } from "./diagnostics.js";
import { buildProvisionalCandidate } from "./ui/ingest-candidate.js";

function hevcCandidate(videoCodecString: string | null) {
    const candidate = buildProvisionalCandidate({
        file: {
            file: new File([new Uint8Array(16)], "20261006_133935_04883_N_A.MP4"),
            relativePath: "Normal/clip.mp4",
        },
        fingerprint: "hevc-camera",
        startUtc: 0,
        startSource: "name",
        cameraTzSec: null,
        durationSec: 300,
        records: [],
        appliedExtractors: [],
    });
    candidate.codec = "hevc";
    candidate.codecParam = "hvc1";
    candidate.videoCodecString = videoCodecString;
    candidate.width = 3840;
    candidate.height = 2160;
    candidate.fps = 30;
    return candidate;
}

describe("formatVideoTrack", () => {
    it("lists the codec string, frame size and frame rate", () => {
        expect(
            formatVideoTrack({ codec: "hevc", codecString: "hev1.2.4.L153", width: 3840, height: 2160, fps: 29.97 }),
        ).toBe("hevc hev1.2.4.L153 3840x2160@29.97");
    });

    it("keeps the bare codec when the metadata is unknown", () => {
        expect(formatVideoTrack({ codec: "h264", codecString: null, width: null, height: null, fps: null })).toBe(
            "h264",
        );
        expect(formatVideoTrack({ codec: null, codecString: null, width: null, height: null, fps: null })).toBe("?");
    });
});

describe("probePlayback", () => {
    it("probes the indexed codec string under the file's own sample entry", async () => {
        const candidate = hevcCandidate("hev1.2.4.L153");
        candidate.codecParam = "hev1";

        const probe = await probePlayback(candidate);

        expect(probe?.codecString).toBe("hev1.2.4.L153");
        expect(probe?.file).toBe("20261006_133935_04883_N_A.MP4");
    });

    it("reports browser decode APIs that this environment lacks as unavailable", async () => {
        // Node has no document, MediaSource, VideoDecoder or mediaCapabilities.
        const probe = await probePlayback(hevcCandidate("hvc1.1.6.L150"));

        expect(probe).toEqual({
            file: "20261006_133935_04883_N_A.MP4",
            codecString: "hvc1.1.6.L150",
            canPlayType: "unavailable",
            mediaSource: "unavailable",
            webCodecs: "unavailable",
            mediaCapabilities: "unavailable",
        });
    });

    it("skips a recording without a full codec string", async () => {
        expect(await probePlayback(hevcCandidate(null))).toBeNull();
    });
});

describe("serializePlaybackProbe", () => {
    it("renders each api answer on its own line", () => {
        const text = serializePlaybackProbe({
            file: "clip.mp4",
            codecString: "hvc1.2.4.L153",
            canPlayType: "no",
            mediaSource: "no",
            webCodecs: "unsupported",
            mediaCapabilities: "supported, smooth, power efficient",
        });

        expect(text.split("\n")).toEqual([
            "== playback probe ==",
            "file: clip.mp4",
            "codec string: hvc1.2.4.L153",
            "video element canPlayType: no",
            "MediaSource.isTypeSupported: no",
            "WebCodecs isConfigSupported: unsupported",
            "mediaCapabilities.decodingInfo: supported, smooth, power efficient",
        ]);
    });

    it("marks a report saved before the probe settled", () => {
        expect(serializePlaybackProbe("pending")).toBe("== playback probe ==\nstill running when the report was saved");
    });
});
