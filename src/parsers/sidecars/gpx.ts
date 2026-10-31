// GPX 1.1 (https://www.topografix.com/GPX/1/1) - vendor-neutral sidecar.
//
// GPX is the de-facto track sharing format for dashcam software (Dashcam
// Viewer, Registrator Viewer) and general GPS apps (Strava, Google Earth,
// OsmAnd). We write it when exporting a selected range (see src/export.ts)
// and read it as a sidecar file placed next to an MP4.
//
// Unlike vendor plugins, GPX is not tied to a specific dashcam, so it is
// implemented as a SidecarHandler (see types.ts). Association with a video
// is by filename: `trip.gpx` looks for `trip.mp4` among known videos.

import type { GpsRecord, SidecarHandler, VendorFile } from "../types.js";
import { escapeXml } from "../../escape.js";
import { forwardFillBearingsIfAllZero, isValidGpsFix } from "../../parser.js";
import { hasSpeed, isSameTrackSegment } from "../../gps-telemetry.js";
import { parseIsoCalendarTime } from "../internal/calendar.js";
import { isCoordinateInRange } from "../internal/ddmm.js";
import { matchByBasename } from "./_basename.js";
import { readSidecarText } from "./_read.js";
import { type SpeedEstimationPoint, estimateSpeedSegments } from "../internal/position-speed.js";

const RX_GPX = /\.gpx$/i;
const GPX_EXTENSION_NS = "https://everydashcam.app/xmlschemas/gpx/1";
const LEGACY_GPX_EXTENSION_NS = "https://dashcamigo.app/xmlschemas/gpx/1";
// A source segment can still contain a device-off gap. Do not treat an
// unobserved span longer than this as evidence that the GPX overlaps a trip.
const TIME_RANGE_GAP_SEC = 5 * 60;

export const gpxSidecar: SidecarHandler = {
    id: "gpx",

    matches(file: VendorFile, knownVideos: Set<string>): string | null {
        return matchByBasename(file, knownVideos, RX_GPX);
    },

    async parse(file: VendorFile, mp4Filename: string, signal?: AbortSignal): Promise<GpsRecord[]> {
        return (await parseGpxTrack(file, mp4Filename, signal)).records;
    },
};

export interface GpxTimeRange {
    startUnix: number;
    endUnix: number;
}

/** Rich GPX result used only by the loose-track assignment UI. Normal
 *  basename sidecars keep the SidecarHandler contract above. */
export interface ParsedGpxTrack {
    records: GpsRecord[];
    /** One range per source track/route segment (waypoints are singletons).
     *  Keeping the source gaps prevents a morning+evening GPX from appearing
     *  to overlap an unrelated recording in the middle of the day. */
    timeRanges: GpxTimeRange[];
    /** GPX requires an explicit zone, but some exporters omit it. We still
     *  parse those timestamps deterministically as UTC; callers must not use
     *  that assumption for an automatic recommendation. */
    hasExplicitTimezone: boolean;
}

/** Reads and parses a GPX while retaining the timing evidence needed to match
 *  an otherwise-unassociated track to a recording trip. */
export async function parseGpxTrack(
    file: VendorFile,
    mp4Filename: string,
    signal?: AbortSignal,
): Promise<ParsedGpxTrack> {
    // Routed through the shared reader so a cancelled ingest stops here like everywhere else.
    const text = await readSidecarText(file, signal);
    return parseGpx(text, mp4Filename);
}

/**
 * Parses GPX file content and returns records in the shared GpsRecord format.
 * Fields absent from GPX (accelerometer) are set to zero. The MP4 filename
 * is supplied by the caller - GPX has no knowledge of a specific MP4.
 *
 * Parsed fields:
 *  - lat/lon (trkpt attributes) - required.
 *  - time (ISO8601, UTC) - required; without it the record cannot be linked to video.
 *  - speed (m/s) - optional; missing/invalid values are estimated within segments.
 *  - course (deg) - optional. If no point carries a non-zero course (a track
 *    re-exported without the camera's bearing, or a track-only GPX), heading is
 *    synthesized from position deltas so the map arrow follows travel instead of
 *    locking north - see forwardFillBearingsIfAllZero below.
 *
 * Throws if the root tag is not gpx or no valid records are found.
 */
