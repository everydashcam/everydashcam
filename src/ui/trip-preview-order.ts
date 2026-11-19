// Which trip's preview to build next. The trip list shows previews only on the
// cards in view, so those go first; the rest follow in list order, starting
// where the user is looking. Trips the list does not show (filtered out) come
// last, newest first.
//
// The sidebar reports its display order on every render and registers each
// preview host (card, parking-run stack) for visibility. A collapsed group, a
// closed mobile drawer or a card scrolled away is not intersecting the
// viewport, so its trips wait behind the visible ones without any special case.

import type { Trip } from "../trips.js";

let displayOrder: readonly Trip[] = [];
const visibleTrips = new Set<Trip>();
const tripByTarget = new WeakMap<Element, Trip>();
let observer: IntersectionObserver | null = null;

function visibilityObserver(): IntersectionObserver | null {
    if (observer) return observer;
    // Without IntersectionObserver every trip counts as unseen: previews then
    // follow the list order alone.
    if (typeof IntersectionObserver === "undefined") return null;
    // The viewport as root: a card clipped by the sidebar's scroll box or
    // carried off screen with the mobile drawer is not visible.
    observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const trip = tripByTarget.get(entry.target);
            if (!trip) continue;
            if (entry.isIntersecting) visibleTrips.add(trip);
            else visibleTrips.delete(trip);
        }
    });
    return observer;
}

/** Forgets the preview hosts of the previous render. Call when the list is
 *  cleared, before the new render registers its hosts. */
export function resetTripPreviewHosts(): void {
    visibleTrips.clear();
    observer?.disconnect();
}

/** Records the trips in the order the rendered list shows them. */
export function setTripPreviewDisplayOrder(trips: readonly Trip[]): void {
    displayOrder = trips;
}

/** Registers an element that shows `trip`'s preview, so a visible one moves
 *  the trip to the front of the preview queue. */
export function observeTripPreviewHost(element: Element, trip: Trip): void {
    const io = visibilityObserver();
    if (!io) return;
    tripByTarget.set(element, trip);
    io.observe(element);
}

/** Stops watching a host the list replaced (a refreshed card). */
export function unobserveTripPreviewHost(element: Element): void {
    const trip = tripByTarget.get(element);
    observer?.unobserve(element);
    tripByTarget.delete(element);
    // The replacement host reports its own visibility right after it is observed.
    if (trip) visibleTrips.delete(trip);
}

/** The trip whose preview to build next among those `isWanted` accepts, or null. */
export function nextTripForPreview(isWanted: (trip: Trip) => boolean, fallback: readonly Trip[]): Trip | null {
    return pickNextPreview(displayOrder, visibleTrips, isWanted, fallback);
}

/**
 * Pure ordering behind nextTripForPreview: a visible item in display order;
 * else the next item in display order from the first visible one, wrapping to
 * the top; else the first wanted item of `fallback`. Linear per pick, which
 * stays far below one preview decode even on a card of thousands of trips.
 */
export function pickNextPreview<T>(
    order: readonly T[],
    visible: ReadonlySet<T>,
    isWanted: (item: T) => boolean,
    fallback: readonly T[],
): T | null {
    let firstVisibleIdx = -1;
    for (let i = 0; i < order.length; i++) {
        const item = order[i]!;
        if (!visible.has(item)) continue;
        if (firstVisibleIdx < 0) firstVisibleIdx = i;
        if (isWanted(item)) return item;
    }
    const start = Math.max(0, firstVisibleIdx);
    for (let step = 0; step < order.length; step++) {
        const item = order[(start + step) % order.length]!;
        if (isWanted(item)) return item;
    }
    for (const item of fallback) {
        if (isWanted(item)) return item;
    }
    return null;
}
