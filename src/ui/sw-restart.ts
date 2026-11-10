// The restart into a waiting worker. Every wait inside it is bounded and the
// restart releases its own lock, so the dialog and the import refusal it holds
// can never outlive it: no attempt survives its lock, and no watchdog or
// attempt counter is needed.
import { createLogger } from "../log.js";
import { UPDATE_MESSAGE, isUpdateResult, type UpdateRequest, type UpdateResult } from "../sw-update-protocol.js";
import { isRestartLocked, restartLockReason, tryLockRestart, unlockRestart } from "./restart-gate.js";
import type { ObservedWorker } from "./sw-update-observer.js";

const log = createLogger("sw-update");

// The restart dialog cannot be dismissed while notes are saved, so a write
// that never settles must not hold the window behind it.
export const NOTES_SAVE_TIMEOUT_MS = 15_000;
export const ACTIVATION_ANSWER_TIMEOUT_MS = 10_000;
// After "updating" the browser reports the takeover through controllerchange;
// this bounds a browser that never does.
export const TAKEOVER_TIMEOUT_MS = 10_000;
// A page still alive this long after reload() stayed, for example because the
// user chose to stay in the browser's leave-page prompt.
export const RELOAD_TIMEOUT_MS = 10_000;

/** Why a user-requested restart stopped and left the page as it was. */
export type UserRestartFailure = "notesNotSaved" | "otherWindows" | "failed";

/** Resolves false when notes are not confirmed saved within the limit. A late
 *  write keeps running; the window simply stays open. */
async function saveNotesWithin(saveNotes: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
            log.warn("notes save timed out", { timeoutMs });
            resolve(false);
        }, timeoutMs);
    });
    try {
        return await Promise.race([saveNotes(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Asks the waiting worker to take over. Resolves null when it does not answer
 * within `timeoutMs` or answers with a result this release does not know. A
 * null answer does not mean the request was cancelled: the worker may have
 * received it and still activate later.
 */
export function requestActivation(
    worker: Pick<ObservedWorker, "postMessage">,
    timeoutMs: number,
): Promise<UpdateResult | null> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const finish = (result: UpdateResult | null): void => {
            clearTimeout(timer);
            channel.port1.close();
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
            finish(isUpdateResult(event.data) ? event.data : null);
        };
        try {
            worker.postMessage({ type: UPDATE_MESSAGE } satisfies UpdateRequest, [channel.port2]);
        } catch {
            finish(null);
        }
    });
}

export interface RestartController {
    /**
     * Restarts the page into the waiting worker at the user's request. The
     * caller has already checked that no work would be lost and that the user
     * confirmed. A no-op while another restart holds the lock.
     */
    restart(): Promise<void>;
    /**
     * Applies the worker-change rule on the browser's report that the page's
     * controller changed. The page should run under the worker it loaded
     * with. When another worker took over: a restart in progress reloads
     * (including a page loaded without a controller); otherwise a page loaded
     * under a worker reloads only when canReloadWithoutAsking allows it, and
     * stays with a log warning when not. A first installation changes nothing.
     */
    handleControllerChange(): void;
}

/**
 * Creates the restart controller. `waitingWorker` reads the observed
 * registration synchronously, so the worker that receives the request is the
 * one waiting at that moment. `loadController` is the worker that controlled
 * the page when it loaded; `currentController` reads the live one.
 * `canReloadWithoutAsking` is the shared answer from restart-gate.ts. `reloadPage` performs the navigation;
 * `markIntentionalNavigation` silences the leave-page prompt for a reload the
 * user confirmed. `onUserRestartFailed` reports a stop that left the page as
 * it was. `sendActivationRequest` exists for tests.
 */
export function createRestartController(options: {
    saveNotes: () => Promise<boolean>;
    waitingWorker: () => ObservedWorker | null;
    loadController: ObservedWorker | null;
    currentController: () => ObservedWorker | null;
    canReloadWithoutAsking: () => boolean;
    reloadPage: () => void;
    markIntentionalNavigation: () => void;
    onUserRestartFailed: (failure: UserRestartFailure) => void;
    sendActivationRequest?: typeof requestActivation;
}): RestartController {
    const sendActivationRequest = options.sendActivationRequest ?? requestActivation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isReloading = false;

    // One pending timer at most, cleared on release: a timer of an earlier
    // attempt can never release a later attempt's lock.
    const schedule = (callback: () => void, delayMs: number): void => {
        clearTimeout(timer);
        timer = setTimeout(callback, delayMs);
    };

    const release = (): void => {
        clearTimeout(timer);
        timer = undefined;
        isReloading = false;
        unlockRestart();
    };

    const fail = (failure: UserRestartFailure): void => {
        release();
        options.onUserRestartFailed(failure);
    };

    // Reloading is a wait as well: the page lives on if the navigation does
    // not happen, and the lock must not outlive that.
    const reload = (): void => {
        if (restartLockReason() === "user") options.markIntentionalNavigation();
        isReloading = true;
        schedule(() => {
            log.warn("page stayed after reload", { reason: restartLockReason() });
            release();
        }, RELOAD_TIMEOUT_MS);
        options.reloadPage();
    };

    const restart = async (): Promise<void> => {
        if (!tryLockRestart("user")) return;
        try {
            const areNotesSaved = await saveNotesWithin(options.saveNotes, NOTES_SAVE_TIMEOUT_MS);
            // A takeover reported while notes were saved has already reloaded.
            if (isReloading) return;
            if (!areNotesSaved) return fail("notesNotSaved");
            const worker = options.waitingWorker();
            if (!worker) {
                // The page already runs under the newest worker or lags behind
                // the active one: a reload loads the newest active release.
                log.info("no waiting worker, reloading");
                return reload();
            }
            const result = await sendActivationRequest(worker, ACTIVATION_ANSWER_TIMEOUT_MS);
            if (isReloading) return;
            if (result === "otherWindows") return fail("otherWindows");
            if (result === "updating") {
                schedule(reload, TAKEOVER_TIMEOUT_MS);
                return;
            }
            // The user accepted the restart; an update that is still waiting
            // shows again after the reload.
            log.warn("reloading without a worker answer");
            reload();
        } catch (error) {
            log.warn("update failed", { error: error instanceof Error ? error.message : String(error) });
            if (!isReloading) fail("failed");
        }
    };

    // The rule acts only on the browser's event, never on a state read: a
    // reload must correspond to a real activation, so it cannot loop.
    const handleControllerChange = (): void => {
        if (options.currentController() === options.loadController) return;
        // The expected outcome of a restart. A page loaded without a
        // controller (hard reload) reloads now instead of after the takeover
        // window. Reloading earlier could load the old release again.
        if (isRestartLocked()) {
            reload();
            return;
        }
        if (options.loadController === null) return;
        // A late activation: an earlier restart request, or another window.
        if (options.canReloadWithoutAsking() && tryLockRestart("auto")) {
            reload();
            return;
        }
        // Lazy chunks of this release now come from the network: asset
        // retention covers the previous release, offline they fail.
        log.warn("page stays under a newer worker");
    };

    return { restart, handleControllerChange };
}
