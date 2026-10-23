// Tests for GPX sidecar: matches by basename, parseGpx round-trip,
// serializeGpx formatting, edge cases for invalid XML / non-standard
// timestamps (70mai_RV).
//
// Node has no global DOMParser - we use @xmldom/xmldom as a polyfill via
// vi.stubGlobal. parseGpx reads DOMParser directly from global scope, so
// the stub must be set before import-evaluation.

import { DOMParser } from "@xmldom/xmldom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
    vi.stubGlobal("DOMParser", DOMParser);
});
afterAll(() => {
    vi.unstubAllGlobals();
});

import { makeVendorFile } from "../__fixtures__/helpers.js";
import { gpxSidecar, parseGpxTrack, serializeGpx } from "./gpx.js";
import type { GpsRecord } from "../types.js";
import { dropTeleportOutliers, interpolatePosition, recordsHaveGps } from "../../parser.js";

function gpxDoc(content: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
${content}
</gpx>`;
}

describe("gpxSidecar.matches", () => {
    it("matches .gpx with matching basename in knownVideos", () => {
        const vf = makeVendorFile("path/trip.gpx", "");
        const known = new Set(["trip.mp4"]);
        expect(gpxSidecar.matches!(vf, known)).toBe("trip.mp4");
    });

    it("matches case-insensitively", () => {
        const vf = makeVendorFile("TRIP.GPX", "");
        const known = new Set(["trip.MP4"]);
        expect(gpxSidecar.matches!(vf, known)).toBe("trip.MP4");
    });

    it("returns null if no matching video basename", () => {
        const vf = makeVendorFile("trip.gpx", "");
        const known = new Set(["other.mp4", "another.mp4"]);
        expect(gpxSidecar.matches!(vf, known)).toBeNull();
    });

    it("returns null for non-.gpx files", () => {
        const vf = makeVendorFile("trip.txt", "");
        const known = new Set(["trip.mp4"]);
        expect(gpxSidecar.matches!(vf, known)).toBeNull();
    });

    it("ignores directory part - only basename matters", () => {
        const vf = makeVendorFile("subdir/clip.gpx", "");
        // VendorFile.file.name = "clip.gpx" (last path segment).
        // knownVideos holds full strings; fileBasenameLower is applied to each:
        // "other/dir/clip.mp4" → basename = "other/dir/clip"
        // (lastIndexOf(".") strips only .mp4). For the match to succeed,
        // knownVideos must use a basename without directory prefix.
        const knownBasename = new Set(["clip.mp4"]);
        expect(gpxSidecar.matches!(vf, knownBasename)).toBe("clip.mp4");
    });
});

describe("gpxSidecar.parse", () => {
    it.each([
        [0, 20],
        [50, 0],
    ])("preserves telemetry through missing positions beside a valid (%s, %s) fix", async (lat, lon) => {
        const text = gpxDoc(`<trk><trkseg>
            <trkpt lat="${lat}" lon="${lon}"><time>2024-01-15T12:34:56Z</time><speed>5</speed></trkpt>
            <trkpt lat="0" lon="0"><time>2024-01-15T12:34:57Z</time><speed>6</speed></trkpt>
            <trkpt lat="${lat}" lon="${lon}"><time>2024-01-15T12:34:58Z</time><speed>7</speed></trkpt>
        </trkseg></trk>`);
        const parsed = await gpxSidecar.parse!(makeVendorFile("trip.gpx", text), "trip.mp4");
        const records = dropTeleportOutliers(parsed);
        expect(records).toEqual(parsed);
        expect(records.map((record) => record.speedMs)).toEqual([5, 6, 7]);
        expect(recordsHaveGps([records[1]!])).toBe(false);
        expect(interpolatePosition(records, records[0]!.unixSeconds)).toMatchObject({ lat, lon });
        expect(interpolatePosition(records, records[1]!.unixSeconds)).toBeNull();
        expect(interpolatePosition(records, records[2]!.unixSeconds)).toMatchObject({ lat, lon });
    });

    it("parses trkpt with lat/lon/time", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55.7558" lon="37.6173">
                    <time>2024-01-15T12:34:56Z</time>
                </trkpt>
                <trkpt lat="55.7600" lon="37.6200">
                    <time>2024-01-15T12:34:57Z</time>
                </trkpt>
            </trkseg></trk>
        `);
        const vf = makeVendorFile("trip.gpx", text);
        const records = await gpxSidecar.parse!(vf, "trip.mp4");
        expect(records).toHaveLength(2);
        expect(records[0]!.lat).toBeCloseTo(55.7558, 4);
        expect(records[0]!.lon).toBeCloseTo(37.6173, 4);
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2024, 0, 15, 12, 34, 56) / 1000);
        expect(records[0]!.mp4Filename).toBe("trip.mp4");
        expect(records[0]!.active).toBe(true);
        expect(records[0]!.accelXg).toBe(0); // GPX has no accelerometer data
    });

    it("parses optional speed and course", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55" lon="37">
                    <time>2024-01-15T12:34:56Z</time>
                    <speed>10.5</speed>
                    <course>90.0</course>
                </trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records[0]!.speedMs).toBeCloseTo(10.5, 6);
        expect(records[0]!.bearingDeg).toBeCloseTo(90, 6);
    });

    it.each(["https://dashcamigo.app/xmlschemas/gpx/1", "https://everydashcam.app/xmlschemas/gpx/1"])(
        "preserves speed provenance from %s exports",
        async (namespace) => {
            const text = gpxDoc(`
                <trk><trkseg xmlns:dc="${namespace}">
                    <trkpt lat="55" lon="37">
                        <time>2024-01-15T12:34:56Z</time>
                        <extensions><dc:speed source="estimated">10</dc:speed></extensions>
                    </trkpt>
                    <trkpt lat="55" lon="37.0001">
                        <time>2024-01-15T12:34:57Z</time>
                        <extensions><dc:speed source="unavailable"/></extensions>
                    </trkpt>
                    <trkpt lat="55" lon="37.0002">
                        <time>2024-01-15T12:34:58Z</time>
                        <extensions><dc:speed source="unavailable"/></extensions>
                    </trkpt>
                </trkseg></trk>
            `);
            const records = await gpxSidecar.parse!(makeVendorFile("export.gpx", text), "export.mp4");
            expect(records.map((record) => [record.speedSource, record.speedMs])).toEqual([
                ["estimated", 10],
                ["unavailable", 0],
                ["unavailable", 0],
            ]);
            expect(records[2]!.lon).toBeCloseTo(37.0002, 6);
            expect(records[2]!.unixSeconds - records[0]!.unixSeconds).toBe(2);
        },
    );

    it("marks a missing singleton speed unavailable", async () => {
        const text = gpxDoc(
            `<trk><trkseg><trkpt lat="55" lon="37"><time>2024-01-15T12:34:56Z</time></trkpt></trkseg></trk>`,
        );
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records[0]!.speedMs).toBe(0);
        expect(records[0]!.bearingDeg).toBe(0);
    });

    it("synthesizes bearing from positions when course is absent", async () => {
        // Re-exported dashcam GPX often drops <course> but keeps <speed>; the
        // map arrow must still follow travel instead of locking north (bearing 0).
        // Two points moving due east -> bearing ~90; both share the derived value.
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55.0000" lon="37.0000">
                    <time>2024-01-15T12:34:56Z</time>
                    <speed>10.0</speed>
                </trkpt>
                <trkpt lat="55.0000" lon="37.0010">
                    <time>2024-01-15T12:34:57Z</time>
                    <speed>10.0</speed>
                </trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(2);
        expect(records[0]!.bearingDeg).toBeGreaterThan(80);
        expect(records[0]!.bearingDeg).toBeLessThan(100);
        // Last point has no successor to bearing toward - inherits the last valid.
        expect(records[1]!.bearingDeg).toBeCloseTo(records[0]!.bearingDeg, 6);
    });

    it("keeps real course untouched, no synthesis", async () => {
        // A GPX that does carry course must win over position-derived bearing:
        // here the points move east (~90) but course says 200 - 200 must survive.
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55.0000" lon="37.0000">
                    <time>2024-01-15T12:34:56Z</time>
                    <speed>10.0</speed>
                    <course>200.0</course>
                </trkpt>
                <trkpt lat="55.0000" lon="37.0010">
                    <time>2024-01-15T12:34:57Z</time>
                    <speed>10.0</speed>
                    <course>205.0</course>
                </trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records[0]!.bearingDeg).toBeCloseTo(200, 6);
        expect(records[1]!.bearingDeg).toBeCloseTo(205, 6);
    });

    it("also picks up wpt (waypoints)", async () => {
        const text = gpxDoc(`
            <wpt lat="55" lon="37"><time>2024-01-15T12:34:56Z</time></wpt>
            <wpt lat="56" lon="38"><time>2024-01-15T12:34:57Z</time></wpt>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(2);
    });

    it("also picks up route points", async () => {
        const text = gpxDoc(`<rte><rtept lat="55" lon="37"><time>2024-01-15T12:34:56Z</time></rtept></rte>`);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(1);
    });

    it("keeps orphan track points even when the document also has a valid waypoint", async () => {
        const text = gpxDoc(`
            <trk><trkpt lat="55" lon="37"><time>2024-01-15T12:34:56Z</time></trkpt></trk>
            <wpt lat="56" lon="38"><time>2024-01-15T12:34:57Z</time></wpt>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records.map((record) => record.lat)).toEqual([55, 56]);
    });

    it("parses prefix-qualified GPX elements", async () => {
        const text = `<?xml version="1.0"?>
            <gpx:gpx version="1.1" creator="test" xmlns:gpx="http://www.topografix.com/GPX/1/1">
                <gpx:trk><gpx:trkseg><gpx:trkpt lat="55" lon="37">
                    <gpx:time>2024-01-15T12:34:56Z</gpx:time>
                </gpx:trkpt></gpx:trkseg></gpx:trk>
            </gpx:gpx>`;
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(1);
    });

    it("sorts records by unixSeconds even if input out-of-order", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="0" lon="0"><time>2024-01-15T12:35:00Z</time></trkpt>
                <trkpt lat="1" lon="1"><time>2024-01-15T12:34:00Z</time></trkpt>
                <trkpt lat="2" lon="2"><time>2024-01-15T12:34:30Z</time></trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records.map((r) => r.lat)).toEqual([1, 2, 0]);
    });

    it("skips trkpt without time", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55" lon="37"><time>2024-01-15T12:34:56Z</time></trkpt>
                <trkpt lat="56" lon="38"></trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBe(55);
    });

    it("skips trkpt with invalid lat/lon", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="abc" lon="37"><time>2024-01-15T12:34:56Z</time></trkpt>
                <trkpt lon="37"><time>2024-01-15T12:34:56Z</time></trkpt>
                <trkpt lat="91" lon="37"><time>2024-01-15T12:34:56Z</time></trkpt>
                <trkpt lat="55" lon="181"><time>2024-01-15T12:34:56Z</time></trkpt>
                <trkpt lat="55" lon="37"><time>2024-01-15T12:34:57Z</time></trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.lat).toBe(55);
    });

    it("interprets a zone-less timestamp as UTC rather than host-local time", async () => {
        const text = gpxDoc(
            `<trk><trkseg><trkpt lat="55" lon="37"><time>2024-01-15T12:34:56</time></trkpt></trkseg></trk>`,
        );
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2024, 0, 15, 12, 34, 56) / 1000);
    });

    it("reports whether every usable timestamp has an explicit timezone", async () => {
        const explicit = gpxDoc(
            `<trk><trkseg><trkpt lat="55" lon="37"><time>2024-01-15T12:34:56+03:00</time></trkpt></trkseg></trk>`,
        );
        const uncertain = gpxDoc(
            `<trk><trkseg><trkpt lat="55" lon="37"><time>2024-01-15T12:34:56</time></trkpt></trkseg></trk>`,
        );
        expect((await parseGpxTrack(makeVendorFile("a.gpx", explicit), "a.mp4")).hasExplicitTimezone).toBe(true);
        expect((await parseGpxTrack(makeVendorFile("a.gpx", uncertain), "a.mp4")).hasExplicitTimezone).toBe(false);
    });

    it("preserves separate source segments as separate time ranges", async () => {
        const text = gpxDoc(`
            <trk>
                <trkseg>
                    <trkpt lat="55" lon="37"><time>2024-01-15T08:00:00Z</time></trkpt>
                    <trkpt lat="55" lon="37"><time>2024-01-15T08:01:00Z</time></trkpt>
                </trkseg>
                <trkseg>
                    <trkpt lat="55" lon="37"><time>2024-01-15T18:00:00Z</time></trkpt>
                    <trkpt lat="55" lon="37"><time>2024-01-15T18:01:00Z</time></trkpt>
                </trkseg>
            </trk>
        `);
        const parsed = await parseGpxTrack(makeVendorFile("a.gpx", text), "a.mp4");
        expect(parsed.timeRanges).toEqual([
            {
                startUnix: Date.UTC(2024, 0, 15, 8, 0) / 1000,
                endUnix: Date.UTC(2024, 0, 15, 8, 1) / 1000,
            },
            {
                startUnix: Date.UTC(2024, 0, 15, 18, 0) / 1000,
                endUnix: Date.UTC(2024, 0, 15, 18, 1) / 1000,
            },
        ]);
    });

    it("splits an unobserved long gap inside one source segment", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55" lon="37"><time>2024-01-15T08:00:00Z</time></trkpt>
                <trkpt lat="55" lon="37"><time>2024-01-15T18:00:00Z</time></trkpt>
            </trkseg></trk>
        `);
        const parsed = await parseGpxTrack(makeVendorFile("a.gpx", text), "a.mp4");
        expect(parsed.timeRanges).toHaveLength(2);
        expect(parsed.timeRanges.every((range) => range.startUnix === range.endUnix)).toBe(true);
    });

    it("skips impossible calendar dates and timezone offsets", async () => {
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55" lon="37"><time>2024-02-31T12:34:56Z</time></trkpt>
                <trkpt lat="55" lon="37"><time>2024-02-29T12:34:56+03:99</time></trkpt>
                <trkpt lat="55" lon="37"><time>2024-02-29T12:34:57Z</time></trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(1);
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2024, 1, 29, 12, 34, 57) / 1000);
    });

    it("normalizes invalid optional motion fields without dropping the point", async () => {
        const text = gpxDoc(`
            <trk><trkseg><trkpt lat="55" lon="37">
                <time>2024-01-15T12:34:56Z</time><speed>-1</speed><course>450</course>
            </trkpt></trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records[0]!.speedMs).toBe(0);
        expect(records[0]!.bearingDeg).toBe(90);
    });

    it("throws on non-gpx root", async () => {
        const text = `<?xml version="1.0"?><foo></foo>`;
        await expect(gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4")).rejects.toThrow(/expected <gpx>/);
    });

    it("throws on empty gpx (no valid points)", async () => {
        const text = gpxDoc(`<trk><trkseg></trkseg></trk>`);
        await expect(gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4")).rejects.toThrow(/no usable/);
    });

    it("handles 70mai_RV non-standard trailing-Z-after-offset format", async () => {
        // 70mai_RV writes a mixed offset+Z: "+03:00Z" - Date.parse returns NaN;
        // the parser strips the trailing Z and parses the offset directly.
        const text = gpxDoc(`
            <trk><trkseg>
                <trkpt lat="55" lon="37"><time>2024-01-15T15:34:56+03:00Z</time></trkpt>
            </trkseg></trk>
        `);
        const records = await gpxSidecar.parse!(makeVendorFile("a.gpx", text), "a.mp4");
        expect(records).toHaveLength(1);
        // 15:34:56 +03:00 = 12:34:56 UTC.
        expect(records[0]!.unixSeconds).toBe(Date.UTC(2024, 0, 15, 12, 34, 56) / 1000);
    });
});

