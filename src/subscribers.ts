import { createLogger } from "./log.js";

/** Synchronous application notifications. A broken view must not prevent the
 * other views from observing committed state. Report once per subscription,
 * including frame-driven signals, so a persistent failure cannot flood logs. */
export function createSubscribers<Args extends unknown[] = []>(scope: string) {
    type Listener = (...args: Args) => void;
    const listeners = new Set<Listener>();
    let reported = new WeakSet<Listener>();
    const log = createLogger(`subscribers:${scope}`);
    const invoke = (listener: Listener, args: Args): void => {
        try {
            listener(...args);
        } catch (error) {
            if (reported.has(listener)) return;
            reported.add(listener);
            log.warn("subscriber failed", error);
        }
    };
    return {
        subscribe(listener: Listener, initial?: Args): () => void {
            if (!listeners.has(listener)) reported.delete(listener);
            listeners.add(listener);
            if (initial) invoke(listener, initial);
            return () => listeners.delete(listener);
        },
        emit(...args: Args): void {
            for (const listener of listeners) invoke(listener, args);
        },
        /** Preserve per-listener copies where callers expose mutable objects. */
        emitWith(createArgs: () => Args): void {
            for (const listener of listeners) invoke(listener, createArgs());
        },
        clear(): void {
            listeners.clear();
            reported = new WeakSet();
        },
    };
}
