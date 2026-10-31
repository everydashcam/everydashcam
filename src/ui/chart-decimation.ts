// Gap-aware decimation for the timeline chart.
//
// Chart.js's built-in LTTB averages y over buckets without guarding NaN, so a
// single gap point (a fix-less record, a track-segment break) either loses the
// break or emits undefined points. The chart therefore kept every gapped trip
// at source resolution, and since a missing fix is common, most real trips
// re-laid out the whole series on every zoom step. Here each finite run is
// decimated on its own share of the budget and the gap points are kept
// verbatim, so the line still breaks exactly where the source does.

import type { Chart, Plugin } from "chart.js";

import { lowerBoundBy } from "../sorted-search.js";

export interface ChartPoint {
    x: number;
    y: number;
}

/** Points per visible window, summed over all finite runs. */
export const CHART_DECIMATION_SAMPLES = 200;

/** Windows up to this many points per CSS pixel of chart width stay exact,
 *  matching the built-in plugin's default threshold. */
const POINTS_PER_PIXEL_BEFORE_DECIMATION = 4;

/**
 * Reduces `data[start, start + count)` to about `samples` points. Every maximal
 * run of finite-y points is reduced with largest-triangle-three-buckets on a
 * share of the budget proportional to its length, never below its two
 * endpoints; non-finite points are kept in place as run separators. Returns
 * the original point objects so callers can map them back to source indices.
 * A window that already fits is returned as a plain slice.
 */
export function decimateGapAware(
    data: readonly ChartPoint[],
    start: number,
    count: number,
    samples: number,
): ChartPoint[] {
    const end = start + count;
    if (count <= samples) return data.slice(start, end);
    let finiteTotal = 0;
    for (let i = start; i < end; i++) if (Number.isFinite(data[i]!.y)) finiteTotal++;
    const out: ChartPoint[] = [];
    let runStart = -1;
    for (let i = start; i <= end; i++) {
        const finite = i < end && Number.isFinite(data[i]!.y);
        if (finite) {
            if (runStart < 0) runStart = i;
            continue;
        }
        if (runStart >= 0) {
            const runLength = i - runStart;
            const share = Math.max(2, Math.round((samples * runLength) / finiteTotal));
            appendLttb(data, runStart, i, share, out);
            runStart = -1;
        }
        if (i < end) out.push(data[i]!);
    }
    return out;
}

/** Largest-triangle-three-buckets over the finite run `data[start, end)`. */
function appendLttb(data: readonly ChartPoint[], start: number, end: number, samples: number, out: ChartPoint[]): void {
    const count = end - start;
    if (samples >= count) {
        for (let i = start; i < end; i++) out.push(data[i]!);
        return;
    }
    if (samples < 3) {
        out.push(data[start]!, data[end - 1]!);
        return;
    }
    // Interior points split into samples - 2 buckets between the fixed
    // endpoints; bucketWidth > 1 because samples < count.
    const bucketWidth = (count - 2) / (samples - 2);
    let anchor = start;
    out.push(data[anchor]!);
    for (let bucket = 0; bucket < samples - 2; bucket++) {
        // The next bucket's centroid stands in for the not-yet-chosen third
        // vertex; the last bucket's "next" is the final point.
        const nextStart = start + 1 + Math.floor((bucket + 1) * bucketWidth);
        const nextEnd = Math.min(start + 1 + Math.floor((bucket + 2) * bucketWidth), end);
        let avgX = 0;
        let avgY = 0;
        for (let j = nextStart; j < nextEnd; j++) {
            avgX += data[j]!.x;
            avgY += data[j]!.y;
        }
        const nextCount = nextEnd - nextStart;
        avgX /= nextCount;
        avgY /= nextCount;
        const rangeStart = start + 1 + Math.floor(bucket * bucketWidth);
        const rangeEnd = start + 1 + Math.floor((bucket + 1) * bucketWidth);
        const ax = data[anchor]!.x;
        const ay = data[anchor]!.y;
        let maxArea = -1;
        let chosen = rangeStart;
        for (let j = rangeStart; j < rangeEnd; j++) {
            const point = data[j]!;
            const area = Math.abs((ax - avgX) * (point.y - ay) - (ax - point.x) * (avgY - ay));
            if (area > maxArea) {
                maxArea = area;
                chosen = j;
            }
        }
        out.push(data[chosen]!);
        anchor = chosen;
    }
    out.push(data[end - 1]!);
}

/** Visible slice of x-sorted data, padded by one point on each side so the
 *  line still reaches both plot edges. */
function visibleWindow(data: readonly ChartPoint[], min: number, max: number): { start: number; count: number } {
    const start = Math.max(0, lowerBoundBy(data, min, (point) => point.x) - 1);
    const end = Math.min(data.length, lowerBoundBy(data, max, (point) => point.x) + 1);
    return { start, count: Math.max(0, end - start) };
}

// The dataset keeps its source array behind a data accessor while decimated,
// the same arrangement Chart.js uses for its own plugin: chart code assigns
// dataset.data as usual and reads back the points Chart.js actually drew.
const SOURCE = Symbol("chart-decimation-source");
const DECIMATED = Symbol("chart-decimation-points");

interface DecimationSlots {
    [SOURCE]?: ChartPoint[];
    [DECIMATED]?: ChartPoint[];
}

function restoreSource(dataset: object): void {
    const slots = dataset as DecimationSlots;
    const source = slots[SOURCE];
    if (source === undefined) return;
    delete slots[SOURCE];
    delete slots[DECIMATED];
    Object.defineProperty(dataset, "data", { configurable: true, enumerable: true, writable: true, value: source });
}

/**
 * Chart.js plugin that decimates every line dataset over the visible x range
 * on each update. Requires chart-level `parsing: false` and `{x, y}` points
 * sorted by x; datasets that fit the threshold keep their source array.
 */
export const gapAwareDecimationPlugin: Plugin<"line"> = {
    id: "gapAwareDecimation",
    beforeElementsUpdate(chart: Chart<"line">) {
        const threshold = POINTS_PER_PIXEL_BEFORE_DECIMATION * chart.width;
        const xScale = chart.scales.x;
        for (const dataset of chart.data.datasets) {
            const slots = dataset as DecimationSlots;
            const source = slots[SOURCE] ?? (dataset.data as unknown as ChartPoint[]);
            const bounds = xScale?.getUserBounds();
            const window =
                bounds?.minDefined && bounds.maxDefined
                    ? visibleWindow(source, bounds.min, bounds.max)
                    : { start: 0, count: source.length };
            if (window.count <= threshold) {
                restoreSource(dataset);
                continue;
            }
            if (slots[SOURCE] === undefined) {
                slots[SOURCE] = source;
                Object.defineProperty(dataset, "data", {
                    configurable: true,
                    enumerable: true,
                    get(this: DecimationSlots) {
                        return this[DECIMATED];
                    },
                    set(this: DecimationSlots, points: ChartPoint[]) {
                        this[SOURCE] = points;
                    },
                });
            }
            slots[DECIMATED] = decimateGapAware(source, window.start, window.count, CHART_DECIMATION_SAMPLES);
        }
    },
    afterDestroy(chart: Chart<"line">) {
        for (const dataset of chart.data.datasets) restoreSource(dataset);
    },
};
