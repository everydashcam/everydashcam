/** Serializes access to one resource. Each caller receives its own result or
 * failure; a rejected operation does not poison the next operation. Cancellation
 * and error reporting stay with the operation that owns those semantics. */
export function createSerialQueue(): <T>(operation: () => T | PromiseLike<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
        const result = tail.then(operation);
        tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
}
