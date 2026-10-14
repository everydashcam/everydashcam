const SOURCE_TIME_EPS_SEC = 1e-4;

/** Borrows each sample until the next iteration, with one prefetched sample to
 * identify the end of the requested decode window. Owns and closes both samples
 * on completion, early exit or failure; callers must not retain or close them. */
export async function* withFinalSample<T extends { close(): void }>(
    source: AsyncIterable<T>,
): AsyncGenerator<{ sample: T; isLast: boolean }> {
    const iterator = source[Symbol.asyncIterator]();
    let current: T | undefined;
    let next: T | undefined;
    try {
        const first = await iterator.next();
        if (first.done) return;
        current = first.value;
        while (current) {
            const following = await iterator.next();
            next = following.done ? undefined : following.value;
            const sample = current;
            current = undefined;
            try {
                yield { sample, isLast: following.done === true };
            } finally {
                sample.close();
            }
            current = next;
            next = undefined;
        }
    } finally {
        try {
            current?.close();
        } finally {
            try {
                next?.close();
            } finally {
                await iterator.return?.();
            }
        }
    }
}

interface SampleTiming {
    timestamp: number;
    duration: number;
}

/** Extends only a decoded final source packet through the requested tail.
 * Iterator exhaustion can also mean a trim boundary or a short decode. Query
 * packet identity only when a tail needs extending, after decoding has warmed
 * the container index; container/audio duration cannot establish video EOF. */
export async function detectionSampleTiming(
    sample: SampleTiming,
    isLast: boolean,
    requestedEndTimestamp: number,
    getFinalPacket: () => Promise<SampleTiming | null>,
): Promise<SampleTiming> {
    let endTimestamp = Math.min(sample.timestamp + sample.duration, requestedEndTimestamp);
    if (isLast && endTimestamp < requestedEndTimestamp - SOURCE_TIME_EPS_SEC) {
        const finalPacket = await getFinalPacket();
        // Endpoint equality alone also matches the preceding sample when the
        // final packet has zero duration. Its own timestamp proves identity,
        // including when the decoded final sample itself has zero duration.
        if (finalPacket && Math.abs(sample.timestamp - finalPacket.timestamp) <= SOURCE_TIME_EPS_SEC) {
            endTimestamp = requestedEndTimestamp;
        }
    }
    return { timestamp: sample.timestamp, duration: Math.max(0, endTimestamp - sample.timestamp) };
}
