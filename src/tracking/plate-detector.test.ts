import { describe, expect, it } from "vitest";

import type { RawDetection } from "./detect-common.js";
import { collectPlateDetections } from "./plate-detector.js";

describe("plate candidate geometry", () => {
    it.each([
        [700, 150],
        [500, 400],
    ])("retains a %i x %i plate without assuming camera distance or field of view", (w, h) => {
        const detections: RawDetection[] = [];
        collectPlateDetections(
            {
                data: new Float32Array([100 + w / 2, 100 + h / 2, w, h, 0.75]),
                dims: [1, 5, 1],
                lb: { scale: 1, dx: 0, dy: 0 },
                tile: { sx: 0, sy: 0, sw: 3840, sh: 2160 },
                frameW: 3840,
                frameH: 2160,
            },
            detections,
        );
        expect(detections).toEqual([{ x: 100, y: 100, w, h, score: 0.75 }]);
    });
});
