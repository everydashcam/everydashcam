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
    /** The installed next release waiting to take over. Null when nothing waits,
     *  during a first installation, which is not an update, and when a page
     *  loaded without a worker already runs that release (see readAtLoad). */
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
     *  Safe to call repeatedly with the same object. On a page loaded without a
     *  worker, the first call decides which workers the page already outdates. */
    adopt(registration: ObservedRegistration): void;
    /** Re-reads the registration and the page's controller, reports a change
     *  through onChange and returns the current state. Idempotent. */
    refresh(): UpdateState;
    /**
     * First read after page load: adopts the registration without waiting for
     * the deferred register(). A page loaded under a worker shows an update
     * installed by an earlier visit at once. A page loaded without one (a hard
     * reload bypasses the worker) came from the network, so it already runs
     * the release of every worker this read finds, or a newer one; none of
     * them is reported. A failed lookup is logged.
     */
    readAtLoad(getRegistration: () => Promise<ObservedRegistration | undefined>): Promise<void>;
}

/** Page lifecycle sources that prompt a re-read, plus the clock and connection
 *  state that pace update checks. */
export interface ObservedPage {
    window: EventTarget;
    document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
    /** Monotonic milliseconds, such as performance.now(). */
    now: () => number;
    isOnline: () => boolean;
}

// The browser checks for a new worker on every navigation, so only a tab kept
// open for long misses releases. A return to the tab is the moment a new
// release can still be useful; there is no timer for a tab nobody looks at.
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Whether a return to the tab should ask the browser for a new release:
 *  online, and at least UPDATE_CHECK_INTERVAL_MS after the previous check or
 *  page load, which the browser's own navigation check covers. */
export function isUpdateCheckDue(nowMs: number, lastCheckMs: number, isOnline: boolean): boolean {
    return isOnline && nowMs - lastCheckMs >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Creates the observer. `loadController` is the worker that controlled the
 * page when it loaded (null for an uncontrolled page, including a hard reload);
 * `currentController` reads the live controller. `onChange` receives every
 * state that differs from the previous one. The page re-reads on return to the
 * tab and on a back/forward cache restore: either may follow a missed event.
 * A return to the tab also asks the browser for a new release when
 * isUpdateCheckDue allows it.
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
    // Workers that a page loaded without a worker already outdates (see
    // readAtLoad). Reporting one would offer a restart into the page's own
    // release, which fails while another window keeps the worker waiting.
    const workersOutdatedByPage = new WeakSet<ObservedWorker>();
    let hasAdopted = false;
    let state: UpdateState = { waitingWorker: null, isPageBehind: false, updateSerial: 0 };
    let lastCheckMs = options.page.now();

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
        const waitingWorker = waiting && registration?.active && !workersOutdatedByPage.has(waiting) ? waiting : null;
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
        // readAtLoad normally makes this first read right after load. If the
        // lookup fails, register() makes it seconds later, and a release
        // installed in between goes unreported in this tab only.
        if (!hasAdopted && options.loadController === null) {
            for (const worker of [next.installing, next.waiting]) if (worker) workersOutdatedByPage.add(worker);
        }
        hasAdopted = true;
        registration = next;
        if (!watchedRegistrations.has(next)) {
            watchedRegistrations.add(next);
            next.addEventListener("updatefound", () => refresh());
        }
        refresh();
    };

    const checkForUpdateIfDue = (): void => {
        const nowMs = options.page.now();
        if (!registration || !isUpdateCheckDue(nowMs, lastCheckMs, options.page.isOnline())) return;
        lastCheckMs = nowMs;
        registration.update().catch((error: unknown) => {
            log.info("update check failed", { error: error instanceof Error ? error.message : String(error) });
        });
    };

    options.page.document.addEventListener("visibilitychange", () => {
        if (options.page.document.visibilityState !== "visible") return;
        refresh();
        checkForUpdateIfDue();
    });
    options.page.window.addEventListener("pageshow", (event) => {
        if ((event as PageTransitionEvent).persisted) refresh();
    });

    const readAtLoad = async (getRegistration: () => Promise<ObservedRegistration | undefined>): Promise<void> => {
        try {
            const found = await getRegistration();
            if (found) adopt(found);
        } catch (error) {
            log.warn("registration lookup failed", { error: error instanceof Error ? error.message : String(error) });
        }
    };

    return { adopt, refresh, readAtLoad };
}
