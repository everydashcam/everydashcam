import { describe, expect, it } from "vitest";

import type { IndexedMp4 } from "../workers/indexer-protocol.js";
import { applyIndexedMetadata, buildProvisionalCandidate, checkCanPlay } from "./ingest-candidate.js";

describe("checkCanPlay", () => {
    it("keeps HEVC playable when the native path can outlive a WebCodecs rejection", async () => {
        const candidate = buildProvisionalCandidate({
            file: {
                file: new File([new Uint8Array(16)], "clip.mp4"),
                relativePath: "CARD/clip.mp4",
            },
            fingerprint: "hevc-camera",
            startUtc: 0,
            startSource: "name",
            cameraTzSec: null,
            durationSec: 60,
            records: [],
            appliedExtractors: [],
        });
        candidate.codec = "hevc";
        candidate.codecParam = "hvc1";
        candidate.videoCodecString = "hev1.1.6.L150";
        candidate.canPlay = false;

        await checkCanPlay([candidate]);

        expect(candidate.canPlay).toBe(true);
    });
});

describe("applyIndexedMetadata", () => {
    const indexed: IndexedMp4 = {
        durationSec: 60,
        createdUtc: null,
        codec: "hevc",
        codecParam: null,
        videoCodecString: "hev1.1.6.L150.90",
        rotation: 0,
        width: 1344,
        height: 760,
        fps: 20,
        audio: null,
        needsHevcRemux: false,
        audioNeedsTranscode: false,
    };

    function rawStreamCandidate() {
        return buildProvisionalCandidate({
            file: { file: new File([new Uint8Array(16)], "fcamera.hevc"), relativePath: "r--7/fcamera.hevc" },
            fingerprint: "openpilot|",
            startUtc: 0,
            startSource: "mtime",
            cameraTzSec: null,
            durationSec: 60,
            records: [],
            appliedExtractors: [],
        });
    }

    it("keeps the duration a log counted over the indexer's nominal one", () => {
        const candidate = rawStreamCandidate();
        candidate.logDurationSec = 3;
        applyIndexedMetadata(candidate, indexed, undefined);
        expect(candidate.durationSec).toBe(3);
        expect(candidate.codec).toBe("hevc");
    });

    it("takes the indexer's duration when no log counted the frames", () => {
        const candidate = rawStreamCandidate();
        applyIndexedMetadata(candidate, { ...indexed, durationSec: 59.5 }, undefined);
        expect(candidate.durationSec).toBe(59.5);
    });
});
