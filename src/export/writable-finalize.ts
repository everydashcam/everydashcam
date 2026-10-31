// Shared finalize helper for the export-to-disk path. The last step of every
// export (stream-copy and re-encode) is closing the FSA writable, which commits
// the file to disk (native FSA) or commits the in-memory export buffer.
//
// On some browsers this close has been observed to hang indefinitely, leaving
// the UI stuck at "Finalizing..." with no error (the close promise simply never
// resolves). A hang with no signal is the worst diagnostic outcome - the ring
// buffer shows the export started and nothing after. This helper turns an
// infinite hang into (a) a breadcrumb pair (close start / close done with the
// elapsed time) and (b) a hard timeout that rejects with a clear error so the
// flow surfaces it and cleans up, instead of waiting forever.

import type { Logger } from "../log.js";

// Backstop only. The close is a flush of the OS write-back cache to the target
// media + an atomic temp->final rename. The bytes are handed to the OS during
// the encode loop, but on slow removable media (an SD card / USB flash stick -
// the dashcam's own storage, a common export target) the write-back trails far
// behind and close()'s final fsync must wait for gigabytes to reach the medium.
// That legitimately takes minutes, so a flat timeout kills a slow-but-working
// export (worst case: the detached close later succeeds, leaving a complete file
// on disk while the user was told it failed). Scale the deadline by the bytes
// written at a pessimistic floor throughput, with an absolute floor for small
// clips. If close has not resolved by then the writer is truly wedged.
// Exported for the unit test only - keeps the test's deadline math derived
// from the real constants instead of hand-copied literals.
export const CLOSE_TIMEOUT_FLOOR_MS = 120_000;
// Pessimistic sustained write+fsync rate for the slowest realistic target: a
// Class 2 SD card / a cheap USB2 flash stick under fsync. Lower = more generous
// deadline = less chance of aborting a slow-but-progressing close. At 2 MiB/s a
// 20 GB clip gets a ~2.8 h backstop; a genuine wedge still eventually errors.
export const MIN_FLUSH_BYTES_PER_MS = 2 * 1024;
// setTimeout stores its delay as a 32-bit signed int; anything above fires
// immediately, which would invert the watchdog into killing a healthy close.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Closes `writable`, racing it against a watchdog timeout. Logs a breadcrumb
 * when the close starts and when it finishes (with elapsed ms), so a future
 * report can tell "moov written, close hung" apart from "encode never finished".
 *
 * On timeout it rejects with an Error (the underlying close keeps running
 * detached - it cannot be cancelled - but its later settle is swallowed so it
 * does not surface as an unhandled rejection). `label` identifies the call site
 * in logs (e.g. "stream-copy" / "transcode-bridge"). `bytesWritten` sizes the
 * watchdog deadline (see MIN_FLUSH_BYTES_PER_MS); 0/omitted falls back to the
 * absolute floor.
 */
export async function closeWritableWithWatchdog(
    writable: { close: () => Promise<void> },
    log: Logger,
    label: string,
    bytesWritten = 0,
): Promise<void> {
    const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(CLOSE_TIMEOUT_FLOOR_MS, Math.ceil(bytesWritten / MIN_FLUSH_BYTES_PER_MS)),
    );
    const startMs = performance.now();
    log.debug("writable close start", { label, bytesWritten, timeoutMs });

    const closePromise = writable.close();
    // Detach a no-op catch so a rejection that lands AFTER the timeout already
    // fired does not become an unhandled rejection. The race below still
    // observes the original settle on the non-timeout path.
    closePromise.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`writable close timed out after ${timeoutMs}ms (${label})`));
        }, timeoutMs);
    });

    try {
        await Promise.race([closePromise, timeout]);
        log.info("writable closed", { label, ms: Math.round(performance.now() - startMs) });
    } catch (err) {
        log.error("writable close failed or timed out", {
            label,
            ms: Math.round(performance.now() - startMs),
            err: String(err),
        });
        throw err;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