function parseGpx(text: string, mp4Filename: string): ParsedGpxTrack {
    const doc = new DOMParser().parseFromString(text, "application/xml");

    // DOMParser does not throw on invalid XML - it returns a <parsererror> element.
    // getElementsByTagName instead of querySelector for compatibility with
    // non-browser DOMParser polyfills (@xmldom/xmldom does not implement querySelector).
    const parserErrors = doc.getElementsByTagName("parsererror");
    if (parserErrors.length > 0) {
        throw new Error(`gpx parse error: ${(parserErrors[0]?.textContent ?? "").slice(0, 200)}`);
    }

    const root = doc.documentElement;
    if (root?.localName !== "gpx") {
        throw new Error(`expected <gpx> root, got <${root?.localName ?? "none"}>`);
    }

    const records: GpsRecord[] = [];
    const timeRanges: GpxTimeRange[] = [];
    let hasExplicitTimezone = true;
    let nextSegment = 0;

    const collectRange = (points: readonly Element[]): void => {
        const rangeRecords: GpsRecord[] = [];
        const parsedPoints = points.map((point) => {
            const parsed = trkptToRecord(point, mp4Filename);
            if (!parsed) return null;
            rangeRecords.push(parsed.record);
            if (!parsed.hasExplicitTimezone) hasExplicitTimezone = false;
            return parsed;
        });
        for (const segment of estimateSpeedSegments(parsedPoints)) {
            for (const record of segment) record.trackSegment = nextSegment;
            nextSegment++;
            forwardFillBearingsIfAllZero(segment);
            for (const record of segment) records.push(record);
        }
        if (rangeRecords.length === 0) return;
        rangeRecords.sort((a, b) => a.unixSeconds - b.unixSeconds);
        let startUnix = rangeRecords[0]!.unixSeconds;
        let previousUnix = startUnix;
        for (let i = 1; i < rangeRecords.length; i++) {
            const currentUnix = rangeRecords[i]!.unixSeconds;
            if (currentUnix - previousUnix > TIME_RANGE_GAP_SEC) {
                timeRanges.push({ startUnix, endUnix: previousUnix });
                startUnix = currentUnix;
            }
            previousUnix = currentUnix;
        }
        timeRanges.push({ startUnix, endUnix: previousUnix });
    };

    // Namespace prefixes are legal in GPX, so match local names rather than
    // only unprefixed qualified names. Preserve source segmentation for time
    // matching; it is semantically meaningful even though the map renders the
    // combined sorted record list.
    const trackSegments = elementsByLocalName(doc, "trkseg");
    for (const segment of trackSegments) collectRange(elementsByLocalName(segment, "trkpt"));
    for (const route of elementsByLocalName(doc, "rte")) collectRange(elementsByLocalName(route, "rtept"));
    for (const waypoint of elementsByLocalName(doc, "wpt")) collectRange([waypoint]);

    // Be liberal with malformed-but-previously-supported GPX that puts track
    // or route points directly under the root instead of a segment/container.
    // Collect only orphans so a document that also has valid segments neither
    // loses those points nor duplicates the well-formed ones above.
    for (const point of elementsByLocalName(doc, "trkpt")) {
        if (!hasAncestorByLocalName(point, "trkseg")) collectRange([point]);
    }
    for (const point of elementsByLocalName(doc, "rtept")) {
        if (!hasAncestorByLocalName(point, "rte")) collectRange([point]);
    }

    if (records.length === 0) {
        throw new Error("gpx contains no usable trkpt/wpt/rtept with time");
    }

    records.sort((a, b) => a.unixSeconds - b.unixSeconds);
    timeRanges.sort((a, b) => a.startUnix - b.startUnix);
    return { records, timeRanges, hasExplicitTimezone };
}

/**
 * Parses an ISO time string from GPX. GPX 1.1 requires ISO 8601 (`...Z` or
 * `...±HH:MM`), but real dashcams write invalid variants: 70mai_RV produces
 * `2024-12-01T12:27:34+03:00Z` (mixed offset and Z), which Date.parse returns
 * NaN for. Strip the trailing Z after an offset to get a valid ISO offset
 * string (`+03:00`) that Date understands.
 *
 * Returns unix milliseconds, or null if the string is unparseable.
 */
function parseGpxTime(raw: string): { ms: number; hasExplicitTimezone: boolean } | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    // 70mai-style trailing Z after an offset.
    const fixed = trimmed.replace(/([+-]\d{2}:?\d{2})Z$/i, "$1");
    const parsed = parseIsoCalendarTime(fixed, { allowLeapSecond: true, caseInsensitive: true });
    if (!parsed) return null;
    const ms = parsed.baseMilliseconds + parsed.fractionalSeconds * 1000 - parsed.offsetSeconds * 1000;
    return Number.isFinite(ms) ? { ms, hasExplicitTimezone: parsed.hasExplicitTimezone } : null;
}

function elementsByLocalName(root: Document | Element, name: string): Element[] {
    const namespaced = root.getElementsByTagNameNS("*", name);
    if (namespaced.length > 0) return Array.from(namespaced);
    return Array.from(root.getElementsByTagName(name));
}

function hasAncestorByLocalName(element: Element, name: string): boolean {
    let parent: Node | null = element.parentNode;
    while (parent) {
        if (parent.nodeType === 1) {
            const ancestor = parent as Element;
            if ((ancestor.localName || ancestor.nodeName.split(":").pop()) === name) return true;
        }
        parent = parent.parentNode;
    }
    return false;
}

