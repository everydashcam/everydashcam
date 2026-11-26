// Pure formatter coverage without DOM dependencies.

import { afterEach, describe, it, expect } from "vitest";
import {
    clipBasename,
    eventLabel,
    formatBytes,
    formatDayHeading,
    formatEventSeverity,
    formatFileMeta,
    indexTripFilteredFixes,
    formatRateBytes,
    formatStartDate,
    formatTimeRange,
    formatTotalDuration,
    formatTripClockTitle,
    formatTripRowMeta,
    formatTripTitle,
    formatTripDistance,
} from "./format.js";
import { setUnits, getUnits } from "../units-pref.js";
import { _resetForTests as resetDateFormat, setDateFormat } from "./date-format.js";
import { t } from "../i18n/index.js";
import { buildTripTimeline, groupTrips, type Trip, type TripFrame, type VideoCandidate } from "../trips.js";

describe("event formatting", () => {
    it("formats the only EventKind without unreachable fallbacks", () => {
        expect(eventLabel("brake")).toBe(t("event.brake.label"));
        expect(
            formatEventSeverity({ kind: "brake", unixSeconds: 100, relSec: 0, severity: 0.42, recordIndex: 0 }),
        ).toBe("0.42 g");
    });
});

/**
 * Minimal fake Trip - clipBasename needs startUtc and a timeline. A single
 * gapless segment anchored at startUtc makes contentToWallUtc an identity
 * offset (footage second N == startUtc + N), matching a pause-free trip.
 */
function makeTrip(startUtc: number): Trip {
    const frame: TripFrame = { startUtc, durationSec: 100_000, wallDurationSec: 100_000, channels: {} };
    return { startUtc, timeline: buildTripTimeline([frame]) } as unknown as Trip;
}

describe("clipBasename", () => {
    it("typical same-day clip uses compact end-time (HHMMSS without date)", () => {
        // 2026-04-29 19:27:47 local + 28 sec → 19:28:15 same day.
        // UTC seconds from Date with local getters - mirrors browser-side behavior.
        const start = new Date(2026, 3, 29, 19, 27, 47).getTime() / 1000;
        const trip = makeTrip(start);
        const name = clipBasename(trip, 0, 28);
        expect(name).toBe("everydashcam_20260429_192747-192815");
    });

    it("zero-length range still produces both timestamps", () => {
        // Defensive: caller should not pass end=start, but if it happens the name must still be valid.
        const start = new Date(2026, 3, 29, 19, 27, 47).getTime() / 1000;
        const trip = makeTrip(start);
        const name = clipBasename(trip, 0, 0);
        expect(name).toBe("everydashcam_20260429_192747-192747");
    });

    it("clip across midnight uses full date for end timestamp", () => {
        // 2026-04-29 23:50:00 local + 905 sec → 2026-04-30 00:05:05
        const start = new Date(2026, 3, 29, 23, 50, 0).getTime() / 1000;
        const trip = makeTrip(start);
        const name = clipBasename(trip, 0, 905);
        expect(name).toBe("everydashcam_20260429_235000-20260430_000505");
    });

    it("clip across month boundary also uses full end timestamp", () => {
        // 2026-04-30 23:59:30 local + 60 sec → 2026-05-01 00:00:30
        const start = new Date(2026, 3, 30, 23, 59, 30).getTime() / 1000;
        const trip = makeTrip(start);
        const name = clipBasename(trip, 0, 60);
        expect(name).toBe("everydashcam_20260430_235930-20260501_000030");
    });

    it("ignores fractional seconds (whole-second granularity in filename)", () => {
        const start = new Date(2026, 3, 29, 19, 27, 47).getTime() / 1000;
        const trip = makeTrip(start);
        const name = clipBasename(trip, 0.4, 28.7);
        // 28.7 s added as 28700 ms to unix*1000 → new Date truncates to whole seconds → 19:28:15
        expect(name).toMatch(/^everydashcam_20260429_192747-1928\d{2}$/);
    });
});

