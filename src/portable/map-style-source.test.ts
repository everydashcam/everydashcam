import { describe, expect, it } from "vitest";
import light from "../../public/styles/light.json";
import dark from "../../public/styles/dark.json";
import sanAndreas from "../../public/styles/san-andreas.json";
import viceCity from "../../public/styles/vice-city.json";
import underground2 from "../../public/styles/underground-2.json";
import neon from "../../public/styles/neon.json";
import { loadMapStyleSource } from "./map-style-source.js";

describe("portable map styles", () => {
    it.each([
        ["light", light],
        ["dark", dark],
        ["neon", neon],
        ["san-andreas", sanAndreas],
        ["vice-city", viceCity],
        ["underground-2", underground2],
    ] as const)("preserves the %s style and isolates map mutations", async (theme, source) => {
        const original = structuredClone(source);
        const expected = { ...original, sprite: "dcasset://assets/sprite" };
        const signal = new AbortController().signal;
        const first = await loadMapStyleSource(theme, signal);
        expect(first).toEqual(expected);
        expect(first.layers.length).toBeGreaterThan(0);
        first.layers[0]!.id = "changed-by-map";
        first.sources.openmaptiles = { type: "vector", tiles: [] };
        expect(await loadMapStyleSource(theme, signal)).toEqual(expected);
        expect(source).toEqual(original);
    });

    it("rejects a cancelled request with its original reason", async () => {
        const controller = new AbortController();
        controller.abort("superseded");
        await expect(loadMapStyleSource("light", controller.signal)).rejects.toBe("superseded");
    });

    it("honors cancellation while the selected style module loads", async () => {
        const controller = new AbortController();
        const pending = loadMapStyleSource("light", controller.signal);
        controller.abort("superseded");
        await expect(pending).rejects.toBe("superseded");
    });
});
