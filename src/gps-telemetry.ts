import type { GpsRecord, SpeedSample } from "./parsers/types.js";

export function hasSpeed(sample: SpeedSample): boolean {
    return sample.speedSource !== "unavailable" && Number.isFinite(sample.speedMs) && sample.speedMs >= 0;
}

/** Position differences amplify GPS noise; only recorded speeds drive event detection. */
export function hasMeasuredSpeed(sample: SpeedSample): boolean {
    return hasSpeed(sample) && sample.speedSource !== "estimated";
}

export function isSameTrackSegment(a: GpsRecord, b: GpsRecord): boolean {
    return a.trackSegment === b.trackSegment && a.trackSegmentSource === b.trackSegmentSource;
}

export function interpolateSpeed(a: SpeedSample, b: SpeedSample, fraction: number): SpeedSample {
    if (!hasSpeed(a) || !hasSpeed(b)) return { speedMs: 0, speedSource: "unavailable" };
    const speedMs = a.speedMs + (b.speedMs - a.speedMs) * fraction;
    return a.speedSource === "estimated" || b.speedSource === "estimated"
        ? { speedMs, speedSource: "estimated" }
        : { speedMs };
}

/** Shared numeric readout for the viewer and burned-in overlays. */
export function formatSpeedReading(sample: SpeedSample, value: number, digits = 0): string {
    if (!hasSpeed(sample)) return "-";
    return `${sample.speedSource === "estimated" ? "≈" : ""}${value.toFixed(digits)}`;
}
