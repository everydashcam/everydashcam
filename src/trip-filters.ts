import type { Trip } from "./trips.js";
import type { TripMetaAnnotation } from "./persist/types.js";
import { frameRecordingMode, tripAllCandidates } from "./trips.js";

export type TripFilterKind = "all" | "normal" | "parking";
export type TripToggleFilter = "event" | "manual" | "notes" | "favorites";

export interface TripFilters {
    kind: TripFilterKind;
    event: boolean;
    manual: boolean;
    notes: boolean;
    favorites: boolean;
    /** Free-text search; every word must appear in the trip's search text. */
    query: string;
}

export interface TripFilterFacts {
    kind: Exclude<TripFilterKind, "all"> | null;
    event: boolean;
    manual: boolean;
    notes: boolean;
    favorites: boolean;
    /** Normalized text the search query is matched against (see normalizeSearchText). */
    searchText: string;
}

/**
 * Lower-cases and strips diacritics so "Café" matches "cafe" and "Ёлка" matches
 * "елка". Applied to both sides of a match, so stripped letters stay consistent.
 */
export function normalizeSearchText(text: string): string {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * True when every word of `query` occurs in the already normalized
 * `searchText`, anywhere - so the tail of a file name finds its trip. The one
 * exception is a bare one- or two-digit number: it is a day or an hour and
 * must be a whole word, because every trip's text is full of digits and
 * "sep 2" would otherwise match all of September 2026.
 */
export function matchesTripSearch(searchText: string, query: string): boolean {
    const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    let textWords: string[] | null = null;
    return words.every((word) => {
        if (!/^\d{1,2}$/.test(word)) return searchText.includes(word);
        textWords ??= searchText.split(/[\s|,]+/);
        return textWords.includes(word);
    });
}

/**
 * Filter facts for one trip. `searchText` is built by the UI, which owns the
 * locale-dependent date wording; callers without an active search pass "".
 */
export function tripFilterFacts(
    trip: Trip,
    meta?: Pick<TripMetaAnnotation, "note" | "isFavorite"> | null,
    searchText = "",
): TripFilterFacts {
    const candidates = tripAllCandidates(trip);
    return {
        // Only expose a trip type when the recordings establish it.
        kind: trip.isParking
            ? "parking"
            : trip.frames.some((f) => frameRecordingMode(f) === "normal")
              ? "normal"
              : null,
        event: candidates.some((c) => c.recordingMode === "event"),
        manual: candidates.some((c) => c.recordingMode === "manual"),
        notes: Boolean(meta?.note?.trim()),
        favorites: meta?.isFavorite === true,
        searchText,
    };
}

export function matchesTripFilters(facts: TripFilterFacts, filters: TripFilters): boolean {
    return (
        (filters.kind === "all" || facts.kind === filters.kind) &&
        (!filters.notes || facts.notes) &&
        (!filters.favorites || facts.favorites) &&
        matchesTripSearch(facts.searchText, filters.query) &&
        ((!filters.event && !filters.manual) || (filters.event && facts.event) || (filters.manual && facts.manual))
    );
}

export function hasTripFilters(filters: TripFilters): boolean {
    return (
        filters.kind !== "all" ||
        filters.event ||
        filters.manual ||
        filters.notes ||
        filters.favorites ||
        filters.query.trim() !== ""
    );
}