describe("serializeGpx", () => {
    function rec(unixSeconds: number, lat: number, lon: number, overrides: Partial<GpsRecord> = {}): GpsRecord {
        return {
            unixSeconds,
            active: true,
            lat,
            lon,
            bearingDeg: 0,
            speedMs: 0,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "x.mp4",
            ...overrides,
        };
    }

    it("emits XML declaration and gpx root with namespaces", () => {
        const out = serializeGpx({ records: [rec(0, 55, 37)], trackName: "test" });
        expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
        expect(out).toContain('<gpx version="1.1"');
        expect(out).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
        expect(out).toContain('xmlns:dc="https://everydashcam.app/xmlschemas/gpx/1"');
        expect(out).toContain('creator="everydashcam"');
        expect(out).not.toContain("dashcamigo");
    });

    it("escapes XML in trackName and creator", () => {
        const out = serializeGpx({
            records: [rec(0, 55, 37)],
            trackName: `Trip <"bad" & 'value'>`,
            creator: `App<"x">`,
        });
        // creator attribute and <name> in metadata and track.
        expect(out).toContain("Trip &lt;&quot;bad&quot; &amp; &apos;value&apos;&gt;");
        expect(out).toContain('creator="App&lt;&quot;x&quot;&gt;"');
        expect(out).not.toContain(`'value'`); // raw quote should be escaped
    });

    it("filters inactive records out", () => {
        const records = [rec(0, 55, 37), rec(1, 56, 38, { active: false }), rec(2, 57, 39)];
        const out = serializeGpx({ records, trackName: "t" });
        // Only 2 trkpts should be present (first and third).
        const matches = out.match(/<trkpt/g);
        expect(matches).toHaveLength(2);
        expect(out).toContain('lat="55.000000"');
        expect(out).toContain('lat="57.000000"');
        expect(out).not.toContain('lat="56.000000"');
    });

    it("omits origin placeholders while preserving points with one zero coordinate", async () => {
        const records = [rec(1700000000, 0, 0), rec(1700000001, 0, 37), rec(1700000002, 55, 0)];
        const out = serializeGpx({ records, trackName: "missing signal" });
        const parsed = await gpxSidecar.parse!(makeVendorFile("x.gpx", out), "x.mp4");
        expect(parsed.map(({ lat, lon }) => ({ lat, lon }))).toEqual([
            { lat: 0, lon: 37 },
            { lat: 55, lon: 0 },
        ]);
        expect(records[0]).toMatchObject({ active: true, lat: 0, lon: 0 });
    });

    it("formats lat/lon with 6 decimals", () => {
        const out = serializeGpx({ records: [rec(0, 55.123456789, 37.987654321)], trackName: "t" });
        expect(out).toContain('lat="55.123457"');
        expect(out).toContain('lon="37.987654"');
    });

    it("formats speed/course with 2 decimals", () => {
        const out = serializeGpx({
            records: [rec(0, 55, 37, { speedMs: 12.3456, bearingDeg: 90.987 })],
            trackName: "t",
        });
        expect(out).toContain('<dc:speed source="measured">12.35</dc:speed>');
        expect(out).toContain("<dc:course>90.99</dc:course>");
    });

    it("metadata <time> takes first record's unix", () => {
        const out = serializeGpx({ records: [rec(1234567890, 0, 0)], trackName: "t" });
        const expected = new Date(1234567890 * 1000).toISOString();
        expect(out).toContain(`<time>${expected}</time>`);
    });

    it("round-trip: serialize then parse gives equivalent records", async () => {
        const original = [
            rec(1700000000, 55.7558, 37.6173, { speedMs: 5, bearingDeg: 90 }),
            rec(1700000001, 55.756, 37.6175, { speedMs: 6, bearingDeg: 91 }),
        ];
        const xml = serializeGpx({ records: original, trackName: "round-trip" });
        const parsed = await gpxSidecar.parse!(makeVendorFile("x.gpx", xml), "x.mp4");
        expect(parsed).toHaveLength(2);
        expect(parsed[0]!.lat).toBeCloseTo(55.7558, 5);
        expect(parsed[0]!.lon).toBeCloseTo(37.6173, 5);
        expect(parsed[0]!.unixSeconds).toBe(1700000000);
        expect(parsed[0]!.speedMs).toBeCloseTo(5, 2);
        expect(parsed[0]!.bearingDeg).toBeCloseTo(90, 2);
    });

    it("round-trips speed provenance and segment boundaries", async () => {
        const original = [
            rec(1700000000, 55, 37, { speedMs: 5, speedSource: "measured", trackSegment: 0 }),
            rec(1700000001, 55, 37.0001, { speedMs: 6, speedSource: "estimated", trackSegment: 0 }),
            rec(1700000002, 55, 37.0002, { speedSource: "unavailable", trackSegment: 1 }),
            rec(1700000003, 55, 37.0003, { speedSource: "unavailable", trackSegment: 1 }),
        ];
        const xml = serializeGpx({ records: original, trackName: "source boundaries" });
        const parsed = await gpxSidecar.parse!(makeVendorFile("x.gpx", xml), "x.mp4");
        expect(
            parsed.map(({ speedMs, speedSource, trackSegment }) => ({ speedMs, speedSource, trackSegment })),
        ).toEqual(original.map(({ speedMs, speedSource, trackSegment }) => ({ speedMs, speedSource, trackSegment })));
    });

    it("empty records list still produces valid GPX", () => {
        const out = serializeGpx({ records: [], trackName: "empty" });
        expect(out).toContain('<gpx version="1.1"');
        expect(out).toContain("<trk>");
        expect(out).not.toContain("<trkpt");
    });
});
