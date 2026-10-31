/** One outstanding dialog choice. Reopening settles the previous caller so
 * rapid clicks cannot leave promises waiting on a dialog that no longer exists. */
export function createModalResult<Value>() {
    let resolve: ((value: Value) => void) | null = null;
    const settle = (value: Value): void => {
        const pending = resolve;
        resolve = null;
        pending?.(value);
    };
    return {
        get pending(): boolean {
            return resolve !== null;
        },
        wait(replacedValue: Value): Promise<Value> {
            settle(replacedValue);
            return new Promise<Value>((done) => {
                resolve = done;
            });
        },
        settle,
    };
}
