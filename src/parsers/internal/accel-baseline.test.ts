import { describe, expect, it } from "vitest";

import type { GpsRecord } from "../types.js";
import { removeGravityBaselineInUnknownUnits } from "./accel-baseline.js";

function recordWithAccel(x: number, y: number, z: number): GpsRecord {
    return {
        unixSeconds: 0,
        active: true,
        lat: 0,
        lon: 0,
        bearingDeg: 0,
        speedMs: 0,
        accelXg: x,
        accelYg: y,
        accelZg: z,
        mp4Filename: "x.ts",
    };
}

describe("removeGravityBaselineInUnknownUnits", () => {
    it("reads the median magnitude as 1 g whatever the unit", () => {
        // Gravity of 5 units along -y, one sample with a 0.5-unit forward push.
        const records = [
            recordWithAccel(0, -5, 0),
            recordWithAccel(0, -5, 0),
            recordWithAccel(0, -5, 0),
            recordWithAccel(0.5, -5, 0),
        ];
        removeGravityBaselineInUnknownUnits(records);
        expect(records[3]!.accelXg).toBeCloseTo(0.1 - 0.025, 9);
        expect(records[0]!.accelXg).toBeCloseTo(-0.025, 9);
        for (const record of records) expect(record.accelYg).toBeCloseTo(0, 9);
    });

    it("zeroes a lone sample like the g-unit helper", () => {
        const records = [recordWithAccel(0, -4.7, 2), recordWithAccel(0, 0, 0)];
        removeGravityBaselineInUnknownUnits(records);
        expect(records.map((r) => [r.accelXg, r.accelYg, r.accelZg])).toEqual([
            [0, 0, 0],
            [0, 0, 0],
        ]);
    });
});
