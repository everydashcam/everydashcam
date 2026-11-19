import { describe, expect, it } from "vitest";

import { endpointFlagAnchor, endpointFlagSvg } from "./map-endpoint-flag.js";

const COLORS = { fill: "#30a46c", stroke: "#0e0e0e" };

describe("endpoint flags", () => {
    it("stands the pole foot on the route point at the artwork's own size", () => {
        expect(endpointFlagAnchor("start")).toEqual({ anchor: "bottom-right", offset: [1, 1] });
        expect(endpointFlagAnchor("end")).toEqual({ anchor: "bottom-left", offset: [-1, 1] });
    });

    it("keeps the pole foot on the point when an inset scales the flag", () => {
        expect(endpointFlagAnchor("start", 16)).toEqual({ anchor: "bottom-right", offset: [0.5, 0.5] });
        expect(endpointFlagAnchor("end", 16)).toEqual({ anchor: "bottom-left", offset: [-0.5, 0.5] });
    });

    it("scales the markup without changing the artwork", () => {
        const full = endpointFlagSvg("end", COLORS);
        const small = endpointFlagSvg("end", COLORS, 16);
        expect(full).toContain('width="28" height="32"');
        expect(small).toContain('width="14" height="16"');
        expect(small.replace('width="14" height="16"', "")).toBe(full.replace('width="28" height="32"', ""));
        expect(full).toContain('fill="#30a46c"');
        expect(endpointFlagSvg("start", COLORS)).toContain('d="M27 2V31"');
    });
});