// formatTripTitle only reads startUtc/endUtc (plus the i18n date locale); the
// timeline is irrelevant here, so a two-field stub is enough.
function makeTitleTrip(startUtc: number, endUtc: number): Trip {
    return { startUtc, endUtc } as unknown as Trip;
}

const secOf = (d: Date): number => d.getTime() / 1000;

describe("formatTripTitle", () => {
    // Runs under TZ=UTC (see package.json test script) so local getters == UTC.
    const now = new Date(2026, 5, 15, 12, 0, 0); // Mon Jun 15 2026

    it("hides the year for a trip in the current year", () => {
        const title = formatTripTitle(
            makeTitleTrip(secOf(new Date(2026, 3, 29, 18, 26, 0)), secOf(new Date(2026, 3, 29, 18, 42, 0))),
            now,
        );
        expect(title).toContain("→");
        expect(title, "current-year trip must not print the year").not.toMatch(/\b2026\b/);
    });

    it("shows the year when the trip is in a different year than now", () => {
        const title = formatTripTitle(
            makeTitleTrip(secOf(new Date(2024, 3, 29, 18, 26, 0)), secOf(new Date(2024, 3, 29, 18, 42, 0))),
            now,
        );
        expect(title).toMatch(/\b2024\b/);
    });

    it("same-day trip renders one date, overnight renders two", () => {
        const sameDay = formatTripTitle(
            makeTitleTrip(secOf(new Date(2026, 3, 29, 18, 26, 0)), secOf(new Date(2026, 3, 29, 18, 42, 0))),
            now,
        );
        const overnight = formatTripTitle(
            makeTitleTrip(secOf(new Date(2026, 3, 29, 23, 50, 0)), secOf(new Date(2026, 3, 30, 0, 15, 0))),
            now,
        );
        expect(sameDay).toBe("Apr 29, 18:26 → 18:42");
        expect(overnight).toBe("Apr 29, 23:50 → Apr 30, 00:15");
    });

    describe("with ISO dates", () => {
        afterEach(() => {
            setDateFormat("locale");
            resetDateFormat();
        });

        it("writes the date with its year and the clock", () => {
            setDateFormat("iso");
            const sameDay = formatTripTitle(
                makeTitleTrip(secOf(new Date(2026, 3, 29, 18, 26, 0)), secOf(new Date(2026, 3, 29, 18, 42, 0))),
                now,
            );
            const overnight = formatTripTitle(
                makeTitleTrip(secOf(new Date(2026, 3, 29, 23, 50, 0)), secOf(new Date(2026, 3, 30, 0, 15, 0))),
                now,
            );
            expect(sameDay).toBe("2026-04-29 18:26 → 18:42");
            expect(overnight).toBe("2026-04-29 23:50 → 2026-04-30 00:15");
            expect(formatDayHeading(2026, 3, 29, now).date).toBe("2026-04-29 Wed");
        });
    });
});

describe("formatDayHeading", () => {
    // TZ=UTC: the viewer's display clock is UTC, so the day math is stable.
    const now = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // Mon Jun 15 2026, noon

    it("adds Today and Yesterday on the viewer's calendar and nothing for other days", () => {
        // Comparing against t() (not a hard-coded string) keeps this locale-agnostic.
        expect(formatDayHeading(2026, 5, 15, now).relative).toBe(t("buckets.today"));
        expect(formatDayHeading(2026, 5, 14, now).relative).toBe(t("buckets.yesterday"));
        expect(formatDayHeading(2026, 5, 12, now).relative).toBeNull();
        expect(formatDayHeading(2025, 5, 15, now).relative).toBeNull();
    });

    it("gives a camera-clock day ahead of the viewer only its date", () => {
        const heading = formatDayHeading(2026, 5, 16, now);
        expect(heading.relative).toBeNull();
        expect(heading.date).toContain("16");
    });

    it("formats the weekday and the date of the given calendar day", () => {
        expect(formatDayHeading(2026, 9, 31, now).date).toBe("Sat, Oct 31");
    });
});

