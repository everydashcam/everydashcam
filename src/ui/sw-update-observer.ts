// Reads the update state from the registration instead of accumulating its
// events: a missed event must not mean a missed update. updatefound is not
// replayed for a listener attached after installation started, so every read
// also picks up registration.installing (workbox-window's register() checks
// only `waiting` and has the same gap).
import { createLogger } from "../log.js";

const log = createLogger("sw");

/** The part of a ServiceWorker the update flow reads or messages. */
export interface ObservedWorker extends EventTarget {
    readonly state: ServiceWorkerState;
    postMessage(message: unknown, transfer: Transferable[]): void;
}

/** The part of a ServiceWorkerRegistration the update flow reads. */
export interface ObservedRegistration extends EventTarget {
    readonly installing: ObservedWorker | null;
    readonly waiting: ObservedWorker | null;
    readonly active: ObservedWorker | null;
    update(): Promise<unknown>;
}

/** What the page knows about releases newer than the one it runs. */
export interface UpdateState {
    /** The installed next release waiting to take over. Null when nothing waits
     *  and during a first installation, which is not an update. */
    waitingWorker: ObservedWorker | null;
    /** The page runs an older release than the newest one the browser holds:
     *  an update waits, or the page loaded under a worker that no longer
     *  controls it. */
    isPageBehind: boolean;
    /** Grows each time a newer release this page has not reported before
     *  appears. Equal values describe the same release. */
    updateSerial: number;
}

export interface UpdateObserver {
    /** Starts reading a registration from getRegistration() or register().
     *  Safe to call repeatedly with the same object. */
    adopt(registration: ObservedRegistration): void;
    /** Re-reads the registration and the page's controller, reports a change
     *  through onChange and returns the current state. Idempotent. */
    refresh(): UpdateState;
    /**
     * First read after page load, for a page loaded under a worker. Resolves
     * whether an update was already waiting at that moment: only that fact may
     * start an automatic restart. A failed lookup resolves false.
     */
    readAtLoad(getRegistration: () => Promise<ObservedRegistration | undefined>): Promise<boolean>;
}

/** Page lifecycle sources that prompt a re-read. */
export interface ObservedPage {
    window: EventTarget;
    document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
}

/**
 * Creates the observer. `loadController` is the worker that controlled the
 * page when it loaded (null for an uncontrolled page, including a hard reload);
 * `currentController` reads the live controller. `onChange` receives every
 * state that differs from the previous one. The page re-reads on return to the
 * tab and on a back/forward cache restore: either may follow a missed event.
 */
export function createUpdateObserver(options: {
    loadController: ObservedWorker | null;
    currentController: () => ObservedWorker | null;
    onChange: (state: UpdateState) => void;
    page: ObservedPage;
}): UpdateObserver {
    let registration: ObservedRegistration | null = null;
    const watchedRegistrations = new WeakSet<ObservedRegistration>();
    const watchedWorkers = new WeakSet<ObservedWorker>();
    const reportedWorkers = new WeakSet<ObservedWorker>();
    let state: UpdateState = { waitingWorker: null, isPageBehind: false, updateSerial: 0 };

    const watchWorker = (worker: ObservedWorker | null): void => {
        if (!worker || watchedWorkers.has(worker)) return;
        watchedWorkers.add(worker);
        worker.addEventListener("statechange", () => {
            if (worker.state === "installed") log.info("installed", { isUpdate: Boolean(registration?.active) });
            else if (worker.state === "redundant") log.info("worker became redundant");
            refresh();
        });
    };

    const refresh = (): UpdateState => {
        watchWorker(registration?.installing ?? null);
        const waiting = registration?.waiting ?? null;
        // A first installation passes through `waiting` with no active worker.
        const waitingWorker = waiting && registration?.active ? waiting : null;
        const controller = options.currentController();
        const hasControllerChanged =
            options.loadController !== null && controller !== null && controller !== options.loadController;
        const newestWorker = waitingWorker ?? (hasControllerChanged ? controller : null);
        let updateSerial = state.updateSerial;
        if (newestWorker && !reportedWorkers.has(newestWorker)) {
            reportedWorkers.add(newestWorker);
            updateSerial++;
        }
        const next: UpdateState = {
            waitingWorker,
            isPageBehind: waitingWorker !== null || hasControllerChanged,
            updateSerial,
        };
        const hasChanged =
            next.waitingWorker !== state.waitingWorker ||
            next.isPageBehind !== state.isPageBehind ||
            next.updateSerial !== state.updateSerial;
        state = next;
        if (hasChanged) options.onChange(next);
        return next;
    };

    const adopt = (next: ObservedRegistration): void => {
        registration = next;
        if (!watchedRegistrations.has(next)) {
            watchedRegistrations.add(next);
            next.addEventListener("updatefound", () => refresh());
        }
        refresh();
    };

    options.page.document.addEventListener("visibilitychange", () => {
        if (options.page.document.visibilityState === "visible") refresh();
    });
    options.page.window.addEventListener("pageshow", (event) => {
        if ((event as PageTransitionEvent).persisted) refresh();
    });

    const readAtLoad = async (getRegistration: () => Promise<ObservedRegistration | undefined>): Promise<boolean> => {
        try {
            const found = await getRegistration();
            if (found) adopt(found);
        } catch (error) {
            log.warn("registration lookup failed", { error: error instanceof Error ? error.message : String(error) });
        }
        return refresh().waitingWorker !== null;
    };

    return { adopt, refresh, readAtLoad };
}
