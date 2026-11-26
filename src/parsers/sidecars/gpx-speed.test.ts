import { DOMParser } from "@xmldom/xmldom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectInferredSegments } from "../../inferred-events.js";
import { dropTeleportOutliers, interpolatePosition, totalDistanceKm } from "../../parser.js";
import { deriveGLat, deriveGLong, resolveFramePos, sampleSpeedAcross } from "../../transcode/frame-pos.js";
import { formatSpeedValue } from "../../transcode/text-overlay.js";
import { makeVendorFile } from "../__fixtures__/helpers.js";
import { gpxSidecar, parseGpxTrack, serializeGpx } from "./gpx.js";

beforeAll(() => vi.stubGlobal("DOMParser", DOMParser));
afterAll(() => vi.unstubAllGlobals());

const START = Date.UTC(2026, 0, 1) / 1000;
const METERS_PER_DEGREE = (6371_000 * Math.PI) / 180;

function point(seconds: number, meters: number, field = ""): string {
    return `<trkpt lat="${50 + meters / METERS_PER_DEGREE}" lon="30"><time>${new Date((START + seconds) * 1000).toISOString()}</time>${field}</trkpt>`;
}

function doc(...segments: string[]): string {
    return `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk>${segments.map((s) => `<trkseg>${s}</trkseg>`).join("")}</trk></gpx>`;
}

async function parse(...segments: string[]) {
    return gpxSidecar.parse!(makeVendorFile("trip.gpx", doc(...segments)), "trip.mp4");
}

