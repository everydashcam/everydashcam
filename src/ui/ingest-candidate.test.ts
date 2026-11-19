import { describe, expect, it } from "vitest";

import type { IndexedMp4, IndexerRepair } from "../workers/indexer-protocol.js";
import {
    applyIndexedMetadata,
    buildProvisionalCandidate,
    checkCanPlay,
    discardIndexedMetadata,
} from "./ingest-candidate.js";

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

    it.each([
        { reason: "header", hvccRepaired: true, hvccProfileRestored: false },
        { reason: "arrays", hvccRepaired: true, hvccProfileRestored: false },
        { reason: "profile", hvccRepaired: false, hvccProfileRestored: true },
    ] as const)("reports a $reason hvcC repair to the damaged-file count: $hvccRepaired", (expected) => {
        const candidate = rawStreamCandidate();
        const repair: IndexerRepair = {
            patchedMoov: new Uint8Array([1, 2, 3, 4]),
            moovFileStart: 4,
            moovFileEnd: 8,
            phantomNeutralized: [],
            hvcc: { needsHevcRemux: false, reason: expected.reason, videoCodecString: "hvc1.1.6.L150" },
        };
        const applied = applyIndexedMetadata(candidate, indexed, repair);
        expect(applied).toEqual({
            phantomRepaired: false,
            hvccRepaired: expected.hvccRepaired,
            hvccProfileRestored: expected.hvccProfileRestored,
        });
        expect(candidate.file.size, "patched file keeps its size").toBe(16);
    });

    it("returns a discarded repaired read to its source file", () => {
        const candidate = rawStreamCandidate();
        const sourceFile = candidate.file;
        const repair: IndexerRepair = {
            patchedMoov: new Uint8Array([1, 2, 3, 4]),
            moovFileStart: 4,
            moovFileEnd: 8,
            phantomNeutralized: ["soun"],
            hvcc: null,
        };
        applyIndexedMetadata(candidate, indexed, repair);
        applyIndexedMetadata(candidate, indexed, repair);
        expect(candidate.file, "a repair swaps in a patched view").not.toBe(sourceFile);

        discardIndexedMetadata(candidate);

        expect(candidate.file, "the next read indexes the unrepaired bytes").toBe(sourceFile);
        expect(candidate.metadataReady).toBe(false);
    });
});
