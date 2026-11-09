import { describe, expect, it } from "vitest";
import { hasTripFilters, matchesTripFilters, matchesTripSearch, normalizeSearchText } from "./trip-filters.js";
import type { TripFilterFacts, TripFilters } from "./trip-filters.js";

describe("trip search", () => {
    const text = normalizeSearchText("Ёлки на Café street | 31 октября 2026 | NO20261031-080000-000001F.MP4");

    it("matches every word anywhere, ignoring case and diacritics", () => {
        expect(matchesTripSearch(text, "cafe")).toBe(true);
        expect(matchesTripSearch(text, "  ЕЛКИ   окт ")).toBe(true);
        expect(matchesTripSearch(text, "no20261031")).toBe(true);
        expect(matchesTripSearch(text, "cafe ноября")).toBe(false);
    });

    it("matches numeric terms in date phrases only as whole words", () => {
        expect(matchesTripSearch(text, "31 окт")).toBe(true);
        expect(matchesTripSearch(text, "3 окт")).toBe(false);
        expect(matchesTripSearch(text, "2 октября")).toBe(false);
    });

    it("finds standalone numbers in clocks and dates without matching longer numbers", () => {
        const text = normalizeSearchText("2026年10月31日土曜日 | 2026/10/31 | 18:05 | NO20261031-180500-000001F.MP4");
        for (const query of ["31", "18", "05"]) {
            expect(matchesTripSearch(text, query), query).toBe(true);
        }
        for (const query of ["3", "26", "1"]) {
            expect(matchesTripSearch(text, query), query).toBe(false);
        }
    });

    it("finds any longer piece of a file name, including its tail", () => {
        expect(matchesTripSearch(text, "no2026")).toBe(true);
        expect(matchesTripSearch(text, "080000")).toBe(true);
        expect(matchesTripSearch(text, "0001f")).toBe(true);
        expect(matchesTripSearch(text, "01F.mp4")).toBe(true);
        expect(matchesTripSearch(text, "0002f")).toBe(false);
    });

    it("treats a blank query as no search", () => {
        expect(matchesTripSearch("", "   ")).toBe(true);
        const filters = {
            kind: "all",
            event: false,
            manual: false,
            notes: false,
            favorites: false,
            mapArea: false,
            place: false,
        } as const;
        expect(hasTripFilters({ ...filters, query: "  " })).toBe(false);
        expect(hasTripFilters({ ...filters, query: "oct" })).toBe(true);
    });
});

describe("map filters", () => {
    const filters: TripFilters = {
        kind: "all",
        event: false,
        manual: false,
        notes: false,
        favorites: false,
        query: "",
        mapArea: false,
        place: false,
    };
    const facts: TripFilterFacts = {
        kind: "normal",
        event: false,
        manual: false,
        notes: false,
        favorites: false,
        searchText: "",
        hasTrack: false,
        inMapArea: false,
        passesPlace: false,
    };

    it("keeps trips without a route while the map frame cuts nothing", () => {
        expect(matchesTripFilters(facts, filters)).toBe(true);
        expect(hasTripFilters(filters)).toBe(false);
    });

    it("keeps only routes crossing the frame once the frame cuts some out", () => {
        const area = { ...filters, mapArea: true };
        expect(hasTripFilters(area)).toBe(true);
        expect(matchesTripFilters({ ...facts, hasTrack: true, inMapArea: true }, area)).toBe(true);
        expect(matchesTripFilters({ ...facts, hasTrack: true }, area), "route outside the frame").toBe(false);
        expect(matchesTripFilters(facts, area), "trip without a route").toBe(false);
    });

    it("keeps only trips passing the chosen place, combined with the other filters", () => {
        const place = { ...filters, place: true, kind: "normal" as const };
        expect(hasTripFilters(place)).toBe(true);
        expect(matchesTripFilters({ ...facts, hasTrack: true, passesPlace: true }, place)).toBe(true);
        expect(matchesTripFilters({ ...facts, hasTrack: true }, place)).toBe(false);
        expect(
            matchesTripFilters({ ...facts, kind: "parking", hasTrack: true, passesPlace: true }, place),
            "a parking trip through the place",
        ).toBe(false);
    });
});
