// Warmup + replays + median runner.
//
// Pattern recommended by web.dev / Playwright community for browser perf
// tests: 1 warmup pass (warms V8 JIT, disk cache, decoder buffers) discarded,
// then N measured passes. Between passes we close + recreate the BrowserContext
// rather than just reload() the page - that ensures V8 doesn't retain inline
// caches across runs that would skew the second iteration.
//
// Aggregation: median is robust against the occasional outlier (GC pause,
// background process, transient throttle). We also return min/max/mean so
// the operator can spot when results vary too wildly to trust.

import type { Browser, Page } from "@playwright/test";

export interface ReplayStats<T> {
    /** Per-replay raw results (warmup excluded). */
    samples: T[];
}

export interface NumericAgg {
    min: number;
    max: number;
    mean: number;
    median: number;
}

export function aggregate(values: number[]): NumericAgg {
    if (values.length === 0) return { min: 0, max: 0, mean: 0, median: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { min, max, mean, median };
}

export interface ReplayOptions {
    warmup: number;
    replays: number;
    /** Called before every pass (warmup or measured) with a freshly created Page. */
    setup: (page: Page) => Promise<void>;
    /** The actual scenario; return its measurement payload. */
    scenario: (page: Page) => Promise<unknown>;
}

/**
 * Runs warmup + replays with fresh BrowserContext + Page each time. Returns
 * the array of measured (non-warmup) scenario results. Closing the context
 * between passes:
 *   1) drops V8 inline caches / hidden classes accumulated on the previous
 *      pass, so each replay's JIT warmup is comparable;
 *   2) closes Web Workers - dispose of leaked decoder buffers between runs;
 *   3) clears cookies, indexedDB, etc. - matches "user just opened the site".
 *
 * Disk page cache is NOT cleared (per design decision in plan: hot cache,
 * not cold). The warmup pass exists to put files in the OS cache so the
 * measured replays see consistent IO.
 */
export async function runWithReplays<T>(browser: Browser, opts: ReplayOptions): Promise<T[]> {
    const samples: T[] = [];
    const total = opts.warmup + opts.replays;
    for (let i = 0; i < total; i++) {
        const ctx = await browser.newContext({ serviceWorkers: "block" });
        const page = await ctx.newPage();
        try {
            await opts.setup(page);
            const result = (await opts.scenario(page)) as T;
            if (i >= opts.warmup) samples.push(result);
        } finally {
            // Best-effort teardown of any sampler the scenario may have
            // started (peak-memory poller via setInterval). Without this an
            // exception inside scenario() leaves the interval running until
            // context.close() races it - usually fine, but explicit is safer.
            // Errors here are swallowed: we are already in finally and
            // ctx.close() below is the authoritative cleanup.
            try {
                await page.evaluate(() => {
                    const w = window as unknown as {
                        __everydashcamPerf?: { peakMemory?: { intervalId?: number } };
                    };
                    const id = w.__everydashcamPerf?.peakMemory?.intervalId;
                    if (typeof id === "number") clearInterval(id);
                });
            } catch {
                // Page may already be detached on test timeout.
            }
            await ctx.close();
        }
    }
    return samples;
}
