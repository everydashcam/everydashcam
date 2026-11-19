interface PreviewJob {
    file: File;
    promise: Promise<string | null>;
    start: () => void;
    reject: (reason: Error) => void;
    signals: Map<AbortSignal, () => void>;
    hasPersistentConsumer: boolean;
    isStarted: boolean;
}

/** One decoder budget shared by progressive ingest and the final preview pass. */
export function createPreviewQueue(capacity: number): {
    run: (file: File, extract: () => Promise<string | null>, signal?: AbortSignal) => Promise<string | null>;
    setPlaybackActive: (active: boolean) => void;
    /** Admits nothing new until every hold is released; extractions already
     *  running finish. Returns the idempotent release. */
    hold: () => () => void;
} {
    const jobs = new Map<File, PreviewJob>();
    const pending: PreviewJob[] = [];
    let activeCount = 0;
    let playbackActive = false;
    let holdCount = 0;

    const remove = (job: PreviewJob): void => {
        if (jobs.get(job.file) === job) jobs.delete(job.file);
        for (const [signal, onAbort] of job.signals) signal.removeEventListener("abort", onAbort);
        job.signals.clear();
    };

    const pump = (): void => {
        const admissionLimit = holdCount > 0 ? 0 : playbackActive ? 1 : capacity;
        while (activeCount < admissionLimit && pending.length > 0) {
            const job = pending.shift()!;
            job.isStarted = true;
            activeCount++;
            job.start();
        }
    };

    return {
        run(file, extract, signal) {
            if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
            let job = jobs.get(file);
            if (!job) {
                let resolveResult!: (value: string | null) => void;
                let rejectResult!: (reason: unknown) => void;
                const promise = new Promise<string | null>((resolve, reject) => {
                    resolveResult = resolve;
                    rejectResult = reject;
                });
                const created: PreviewJob = {
                    file,
                    promise,
                    signals: new Map(),
                    hasPersistentConsumer: false,
                    isStarted: false,
                    reject: rejectResult,
                    start: () => {
                        void (async () => {
                            try {
                                resolveResult(await extract());
                            } catch (err) {
                                rejectResult(err);
                            } finally {
                                remove(created);
                                activeCount--;
                                pump();
                            }
                        })();
                    },
                };
                job = created;
                jobs.set(file, job);
                pending.push(job);
            }
            const sharedJob = job;
            if (!signal) sharedJob.hasPersistentConsumer = true;
            else if (!sharedJob.signals.has(signal)) {
                const onAbort = (): void => {
                    if (sharedJob.isStarted || sharedJob.hasPersistentConsumer) return;
                    if ([...sharedJob.signals.keys()].some((consumer) => !consumer.aborted)) return;
                    const index = pending.indexOf(sharedJob);
                    if (index >= 0) pending.splice(index, 1);
                    remove(sharedJob);
                    sharedJob.reject(new DOMException("aborted", "AbortError"));
                };
                sharedJob.signals.set(signal, onAbort);
                signal.addEventListener("abort", onAbort, { once: true });
            }
            pump();
            return sharedJob.promise;
        },
        setPlaybackActive(active) {
            // Existing decodes finish; only admission of the next file changes.
            playbackActive = active;
            pump();
        },
        hold() {
            holdCount++;
            let isReleased = false;
            return () => {
                if (isReleased) return;
                isReleased = true;
                holdCount--;
                pump();
            };
        },
    };
}
