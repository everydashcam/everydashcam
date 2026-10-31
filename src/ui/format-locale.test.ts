import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoCandidate } from "../trips.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe.each([
    ["en", "."],
    ["ru", ","],
] as const)("numeric UI formatting (%s)", (lang, decimal) => {
    it("uses the page locale for size, rate, distance and event precision", async () => {
        vi.stubGlobal("location", { pathname: `/${lang}/` });
        vi.stubGlobal("navigator", { language: lang === "ru" ? "en-US" : "ru-RU" });
        vi.resetModules();
        const { formatBytes, formatRateBytes, formatNumber, formatTripDistance, formatEventSeverity, formatFileMeta } =
            await import("./format.js");
        const { setUnits } = await import("../units-pref.js");
        const { t } = await import("../i18n/index.js");
        setUnits("metric");
        expect(formatBytes(1.5 * 1024 ** 3)).toBe(`1${decimal}50 ${t("units.gb")}`);
        expect(formatRateBytes(2.5 * 1024 ** 2)).toBe(`2${decimal}5 ${t("units.mb")}`);
        expect(formatTripDistance(1.5)).toBe(`1${decimal}5 ${t("units.km")}`);
        expect(formatTripDistance(0.02)).toBe(`<0${decimal}1 ${t("units.km")}`);
        expect(formatNumber(2, 1, 0)).toBe("2");
        expect(formatNumber(2.5, 1, 0)).toBe(`2${decimal}5`);
        expect(formatEventSeverity({ kind: "brake", severity: 0.42, relSec: 0, recordIndex: 0, unixSeconds: 0 })).toBe(
            `0${decimal}42 g`,
        );
        const video = { file: { size: 1.5 * 1024 ** 2 }, metadataReady: false } as VideoCandidate;
        expect(formatFileMeta(video, 0)).toBe(`1${decimal}5 ${t("units.mb")}`);
    });
});
