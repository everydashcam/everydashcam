import { setImmediate as nextTurn } from "node:timers/promises";
// Mock endpoints for protocol tests. Avoids spinning up real Workers in
// vitest (environment: node) - the tests exercise our framing/correlation,
// not the browser's Worker API.
//
// Pairs a WorkerEndpoint (main-thread shape) with a WorkerScopeEndpoint
// (worker shape) so a message posted on one fires `message` on the other -
// the same way a real Worker does, minus the structured-clone copy.

import type { WorkerEndpoint } from "./worker-client.js";
import type { WorkerScopeEndpoint } from "./worker-server.js";

type MsgListener = (ev: MessageEvent) => void;
type ErrListener = (ev: ErrorEvent) => void;

interface ListenerSets {
    message: Set<MsgListener>;
    messageerror: Set<MsgListener>;
    error: Set<ErrListener>;
}

function emptyListeners(): ListenerSets {
    return { message: new Set(), messageerror: new Set(), error: new Set() };
}

/** Public handle for tests to inject fake events. */
export interface PairedEndpoints {
    mainEndpoint: WorkerEndpoint;
    workerEndpoint: WorkerScopeEndpoint;
    /** Simulates a worker-thread uncaught exception delivered to main. */
    fireMainError(init: Partial<ErrorEventInit>): void;
    /** Simulates a messageerror (unclonable arrival) on main. */
    fireMainMessageError(data: unknown): void;
    /** True after mainEndpoint.terminate() - tests can assert teardown. */
    terminated(): boolean;
    /** Counts of in-flight listeners, for leak detection in tests. */
    listenerCounts(): { mainMessage: number; workerMessage: number };
}

export function makePairedEndpoints(): PairedEndpoints {
    const mainListeners = emptyListeners();
    const workerListeners = emptyListeners();
    let terminated = false;

    const deliver = (listeners: Set<MsgListener>, data: unknown): void => {
        // queueMicrotask to mirror real postMessage async semantics - listeners
        // never fire synchronously inside postMessage.
        queueMicrotask(() => {
            if (terminated) return;
            const ev = { data } as MessageEvent;
            for (const fn of listeners) fn(ev);
        });
    };

    const mainEndpoint: WorkerEndpoint = {
        postMessage(message: unknown) {
            if (terminated) return;
            deliver(workerListeners.message, message);
        },
        addEventListener(type, listener) {
            if (type === "message") mainListeners.message.add(listener as MsgListener);
            else if (type === "messageerror") mainListeners.messageerror.add(listener as MsgListener);
            else mainListeners.error.add(listener as ErrListener);
        },
        removeEventListener(type, listener) {
            if (type === "message") mainListeners.message.delete(listener as MsgListener);
            else if (type === "messageerror") mainListeners.messageerror.delete(listener as MsgListener);
            else mainListeners.error.delete(listener as ErrListener);
        },
        terminate() {
            terminated = true;
        },
    };

    const workerEndpoint: WorkerScopeEndpoint = {
        postMessage(message: unknown) {
            if (terminated) return;
            deliver(mainListeners.message, message);
        },
        addEventListener(_type, listener) {
            workerListeners.message.add(listener as MsgListener);
        },
    };

    return {
        mainEndpoint,
        workerEndpoint,
        fireMainError(init) {
            const ev = init as ErrorEvent;
            for (const fn of mainListeners.error) fn(ev);
        },
        fireMainMessageError(data) {
            const ev = { data } as MessageEvent;
            for (const fn of mainListeners.messageerror) fn(ev);
        },
        terminated() {
            return terminated;
        },
        listenerCounts() {
            return {
                mainMessage: mainListeners.message.size,
                workerMessage: workerListeners.message.size,
            };
        },
    };
}

/** A task boundary drains recursively queued promise continuations too. A single
 * queueMicrotask marker can run before the handlers those continuations enqueue. */
export function flushMicrotasks(): Promise<void> {
    return nextTurn();
}
