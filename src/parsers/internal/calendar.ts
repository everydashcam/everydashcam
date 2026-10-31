/**
 * Builds a UTC timestamp without JavaScript's calendar rollover. A parser that
 * reads February 31 or April 31 has decoded corrupt bytes and must reject the
 * record instead of silently moving it into the next month.
 */
export function utcMillisecondsFromParts(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    allowLeapSecond = false,
): number | null {
    if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null;
    if (year < 100 || year > 9999) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const isLeapSecond = allowLeapSecond && second === 60;
    if (second < 0 || second > (allowLeapSecond ? 60 : 59)) return null;

    const normalizedSecond = isLeapSecond ? 59 : second;
    const ms = Date.UTC(year, month - 1, day, hour, minute, normalizedSecond);
    if (!Number.isFinite(ms)) return null;
    const date = new Date(ms);
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute ||
        date.getUTCSeconds() !== normalizedSecond
    ) {
        return null;
    }
    return isLeapSecond ? ms + 1000 : ms;
}

/** Plausibility window for camera clocks; generic GPS/GPX dates have wider bounds. */
export function isDashcamYear(year: number): boolean {
    return year >= 2000 && year <= 2099;
}

/** Binary camera dates accept either an absolute year or a year since 2000. */
export function utcSecondsFromYmdhms(
    yearRaw: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): number | null {
    if (![yearRaw, month, day, hour, minute, second].every(Number.isFinite)) return null;
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (!isDashcamYear(year)) return null;
    const ms = utcMillisecondsFromParts(year, month, day, hour, minute, second);
    return ms === null ? null : ms / 1000;
}

/** Compact camera-local fields, represented as UTC without applying the host zone. */
export function parseCompactTimestamp(value: string, allowLeapSecond = false): number | null {
    if (!/^\d{14}$/.test(value)) return null;
    const ms = utcMillisecondsFromParts(
        Number(value.slice(0, 4)),
        Number(value.slice(4, 6)),
        Number(value.slice(6, 8)),
        Number(value.slice(8, 10)),
        Number(value.slice(10, 12)),
        Number(value.slice(12, 14)),
        allowLeapSecond,
    );
    return ms === null ? null : ms / 1000;
}

interface IsoCalendarTime {
    baseMilliseconds: number;
    fractionalSeconds: number;
    offsetSeconds: number;
    hasExplicitTimezone: boolean;
}

/** ISO calendar fields with an optional zone. Callers keep their own precision
 * and format repairs; an absent zone always means a deterministic UTC clock. */
export function parseIsoCalendarTime(
    value: string,
    options: { allowLeapSecond?: boolean; caseInsensitive?: boolean } = {},
): IsoCalendarTime | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
        options.caseInsensitive ? value.trim().toUpperCase() : value.trim(),
    );
    if (!match) return null;
    const [, y, mo, d, h, mi, s, fraction = "", zone] = match;
    const baseMilliseconds = utcMillisecondsFromParts(
        Number(y),
        Number(mo),
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
        options.allowLeapSecond,
    );
    if (baseMilliseconds === null) return null;
    const fractionalSeconds = fraction === "" ? 0 : Number(fraction);
    if (!Number.isFinite(fractionalSeconds)) return null;
    let offsetSeconds = 0;
    if (zone && zone.toUpperCase() !== "Z") {
        const digits = zone.slice(1).replace(":", "");
        const hours = Number(digits.slice(0, 2));
        const minutes = Number(digits.slice(2));
        if (hours > 23 || minutes > 59) return null;
        offsetSeconds = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes) * 60;
    }
    return { baseMilliseconds, fractionalSeconds, offsetSeconds, hasExplicitTimezone: zone !== undefined };
}
