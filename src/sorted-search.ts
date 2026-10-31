/** First index whose key is >= target, or length when every key is smaller. */
export function lowerBoundBy<T>(items: readonly T[], target: number, key: (item: T) => number): number {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (key(items[mid]!) < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** First index whose key is > target. Subtract one for the last key <= target. */
export function upperBoundBy<T>(items: readonly T[], target: number, key: (item: T) => number): number {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (key(items[mid]!) <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Nearest key in sorted input; empty arrays return -1. Equal distances use
 * the caller's tie policy. Exact matches select the first matching key. */
export function nearestIndexBy<T>(
    items: readonly T[],
    target: number,
    key: (item: T) => number,
    tie: "earlier" | "later",
): number {
    if (items.length === 0) return -1;
    const index = Math.min(lowerBoundBy(items, target, key), items.length - 1);
    if (index > 0) {
        const previous = Math.abs(key(items[index - 1]!) - target);
        const current = Math.abs(key(items[index]!) - target);
        if (tie === "earlier" ? previous <= current : previous < current) return index - 1;
    }
    return index;
}
