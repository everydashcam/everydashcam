import { describe, expect, it } from "vitest";
import type { RawDetection } from "./detect-common.js";
import { collectFaceDetections } from "./face-detector.js";
import { collectPlateDetections } from "./plate-detector.js";

const geometry = {
    lb: { scale: 0.5, dx: 10, dy: 20 },
    tile: { sx: 100, sy: 200, sw: 400, sh: 200 },
    frameW: 1000,
    frameH: 1000,
};

describe("detector output mapping", () => {
    it("maps channels-first faces including small faces and drops scores below the candidate floor", () => {
        const detections: RawDetection[] = [];
        collectFaceDetections(
            {
                ...geometry,
                dims: [1, 5, 3],
                data: new Float32Array([50, 70, 90, 40, 40, 40, 10, 9, 10, 20, 20, 20, 0.25, 0.5, 0.24]),
            },
            detections,
        );
        expect(detections).toEqual([
            { x: 170, y: 220, w: 20, h: 40, score: 0.25 },
            { x: 211, y: 220, w: 18, h: 40, score: 0.5 },
        ]);
    });

    it("maps channels-first plates including close plates and drops scores below the candidate floor", () => {
        const detections: RawDetection[] = [];
        collectPlateDetections(
            {
                ...geometry,
                dims: [1, 5, 3],
                data: new Float32Array([40, 120, 40, 35, 35, 35, 40, 200, 40, 10, 10, 10, 0.25, 0.75, 0.24]),
            },
            detections,
        );
        expect(detections).toEqual([
            { x: 120, y: 220, w: 80, h: 20, score: 0.25 },
            { x: 120, y: 220, w: 400, h: 20, score: 0.75 },
        ]);
    });
});
