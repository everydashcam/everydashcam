// Connectivity tracker. Single source of truth for "is the app effectively
// offline", surfaced to the UI by the offline banner (src/ui/offline-banner.ts).
//
// Two independent signals are OR-ed, because neither alone is enough:
//
//   1. navigator online/offline events. Reliable for HARD offline (airplane
//      mode), where navigator.onLine flips to false. Fires everywhere, incl. the
//      landing page before any map exists.
//   2. Map tile network failures. The ONLY runtime signal for "connected but no
//      internet" limbo (router with no WAN, cellular attached with no data) -
//      navigator.onLine stays TRUE there, so signal 1 never trips. The map is
//      lazy, so this contributes only once a trip's map is on screen; that is
//      also exactly when the degradation (a blank map background) is visible.
//
// Each signal clears itself: the "online" event clears the nav flag, a tile that
// loads again clears the limbo flag - so recovery works for both paths.

import { createSubscribers } from "../subscribers.js";
import { createLogger } from "../log.js";

const log = createLogger("connectivity");

// Hard-offline (navigator) and limbo (map tiles) flags. Effective offline is
// either one. navOffline is set authoritatively in initConnectivity() from
// navigator.onLine; it defaults false so the module is import-safe in non-DOM
// test contexts.
let navOffline = false;
let tileOffline = false;

type OfflineListener = (offline: boolean) => void;
const listeners = createSubscribers<Parameters<OfflineListener>>("connectivity");

// Last value broadcast, so emit() notifies ONLY on a real transition (the map
// tile-ok path can fire on every loaded tile).
let lastBroadcast: boolean | null = null;

function effectiveOffline(): boolean {
    return navOffline || tileOffline;
}

function emit(): void {
    const next = effectiveOffline();
    if (next === lastBroadcast) return;
    lastBroadcast = next;
    listeners.emit(next);
}

/** Current effective offline state. */
export function isOffline(): boolean {
    return effectiveOffline();
}

/**
 * Subscribe to effective-offline transitions. The handler is called once
 * immediately with the current state (so a late subscriber is in sync), then on
 * every change. Returns an unsubscribe function.
 */
export function subscribeConnectivity(handler: OfflineListener): () => void {
    return listeners.subscribe(handler, [effectiveOffline()]);
}

/**
 * Report that a map tile fetch failed with a NETWORK error (server unreachable),
 * which means limbo offline even when navigator.onLine is true. Idempotent -
 * cheap to call from the map's per-tile error handler.
 */
export function reportMapTileNetworkError(): void {
    if (tileOffline) return;
    tileOffline = true;
    log.info("map tiles unreachable - going offline");
    emit();
}

/**
 * Report that a map tile loaded successfully again - clears the limbo flag.
 * Idempotent and gated, so it is a no-op (one boolean check) on the hot map
 * "data" event in the normal online case.
 */
export function reportMapTilesOk(): void {
    if (!tileOffline) return;
    tileOffline = false;
    log.info("map tiles reachable again");
    emit();
}

let initialized = false;

/**
 * Bind the navigator online/offline listeners and seed the initial state from
 * navigator.onLine. Idempotent. Call once from app.ts.
 */
export function initConnectivity(): void {
    if (initialized) return;
    initialized = true;
    navOffline = navigator.onLine === false;
    addEventListener("online", () => {
        navOffline = false;
        emit();
    });
    addEventListener("offline", () => {
        navOffline = true;
        emit();
    });
    emit();
}