/**
 * Converts a <trkpt> or <wpt> element to a GpsRecord. Returns null if
 * lat/lon or time are missing or invalid - silently skipped so one bad
 * element does not abort the whole file.
 */
function trkptToRecord(
    el: Element,
    mp4Filename: string,
): (SpeedEstimationPoint & { hasExplicitTimezone: boolean }) | null {
    const latRaw = el.getAttribute("lat");
    const lonRaw = el.getAttribute("lon");
    if (latRaw === null || lonRaw === null || latRaw.trim() === "" || lonRaw.trim() === "") return null;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;

    const timeEl = elementsByLocalName(el, "time")[0];
    if (!timeEl) return null;
    const parsedTime = parseGpxTime((timeEl.textContent ?? "").trim());
    if (parsedTime === null) return null;

    // Empty, negative and non-finite speeds are missing evidence, never a stop.
    const ownSpeed =
        el.getElementsByTagNameNS(GPX_EXTENSION_NS, "speed")[0] ??
        el.getElementsByTagNameNS(LEGACY_GPX_EXTENSION_NS, "speed")[0];
    const speedEl = ownSpeed ?? elementsByLocalName(el, "speed")[0];
    const courseEl = elementsByLocalName(el, "course")[0];
    const speedText = speedEl?.textContent?.trim() ?? "";
    const speedValue = speedText === "" ? Number.NaN : Number(speedText);
    const courseValue = courseEl ? Number(courseEl.textContent) : 0;
    const isExplicitlyUnavailable = ownSpeed?.getAttribute("source") === "unavailable";
    const hasValidSpeed = !isExplicitlyUnavailable && Number.isFinite(speedValue) && speedValue >= 0;
    const speedMs = hasValidSpeed ? speedValue : 0;
    const speedSource = hasValidSpeed
        ? ownSpeed?.getAttribute("source") === "estimated"
            ? "estimated"
            : "measured"
        : "unavailable";
    const bearingDeg = Number.isFinite(courseValue) ? ((courseValue % 360) + 360) % 360 : 0;

    return {
        record: {
            unixSeconds: parsedTime.ms / 1000,
            active: true, // GPX normally contains only valid points
            lat,
            lon,
            bearingDeg,
            speedMs,
            speedSource,
            // GPX has no accelerometer data - brake events will not be detected
            // on these tracks (gMagnitude = 0).
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename,
        },
        hasExplicitTimezone: parsedTime.hasExplicitTimezone,
        canEstimateSpeed: !hasValidSpeed && !isExplicitlyUnavailable,
    };
}

/** Arguments for serializeGpx. */
interface SerializeGpxArgs {
    records: GpsRecord[];
    /** Human-readable track name. */
    trackName: string;
    /** Value of the creator attribute. */
    creator?: string;
}

/**
 * Serializes an array of records to GPX 1.1. Track name and metadata time
 * are provided by the caller. Records must be sorted by unixSeconds.
 *
 * Source boundaries are preserved so re-import cannot infer motion across gaps.
 */
export function serializeGpx({ records, trackName, creator = "everydashcam" }: SerializeGpxArgs): string {
    let points = "";
    let previous: GpsRecord | null = null;
    for (const record of records) {
        if (!isValidGpsFix(record)) continue;
        if (previous && !isSameTrackSegment(previous, record)) points += "\n    </trkseg>\n    <trkseg>";
        points += serializeTrkpt(record);
        previous = record;
    }

    const metadataTime =
        records.length > 0 ? new Date(records[0]!.unixSeconds * 1000).toISOString() : new Date().toISOString();

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${escapeXml(creator)}"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:dc="${GPX_EXTENSION_NS}"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(trackName)}</name>
    <time>${metadataTime}</time>
  </metadata>
  <trk>
    <name>${escapeXml(trackName)}</name>
    <trkseg>${points}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * Serializes one <trkpt> element. 6 decimal places for coordinates (~11 cm
 * at the equator, well above GPS fix accuracy). 2 decimal places for speed
 * and course are enough.
 */
function serializeTrkpt(r: GpsRecord): string {
    const time = new Date(r.unixSeconds * 1000).toISOString();
    const speed = hasSpeed(r)
        ? `<dc:speed source="${r.speedSource ?? "measured"}">${r.speedMs.toFixed(2)}</dc:speed>`
        : '<dc:speed source="unavailable"/>';
    return `
      <trkpt lat="${r.lat.toFixed(6)}" lon="${r.lon.toFixed(6)}">
        <time>${time}</time>
        <extensions>
          ${speed}
          <dc:course>${r.bearingDeg.toFixed(2)}</dc:course>
        </extensions>
      </trkpt>`;
}
