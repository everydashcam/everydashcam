// Observability helpers for the ingest/export pipeline:
//  - markStage:     wraps an async stage in performance.mark+measure. Visible
//                   in DevTools Performance tab without setup, consumed by the
//                   perf-test harness via performance.getEntriesByType('measure').
//  - emitLifecycle: dispatches a typed CustomEvent on window for external
//                   observers (perf harness, future integrations).
//
// What this module is NOT:
//  - Not a logger. Stage durations that need to land in bug-report ring
//    buffers go through src/log.ts (see ingest.ts "ingest done" entry).
//  - Not a tracer. No spans, no parent/child links. Use plain marks - the
//    perf harness can correlate by start time.
//  - Not a test-only API. Both APIs are valid observability primitives that
//    any integration could subscribe to.
//
// Hot-path rules (matches AGENTS.md Logging invariants):
//  - Never call markStage inside a rAF loop, packet loop, GPS-record loop,
//    or timeupdate handler. mark/measure cost microseconds, but called
//    10k times per scenario they pollute the buffer (default cap ~150
//    entries) and add measurable overhead.
//  - Granularity = stage boundary, not per-function-call.

/**
 * Names dispatched via emitLifecycle. Strongly typed so test harness and app
 * code stay in sync. Each event fires exactly once per scenario:
 *
 *  - ingest-list-ready      after the provisional trip list is visible
 *  - ingest-done            after recording metadata and previews are complete
 *  - trip-activated         after playFrame attaches a candidate and the player begins loading
 *  - player-first-frame     after the first video frame is actually painted (requestVideoFrameCallback)
 *  - map-tracks-rendered    after the active trip polyline is drawn on the map
 *  - chart-rendered         after the chart strip finishes rebuild for the active trip
 */
export type LifecycleEvent =
    | "ingest-list-ready"
    | "ingest-done"
    | "trip-activated"
    | "player-first-frame"
    | "player-failed"
    | "map-tracks-rendered"
    | "chart-rendered";

const LIFECYCLE_PREFIX = "everydashcam:";

/**
 * Wraps an async stage in performance.mark+measure. Returns the value of fn().
 * Mark/measure errors never propagate - perf instrumentation must not break
 * the wrapped operation. The measure entry name is `name` (no prefix); use
 * a stable namespace prefix in callers if collisions are possible
 * (e.g. "extract:gpmf" vs "extract:freegps").
 */
export async function markStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (typeof performance === "undefined" || typeof performance.mark !== "function") {
        return fn();
    }
    const startMark = `${name}:start`;
    const endMark = `${name}:end`;
    try {
        performance.mark(startMark);
    } catch {
        // Buffer full or invalid name - measure becomes best-effort.
    }
    try {
        return await fn();
    } finally {
        try {
            performance.mark(endMark);
            performance.measure(name, startMark, endMark);
        } catch {
            // Mark missing or unsupported by engine - silently skip the measure.
        }
    }
}

/**
 * Dispatches a CustomEvent on window with name `everydashcam:<event>` and the
 * given detail. Used as a public lifecycle signal for the performance-test
 * harness (it waits on these events) and for any third-party integration that
 * needs to know when key UI milestones are reached. No-op outside the browser.
 */
export function emitLifecycle(event: LifecycleEvent, detail?: Record<string, unknown>): void {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    try {
        window.dispatchEvent(new CustomEvent(`${LIFECYCLE_PREFIX}${event}`, { detail }));
    } catch {
        // Observability must never interrupt the operation being observed.
    }
}
