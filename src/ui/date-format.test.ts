import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    cachedDateTimeFormat,
    formatClock,
    formatDate,
    formatDateTime,
    formatMonthYear,
    formatWeekday,
    getDateFormat,
    setDateFormat,
    subscribeDateFormatChange,
} from "./date-format.js";

// Display-clock values: the UTC fields are the wall clock (displayClockDate).
const evening = new Date(Date.UTC(2026, 9, 31, 18, 26, 5));
const newYear = new Date(Date.UTC(2027, 0, 1, 0, 5, 9));

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
    const values = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    });
    return values;
}

beforeEach(() => _resetForTests());
afterEach(() => {
    vi.unstubAllGlobals();
    _resetForTests();
});

describe("date format setting", () => {
    it("defaults to the language's own style", () => {
        stubStorage();
        expect(getDateFormat()).toBe("locale");
    });

    it("ignores an unknown stored value", () => {
        stubStorage({ "everydashcam:date-format": "us" });
        expect(getDateFormat()).toBe("locale");
    });

    it("stores the choice and notifies subscribers once per change", () => {
        const values = stubStorage();
        let changes = 0;
        const unsubscribe = subscribeDateFormatChange(() => changes++);
        setDateFormat("iso");
        setDateFormat("iso");
        expect(getDateFormat()).toBe("iso");
        expect(values.get("everydashcam:date-format")).toBe("iso");
        expect(changes).toBe(1);
        unsubscribe();
        setDateFormat("locale");
        expect(changes).toBe(1);
    });

    it("reads a stored ISO choice", () => {
        stubStorage({ "everydashcam:date-format": "iso" });
        expect(getDateFormat()).toBe("iso");
    });
});

describe("language style", () => {
    it("writes dates with the month name", () => {
        expect(formatDate(evening)).toBe("Oct 31");
        expect(formatDate(evening, { year: true })).toBe("Oct 31, 2026");
        expect(formatDate(evening, { year: true, month: "long" })).toBe("October 31, 2026");
        expect(formatDate(evening, { weekday: true })).toBe("Sat, Oct 31");
    });

    it("writes a date with a 24-hour clock", () => {
        expect(formatDateTime(evening)).toBe("Oct 31, 18:26");
        expect(formatDateTime(evening, { year: true, seconds: true })).toBe("Oct 31, 2026, 18:26:05");
    });

    it("names the month and the year", () => {
        expect(formatMonthYear(2026, 9)).toBe("October 2026");
    });

    it("drops a year abbreviation but keeps a month marker", () => {
        expect(formatMonthYear(2026, 9, "ru-RU")).toBe("Октябрь 2026");
        expect(formatMonthYear(2026, 9, "ja-JP")).toBe("2026年10月");
    });
});

describe("ISO style", () => {
    beforeEach(() => setDateFormat("iso"));

    it("writes numeric dates that always carry the year", () => {
        expect(formatDate(evening)).toBe("2026-10-31");
        expect(formatDate(evening, { month: "long" })).toBe("2026-10-31");
        expect(formatDate(newYear)).toBe("2027-01-01");
    });

    it("keeps the weekday after the date", () => {
        expect(formatDate(evening, { weekday: true })).toBe("2026-10-31 Sat");
    });

    it("writes the date and clock with a space between them", () => {
        expect(formatDateTime(evening)).toBe("2026-10-31 18:26");
        expect(formatDateTime(newYear, { seconds: true })).toBe("2027-01-01 00:05:09");
    });

    it("writes a month as year and month numbers", () => {
        expect(formatMonthYear(2026, 9)).toBe("2026-10");
        expect(formatMonthYear(2026, 0, "ru-RU")).toBe("2026-01");
    });

    it("previews the other style on request", () => {
        expect(formatDate(evening, { year: true, format: "locale" })).toBe("Oct 31, 2026");
    });
});

describe("style-independent parts", () => {
    it.each(["locale", "iso"] as const)("writes the same clock and weekday in the %s style", (format) => {
        setDateFormat(format);
        expect(formatClock(newYear)).toBe("00:05");
        expect(formatClock(evening, { seconds: true })).toBe("18:26:05");
        expect(formatWeekday(evening)).toBe("Sat");
        expect(formatWeekday(evening, "narrow")).toBe("S");
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
        expect(cachedDateTimeFormat("de", options).format(evening)).toBe(
            new Intl.DateTimeFormat("de", options).format(evening),
        );
    });
});
