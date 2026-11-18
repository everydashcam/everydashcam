import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { groupTrips, tripAllCandidates, estimateTzByFingerprint } from "../../../trips.js";
import { buildProvisionalCandidate } from "../../../ui/ingest-candidate.js";
import { cameraFingerprint } from "../../camera-fingerprint.js";
import { classifyFilenameTime, matchFilenameChannel, matchFilenameSequence } from "../../filename/index.js";
import { classifyGpsSource, shouldTryEmbeddedGps } from "../../gps-source-hints.js";
import { findTsPesGpsStream } from "../../internal/ts-pes-gps.js";
import { dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const names = ["20260926_132423_F.ts", "20260926_132423_R.ts", "20260926_132723_F.ts", "20260926_132723_R.ts"];
function fileAt(name: string, root = "card/video", folders = true) {
    const bytes = Uint8Array.from(readFileSync(fileURLToPath(new URL(name.replace(/\.ts$/, ".TS"), import.meta.url))));
    return {
        file: new File([bytes], name),
        relativePath: `${root}/${folders ? (name.endsWith("_F.ts") ? "front/" : "back/") : ""}${name}`,
    };
}

async function parse(name: string) {
    const file = fileAt(name);
    const result = await dispatchParseVideoEmbeddedGps([
        { file, role: "video", sidecarId: null, sidecarMp4: null, logExtractorId: null },
    ]);
    return { file, result };
}

describe("real anonymized Viidure MPEG-TS", () => {
    it.each(names)("imports GPS from %s through the production dispatcher", async (name) => {
        const { file, result } = await parse(name);
        expect(classifyGpsSource(file)).toBe("embedded");
        expect(shouldTryEmbeddedGps(file, false)).toBe(true);
        expect(result.appliedExtractors).toEqual(["ts-pes-gps"]);
        expect(result.errors).toEqual([]);
        expect(result.records).toHaveLength(2);
        expectPlausibleGpsTrack(result.records);
        expect(result.records[1]!.unixSeconds - result.records[0]!.unixSeconds).toBe(1);
        const expectedTime =
            Date.UTC(
                2026,
                8,
                26,
                12,
                name.includes("132423") ? 24 : 27,
                name.includes("132423") ? 23 : name.endsWith("_F.ts") ? 24 : 25,
            ) / 1000;
        expect(result.records[0]!.unixSeconds).toBe(expectedTime);
        for (const record of result.records) {
            expect(record.lat).toBe(52);
            expect(record.lon).toBe(-1);
            expect(record.speedMs).toBeGreaterThanOrEqual(0);
            expect(record.speedMs).toBeLessThan(60);
            expect(record.timeUnsynced).toBeUndefined();
            expect([record.accelXg, record.accelYg, record.accelZg]).toEqual([0, 0, 0]);
        }
        const bytes = new Uint8Array(await file.file.arrayBuffer());
        expect(findTsPesGpsStream(bytes)).toEqual({ pid: 0x300, dialect: "viidure" });
        const coordinates = [...new TextDecoder().decode(bytes).matchAll(/[NSEW]:(\d+\.\d+)/g)];
        expect(coordinates).toHaveLength(4);
        expect(coordinates.every((match) => Number.isInteger(Number(match[1])))).toBe(true);
    });

    it("preserves the measured speed and course", async () => {
        const { result } = await parse(names[0]!);
        expect(result.records[0]!.speedMs).toBeCloseTo(0.5 / 3.6);
        expect(result.records[0]!.bearingDeg).toBeCloseTo(0.5);
    });

    it.each([true, false])("groups front and rear into one trip with folders=%s", async (folders) => {
        const candidates = await Promise.all(
            names.map(async (name) => {
                const { result } = await parse(name);
                const file = fileAt(name, "card/video", folders);
                expect(matchFilenameChannel(file).value).toEqual({
                    channel: name.endsWith("_F.ts") ? "front" : "rear",
                    confident: true,
                });
                expect(matchFilenameSequence(file).value).toBeNull();
                const candidate = buildProvisionalCandidate({
                    file,
                    fingerprint: cameraFingerprint(file),
                    startUtc: result.records[0]!.unixSeconds,
                    startSource: "gps",
                    cameraTzSec: 3600,
                    durationSec: 180,
                    records: result.records,
                    appliedExtractors: result.appliedExtractors,
                });
                candidate.metadataReady = true;
                return candidate;
            }),
        );
        const trips = groupTrips(candidates);
        expect(trips).toHaveLength(1);
        expect(trips[0]!.frames).toHaveLength(2);
        expect(tripAllCandidates(trips[0]!)).toHaveLength(4);
        expect(new Set(tripAllCandidates(trips[0]!).map((candidate) => candidate.channel))).toEqual(
            new Set(["front", "rear"]),
        );
    });

    it("keeps camera roots separate and derives the filename timezone from GPS", async () => {
        const { file, result } = await parse(names[0]!);
        const fingerprint = cameraFingerprint(file);
        expect(fingerprint).not.toBe(cameraFingerprint(fileAt(names[1]!, "other/video")));
        expect(cameraFingerprint(fileAt(names[0]!, "front"))).not.toBe(cameraFingerprint(fileAt(names[1]!, "back")));
        const timezone = estimateTzByFingerprint(
            [
                {
                    file,
                    fingerprint,
                    firstGpsUnix: result.records[0]!.unixSeconds,
                    mvhdNaiveUnix: null,
                    durationSec: 180,
                    lastGpsUnix: null,
                },
            ],
            classifyFilenameTime,
        );
        expect(timezone.get(fingerprint)?.filenameTzSec).toBe(3600);
    });
});
