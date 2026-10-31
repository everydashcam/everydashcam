// User preference: metric (km/h, km) vs imperial (mph, mi).
// One source of truth for unit formatting across chart, map popup, sidebar,
// trip meta, feedback report.
//
// Storage: localStorage["everydashcam:units"]. Default is autodetect by
// navigator.language - countries that use mph on road signs map to imperial,
// everything else stays metric.
//
// Subscribers (subscribeUnitsChange) re-render their DOM when the preference
// changes - mirrors the existing langchange subscription pattern.

import type { I18nKey } from "./i18n/keys.js";
import { readLocalStorage, writeLocalStorage } from "./local-storage.js";

export type Units = "metric" | "imperial";

const STORAGE_KEY = "everydashcam:units";
const UNITS_CHANGE_EVENT = "dc:units-change";
const eventTarget: EventTarget = new EventTarget();

// 1 km/h = 0.621371 mph; 1 km = 0.621371 mi (same factor, different domain).
const KMH_TO_MPH = 0.621371;
const KM_TO_MI = 0.621371;

let cached: Units | null = null;

/**
 * Default for users who never opened settings. Locales using mph on road
 * signs: US, UK, Liberia, Myanmar (Burma), Belize. en-* fallback covers UK and
 * US out of the box; the explicit list catches non-English locales in those
 * countries (e.g. cy-GB for Welsh). Liberia is `lr` (not `li`, which is
 * Liechtenstein - a metric country).
 */
function detectDefault(): Units {
    if (typeof navigator === "undefined") return "metric";
    const lang = navigator.language?.toLowerCase() ?? "";
    if (/^en-(us|gb|lr|mm|bz)\b/.test(lang)) return "imperial";
    if (/-(us|gb|lr|mm|bz)$/.test(lang)) return "imperial";
    return "metric";
}

/** Current preference; reads localStorage once on first call, then in-memory. */
export function getUnits(): Units {
    if (cached !== null) return cached;
    const stored = readLocalStorage(STORAGE_KEY);
    if (stored === "metric" || stored === "imperial") {
        cached = stored;
        return stored;
    }
    cached = detectDefault();
    return cached;
}

/**
 * Sets the preference and broadcasts the change. Subscribers re-render
 * their views; no-op if the value is unchanged.
 */
export function setUnits(u: Units): void {
    if (cached === null) cached = getUnits();
    if (cached === u) return;
    cached = u;
    writeLocalStorage(STORAGE_KEY, u);
    eventTarget.dispatchEvent(new CustomEvent<Units>(UNITS_CHANGE_EVENT, { detail: u }));
}

/**
 * Flips the preference. Used by inline UI toggles (e.g. clicking the speed
 * value in the player overlay) - avoids the call site having to know both
 * possible states and read the current one.
 */
export function toggleUnits(): Units {
    const next: Units = getUnits() === "metric" ? "imperial" : "metric";
    setUnits(next);
    return next;
}

/**
 * Subscribes to preference changes. Returns an unsubscribe function.
 * The listener fires AFTER the new value is persisted, so handlers that
 * call getUnits() see the fresh value.
 */
export function subscribeUnitsChange(handler: (u: Units) => void): () => void {
    const wrapped = ((ev: Event) => {
        handler((ev as CustomEvent<Units>).detail);
    }) as EventListener;
    eventTarget.addEventListener(UNITS_CHANGE_EVENT, wrapped);
    return () => eventTarget.removeEventListener(UNITS_CHANGE_EVENT, wrapped);
}

// --- Formatting helpers ---
//
// Functions return {value, unitKey} pairs rather than fully formatted
// strings so the caller controls decimals and surrounding markup. unitKey
// is one of the i18n unit keys ("units.kmh" / "units.mph" / "units.km" /
// "units.mi") - the caller passes it through t().

/** Speed in user units, from raw m/s. */
export function formatSpeedFromMs(speedMs: number): { value: number; unitKey: I18nKey } {
    if (getUnits() === "imperial") {
        return { value: speedMs * 3.6 * KMH_TO_MPH, unitKey: "units.mph" };
    }
    return { value: speedMs * 3.6, unitKey: "units.kmh" };
}

/** Distance in user units, from kilometers. */
export function formatDistanceFromKm(distanceKm: number): { value: number; unitKey: I18nKey } {
    if (getUnits() === "imperial") {
        return { value: distanceKm * KM_TO_MI, unitKey: "units.mi" };
    }
    return { value: distanceKm, unitKey: "units.km" };
}