describe("formatTimeRange", () => {
    it("shows clock times on the camera clock and the weekday of an end on another day", () => {
        const start = Date.UTC(2026, 9, 31, 20, 4) / 1000;
        expect(formatTimeRange(start, start + 3600, 3 * 3600)).toBe("23:04 → Sun 00:04");
        expect(formatTimeRange(start, start + 600, 0)).toBe("20:04 → 20:14");
    });
});

describe("formatStartDate", () => {
    it("dates the start on the camera clock with the year only outside the current year", () => {
        const now = new Date(Date.UTC(2026, 5, 15, 12));
        // 22:10 UTC is already Sep 15 on a +3 h camera clock.
        const start = Date.UTC(2026, 8, 14, 22, 10) / 1000;
        expect(formatStartDate(start, 3 * 3600, now)).toBe("Sep 15");
        expect(formatStartDate(start, 0, now)).toBe("Sep 14");
        expect(formatStartDate(Date.UTC(2024, 6, 2, 9) / 1000, 0, now)).toBe("Jul 2, 2024");
    });
});

describe("compact row text", () => {
    it("titles a row with the clock range, or the start alone while the end is unknown", () => {
        const start = Date.UTC(2026, 9, 31, 8, 10) / 1000;
        const trip = { startUtc: start, endUtc: start + 21 * 60, cameraTzSec: 0 } as unknown as Trip;
        expect(formatTripClockTitle(trip, true)).toBe("08:10 → 08:31");
        expect(formatTripClockTitle(trip, false)).toBe("08:10");
    });

    it("puts distance and size on one line", () => {
        const trip = makeTrip(Date.UTC(2026, 9, 31, 8, 10) / 1000);
        (trip as { distanceKm: number }).distanceKm = 12;
        (trip as { totalBytes: number }).totalBytes = 300 * 1024 * 1024;
        const meta = formatTripRowMeta(trip);
        expect(meta).not.toContain("\n");
        expect(meta.split(" · ")).toHaveLength(2);
        expect(meta).toContain(formatTripDistance(12));
        expect(meta).toContain(formatBytes(300 * 1024 * 1024));
    });
});

describe("formatTotalDuration", () => {
    it("rounds a total to minutes, and to hours past ten hours", () => {
        expect(formatTotalDuration(12)).toBe("<1min");
        expect(formatTotalDuration(722)).toBe("12min");
        expect(formatTotalDuration(3600)).toBe("1h");
        expect(formatTotalDuration(4320)).toBe("1h 12min");
        expect(formatTotalDuration(28 * 3600 + 1700)).toBe("28h");
    });
});

describe("display clock (camera clock when the trip carries a zone estimate)", () => {
    it("formatTripTitle renders the camera clock, not the host zone", () => {
        // 12:00 UTC + camera zone +3h -> 15:00 regardless of where the viewer sits.
        const start = Date.UTC(2026, 3, 6, 12, 0, 0) / 1000;
        const trip = { startUtc: start, endUtc: start + 60, cameraTzSec: 3 * 3600 } as unknown as Trip;
        const title = formatTripTitle(trip, new Date(Date.UTC(2026, 0, 15)));
        expect(title).toContain("15:00");
        expect(title).toContain("15:01");
    });

    it("clipBasename shifts filename timestamps by the camera zone", () => {
        const start = Date.UTC(2026, 3, 29, 19, 27, 47) / 1000;
        const trip = makeTrip(start);
        (trip as { cameraTzSec: number | null }).cameraTzSec = 3 * 3600;
        expect(clipBasename(trip, 0, 28)).toBe("everydashcam_20260429_222747-222815");
    });
});

