import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexedMp4, IndexerRepair } from "../workers/indexer-protocol.js";
import {
    _resetForTests,
    applyIndexedMetadata,
    buildProvisionalCandidate,
    checkCanPlay,
    discardIndexedMetadata,
} from "./ingest-candidate.js";

function buildIndexedCandidate(name: string): ReturnType<typeof buildProvisionalCandidate> {
    return buildProvisionalCandidate({
        file: {
            file: new File([new Uint8Array(16)], name),
            relativePath: `CARD/${name}`,
        },
        fingerprint: name,
        startUtc: 0,
        startSource: "name",
        cameraTzSec: null,
        durationSec: 60,
        records: [],
        appliedExtractors: [],
    });
}

describe("checkCanPlay", () => {
    beforeEach(() => {
        _resetForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps HEVC playable when the native path can outlive a WebCodecs rejection", async () => {
        const candidate = buildIndexedCandidate("clip.mp4");
        candidate.codec = "hevc";
        candidate.codecParam = "hvc1";
        candidate.videoCodecString = "hev1.1.6.L150";
        candidate.canPlay = false;

        await checkCanPlay([candidate]);

        expect(candidate.canPlay).toBe(true);
    });

    it("rejects an H.264 profile the decoder lacks and probes each stream shape once", async () => {
        const probedCodecs: string[] = [];
        // Node has no WebCodecs; this decoder handles Main but not High 10.
        vi.stubGlobal("VideoDecoder", {
            isConfigSupported: async (config: VideoDecoderConfig) => {
                probedCodecs.push(config.codec);
                return { supported: config.codec === "avc1.4d401f", config };
            },
        });
        const main = ["a.mp4", "b.mp4"].map((name) => {
            const candidate = buildIndexedCandidate(name);
            candidate.codec = "avc";
            candidate.videoCodecString = "avc1.4d401f";
            candidate.width = 1280;
            candidate.height = 720;
            return candidate;
        });
        const high10 = buildIndexedCandidate("c.mp4");
        high10.codec = "avc";
        high10.videoCodecString = "avc1.6e0028";
        high10.width = 1920;
        high10.height = 1080;

        await checkCanPlay([...main, high10]);

        expect(main.map((candidate) => candidate.canPlay)).toEqual([true, true]);
        expect(high10.canPlay).toBe(false);
        expect(probedCodecs.sort()).toEqual(["avc1.4d401f", "avc1.6e0028"]);
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
