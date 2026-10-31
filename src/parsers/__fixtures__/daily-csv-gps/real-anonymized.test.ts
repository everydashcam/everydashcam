// Published Kaiser Baas R50 demo telemetry from jgOhYeah/dashcam-viewer,
// commit 492240a16766bc68755b11b2e9af5fb1699b6169. The accompanying public
// clips were downscaled; this fixture validates their log/filename association,
// not an untouched native video container. No source footage is included.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { associateRecordsWithVideos, buildVideoAssociationIndex, recordsForVideo } from "../../../gps-association.js";
import { rebuildLog } from "../../../parser.js";
import { dailyCsvGpsPrimitive } from "../../primitives/daily-csv-gps.js";
import { KNOTS_TO_MS, type GpsRecord, type VendorFile } from "../../types.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const PATHS = [
    "DCIM/100video/20240112181119_180.MP4",
    "DCIM/100video/20240112181419_180.MP4",
    "DCIM/100video/20240113175633_163.MP4",
    "DCIM/101video/20240113175916_10.MP4",
];

function videos(): VendorFile[] {
    return PATHS.map((relativePath) => ({
        file: new File([], relativePath.split("/").at(-1)!),
        relativePath,
        sourceKey: "demo-card",
    }));
}

describe("real anonymized daily CSV logs", () => {
    it("binds both days to their observed normal/event video windows", async () => {
        const loadedVideos = videos();
        const association = buildVideoAssociationIndex(loadedVideos);
        const allRecords: GpsRecord[] = [];
        for (const name of ["20240112.dat", "20240113.dat"]) {
            const source: VendorFile = {
                file: new File([readFileSync(new URL(`./${name}`, import.meta.url))], name),
                relativePath: `gps/${name}`,
                sourceKey: "demo-card",
            };
            expect(await dailyCsvGpsPrimitive.marker(source)).toBe(true);
            const parsed = await dailyCsvGpsPrimitive.parse(source, undefined, undefined, {
                knownVideos: loadedVideos.map((video) => ({
                    name: video.file.name,
                    relativePath: video.relativePath,
                    sourceKey: video.sourceKey,
                })),
            });
            expect(parsed.skipped).toEqual([]);
            expectPlausibleGpsTrack(parsed.records);
            for (const [index, record] of parsed.records.entries()) {
                expect(Number.isInteger(record.lat) && Number.isInteger(record.lon)).toBe(true);
                expect(record.timeUnsynced).toBe(true);
                expect(record.relStartSeconds).toBeGreaterThanOrEqual(0);
                if (index > 0) expect(record.unixSeconds).toBeGreaterThan(parsed.records[index - 1]!.unixSeconds);
            }
            associateRecordsWithVideos(parsed.records, source, association);
            allRecords.push(...parsed.records);
        }
        const log = rebuildLog([dailyCsvGpsPrimitive.id], allRecords, []);
        const records = loadedVideos.map((video) => recordsForVideo(log, video, association));
        expect(records.map((items) => items.length)).toEqual([19, 31, 26, 10]);
        expect(records.map((items) => items[0]!.relStartSeconds)).toEqual([161, 0, 137, 0]);
        expect(records.map((items) => items.at(-1)!.relStartSeconds)).toEqual([179, 30, 162, 9]);
        expect(allRecords.every((record) => record.videoKey !== undefined)).toBe(true);
        expect(allRecords[0]!.speedMs).toBeGreaterThan(0);
        expect(allRecords[0]!.speedMs / KNOTS_TO_MS).toBeCloseTo(51.007, 5);
    });
});
