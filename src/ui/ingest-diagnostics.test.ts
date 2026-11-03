import { afterEach, describe, expect, it, vi } from "vitest";

import { captureSentryMessage } from "../sentry.js";
import { reportParseErrors } from "./ingest-diagnostics.js";

// Spy on the Sentry capture to assert the reported grouping without a live
// SDK. Other exports stay real.
vi.mock("../sentry.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../sentry.js")>();
    return { ...original, captureSentryMessage: vi.fn() };
});

afterEach(() => {
    vi.mocked(captureSentryMessage).mockClear();
});

describe("reportParseErrors", () => {
    it("groups source read failures apart from parser failures of the same parser", () => {
        reportParseErrors("embedded", [
            { extractor: "nmea-subtitle", isSourceRead: true },
            { extractor: "nmea-subtitle", isSourceRead: true },
            { extractor: "nmea-subtitle", isSourceRead: false },
            { sidecarId: "gpx" },
        ]);
        const calls = vi.mocked(captureSentryMessage).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls).toContainEqual([
            "gps source read failed",
            {
                level: "warning",
                fingerprint: ["gps_source_read_failed", "embedded", "nmea-subtitle"],
                tags: { stage: "embedded", parser: "nmea-subtitle" },
                extra: { count: 2 },
            },
        ]);
        expect(calls).toContainEqual([
            "gps parse failed",
            {
                level: "warning",
                fingerprint: ["gps_parse_failed", "embedded", "nmea-subtitle"],
                tags: { stage: "embedded", parser: "nmea-subtitle" },
                extra: { count: 1 },
            },
        ]);
        expect(calls).toContainEqual([
            "gps parse failed",
            {
                level: "warning",
                fingerprint: ["gps_parse_failed", "embedded", "gpx"],
                tags: { stage: "embedded", parser: "gpx" },
                extra: { count: 1 },
            },
        ]);
    });

    it("reports nothing for an empty error list", () => {
        reportParseErrors("embedded", []);
        expect(captureSentryMessage).not.toHaveBeenCalled();
    });
});
