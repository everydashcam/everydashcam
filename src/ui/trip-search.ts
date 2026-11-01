// Text a trip is found by in the sidebar search: its name and note, the
// recording file names, and its start date written the ways a person types it
// in the UI language ("31 oct", "31.10.2026", "2026-10-31", "saturday").

import { getDateLocale } from "../i18n/index.js";
import type { TripMetaAnnotation } from "../persist/types.js";
import { normalizeSearchText } from "../trip-filters.js";
import { displayClockDate, tripAllCandidates } from "../trips.js";
import type { Trip } from "../trips.js";
import { cachedDateTimeFormat } from "./date-format.js";

// Long and short month names, the numeric date and the clock, all on the
// display clock (timeZone UTC: the shift is already inside the Date).
const SEARCH_DATE_FORMATS: readonly Intl.DateTimeFormatOptions[] = [
    { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" },
    { day: "numeric", month: "short", timeZone: "UTC" },
    { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" },
    { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" },
];

/** The normalized search text for one trip (see matchesTripSearch). */
export function tripSearchText(trip: Trip, meta?: Pick<TripMetaAnnotation, "name" | "note"> | null): string {
    const locale = getDateLocale();
    const start = displayClockDate(trip.startUtc, trip.cameraTzSec);
    const parts = [
        meta?.name,
        meta?.note,
        // The display-clock fields are the Date's UTC fields, so this is the local ISO date.
        start.toISOString().slice(0, 10),
        // Keep the day searchable as a whole word in phrases even when the
        // locale attaches punctuation or a suffix ("31. Oktober", "10月31日").
        String(start.getUTCDate()),
        ...SEARCH_DATE_FORMATS.map((options) => cachedDateTimeFormat(locale, options).format(start)),
        ...tripAllCandidates(trip).map((candidate) => candidate.file.name),
    ];
    return normalizeSearchText(parts.filter(Boolean).join(" | "));
}
