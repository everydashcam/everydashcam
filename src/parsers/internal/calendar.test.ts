import { describe, expect, it } from "vitest";

import {
    parseCompactTimestamp,
    parseIsoCalendarTime,
    utcMillisecondsFromParts,
    utcSecondsFromYmdhms,
} from "./calendar.js";

describe("utcMillisecondsFromParts", () => {
    it("keeps a valid leap day", () => {
        expect(utcMillisecondsFromParts(2024, 2, 29, 12, 34, 56)).toBe(Date.UTC(2024, 1, 29, 12, 34, 56));
    });

    it("rejects a day that JavaScript would roll into the next month", () => {
        expect(utcMillisecondsFromParts(2026, 2, 31, 12, 0, 0)).toBeNull();
        expect(utcMillisecondsFromParts(2026, 4, 31, 12, 0, 0)).toBeNull();
    });

    it("normalizes an allowed leap second to the next UTC second", () => {
        expect(utcMillisecondsFromParts(2016, 12, 31, 23, 59, 60, true)).toBe(Date.UTC(2017, 0, 1));
    });

    it("rejects negative clock fields", () => {
        expect(utcMillisecondsFromParts(2026, 1, 1, -1, 0, 0)).toBeNull();
    });
});

describe("camera calendar formats", () => {
    it("keeps the binary two-digit year convention separate from generic dates", () => {
        expect(utcSecondsFromYmdhms(24, 2, 29, 12, 0, 0)).toBe(Date.UTC(2024, 1, 29, 12) / 1000);
        expect(utcSecondsFromYmdhms(2024, 2, 29, 12, 0, 0)).toBe(Date.UTC(2024, 1, 29, 12) / 1000);
        expect(utcSecondsFromYmdhms(1999, 12, 31, 0, 0, 0)).toBeNull();
        expect(utcSecondsFromYmdhms(2100, 1, 1, 0, 0, 0)).toBeNull();
        expect(parseCompactTimestamp("19991231000000")).toBe(Date.UTC(1999, 11, 31) / 1000);
    });

    it("retains each compact format's leap-second policy", () => {
        expect(parseCompactTimestamp("20161231235960")).toBeNull();
        expect(parseCompactTimestamp("20161231235960", true)).toBe(Date.UTC(2017, 0, 1) / 1000);
        expect(parseCompactTimestamp("20260231000000")).toBeNull();
        expect(parseCompactTimestamp("20240101000000 ")).toBeNull();
    });

    it("separates ISO precision and zone presence without applying the host timezone", () => {
        const expected = {
            baseMilliseconds: Date.UTC(2024, 1, 29, 12),
            fractionalSeconds: 0.123456,
            offsetSeconds: -3 * 3600 - 30 * 60,
            hasExplicitTimezone: true,
        };
        expect(parseIsoCalendarTime("2024-02-29T12:00:00.123456-0330")).toEqual(expected);
        expect(parseIsoCalendarTime("2024-02-29 12:00:00")).toMatchObject({
            offsetSeconds: 0,
            hasExplicitTimezone: false,
        });
        expect(parseIsoCalendarTime("2024-02-29T12:00:00+24:00")).toBeNull();
        expect(parseIsoCalendarTime("2024-02-30T12:00:00Z")).toBeNull();
    });

    it("keeps GPX permissiveness opt-in for the stricter Nextbase format", () => {
        const value = "2016-12-31t23:59:60z";
        expect(parseIsoCalendarTime(value)).toBeNull();
        expect(parseIsoCalendarTime(value, { caseInsensitive: true })).toBeNull();
        expect(parseIsoCalendarTime(value, { caseInsensitive: true, allowLeapSecond: true })).toMatchObject({
            baseMilliseconds: Date.UTC(2017, 0, 1),
            hasExplicitTimezone: true,
        });
        expect(parseIsoCalendarTime("2024-01-01T00:00:00+03:00Z", { caseInsensitive: true })).toBeNull();
    });
});
