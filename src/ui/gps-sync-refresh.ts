// Lightweight fan-out for live GPS calibration. The dialog requests a
// refresh without importing the heavy player/map/chart graph into its module;
// initialized viewer modules register repaint callbacks.

import { createSubscribers } from "../subscribers.js";
type RefreshListener = () => void;

const listeners = createSubscribers<Parameters<RefreshListener>>("gps-sync");

export function registerGpsSyncRefreshListener(listener: RefreshListener): () => void {
    return listeners.subscribe(listener);
}

export function requestGpsSyncSurfaceRefresh(): void {
    listeners.emit();
}
