// Regression tests on a real-anonymized Thinkware U3000 Pro front clip.
//
// Source: cont_rec/REC_20261115_165549_F.MP4 from a user card (firmware
// 1.00.06, camera zone UTC-6). real-anonymized-u3000.mp4 keeps its first 10
// GPS fixes with coordinates scrubbed (scripts/anonymize-thinkware-mp4.mjs),
// the source mvhd stamp and the 100 ms cue spacing.
//
// Values read from the sample card with ffprobe and checked against the OSD:
//   - REC and PAK names, GPS RMC time and the burned-in OSD (1 s behind) agree.
//     The Ambarella mvhd stamp is the name time plus 27 s on all 16 files.
//   - The rear REC file carries a byte-identical copy of the front telemetry.
//   - The interior EXT file (another muxer, no telemetry) stamps mvhd at its
//     name time in true UTC; it starts 6 s after the REC pair.
//   - REC clips are 60 s, EXT clips 59.9994 s.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cameraFingerprint } from "../../camera-fingerprint.js";
import { classifyFilenameTime } from "../../filename/index.js";
import { indexMp4FileWithMoov } from "../../internal/mp4-indexing.js";
import { KNOTS_TO_MS } from "../../types.js";
import type { GpsRecord, VendorFile } from "../../types.js";
import { classifyFiles, dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { applyIndexedMetadata, buildProvisionalCandidate } from "../../../ui/ingest-candidate.js";
import type { IndexedMp4 } from "../../../workers/indexer-protocol.js";
import {
    frameMediaOffset,
    groupTrips,
    rederiveStartUtcForCandidates,
    tripChannels,
    type VideoCandidate,
} from "../../../trips.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = readFileSync(resolve(HERE, "real-anonymized-u3000.mp4"));

const unix = (iso: string): number => Date.parse(iso) / 1000;

function cardFile(folder: string, name: string): VendorFile {
    return { file: new File([FIXTURE_BYTES], name), relativePath: `0000-0000/${folder}/${name}` };
}

async function parseFixture(file: VendorFile): Promise<{ records: GpsRecord[]; extractor: string | undefined }> {
    const result = await dispatchParseVideoEmbeddedGps(await classifyFiles([file]));
    expect(result.errors).toEqual([]);
    return { records: result.records, extractor: [...result.winningExtractorByFileKey.values()][0] };
}

async function fixtureIndex(): Promise<IndexedMp4> {
    const { indexed } = await indexMp4FileWithMoov(new File([FIXTURE_BYTES], "fixture.mp4"), false);
    expect(indexed, "fixture indexes").not.toBeNull();
    return indexed!;
}

/** A candidate built the way ingest builds it, with the real clip's container
 *  stamp and duration in place of the fixture's 9 s excerpt. */
function ingestCandidate(
    file: VendorFile,
    records: GpsRecord[],
    indexed: IndexedMp4,
    real: { createdIso: string; durationSec: number },
): VideoCandidate {
    const candidate = buildProvisionalCandidate({
        file,
        fingerprint: cameraFingerprint(file),
        startUtc: 0,
        startSource: "name",
        cameraTzSec: null,
        durationSec: real.durationSec,
        records,
        appliedExtractors: records.length > 0 ? ["nmea-subtitle"] : [],
    });
    applyIndexedMetadata(
        candidate,
        { ...indexed, createdUtc: new Date(real.createdIso), durationSec: real.durationSec },
        undefined,
    );
    return candidate;
}

describe("real-anonymized Thinkware U3000 Pro front", () => {
    it("parses the scrubbed subtitle telemetry with real times and speed", async () => {
        const { records, extractor } = await parseFixture(cardFile("cont_rec", "REC_20261115_165549_F.MP4"));
        expect(extractor).toBe("nmea-subtitle");
        expectPlausibleGpsTrack(records, { minCount: 10 });
        expect(records).toHaveLength(10);
        expect(records[0]!.unixSeconds, "first fix at the name time").toBe(unix("2026-11-15T22:55:49Z"));
        expect(records.at(-1)!.unixSeconds).toBe(unix("2026-11-15T22:55:58Z"));
        for (const record of records) {
            expect(record.lat, "scrubbed latitude").toBeCloseTo(50, 1);
            expect(record.lon, "scrubbed longitude").toBeCloseTo(30, 1);
        }
        expect(records[0]!.speedMs).toBeCloseTo(14.68 * KNOTS_TO_MS, 3);
        expect(records[0]!.bearingDeg).toBeCloseTo(293.78, 2);
    });

    it("keeps the real container stamp, 27 s after the name", async () => {
        const indexed = await fixtureIndex();
        expect(indexed.createdUtc?.toISOString()).toBe("2026-11-15T22:56:16.000Z");
    });
});

describe("real-anonymized Thinkware U3000 Pro drive", () => {
    it("keeps a cold-start REC pair with the interior although its container stamp runs 27 s ahead", async () => {
        const indexed = await fixtureIndex();
        const front = cardFile("cont_rec", "REC_20261115_165549_F.MP4");
        const { records } = await parseFixture(front);
        const rear = cardFile("cont_rec", "REC_20261115_165549_R.MP4");
        const rearRecords = records.map((record) => ({ ...record, mp4Filename: rear.file.name }));
        const realRec = (createdIso: string) => ({ createdIso, durationSec: 60 });
        const realExt = (createdIso: string) => ({ createdIso, durationSec: 59.9994 });

        const candidates = [
            // The first minute of the drive, before the GPS fix.
            ingestCandidate(
                cardFile("cont_rec", "REC_20261115_165449_F.MP4"),
                [],
                indexed,
                realRec("2026-11-15T22:55:16Z"),
            ),
            ingestCandidate(
                cardFile("cont_rec", "REC_20261115_165449_R.MP4"),
                [],
                indexed,
                realRec("2026-11-15T22:55:16Z"),
            ),
            ingestCandidate(front, records, indexed, realRec("2026-11-15T22:56:16Z")),
            ingestCandidate(rear, rearRecords, indexed, realRec("2026-11-15T22:56:16Z")),
            ingestCandidate(
                cardFile("incabin_rec", "EXT_20261115_165455_I.MP4"),
                [],
                indexed,
                realExt("2026-11-15T22:54:55Z"),
            ),
            ingestCandidate(
                cardFile("incabin_rec", "EXT_20261115_165555_I.MP4"),
                [],
                indexed,
                realExt("2026-11-15T22:55:55Z"),
            ),
        ];
        rederiveStartUtcForCandidates(candidates, classifyFilenameTime);

        const startByName = Object.fromEntries(candidates.map((c) => [c.file.name, c.startUtc]));
        expect(startByName).toEqual({
            "REC_20261115_165449_F.MP4": unix("2026-11-15T22:54:49Z"),
            "REC_20261115_165449_R.MP4": unix("2026-11-15T22:54:49Z"),
            "REC_20261115_165549_F.MP4": unix("2026-11-15T22:55:49Z"),
            "REC_20261115_165549_R.MP4": unix("2026-11-15T22:55:49Z"),
            "EXT_20261115_165455_I.MP4": unix("2026-11-15T22:54:55Z"),
            "EXT_20261115_165555_I.MP4": unix("2026-11-15T22:55:55Z"),
        });

        const trips = groupTrips(candidates);
        expect(trips, "one drive").toHaveLength(1);
        const trip = trips[0]!;
        expect(tripChannels(trip)).toEqual(["front", "rear", "interior"]);
        const interiorStart = trip.frames.find((frame) => frame.channels.interior && frame.channels.front)!;
        expect(interiorStart.channels.front!.file.name).toBe("REC_20261115_165449_F.MP4");
        expect(frameMediaOffset(interiorStart, "front") - frameMediaOffset(interiorStart, "interior")).toBeCloseTo(6, 6);
        expect(frameMediaOffset(interiorStart, "rear")).toBe(frameMediaOffset(interiorStart, "front"));
    });
});
