import { describe, expect, it } from "vitest";
import { SUPPORTED_BRANDS } from "../../vite-plugins/supported-brands.js";
import { BRAND_ALPHABET, createBrandCycle } from "./brand-mark.js";

const brands = SUPPORTED_BRANDS.map((brand) => brand.displayName.toUpperCase());

describe("brand cycle", () => {
    it.each([0, 0.25, 0.999])("shows every supported brand once per round with random value %s", (random) => {
        const next = createBrandCycle(() => random);
        let previous: string | undefined;
        for (let round = 0; round < 3; round++) {
            const seen: string[] = [];
            for (let index = 0; index < brands.length; index++) {
                const brand = next();
                expect(brand).not.toBe(previous);
                seen.push(brand);
                previous = brand;
            }
            expect(seen.sort()).toEqual([...brands].sort());
        }
    });

    it("avoids repeating the final brand when the next shuffle selects it first", () => {
        let random = 0;
        const next = createBrandCycle(() => random);
        let previous = "";
        for (let index = 0; index < brands.length; index++) previous = next();
        expect(previous).toBe(brands[1]);
        random = 1.5 / brands.length;
        expect(next()).not.toBe(previous);
    });

    it("represents each brand once using characters available on the drums", () => {
        expect(new Set(brands).size).toBe(brands.length);
        for (const brand of brands) {
            expect(brand.length).toBeGreaterThanOrEqual(2);
            for (const letter of brand) expect(BRAND_ALPHABET, brand).toContain(letter);
        }
    });
});
