// Unit tests for the text overlay helpers. We can't paint to a real canvas in
// node, but we can verify the pure formatters (formatClock and friends) here.

import { describe, expect, it } from "vitest";

import {
    drawCoordsBox,
    drawWidgetBox,
    formatClock,
    formatCoordParts,
    formatDistanceValue,
    formatSpeedValue,
} from "./text-overlay.js";

describe("formatSpeedValue", () => {
    it("rounds km/h in metric", () => {
        expect(formatSpeedValue(0, "metric")).toBe("0");
        expect(formatSpeedValue(10, "metric")).toBe("36"); // 10 m/s = 36 km/h
        expect(formatSpeedValue(27.78, "metric")).toBe("100");
    });

    it("rounds mph in imperial", () => {
        expect(formatSpeedValue(0, "imperial")).toBe("0");
        expect(formatSpeedValue(10, "imperial")).toBe("22"); // ≈ 22.37 mph
        expect(formatSpeedValue(27.78, "imperial")).toBe("62"); // ≈ 62.14 mph
    });

    it("returns a dash for invalid inputs", () => {
        expect(formatSpeedValue(Number.NaN, "metric")).toBe("-");
        expect(formatSpeedValue(-5, "metric")).toBe("-");
        expect(formatSpeedValue(Number.POSITIVE_INFINITY, "imperial")).toBe("-");
    });
});

describe("formatCoordParts", () => {
    it("splits into hemisphere keys + absolute degrees (4 decimals)", () => {
        expect(formatCoordParts(55.7521, 37.6173)).toEqual({
            latKey: "N",
            latVal: "55.7521°",
            lonKey: "E",
            lonVal: "37.6173°",
        });
    });
    it("flips the keys for southern / western hemispheres", () => {
        expect(formatCoordParts(-33.86882, -151.2)).toEqual({
            latKey: "S",
            latVal: "33.8688°",
            lonKey: "W",
            lonVal: "151.2000°",
        });
    });
    it("returns null on a non-finite reading", () => {
        expect(formatCoordParts(Number.NaN, 0)).toBeNull();
        expect(formatCoordParts(0, Number.POSITIVE_INFINITY)).toBeNull();
    });
});

describe("formatDistanceValue", () => {
    it("formats km in metric, miles in imperial (1 decimal)", () => {
        expect(formatDistanceValue(12_400, "metric")).toBe("12.4");
        expect(formatDistanceValue(12_400, "imperial")).toBe("7.7");
        expect(formatDistanceValue(0, "metric")).toBe("0.0");
    });
    it("guards invalid input", () => {
        expect(formatDistanceValue(Number.NaN, "metric")).toBe("0.0");
        expect(formatDistanceValue(-5, "imperial")).toBe("0.0");
    });
});

describe("formatClock", () => {
    const epoch = Date.UTC(2026, 3, 29, 18, 26, 40) / 1000; // 29 Apr 2026 18:26:40 UTC
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    it("formats UTC with a zero offset", () => {
        expect(formatClock(epoch, 0, MONTHS)).toEqual({ date: "29 Apr 2026", time: "18:26:40" });
    });
    it("applies the tz offset (minutes) to reach local wall time", () => {
        expect(formatClock(epoch, 120, MONTHS).time).toBe("20:26:40"); // +2h
        expect(formatClock(epoch, -60, MONTHS).time).toBe("17:26:40"); // -1h
    });
    it("uses the supplied (localized) month names", () => {
        const ru = ["янв.", "февр.", "март", "апр.", "май", "июнь", "июль", "авг.", "сент.", "окт.", "нояб.", "дек."];
        expect(formatClock(epoch, 0, ru).date).toBe("29 апр. 2026");
    });
    it("guards invalid input", () => {
        expect(formatClock(Number.NaN, 0, MONTHS)).toEqual({ date: "-", time: "-" });
    });
});

function makeCtx(): { ctx: CanvasRenderingContext2D; calls: string[]; fillStyles: string[] } {
    const calls: string[] = [];
    const fillStyles: string[] = [];
    const ctx = {
        save: () => calls.push("save"),
        restore: () => calls.push("restore"),
        measureText: (text: string) => ({ width: text.length * 8 }),
        fillText: (text: string, x: number, y: number) =>
            calls.push(`fillText:${text}@${Math.round(x)},${Math.round(y)}`),
        fillRect: () => calls.push("fillRect"),
        rect: () => calls.push("rect"),
        clip: () => calls.push("clip"),
        beginPath: () => calls.push("beginPath"),
        moveTo: () => {},
        lineTo: () => {},
        arcTo: () => {},
        arc: () => {},
        closePath: () => {},
        fill: () => calls.push("fill"),
        stroke: () => calls.push("stroke"),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        font: "",
        textBaseline: "alphabetic",
        textAlign: "start",
        shadowColor: "",
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        strokeStyle: "",
        globalAlpha: 1,
        // Capture every value/plate color assigned so a test can assert the
        // accent reached the canvas (the call log only records text + geometry).
        set fillStyle(v: string) {
            fillStyles.push(v);
        },
        get fillStyle() {
            return fillStyles[fillStyles.length - 1] ?? "";
        },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls, fillStyles };
}