describe("formatRateBytes", () => {
    it("keeps a decimal in the MB band so nearby rates stay distinguishable", () => {
        // The case that motivated it: a tier at 1.3x the source rounded to the
        // same whole megabyte as the source, hiding the whole difference.
        const source = formatRateBytes(2_000_000);
        const withHeadroom = formatRateBytes(2_600_000);
        expect(formatBytes(2_000_000)).toBe(formatBytes(2_600_000));
        expect(withHeadroom).not.toBe(source);
    });

    it("stays on whole kilobytes below a megabyte", () => {
        expect(formatRateBytes(500_000)).toBe(`488 ${t("units.kb")}`);
    });

    it("switches to gigabytes at the top of the scale", () => {
        expect(formatRateBytes(3 * 1024 ** 3)).toBe(`3.00 ${t("units.gb")}`);
    });
});

describe("formatFileMeta", () => {
    const video = {
        file: { size: 10 * 1024 * 1024 },
        metadataReady: true,
        metadataFailed: false,
        startUtc: 100,
        durationSec: 60,
        records: [],
    } as unknown as VideoCandidate;

    it("does not claim that GPS is absent while telemetry is still being read", () => {
        expect(formatFileMeta(video, 100, true)).not.toContain(t("trip.fileMeta.noGps"));
        expect(formatFileMeta(video, 100, false)).toContain(t("trip.fileMeta.noGps"));
    });

    it("does not show estimated duration or no-GPS as facts after a metadata failure", () => {
        const failed = { ...video, metadataReady: false, metadataFailed: true } as VideoCandidate;
        const meta = formatFileMeta(failed, 100, false);
        expect(meta).toBe(`${t("trip.chip.readFailed")} · 10.0 ${t("units.mb")}`);
    });

    it("excludes transient teleport outliers from per-file distance", () => {
        const previous = getUnits();
        setUnits("metric");
        const base = {
            active: true,
            bearingDeg: 0,
            speedMs: 15,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "clip.mp4",
        };
        // ~1.1 km clip (~28 m/s) with a 760 km lon=0 glitch mid-clip;
        // unfiltered distance would exceed 1,500 km, matching the Viofo bug.
        const records = [
            { ...base, unixSeconds: 100, lat: 44.94, lon: 9.63 },
            { ...base, unixSeconds: 120, lat: 44.945, lon: 9.63 },
            { ...base, unixSeconds: 121, lat: 44.948, lon: 0 },
            { ...base, unixSeconds: 140, lat: 44.95, lon: 9.63 },
        ];
        const snapshot = [...records];
        const meta = formatFileMeta({ ...video, records } as unknown as VideoCandidate, 100, false);
        expect(meta).toContain(`1.1 ${t("units.km")}`);
        expect(records).toEqual(snapshot);
        setUnits(previous);
    });

    it("matches trip-filtered distance when groupTrips drops a teleport inside a single file", () => {
        const previous = getUnits();
        setUnits("metric");
        const t0 = Date.UTC(2026, 10, 25, 16, 17, 20) / 1000;
        const base = {
            active: true,
            bearingDeg: 0,
            speedMs: 15,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "2026_1125_161720_000373F.MP4",
        };
        // 3 fixes in one file: two real fixes ~1.1 km apart and one lon=0
        // teleport between them. Through real groupTrips + indexTripFilteredFixes,
        // the file row must show only the distance between the two kept fixes.
        const rawRecords = [
            { ...base, unixSeconds: t0, lat: 44.94, lon: 9.63 },
            { ...base, unixSeconds: t0 + 20, lat: 44.945, lon: 0 },
            { ...base, unixSeconds: t0 + 40, lat: 44.95, lon: 9.63 },
        ];
        const candidate = {
            file: new File([new Uint8Array(1024)], base.mp4Filename),
            relativePath: base.mp4Filename,
            fingerprint: "viofo",
            channel: "front",
            durationSec: 60,
            startUtc: t0,
            startSource: "gps",
            records: rawRecords,
            metadataReady: true,
            metadataFailed: false,
            codec: "avc",
            width: 1920,
            height: 1080,
            fps: 30,
        } as unknown as VideoCandidate;

        const trips = groupTrips([candidate]);
        expect(trips).toHaveLength(1);
        const trip = trips[0]!;
        expect(trip.records).toHaveLength(2);

        const tripFixes = indexTripFilteredFixes(trip);
        const meta = formatFileMeta(candidate, trip.startUtc, false, tripFixes);
        expect(meta).toContain(`1.1 ${t("units.km")}`);
        setUnits(previous);
    });

    it("uses trip-level filtered fixes when provided so a transition continued by the next file is preserved", () => {
        const previous = getUnits();
        setUnits("metric");
        const base = {
            active: true,
            bearingDeg: 0,
            speedMs: 0,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "clip1.mp4",
        };
        // 5 stationary fixes at A, then 2 fixes at B (~450 m away). Alone, the
        // 2 trailing points at B look like a trailing spike cluster; inside a
        // trip whose next file continues at B, trip.records keeps them.
        const file1Records = [
            ...Array.from({ length: 5 }, (_, i) => ({ ...base, unixSeconds: 100 + i, lat: 44.94, lon: 9.63 })),
            { ...base, unixSeconds: 105, lat: 44.94405, lon: 9.63 },
            { ...base, unixSeconds: 106, lat: 44.94405, lon: 9.63 },
        ];
        const file2Records = Array.from({ length: 5 }, (_, i) => ({
            ...base,
            mp4Filename: "clip2.mp4",
            unixSeconds: 107 + i,
            lat: 44.94405,
            lon: 9.63,
        }));
        const tripFixes = indexTripFilteredFixes({ records: [...file1Records, ...file2Records] });

        const meta = formatFileMeta(
            { ...video, records: file1Records } as unknown as VideoCandidate,
            100,
            false,
            tripFixes,
        );
        expect(meta).toContain(`0.5 ${t("units.km")}`);
        setUnits(previous);
    });

    it("omits distance for timeUnsynced records trimmed out of trip.records after GPS sync offset", () => {
        const previous = getUnits();
        setUnits("metric");
        const base = {
            active: true,
            timeUnsynced: true,
            bearingDeg: 0,
            speedMs: 15,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "70mai.mp4",
        };
        const unsyncedRecords = [
            { ...base, unixSeconds: 100, lat: 44.94, lon: 9.63 },
            { ...base, unixSeconds: 120, lat: 44.945, lon: 9.63 },
            { ...base, unixSeconds: 140, lat: 44.95, lon: 9.63 },
        ];
        // Trip was trimmed after shifting GPS past the clip -> trip.records is empty.
        const trimmedTripFixes = indexTripFilteredFixes({ records: [], gpsOffsetSec: 500 });
        const trimmedMeta = formatFileMeta(
            { ...video, records: unsyncedRecords } as unknown as VideoCandidate,
            100,
            false,
            trimmedTripFixes,
        );
        expect(trimmedMeta).not.toContain(t("units.km"));

        // Without trimming, surviving timeUnsynced fixes still report distance.
        const keptTripFixes = indexTripFilteredFixes({ records: unsyncedRecords, gpsOffsetSec: 0 });
        const keptMeta = formatFileMeta(
            { ...video, records: unsyncedRecords } as unknown as VideoCandidate,
            100,
            false,
            keptTripFixes,
        );
        expect(keptMeta).toContain(`1.1 ${t("units.km")}`);
        setUnits(previous);
    });
});

describe("formatTripDistance", () => {
    it("keeps short routes distinct from zero", () => {
        const previous = getUnits();
        setUnits("metric");
        expect(formatTripDistance(0.5)).toBe(`0.5 ${t("units.km")}`);
        expect(formatTripDistance(0.02)).toBe(`<0.1 ${t("units.km")}`);
        expect(formatTripDistance(12.3)).toBe(`12 ${t("units.km")}`);
        setUnits(previous);
    });
});
