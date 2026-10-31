// Pure formatter coverage without DOM dependencies.

import { describe, it, expect } from "vitest";
import {
    cachedDateTimeFormat,
    clipBasename,
    eventLabel,
    formatBytes,
    formatDayHeading,
    formatEventSeverity,
    formatFileMeta,
    formatMonthHeading,
    formatRateBytes,
    formatTimeRange,
    formatTripClockTitle,
    formatTripRowMeta,
    formatTripTitle,
    formatTripDistance,
} from "./format.js";
import { setUnits, getUnits } from "../units-pref.js";
import { t } from "../i18n/index.js";
import { buildTripTimeline, type Trip, type TripFrame, type VideoCandidate } from "../trips.js";

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
        // Same-day form has a comma between the single date and the time range;
        // the overnight form repeats "date time" on both sides of the arrow.
        expect(sameDay).toContain(", ");
        expect(overnight).not.toContain(", ");
        expect(overnight.split("→")).toHaveLength(2);
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

describe("compact row text", () => {
    it("titles a row with the clock range, or the start alone while the end is unknown", () => {
        const start = Date.UTC(2026, 9, 31, 8, 10) / 1000;
        const trip = { startUtc: start, endUtc: start + 21 * 60, cameraTzSec: 0 } as unknown as Trip;
        expect(formatTripClockTitle(trip, true)).toBe("08:10 → 08:31");
        expect(formatTripClockTitle(trip, false)).toBe("08:10");
    });

    it("puts duration, distance and size on one line", () => {
        const trip = makeTrip(Date.UTC(2026, 9, 31, 8, 10) / 1000);
        (trip as { distanceKm: number }).distanceKm = 12;
        (trip as { totalBytes: number }).totalBytes = 300 * 1024 * 1024;
        const meta = formatTripRowMeta(trip);
        expect(meta).not.toContain("\n");
        expect(meta.split(" · ")).toHaveLength(3);
        expect(meta).toContain(formatTripDistance(12));
        expect(meta).toContain(formatBytes(300 * 1024 * 1024));
    });
});

describe("formatMonthHeading", () => {
    it("names the month and the year", () => {
        expect(formatMonthHeading(2026, 9)).toBe("October 2026");
    });

    it("drops a year abbreviation but keeps a month marker", () => {
        expect(formatMonthHeading(2026, 9, "ru-RU")).toBe("Октябрь 2026");
        expect(formatMonthHeading(2026, 9, "ja-JP")).toBe("2026年10月");
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

describe("cachedDateTimeFormat", () => {
    it("shares one formatter per locale and option set", () => {
        const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone: "UTC" };
        const first = cachedDateTimeFormat("en", options);
        expect(cachedDateTimeFormat("en", { ...options })).toBe(first);
        expect(cachedDateTimeFormat("ru", options)).not.toBe(first);
        expect(cachedDateTimeFormat("en", { ...options, second: "2-digit" })).not.toBe(first);
    });

    it("formats like a freshly constructed formatter", () => {
        const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
        const date = new Date(Date.UTC(2026, 9, 31, 12));
        expect(cachedDateTimeFormat("de", options).format(date)).toBe(
            new Intl.DateTimeFormat("de", options).format(date),
        );
    });
});
