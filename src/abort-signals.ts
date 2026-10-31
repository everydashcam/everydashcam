/** Cancellation checkpoints that promise AbortError normalize any signal reason.
 * Use the native signal.throwIfAborted() where TimeoutError or a caller's reason
 * must survive (asset downloads and tracker timeout classification). */
export function throwIfCancelled(signal?: AbortSignal, message = "aborted"): void {
    if (signal?.aborted) throw new DOMException(message, "AbortError");
}

export interface CombinedAbortSignal {
    signal: AbortSignal;
    /** Release fallback subscriptions when the operation settles without aborting. */
    dispose(): void;
}

/** AbortSignal.any is missing in older Safari/Chromium. Keep its first-reason
 * semantics, including TimeoutError, without retaining completed operations. */
export function combineAbortSignals(signals: readonly AbortSignal[]): CombinedAbortSignal {
    if (typeof AbortSignal.any === "function") {
        return { signal: AbortSignal.any([...signals]), dispose() {} };
    }
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const dispose = (): void => {
        for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
        listeners.clear();
    };
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) {
        controller.abort(aborted.reason);
    } else {
        for (const signal of new Set(signals)) {
            const listener = (): void => {
                dispose();
                controller.abort(signal.reason);
            };
            listeners.set(signal, listener);
            signal.addEventListener("abort", listener, { once: true });
        }
    }
    return { signal: controller.signal, dispose };
}
