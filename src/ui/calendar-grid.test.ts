import { describe, expect, it } from "vitest";
import { firstDayOfWeek, monthGridCells, weekdayOrder } from "./calendar-grid.js";

describe("calendar grid", () => {
    it("starts the week where the locale does", () => {
        expect(firstDayOfWeek("en-US")).toBe(0);
        expect(firstDayOfWeek("ru-RU")).toBe(1);
        expect(firstDayOfWeek("not a locale")).toBe(1);
        expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    });

    it("pads the month to its first weekday and ends on its last day", () => {
        // October 1, 2026 is a Thursday.
        const mondayFirst = monthGridCells(2026, 9, 1);
        expect(mondayFirst.slice(0, 4)).toEqual([null, null, null, 1]);
        expect(mondayFirst.at(-1)).toBe(31);
        expect(monthGridCells(2026, 9, 0).slice(0, 5)).toEqual([null, null, null, null, 1]);
        expect(monthGridCells(2026, 1, 1).filter((cell) => cell !== null)).toHaveLength(28);
    });
});
