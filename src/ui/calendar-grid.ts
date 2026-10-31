// Month grid math for the jump-to-date calendar. Pure, so week starts and
// month edges stay testable without a DOM.

/**
 * First day of the week for `locale`, as Date#getUTCDay numbers it
 * (0 = Sunday). Engines without Intl week data get Monday, the most common
 * start among the UI languages.
 */
export function firstDayOfWeek(locale: string): number {
    let info: unknown;
    try {
        const intlLocale: unknown = new Intl.Locale(locale);
        // getWeekInfo() is the current API; older engines expose a weekInfo getter.
        const getter = (intlLocale as { getWeekInfo?: unknown }).getWeekInfo;
        info = typeof getter === "function" ? getter.call(intlLocale) : (intlLocale as { weekInfo?: unknown }).weekInfo;
    } catch {
        info = undefined;
    }
    const firstDay = info && typeof info === "object" ? (info as { firstDay?: unknown }).firstDay : undefined;
    // Intl week data numbers days from 1 (Monday) to 7 (Sunday).
    return typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7 ? firstDay % 7 : 1;
}

/** Weekday numbers (0 = Sunday) in display order for a week starting on `weekStart`. */
export function weekdayOrder(weekStart: number): number[] {
    return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

/** A month's cells in reading order: null for blanks before the 1st, then day numbers. */
export function monthGridCells(year: number, month: number, weekStart: number): (number | null)[] {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const blanks = (firstWeekday - weekStart + 7) % 7;
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return [...Array<null>(blanks).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
}
