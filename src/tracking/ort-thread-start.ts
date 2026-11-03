import { createSerialQueue } from "../serial-queue.js";

const serialize = createSerialQueue();

/** Emscripten's pthread onerror throws outside the session promise. Observe
 * its workers before it installs that handler, so a failed pool rejects the
 * session startup and the page can retry on a fresh, single-threaded worker.
 * This scope runs only inside the tracker worker, during threaded startup.
 * Serializing scopes also keeps concurrent runtime loads from nesting global
 * Worker replacements. No error handlers are installed on the global scope. */
export function startOrtThreadPool<T>(start: () => Promise<T>): Promise<T> {
    return serialize(async () => {
        const OriginalWorker = globalThis.Worker;
        const threads = new Map<Worker, (event: Event) => void>();
        let rejectThreadFailure!: (error: Error) => void;
        const threadFailure = new Promise<never>((_, reject) => {
            rejectThreadFailure = reject;
        });
        globalThis.Worker = new Proxy(OriginalWorker, {
            construct(target, args, newTarget) {
                // Keep the native prototype: surviving threads must not retain
                // the temporary constructor and its startup promise through it.
                const thread = Reflect.construct(target, args, newTarget) as Worker;
                const options = args[1] as WorkerOptions | undefined;
                // Match ORT's own thread entry check, including builds whose
                // pthread names have an id suffix. Other children are untouched.
                if (!options?.name?.startsWith("em-pthread")) return thread;
                const onError = (event: Event): void => {
                    // Consume only this owned thread's startup error; the
                    // rejected operation carries the failure over RPC instead.
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    // Script-load failures use a plain Event, not ErrorEvent.
                    const fields = event as Partial<ErrorEvent>;
                    rejectThreadFailure(
                        new Error(fields.message || "ort thread failed to start", { cause: fields.error }),
                    );
                };
                threads.set(thread, onError);
                thread.addEventListener("error", onError);
                return thread;
            },
        });
        let succeeded = false;
        try {
            // Observe both promises even if start throws synchronously or the
            // native initialization rejects after a thread already failed.
            const result = await Promise.race([Promise.resolve().then(start), threadFailure]);
            succeeded = true;
            return result;
        } finally {
            globalThis.Worker = OriginalWorker;
            for (const [thread, onError] of threads) {
                if (succeeded) {
                    // Once initialized, an inference crash must reach the
                    // regular worker failure boundary, never a startup retry.
                    thread.removeEventListener("error", onError);
                } else {
                    thread.terminate();
                    // Retain the handler for errors already queued by sibling
                    // threads until the page discards this failed tracker.
                }
            }
        }
    });
}
