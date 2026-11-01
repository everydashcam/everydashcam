// How the interface writes dates and clock times, and the setting that picks
// the style. Every date shown in the UI goes through these formatters, so the
// setting applies everywhere at once. The styles:
//   "locale" - the UI language's own way, "Oct 31, 18:26" (the default);
//   "iso"    - ISO 8601, "2026-10-31 18:26": sorts as text, reads the same in
//              every language, always carries the year.
// Clock times are 24-hour in both styles.
//
// Callers pass display-clock Dates (displayClockDate in trips.ts): the camera
// or viewer zone shift is already inside the value, so everything here reads
// UTC fields and formats with timeZone "UTC".
//
// Deliberately outside the setting: the overlay drawn onto video
// (export-flow.ts), the maintainer report body (feedback.ts) and the search
// index (trip-search.ts), which matches every style anyway.

import { getDateLocale } from "../i18n/index.js";
import { readLocalStorage, writeLocalStorage } from "../local-storage.js";

export type DateFormat = "locale" | "iso";

const STORAGE_KEY = "everydashcam:date-format";
const CHANGE_EVENT = "dc:date-format-change";
const eventTarget = new EventTarget();

let cachedFormat: DateFormat | null = null;

export function isDateFormat(value: string): value is DateFormat {
    return value === "locale" || value === "iso";
}

/** The stored style; the language's own style when nothing valid is stored. */
export function getDateFormat(): DateFormat {
    if (cachedFormat !== null) return cachedFormat;
    const stored = readLocalStorage(STORAGE_KEY);
    cachedFormat = stored !== null && isDateFormat(stored) ? stored : "locale";
    return cachedFormat;
}

/** Stores the style and notifies subscribers; no-op when it is unchanged. */
export function setDateFormat(format: DateFormat): void {
    if (getDateFormat() === format) return;
    cachedFormat = format;
    writeLocalStorage(STORAGE_KEY, format);
    eventTarget.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Calls `handler` after the style changed, once getDateFormat() returns the
 * new value. Views that keep formatted dates on screen re-render from it.
 * Returns an unsubscribe function.
 */
export function subscribeDateFormatChange(handler: () => void): () => void {
    eventTarget.addEventListener(CHANGE_EVENT, handler);
    return () => eventTarget.removeEventListener(CHANGE_EVENT, handler);
}

/** Forgets the cached style so the next read goes to storage again. */
export function _resetForTests(): void {
    cachedFormat = null;
}

// Constructing an Intl.DateTimeFormat resolves locale data and compiles a
// pattern, which costs far more than formatting with it. Hover popups, the
// player readout and the range rulers format on every pointer move or
// timeupdate, so immutable formatters are shared per locale and option set.
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

/** A shared formatter for `locale` and `options`; same arguments, same instance. */
export function cachedDateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${locale}|${JSON.stringify(options)}`;
    let formatter = dateTimeFormatCache.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, options);
        dateTimeFormatCache.set(key, formatter);
    }
    return formatter;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");
const isoYear = (year: number): string => String(year).padStart(4, "0");

/** ISO 8601 calendar date, whatever the setting: "2026-10-31". */
function isoDate(date: Date): string {
    return `${isoYear(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function isoClock(date: Date, withSeconds: boolean): string {
    const clock = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
    return withSeconds ? `${clock}:${pad2(date.getUTCSeconds())}` : clock;
}

// hour12:false forces the 24-hour clock regardless of the locale default
// (en-US would otherwise give "04:43 PM").
const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

interface DateOptions {
    /** Writes the year; ISO dates always carry it. */
    readonly year?: boolean;
    /** Month name length in the language's own style; default short. */
    readonly month?: "short" | "long";
    /** Adds the short weekday: "Sat, Oct 31", or after an ISO date, "2026-10-31 Sat". */
    readonly weekday?: boolean;
    /** Writes in this style instead of the stored one, e.g. to preview the choices. */
    readonly format?: DateFormat;
}

/** A calendar date: "Oct 31" / "Oct 31, 2026", or "2026-10-31". */
export function formatDate(date: Date, options: DateOptions = {}): string {
    if ((options.format ?? getDateFormat()) === "iso") {
        return options.weekday ? `${isoDate(date)} ${formatWeekday(date)}` : isoDate(date);
    }
    return cachedDateTimeFormat(getDateLocale(), {
        ...(options.weekday ? { weekday: "short" } : {}),
        day: "numeric",
        month: options.month ?? "short",
        ...(options.year ? { year: "numeric" } : {}),
        timeZone: "UTC",
    }).format(date);
}

interface DateTimeOptions {
    /** Writes the year; ISO dates always carry it. */
    readonly year?: boolean;
    readonly seconds?: boolean;
}

/** A date with its clock: "Oct 31, 18:26", or "2026-10-31 18:26". */
export function formatDateTime(date: Date, options: DateTimeOptions = {}): string {
    if (getDateFormat() === "iso") return `${isoDate(date)} ${isoClock(date, options.seconds ?? false)}`;
    return cachedDateTimeFormat(getDateLocale(), {
        day: "numeric",
        month: "short",
        ...(options.year ? { year: "numeric" } : {}),
        ...CLOCK_OPTIONS,
        ...(options.seconds ? { second: "2-digit" } : {}),
        timeZone: "UTC",
    }).format(date);
}

/** The 24-hour clock alone, the same in both styles: "18:26" or "18:26:05". */
export function formatClock(date: Date, options: { readonly seconds?: boolean } = {}): string {
    return cachedDateTimeFormat(getDateLocale(), {
        ...CLOCK_OPTIONS,
        ...(options.seconds ? { second: "2-digit" } : {}),
        timeZone: "UTC",
    }).format(date);
}

/** The weekday name in the UI language, the same in both styles: "Sat", or "S" when narrow. */
export function formatWeekday(date: Date, width: "short" | "narrow" = "short"): string {
    return cachedDateTimeFormat(getDateLocale(), { weekday: width, timeZone: "UTC" }).format(date);
}

/**
 * A month of a year as a heading: "October 2026", or "2026-10". `month` is
 * 0-based, like Date. Locales that write month names in lower case get a
 * capital first letter, because the heading starts a line. `locale` is
 * injectable for tests.
 */
export function formatMonthYear(year: number, month: number, locale: string = getDateLocale()): string {
    if (getDateFormat() === "iso") return `${isoYear(year)}-${pad2(month + 1)}`;
    const parts = cachedDateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).formatToParts(
        new Date(Date.UTC(year, month, 1)),
    );
    // Some locales close the year with an abbreviation (ru "октябрь 2026 г."),
    // which only costs width in a narrow heading. A literal after the month
    // (ja "2026年10月") is part of the date and stays.
    let end = parts.length;
    while (end > 0 && parts[end - 1]!.type === "literal") end--;
    const kept = parts[end - 1]?.type === "year" ? parts.slice(0, end) : parts;
    const text = kept.map((part) => part.value).join("");
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}
