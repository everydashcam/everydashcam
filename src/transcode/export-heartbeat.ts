// Deliberately dependency-light: transcode-shim imports this on the MAIN
// thread, and anything heavier (pipeline-common pulls in mediabunny) would drag
// the whole codec stack onto the eager bundle path the landing budget guards.

import type { Logger } from "../log.js";

/** Seconds' worth of breadcrumbs is the wrong resolution for a ring buffer and
 *  none at all leaves a died export a black box - one line every 30 s spans an
 *  hour-long export in ~120 lines. */
const EXPORT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Chromium's non-standard JS-heap gauge (window and worker scopes alike);
 *  absent on other engines. Narrowed here so the heartbeat stays cast-free. */
interface PerformanceWithMemory extends Performance {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
}

/**
 * Periodic export breadcrumb for the ring buffer, throttled to one line per
 * EXPORT_HEARTBEAT_INTERVAL_MS. A failed long export otherwise dies with only
 * its final error line; the slope across heartbeats answers the two questions
 * a report cannot settle after the fact: was memory climbing toward
 * exhaustion, and did throughput collapse before death or stop cold. JS heap
 * is best-effort - measureUserAgentSpecificMemory needs crossOriginIsolated,
 * which the portable edition never has, and resolves asynchronously, so the
 * heartbeat reads Chromium's synchronous performance.memory gauge.
 */
export function createExportHeartbeat(heartbeatLog: Logger): (framesDone: number, bytesWritten: number) => void {
    let lastBeatMs = performance.now();
    let lastFrames = 0;
    return (framesDone, bytesWritten) => {
        const now = performance.now();
        const sinceMs = now - lastBeatMs;
        if (sinceMs < EXPORT_HEARTBEAT_INTERVAL_MS) return;
        const fpsSinceLast = Math.round(((framesDone - lastFrames) * 1000) / sinceMs);
        lastBeatMs = now;
        lastFrames = framesDone;
        const memory = (performance as PerformanceWithMemory).memory;
        heartbeatLog.info("export heartbeat", {
            framesDone,
            bytesWritten,
            fpsSinceLast,
            ...(memory
                ? {
                      jsHeapUsedMB: Math.round(memory.usedJSHeapSize / 1048576),
                      jsHeapLimitMB: Math.round(memory.jsHeapSizeLimit / 1048576),
                  }
                : {}),
        });
    };
}