describe("GPX speed estimates", () => {
    it.each([0, 0.2, 1.4, 25])(
        "preserves stationary, slow walking and driving displacement at %s m/s",
        async (speed) => {
            const records = await parse(point(0, 0) + point(1, speed) + point(2, 2 * speed));
            for (const r of records) {
                expect(r.speedSource).toBe("estimated");
                expect(r.speedMs).toBeCloseTo(speed, 5);
            }
        },
    );

    it("attaches each interval to its ending point and uses the first interval at the start", async () => {
        const records = await parse(point(0, 0) + point(1, 5) + point(2, 15));
        expect(records.map((r) => r.speedMs)).toEqual([
            expect.closeTo(5, 5),
            expect.closeTo(5, 5),
            expect.closeTo(10, 5),
        ]);
    });

    it("preserves measured speeds including zero and fills only missing or invalid values", async () => {
        const records = await parse(
            point(0, 0, "<speed>0</speed>") +
                point(1, 10, "<speed>7</speed>") +
                point(2, 20) +
                point(3, 30, "<speed>bad</speed>"),
        );
        expect(records.map((r) => r.speedSource)).toEqual(["measured", "measured", "estimated", "estimated"]);
        expect(records.map((r) => r.speedMs)).toEqual([0, 7, expect.closeTo(10, 5), expect.closeTo(10, 5)]);
    });

    it.each(["", " ", "-1", "NaN", "Infinity"])("treats invalid speed %j as missing evidence", async (value) => {
        const records = await parse(point(0, 0, `<speed>${value}</speed>`) + point(1, 10));
        expect(records[0]!.speedSource).toBe("estimated");
        expect(records[0]!.speedMs).toBeCloseTo(10, 5);
        const singleton = await parse(point(0, 0, `<speed>${value}</speed>`));
        expect(singleton[0]!.speedSource).toBe("unavailable");
    });

    it("supports namespaced speed extensions without estimating a recorded zero", async () => {
        const records = await parse(
            point(0, 0, '<extensions><v:speed xmlns:v="urn:test">0</v:speed></extensions>') + point(1, 10),
        );
        expect(records[0]!.speedSource).toBe("measured");
        expect(records[0]!.speedMs).toBe(0);
    });

    it("does not join separate source segments or standalone waypoints", async () => {
        const records = await parse(point(0, 0), point(1, 10));
        expect(records.map((r) => r.speedSource)).toEqual(["unavailable", "unavailable"]);
        expect(interpolatePosition(records, START + 0.5)).toBeNull();
        expect(totalDistanceKm(records)).toBe(0);
        const waypoints = doc(point(0, 0) + point(1, 10)).replaceAll("trkpt", "wpt");
        const result = await parseGpxTrack(makeVendorFile("trip.gpx", waypoints), "trip.mp4");
        expect(result.records.every((r) => r.speedSource === "unavailable")).toBe(true);
    });

    it.each([
        [0, 10],
        [-1, 10],
        [1, 1000],
    ])("rejects an interval with time %s s and distance %s m before sorting", async (seconds, meters) => {
        const records = await parse(point(0, 0) + point(seconds, meters));
        expect(records.map((r) => r.speedSource)).toEqual(["unavailable", "unavailable"]);
        expect(new Set(records.map((r) => r.trackSegment)).size).toBe(2);
    });

    it("preserves measured speed and route continuity across sparse fixes", async () => {
        const records = await parse(point(0, 0, "<speed>10</speed>") + point(60, 600, "<speed>10</speed>"));
        expect(records.map((r) => r.speedSource)).toEqual(["measured", "measured"]);
        expect(records.map((r) => r.speedMs)).toEqual([10, 10]);
        expect(new Set(records.map((r) => r.trackSegment)).size).toBe(1);
        expect(totalDistanceKm(records)).toBeCloseTo(0.6, 6);
        const position = interpolatePosition(records, START + 30);
        expect(position?.lat).toBeCloseTo(50 + 300 / METERS_PER_DEGREE, 8);
        expect(position?.speedMs).toBe(10);
    });

    it("preserves a sparse route without estimating its speed or backfilling from a later interval", async () => {
        const records = await parse(point(0, 0) + point(60, 600) + point(61, 610));
        expect(records.map((r) => r.speedSource)).toEqual(["unavailable", "unavailable", "estimated"]);
        expect(records[2]!.speedMs).toBeCloseTo(10, 5);
        expect(new Set(records.map((r) => r.trackSegment)).size).toBe(1);
        expect(totalDistanceKm(records)).toBeCloseTo(0.61, 6);
        const position = interpolatePosition(records, START + 30);
        expect(position?.lat).toBeCloseTo(50 + 300 / METERS_PER_DEGREE, 8);
        expect(position?.speedSource).toBe("unavailable");
    });

    it("uses elapsed time for irregular sampling", async () => {
        const records = await parse(point(0, 0) + point(4, 40) + point(24, 240));
        expect(records.every((r) => r.speedSource === "estimated")).toBe(true);
        for (const r of records) expect(r.speedMs).toBeCloseTo(10, 5);
    });

    it("does not bridge a skipped invalid point and recovers after an outlier", async () => {
        const invalid = '<trkpt lat="bad" lon="30"><time>2026-01-01T00:00:01Z</time></trkpt>';
        const skipped = await parse(point(0, 0) + invalid + point(2, 20));
        expect(skipped.map((r) => r.speedSource)).toEqual(["unavailable", "unavailable"]);
        const records = await parse(point(0, 0) + point(1, 10) + point(2, 10000) + point(3, 30) + point(4, 40));
        expect(records.map((r) => r.speedSource)).toEqual([
            "estimated",
            "estimated",
            "unavailable",
            "estimated",
            "estimated",
        ]);
        for (const r of records) expect(r.speedMs).toBeLessThan(11);
    });

    it("produces identical speed data through sidecar and loose-track imports", async () => {
        const file = makeVendorFile("trip.gpx", doc(point(0, 0) + point(1, 10)));
        expect((await parseGpxTrack(file, "trip.mp4")).records).toEqual(await gpxSidecar.parse!(file, "trip.mp4"));
    });

    it("preserves provenance, unavailable values and segment boundaries through GPX export", async () => {
        const records = await parse(point(0, 0, "<speed>0</speed>") + point(1, 10), point(2, 20));
        const xml = serializeGpx({ records, trackName: "test" });
        const parsed = await gpxSidecar.parse!(makeVendorFile("again.gpx", xml), "again.mp4");
        expect(parsed.map((r) => r.speedSource)).toEqual(["measured", "estimated", "unavailable"]);
        expect(parsed[0]!.speedMs).toBe(0);
        expect(parsed[1]!.speedMs).toBeCloseTo(10, 2);
        expect(parsed[2]!.trackSegment).not.toBe(parsed[1]!.trackSegment);
        expect(xml).toContain('<dc:speed source="unavailable"/>');
        expect(xml).not.toContain("<speed>");
    });

    it("keeps coordinates when speed is unavailable and marks interpolated estimates", async () => {
        const singleton = await parse(point(0, 0));
        expect(interpolatePosition(singleton, START)).toMatchObject({ lat: 50, speedSource: "unavailable" });
        const records = await parse(point(0, 0) + point(1, 10, "<speed>12</speed>"));
        const base = interpolatePosition(records, START + 0.5)!;
        expect(base.speedSource).toBe("estimated");
        expect(base.speedMs).toBeCloseTo(11, 5);
        const frame = resolveFramePos({
            records,
            base,
            cumulative: null,
            distanceBaseM: 0,
            frameUtc: START + 0.5,
            progress: 0.5,
        });
        expect(frame.speedSource).toBe("estimated");
        expect(frame.hasFix).toBe(true);
        expect(formatSpeedValue(frame.speedMs, "metric", frame.speedSource)).toBe("≈40");
        expect(formatSpeedValue(0, "metric", "unavailable")).toBe("-");
    });

    it("keeps gaps in exported speed graphs", async () => {
        const records = await parse(point(0, 0) + point(1, 10), point(3, 20));
        const samples = sampleSpeedAcross(records, START, START + 3, 4);
        expect(samples[0]).toBeCloseTo(10, 5);
        expect(samples[1]).toBeCloseTo(10, 5);
        expect(samples[2]).toBeNaN();
        expect(samples[3]).toBeNaN();
    });

    it("does not infer stops, braking or turns from stationary GPS jitter", async () => {
        const records = await parse(
            Array.from({ length: 20 }, (_, i) => point(i, i % 2 === 0 ? 0 : (i % 3) * 2)).join(""),
        );
        expect(records.every((r) => r.speedSource === "estimated")).toBe(true);
        expect(detectInferredSegments(records, START)).toEqual([]);
        expect(deriveGLong(records, START + 5)).toBe(0);
        expect(deriveGLat(records, START + 5)).toBe(0);
    });

    it("does not interpret unavailable speed as a sustained stop", async () => {
        const records = await parse(...Array.from({ length: 10 }, (_, i) => point(i, 0)));
        expect(detectInferredSegments(records, START)).toEqual([]);
    });

    it("drops a trailing 5 km teleport inside a single trkseg while keeping an explicit trailing waypoint", async () => {
        const singleSegmentWithSpike = await parse(point(0, 0) + point(1, 10) + point(2, 20) + point(3, 5020));
        expect(singleSegmentWithSpike).toHaveLength(4);
        expect(singleSegmentWithSpike[3]!.trackSegmentSplitBySpeed).toBe(true);
        expect(dropTeleportOutliers(singleSegmentWithSpike).map((r) => r.unixSeconds - START)).toEqual([0, 1, 2]);

        const trackPlusWaypointXml =
            `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">` +
            `<trk><trkseg>${point(0, 0) + point(1, 10) + point(2, 20)}</trkseg></trk>` +
            `${point(3, 5020).replaceAll("trkpt", "wpt")}</gpx>`;
        const withTrailingWaypoint = (await parseGpxTrack(makeVendorFile("trip.gpx", trackPlusWaypointXml), "trip.mp4"))
            .records;
        expect(withTrailingWaypoint[3]!.trackSegmentSplitBySpeed).toBeUndefined();
        expect(dropTeleportOutliers(withTrailingWaypoint).map((r) => r.unixSeconds - START)).toEqual([0, 1, 2, 3]);
    });
});
