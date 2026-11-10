// The page state an app restart depends on: whether an import has ever started
// and whether a restart is running. Both live only in memory and die with the
// page: a stored flag would turn a bug into a permanent one, and a normal
// reload must always yield a clean page.
//
// The import flag only ever goes up. That removes "checked, then it changed"
// races and any bookkeeping of running operations: a cancelled picker, a
// folder walk that cannot be aborted, a pending permission prompt and a failed
// import all leave the same answer, and the log and notifications of a failed
// import are never wiped by a reload nobody asked for.
import { createLogger } from "../log.js";
import type { UpdateReason } from "../sw-update-protocol.js";

const log = createLogger("restart-gate");

/** Who asked for the restart: the user through the dialog, or the page itself. */
export type RestartReason = UpdateReason;

let hasImportGesture = false;
let lockReason: RestartReason | null = null;
const lockListeners = new Set<(reason: RestartReason | null) => void>();

/**
 * The single question every import gesture asks first, synchronously and
 * before any await: "may an import start?". Returns false while a restart
 * runs; the gesture must then do nothing. Otherwise records for the rest of
 * the page's life that an import has started, and returns true. Asking and
 * recording are one call so that no entry point can do one without the other.
 */
export function claimImportGesture(): boolean {
    if (lockReason !== null) return false;
    hasImportGesture = true;
    return true;
}

/**
 * Safety net for the functions every import passes through. An entry point
 * that reached `site` without claimImportGesture() is a bug: it is logged, and
 * the flag goes up so the page still counts the import.
 */
export function ensureImportGestureClaimed(site: string): void {
    if (hasImportGesture) return;
    log.warn("import started without a claimed gesture", { site });
    hasImportGesture = true;
}

/**
 * The check in the function every import batch passes through. A gesture can
 * pass claimImportGesture() before a restart and finish during it: a folder
 * walk keeps running after its overlay is dismissed. Returns false while a
 * restart runs, and the batch must be dropped: the reload would discard it
 * anyway, and the restart must not meet an ingest it did not check for.
 * Otherwise applies ensureImportGestureClaimed(site) and returns true.
 */
export function admitImportBatch(site: string): boolean {
    if (lockReason !== null) {
        log.warn("import batch dropped during restart", { site });
        return false;
    }
    ensureImportGestureClaimed(site);
    return true;
}

/**
 * Takes the restart lock for `reason`. Returns false when a restart already
 * holds it. While the lock is held, claimImportGesture() refuses. Whoever takes
 * the lock must release it through unlockRestart() after a bounded wait.
 */
export function tryLockRestart(reason: RestartReason): boolean {
    if (lockReason !== null) return false;
    lockReason = reason;
    for (const listener of lockListeners) listener(reason);
    return true;
}

/** Releases the restart lock; a no-op when it is not held. */
export function unlockRestart(): void {
    if (lockReason === null) return;
    lockReason = null;
    for (const listener of lockListeners) listener(null);
}

/** The reason of the restart holding the lock, or null when none runs. */
export function restartLockReason(): RestartReason | null {
    return lockReason;
}

export function isRestartLocked(): boolean {
    return lockReason !== null;
}

/** Calls `listener` with the new reason, or null, each time the lock changes hands. */
export function subscribeRestartLock(listener: (reason: RestartReason | null) => void): () => void {
    lockListeners.add(listener);
    return () => lockListeners.delete(listener);
}

/** Live page facts that a reload without asking would destroy. */
export interface LiveWork {
    hasOpenTrips: boolean;
    isIngesting: boolean;
    /** Any open dialog: it may hold typed text. */
    isModalOpen: boolean;
}

/**
 * The one answer to "may the page reload without asking the user?", shared by
 * the automatic restart and the worker-change rule. True only when no import
 * gesture ever started and no dialog is open. Live trips or a running ingest
 * without the flag mean an entry point skipped the gate: that is logged and
 * also answers no.
 */
export function canReloadWithoutAsking(live: LiveWork): boolean {
    if (hasImportGesture || live.isModalOpen) return false;
    if (live.hasOpenTrips || live.isIngesting) {
        log.warn("work found without an import gesture", {
            hasOpenTrips: live.hasOpenTrips,
            isIngesting: live.isIngesting,
        });
        return false;
    }
    return true;
}

export function _resetForTests(): void {
    hasImportGesture = false;
    lockReason = null;
    lockListeners.clear();
}
