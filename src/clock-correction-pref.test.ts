import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
    _resetForTests,
    clampClockCorrectionMin,
    getClockCorrectionMin,
    parseClockCorrectionText,
    setClockCorrectionMin,
    subscribeClockCorrectionChange,
} from "./clock-correction-pref.js";
import { formatClock } from "./transcode/text-overlay.js";
import { displayTzSec } from "./trips.js";

const UNIX_SEC = Date.UTC(2026, 10, 20, 14, 5, 34) / 1000;
const MONTHS = Array<string>(12).fill("Nov");

function stubStorage(getItem: (key: string) => string | null = () => null): void {
    const written = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => written.get(key) ?? getItem(key),
        setItem: (key: string, value: string) => void written.set(key, value),
    });
}

beforeEach(() => {
    _resetForTests();
    stubStorage();
});
afterEach(() => vi.unstubAllGlobals());

it("shifts the camera clock in the overlay on both sides of midnight", () => {
    setClockCorrectionMin(-30);
    expect(formatClock(UNIX_SEC, displayTzSec(UNIX_SEC, 36_000) / 60, MONTHS)).toEqual({
        date: "20 Nov 2026",
        time: "23:35:34",
    });
    setClockCorrectionMin(30);
    expect(formatClock(UNIX_SEC, displayTzSec(UNIX_SEC, 36_000) / 60, MONTHS)).toEqual({
        date: "21 Nov 2026",
        time: "00:35:34",
    });
});

it("keeps the browser zone when the camera zone is unknown", () => {
    const browserZoneSec = displayTzSec(UNIX_SEC, null);
    setClockCorrectionMin(30);
    expect(displayTzSec(UNIX_SEC, null)).toBe(browserZoneSec);
});

it("restores the stored correction after a reload", () => {
    setClockCorrectionMin(-90);
    _resetForTests();
    expect(getClockCorrectionMin()).toBe(-90);
});

it("defaults to zero with a corrupt preference and ignores invalid edits", () => {
    stubStorage(() => "Infinity");
    expect(getClockCorrectionMin()).toBe(0);
    setClockCorrectionMin(-30);
    for (const value of [Number.NaN, 1.1, Number.POSITIVE_INFINITY, 1441]) setClockCorrectionMin(value);
    expect(getClockCorrectionMin()).toBe(-30);
});

it("notifies subscribers once per accepted change", () => {
    const listener = vi.fn();
    subscribeClockCorrectionChange(listener);
    setClockCorrectionMin(30);
    setClockCorrectionMin(30);
    setClockCorrectionMin(1.5);
    expect(listener).toHaveBeenCalledTimes(1);
});

it("reads typed and pasted corrections with either sign", () => {
    expect(parseClockCorrectionText("+30")).toBe(30);
    expect(parseClockCorrectionText(" 30\n")).toBe(30);
    expect(parseClockCorrectionText("-30")).toBe(-30);
    expect(parseClockCorrectionText("\u221230"), "typographic minus").toBe(-30);
    expect(Object.is(parseClockCorrectionText("-0"), 0), "no negative zero").toBe(true);
    for (const text of ["", "+", "1.5", "30 min", "--30", "1e3"]) {
        expect(parseClockCorrectionText(text), JSON.stringify(text)).toBeNull();
    }
});

it("clamps a correction to whole minutes within a day", () => {
    expect(clampClockCorrectionMin(1500)).toBe(1440);
    expect(clampClockCorrectionMin(-1500)).toBe(-1440);
    expect(clampClockCorrectionMin(29.6)).toBe(30);
    expect(Object.is(clampClockCorrectionMin(-0.2), 0), "no negative zero").toBe(true);
    expect(clampClockCorrectionMin(Number.NaN)).toBeNull();
    expect(clampClockCorrectionMin(Number.POSITIVE_INFINITY)).toBeNull();
});
