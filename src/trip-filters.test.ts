import { describe, expect, it } from "vitest";
import { hasTripFilters, matchesTripSearch, normalizeSearchText } from "./trip-filters.js";

describe("trip search", () => {
    const text = normalizeSearchText("Ёлки на Café street | 31 октября 2026 | NO20261031-080000-000001F.MP4");

    it("matches every word anywhere, ignoring case and diacritics", () => {
        expect(matchesTripSearch(text, "cafe")).toBe(true);
        expect(matchesTripSearch(text, "  ЕЛКИ   окт ")).toBe(true);
        expect(matchesTripSearch(text, "no20261031")).toBe(true);
        expect(matchesTripSearch(text, "cafe ноября")).toBe(false);
    });

    it("matches a day or hour number only as a whole word and longer numbers at a word start", () => {
        expect(matchesTripSearch(text, "31 окт")).toBe(true);
        expect(matchesTripSearch(text, "3 окт")).toBe(false);
        expect(matchesTripSearch(text, "2 октября")).toBe(false);
        expect(matchesTripSearch(text, "202")).toBe(true);
        expect(matchesTripSearch(text, "0800")).toBe(false);
        expect(matchesTripSearch(text, "080000")).toBe(false);
        expect(matchesTripSearch(text, "no2026")).toBe(true);
    });

    it("treats a blank query as no search", () => {
        expect(matchesTripSearch("", "   ")).toBe(true);
        const filters = { kind: "all", event: false, manual: false, notes: false, favorites: false } as const;
        expect(hasTripFilters({ ...filters, query: "  " })).toBe(false);
        expect(hasTripFilters({ ...filters, query: "oct" })).toBe(true);
    });
});
