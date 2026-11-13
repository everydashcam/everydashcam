// Integration tests for the indexer's non-ISOBMFF branch (MPEG-TS + Matroska).
//
// MP4 path is exercised indirectly through trips/registry/vendor tests
// (every snapshot test builds an Mp4Index, which shares findMoovInFile with
// the indexer). The TS/MKV path has no such overlap - if mediabunny's
// MPEG_TS / MATROSKA input formats regress or the indexNonIsobmffFile wrapper
// drops a code path, nothing else in the test suite would catch it. Hence a
// dedicated check.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { indexOneFile } from "./parsers/internal/mp4-indexing.js";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "parsers/__fixtures__/generic");
const LIGOGPS_TS_FIXTURES_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "parsers/__fixtures__/ligogps-trailer-ts",
);

// Tests the indexing logic directly (mp4-indexing.ts) rather than going
// through indexer.ts → Worker - Worker is undefined in node, but the
// indexing logic itself is environment-agnostic and that is what we want
// to lock down (the wire layer is covered by worker-client.test.ts).
describe("indexer: MPEG-TS branch", () => {
    it("indexes paired GPS tables followed by large zero preallocation", async () => {
        const bytes = readFileSync(resolve(LIGOGPS_TS_FIXTURES_DIR, "real-anonymized-paired.TS"));
        const file = new File([bytes, new Uint8Array(40 * 1024 * 1024)], "20261008_095348_f.ts");
        const { indexed } = await indexOneFile(file, false);
        expect(indexed).not.toBeNull();
        expect(indexed!.durationSec).toBeGreaterThan(1.9);
        expect(indexed!.durationSec).toBeLessThan(2.3);
        expect(indexed!.codec).toBe("avc");
        expect(indexed!.audio?.codec).toBe("aac");
    });

    it("extracts duration, codec and intended frame rate from a generated .TS fixture", async () => {
        const buf = readFileSync(resolve(FIXTURES_DIR, "20260511134011_073648A.TS"));
        const file = new File([buf], "20260511134011_073648A.TS");
        const { indexed } = await indexOneFile(file, false);
        expect(indexed).not.toBeNull();
        // The transport clock offset must not add blank time to the recording.
        expect(indexed!.durationSec).toBeGreaterThan(4.5);
        expect(indexed!.durationSec).toBeLessThan(5.5);
        expect(indexed!.codec).toBe("hevc");
        expect(indexed!.fps).toBe(30);
        // Full RFC 6381 string from mediabunny.getCodecParameterString - feeds
        // the config-aware canPlay check. A transport stream has no sample
        // entry and may repeat parameter sets in band, so mediabunny says hev1.
        expect(indexed!.videoCodecString).toMatch(/^hev1\./);
        // TS has no mvhd, so creation_time and rotation are explicitly null/0.
        expect(indexed!.createdUtc).toBeNull();
        expect(indexed!.rotation).toBe(0);
        // needsHevcRemux is left false on the TS path - the player forces MSE
        // via the orthogonal isTransportStream flag, not this one.
        expect(indexed!.needsHevcRemux).toBe(false);
    });

    it("clamps the ampersand LigoGPS trailer before mediabunny scans the stream", async () => {
        const buf = readFileSync(resolve(LIGOGPS_TS_FIXTURES_DIR, "real-anonymized-ampersand.TS"));
        const file = new File([buf], "2026081822373512_f.ts");
        const { indexed } = await indexOneFile(file, false);
        expect(indexed).not.toBeNull();
        expect(indexed!.durationSec).toBeGreaterThan(0);
        expect(indexed!.codec).toBe("hevc");
    });

    it("indexes an empty LCAI trailer with retained capacity", async () => {
        const buf = readFileSync(resolve(LIGOGPS_TS_FIXTURES_DIR, "real-anonymized-empty-capacity.TS"));
        const file = new File([buf], "20260904_205125F.ts");
        const { indexed } = await indexOneFile(file, false);
        expect(indexed).not.toBeNull();
        expect(indexed!.durationSec).toBeGreaterThan(2);
        expect(indexed!.codec).toBe("avc");
    });
});

describe("indexer: Matroska branch", () => {
    it("extracts duration, codec and intended frame rate from a generated .mkv fixture", async () => {
        const buf = readFileSync(resolve(FIXTURES_DIR, "clip-h264.mkv"));
        const file = new File([buf], "clip-h264.mkv");
        const { indexed, moovBytes } = await indexOneFile(file, true);
        expect(indexed).not.toBeNull();
        // 2 s fixture (make-mkv-fixture.mjs). mediabunny computeDuration on
        // Matroska reads the segment duration, so it lands close to wall-clock;
        // keep a tolerant band rather than nailing the exact value.
        expect(indexed!.durationSec).toBeGreaterThan(1.5);
        expect(indexed!.durationSec).toBeLessThan(3.0);
        expect(indexed!.codec).toBe("avc");
        // The Matroska timebase makes packetCount/duration come out as 29.995;
        // timestamp-lattice inference recovers the camera's intended 30 fps.
        expect(indexed!.fps).toBe(30);
        // Full RFC 6381 string feeds the config-aware canPlay check.
        expect(indexed!.videoCodecString).toMatch(/^avc1\./);
        // Matroska has no moov, so the wall-clock/rotation fields are null/0 and
        // no moov bytes come back even when captureMoov=true.
        expect(indexed!.createdUtc).toBeNull();
        expect(indexed!.rotation).toBe(0);
        expect(moovBytes).toBeUndefined();
        // The MSE decision rides the orthogonal isMatroska filename flag, so the
        // index leaves needsHevcRemux / audioNeedsTranscode false here.
        expect(indexed!.needsHevcRemux).toBe(false);
        expect(indexed!.audioNeedsTranscode).toBe(false);
    });
});
