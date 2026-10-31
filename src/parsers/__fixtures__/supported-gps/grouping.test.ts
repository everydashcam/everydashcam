import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attachRecordsToCandidates } from "../../../gps-association.js";
import { mergeIntoGpsLog } from "../../../parser.js";
import { groupTrips, rederiveStartUtcForCandidates, tripAllCandidates, type VideoCandidate } from "../../../trips.js";
import { applyIndexedMetadata, buildProvisionalCandidate } from "../../../ui/ingest-candidate.js";
import { cameraFingerprint } from "../../camera-fingerprint.js";
import { classifyFilenameClockTimelapse, classifyFilenameTime } from "../../filename/index.js";
import { indexOneFile } from "../../internal/mp4-indexing.js";
import { classifyFiles, dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { COLLECTED_CHANNEL_PAIRS, type CollectedPair } from "./grouping-cases.js";

async function indexedCandidates(pair: CollectedPair): Promise<VideoCandidate[]> {
    return Promise.all(
        pair.files.map(async (fixture) => {
            const file = new File([readFileSync(new URL(`./${fixture.fixture}.mp4`, import.meta.url))], fixture.name);
            const vf = { file, relativePath: `card/${pair.model}/${fixture.name}`, sourceKey: "card" };
            const candidate = buildProvisionalCandidate({
                file: vf,
                fingerprint: cameraFingerprint(vf),
                startUtc: (classifyFilenameTime(vf)?.getTime() ?? 0) / 1000,
                startSource: "name",
                cameraTzSec: null,
                durationSec: 60,
                records: [],
                appliedExtractors: [],
            });
            const { indexed, repair } = await indexOneFile(file, true);
            expect(indexed).not.toBeNull();
            if (indexed === null) throw new Error("expected indexed recording fixture");
            applyIndexedMetadata(candidate, indexed, repair);
            const result = await dispatchParseVideoEmbeddedGps(await classifyFiles([vf]));
            expect(result.errors).toEqual([]);
            // Each source carries 60 rows. The ingest merge removes repeated
            // timestamps before associating Mikavi's 58/58/59 effective fixes.
            expect(result.records).toHaveLength(60);
            attachRecordsToCandidates(mergeIntoGpsLog(null, result), [candidate], [candidate]);
            candidate.appliedExtractors = result.appliedExtractors;
            expect(candidate.createdUtc?.toISOString()).toBe(fixture.createdUtc);
            expect(candidate.durationSec).toBe(60);
            expect(candidate.channel).toBe(fixture.channel);
            expect(candidate.records).toHaveLength(fixture.gpsCount);
            return candidate;
        }),
    );
}

function groupedNames(candidates: VideoCandidate[]): string[][] {
    return groupTrips(candidates).map((trip) =>
        tripAllCandidates(trip)
            .map((candidate) => candidate.file.name)
            .sort(),
    );
}

describe.each(COLLECTED_CHANNEL_PAIRS)("real timing and grouping: $model", (pair) => {
    it("keeps synchronized channels together after container and full GPS clock refinement", async () => {
        const candidates = await indexedCandidates(pair);
        rederiveStartUtcForCandidates(candidates, classifyFilenameTime, classifyFilenameClockTimelapse);
        expect(candidates.map((candidate) => candidate.startUtc)).toEqual(pair.files.map((fixture) => fixture.start));
        expect(candidates.every((candidate) => candidate.startSource === "mp4")).toBe(true);
        const trips = groupTrips(candidates);
        expect(groupedNames(candidates)).toEqual(pair.groups.map((group) => [...group].sort()));
        for (const trip of trips) expect(trip.frames).toHaveLength(1);
        expect(groupedNames([...candidates].reverse()), "file selection order does not change pairing").toEqual(
            groupedNames(candidates),
        );
        for (const trip of trips) {
            expect(new Set(tripAllCandidates(trip).map((candidate) => candidate.fingerprint)).size).toBe(1);
            expect(new Set(tripAllCandidates(trip).map((candidate) => candidate.channel)).size).toBe(
                tripAllCandidates(trip).length,
            );
        }
    });
});

it("keeps the two collected cameras distinct in one mixed folder import", async () => {
    const candidates = (await Promise.all(COLLECTED_CHANNEL_PAIRS.map(indexedCandidates))).flat();
    rederiveStartUtcForCandidates(candidates, classifyFilenameTime, classifyFilenameClockTimelapse);
    const expected = COLLECTED_CHANNEL_PAIRS.flatMap((pair) => pair.groups.map((group) => [...group].sort()));
    const byFirstName = (a: string[], b: string[]) => a[0]!.localeCompare(b[0]!);
    expect(groupedNames(candidates).sort(byFirstName)).toEqual(expected.sort(byFirstName));
    expect(candidates).toHaveLength(5);
});
