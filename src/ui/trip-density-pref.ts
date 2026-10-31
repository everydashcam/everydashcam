// Remembers the trip list layout (cards or compact rows) across sessions.

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import type { TripListDensity } from "./state.js";

const TRIP_DENSITY_KEY = "everydashcam:trip-density";

/** The stored layout; cards when nothing valid is stored or storage is unavailable. */
export function readTripDensity(): TripListDensity {
    return readLocalStorage(TRIP_DENSITY_KEY) === "rows" ? "rows" : "cards";
}

/** Stores the layout; a failing storage only costs the choice on the next visit. */
export function writeTripDensity(density: TripListDensity): void {
    writeLocalStorage(TRIP_DENSITY_KEY, density);
}