describe("drawWidgetBox", () => {
    it("draws the value inside a save/restore (min: no plate fill)", () => {
        const { ctx, calls } = makeCtx();
        drawWidgetBox(ctx, 1920, 1080, { xPct: 0.05, yPct: 0.9, scalePct: 100 }, "min", "#FF9000", {
            value: "120",
            unit: "km/h",
            valueScale: 1,
        });
        expect(calls[0]).toBe("save");
        expect(calls[calls.length - 1]).toBe("restore");
        expect(calls.some((c) => c.startsWith("fillText:120@"))).toBe(true);
        // min has no plate, so no rounded-rect fill was issued
        expect(calls.includes("fill")).toBe(false);
    });

    it("paints a plate for the card style", () => {
        const { ctx, calls } = makeCtx();
        drawWidgetBox(ctx, 1920, 1080, { xPct: 0.05, yPct: 0.9, scalePct: 100 }, "card", "#FF9000", {
            value: "120",
            unit: "km/h",
            valueScale: 1,
        });
        expect(calls.includes("fill")).toBe(true); // plate background
        expect(calls.includes("stroke")).toBe(true); // plate hairline border
        expect(calls.some((c) => c.startsWith("fillText:120@"))).toBe(true);
    });

    it("paints the hazard stripe + accent value for the bold hero speed", () => {
        const bold = makeCtx();
        drawWidgetBox(bold.ctx, 1920, 1080, { xPct: 0.05, yPct: 0.8, scalePct: 100 }, "bold", "#FF9000", {
            value: "88",
            unit: "km/h",
            valueScale: 1,
            hero: true,
        });
        expect(bold.calls.includes("fillRect")).toBe(true); // stripe black backing
        expect(bold.fillStyles).toContain("#FF9000"); // hero value drawn in accent

        // min ignores hero (its chrome has heroSpeed=false): no stripe.
        const min = makeCtx();
        drawWidgetBox(min.ctx, 1920, 1080, { xPct: 0.05, yPct: 0.8, scalePct: 100 }, "min", "#FF9000", {
            value: "88",
            unit: "km/h",
            valueScale: 1,
            hero: true,
        });
        expect(min.calls.includes("fillRect")).toBe(false);
    });

    it("clamps position so the box stays inside the frame", () => {
        const { ctx, calls } = makeCtx();
        drawWidgetBox(ctx, 100, 100, { xPct: 2, yPct: 2, scalePct: 100 }, "min", "#FF9000", {
            value: "abc",
            valueScale: 1,
        });
        const fill = calls.find((c) => c.startsWith("fillText:abc@"));
        const match = fill?.match(/fillText:abc@(-?\d+),(-?\d+)/);
        expect(match).toBeTruthy();
        if (match) {
            expect(Number(match[1])).toBeLessThanOrEqual(100);
            expect(Number(match[2])).toBeLessThanOrEqual(100);
            expect(Number(match[1])).toBeGreaterThanOrEqual(0);
            expect(Number(match[2])).toBeGreaterThanOrEqual(0);
        }
    });

    it("does nothing for an empty widget", () => {
        const { ctx, calls } = makeCtx();
        drawWidgetBox(ctx, 100, 100, { xPct: 0, yPct: 0, scalePct: 100 }, "min", "#FF9000", {
            value: "",
            valueScale: 1,
        });
        expect(calls).toEqual([]);
    });
});

describe("drawCoordsBox", () => {
    it("draws two hemisphere lines with accent keys", () => {
        const { ctx, calls, fillStyles } = makeCtx();
        drawCoordsBox(ctx, 1920, 1080, { xPct: 0.04, yPct: 0.9, scalePct: 100 }, "min", "#FF9000", 55.75, 37.61, 0.55);
        expect(calls.some((c) => c.startsWith("fillText:N@"))).toBe(true);
        expect(calls.some((c) => c.startsWith("fillText:E@"))).toBe(true);
        expect(calls.some((c) => c.startsWith("fillText:55.7500°@"))).toBe(true);
        expect(calls.some((c) => c.startsWith("fillText:37.6100°@"))).toBe(true);
        expect(fillStyles).toContain("#FF9000"); // accent hemisphere key
    });

    it("draws nothing on a non-finite reading", () => {
        const { ctx, calls } = makeCtx();
        drawCoordsBox(ctx, 1920, 1080, { xPct: 0, yPct: 0, scalePct: 100 }, "min", "#FF9000", Number.NaN, 0, 0.55);
        expect(calls).toEqual([]);
    });
});
