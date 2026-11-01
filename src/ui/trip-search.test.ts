import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesTripSearch } from "../trip-filters.js";
import type { Trip } from "../trips.js";
import { tripSearchText } from "./trip-search.js";

/** A trip with one front clip; only the fields the search text reads. */
function trip(startUtc: number, cameraTzSec: number | null, fileName: string): Trip {
    const candidate = { file: { name: fileName } };
    return { startUtc, cameraTzSec, frames: [{ channels: { front: candidate } }] } as unknown as Trip;
}

describe("tripSearchText", () => {
    // 23:30 UTC on Oct 30 is already Oct 31 on a +2 h camera clock.
    const text = tripSearchText(trip(Date.UTC(2026, 9, 30, 23, 30) / 1000, 7200, "NO20261031-013000-000001F.MP4"), {
        name: "Lake house",
        note: "Roadworks by the bridge",
    });

    it("finds a trip by its camera-clock date written several ways", () => {
        for (const query of ["oct 31", "october 31", "saturday", "2026-10-31", "10/31/2026", "01:30"]) {
            expect(matchesTripSearch(text, query), query).toBe(true);
        }
        expect(matchesTripSearch(text, "oct 30")).toBe(false);
        expect(matchesTripSearch(text, "01")).toBe(true);
        expect(matchesTripSearch(text, "30")).toBe(true);
    });

    it("finds a trip by name, note and file name", () => {
        expect(matchesTripSearch(text, "lake bridge")).toBe(true);
        expect(matchesTripSearch(text, "no20261031")).toBe(true);
    });
});

describe("localized date search", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it.each([
        ["de", "oktober"],
        ["ja", "10月"],
        ["zh", "10月"],
        ["ko", "10월"],
    ])("finds a day and month in %s without requiring date punctuation", async (lang, month) => {
        vi.stubGlobal("location", { pathname: `/${lang}/` });
        vi.resetModules();
        const { tripSearchText } = await import("./trip-search.js");
        const text = tripSearchText(trip(Date.UTC(2026, 9, 31, 18, 30) / 1000, 0, "clip.mp4"));
        expect(matchesTripSearch(text, `${month} 31`)).toBe(true);
        expect(matchesTripSearch(text, `${month} 30`)).toBe(false);
        expect(matchesTripSearch(text, `${month} 3`)).toBe(false);
    });
});
