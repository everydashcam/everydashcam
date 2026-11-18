import { describe, expect, it } from "vitest";
import light from "../../public/styles/light.json";
import dark from "../../public/styles/dark.json";
import la92 from "../../public/styles/la-92.json";
import miami86 from "../../public/styles/miami-86.json";
import tuner04 from "../../public/styles/tuner-04.json";
import neon from "../../public/styles/neon.json";
import { loadMapStyleSource } from "./map-style-source.js";

describe("portable map styles", () => {
    it.each([
        ["light", light],
        ["dark", dark],
        ["neon", neon],
        ["la-92", la92],
        ["miami-86", miami86],
        ["tuner-04", tuner04],
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
