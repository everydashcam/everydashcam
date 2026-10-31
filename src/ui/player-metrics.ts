// GPS readouts for the playhead: speed, coordinates, camera clock. Rendered in
// the readout row between the player bar and the timeline, plus a speed-only
// copy the bar keeps for phones. Driven by timeupdate + unit-change
// subscriptions. Falls back to placeholders when the player is outside the GPS
// window so the numbers and the map marker disappear together.

import { getDateLocale, t } from "../i18n/index.js";
import { formatSpeedReading } from "../gps-telemetry.js";
import { isValidGpsFix } from "../parser.js";
import { contentToFrame, contentToWallUtc, displayClockDate, type Trip } from "../trips.js";
import type { GpsRecord } from "../parser.js";
import { formatDistanceFromKm, formatSpeedFromMs, getUnits, subscribeUnitsChange, toggleUnits } from "../units-pref.js";
import { dom } from "./dom.js";
import { formatNumber } from "./format.js";
import { syncGpsSyncLaunchers } from "./gps-sync-controls.js";
import { activeCandidate, activeFrame } from "./state.js";
import { type FixState, resolvePlayerMetrics } from "./player-metrics-data.js";

// timeupdate fires every 15-250 ms (Chromium: 250 ms); Intl.DateTimeFormat
// construction (locale-data resolution + ICU pattern compile) is the only
// expensive op in refreshMetrics. Memoize it, keyed by locale - the langchange
// subscription re-runs the refresh after the locale flips, so a new key
// rebuilds naturally with no stale-formatter risk.
let cachedTimeFmt: Intl.DateTimeFormat | null = null;
let cachedTimeFmtLocale: string | null = null;
function localTimeFormatter(): Intl.DateTimeFormat {
    const locale = getDateLocale();
    if (!cachedTimeFmt || cachedTimeFmtLocale !== locale) {
        cachedTimeFmt = new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
            // The zone shift lives inside the displayClockDate value, so the
            // formatter is constant and the locale-keyed memoization holds.
            timeZone: "UTC",
        });
        cachedTimeFmtLocale = locale;
    }
    return cachedTimeFmt;
}

/** Writes speed into both places it is shown: the readout row on desktop and
 *  the bar's speed-only copy on phones. Only one of them is on screen at a
 *  time, but which one is a CSS breakpoint decision - so both are always
 *  current and neither needs a media query in JS. */
function setSpeedText(value: string, unit: string, isEstimated = false): void {
    for (const element of [dom.metrics.speed, dom.metrics.barSpeed]) {
        element.title = isEstimated ? t("speed.estimated") : "";
    }
    dom.metrics.speed.textContent = value;
    dom.metrics.unit.textContent = unit;
    dom.metrics.barSpeed.textContent = value;
    dom.metrics.barUnit.textContent = unit;
}

// Last-applied state: refreshMetrics runs at timeupdate rate, and the class
// toggle plus the t() lookup are wasted on every call that does not change it.
let shownFixState: FixState | null = null;

function applyFixState(fix: FixState): void {
    if (fix === shownFixState) return;
    shownFixState = fix;
    dom.metrics.readout.classList.toggle("is-nofix", fix !== "ok");
    dom.metrics.fixLabel.textContent =
        fix === "ok" ? t("readout.gps.ok") : fix === "lost" ? t("readout.gps.lost") : t("readout.gps.none");
}

/** Blanks every value. The unit labels stay correct: the user can still click
 *  to switch the preference with no record on screen, and the next record must
 *  come back in the unit they picked. */
function showPlaceholders(): void {
    const ph = t("player.metrics.placeholder");
    dom.metrics.coords.textContent = ph;
    dom.metrics.time.textContent = ph;
    dom.metrics.distance.textContent = ph;
    setSpeedText(ph, t(formatSpeedFromMs(0).unitKey));
    dom.metrics.distanceUnit.textContent = t(formatDistanceFromKm(0).unitKey);
}

let shownRecord: GpsRecord | null | undefined;
let shownUnixSeconds: number | undefined;
let shownActive: boolean | undefined;
let shownLat: number | undefined;
let shownLon: number | undefined;
let shownSpeedMs: number | undefined;
let shownSpeedSource: GpsRecord["speedSource"];
let shownCameraTzSec: number | null = null;
let shownDistanceKm: number | null = null;
let shownUnits: ReturnType<typeof getUnits> | null = null;
let shownLocale: string | null = null;

function refreshMetrics(
    rec: GpsRecord | null,
    cameraTzSec: number | null,
    distanceKm: number | null,
    fix: FixState = "none",
): void {
    const units = getUnits();
    const locale = getDateLocale();
    // The readout uses the nearest GPS sample, which often stays unchanged
    // across many timeupdates. Preserve its DOM and formatted strings until
    // a sample, distance, timezone or formatting preference changes. Metadata
    // enrichment can correct the same record in place, so retain its scalars.
    if (
        rec === shownRecord &&
        fix === shownFixState &&
        Object.is(rec?.unixSeconds, shownUnixSeconds) &&
        rec?.active === shownActive &&
        Object.is(rec?.lat, shownLat) &&
        Object.is(rec?.lon, shownLon) &&
        Object.is(rec?.speedMs, shownSpeedMs) &&
        rec?.speedSource === shownSpeedSource &&
        cameraTzSec === shownCameraTzSec &&
        distanceKm === shownDistanceKm &&
        units === shownUnits &&
        locale === shownLocale
    )
        return;
    shownRecord = rec;
    shownUnixSeconds = rec?.unixSeconds;
    shownActive = rec?.active;
    shownLat = rec?.lat;
    shownLon = rec?.lon;
    shownSpeedMs = rec?.speedMs;
    shownSpeedSource = rec?.speedSource;
    shownCameraTzSec = cameraTzSec;
    shownDistanceKm = distanceKm;
    shownUnits = units;
    if (locale !== shownLocale) shownFixState = null;
    shownLocale = locale;
    if (rec === null) {
        applyFixState("none");
        showPlaceholders();
        return;
    }
    // A lat/lon from a record whose fix was lost is a number, not a place -
    // treat it exactly like having nothing.
    if (fix !== "ok" || !isValidGpsFix(rec)) {
        applyFixState("lost");
        showPlaceholders();
        return;
    }
    applyFixState("ok");
    const speed = formatSpeedFromMs(rec.speedMs);
    setSpeedText(formatSpeedReading(rec, speed.value, 1), t(speed.unitKey), rec.speedSource === "estimated");
    // 4 decimal places = ~11m accuracy at mid-latitudes, enough for viewing.
    // Full 5-place accuracy is in tooltip popups.
    dom.metrics.coords.textContent = `${rec.lat.toFixed(4)}, ${rec.lon.toFixed(4)}`;
    // GPS time on the display clock (camera clock when known). Locale from
    // i18n so 24h/12h follows the UI language.
    dom.metrics.time.textContent = localTimeFormatter().format(displayClockDate(rec.unixSeconds, cameraTzSec));
    const distance = formatDistanceFromKm(distanceKm ?? 0);
    dom.metrics.distance.textContent = formatNumber(distance.value, 1);
    dom.metrics.distanceUnit.textContent = t(distance.unitKey);
    // Map marker updates via rAF-loop with GPS interpolation - it moves
    // smoothly without us setting position here.
}

// Last-written file name: the value changes once per clip, the caller asks at
// timeupdate rate.
let shownFileName: string | null = null;

/** Shows which clip the playhead sits in. Hidden until a trip is open - an
 *  empty button would still take its gap in the row. */
function refreshFileName(): void {
    const name = activeCandidate()?.file.name ?? null;
    if (name === shownFileName) return;
    shownFileName = name;
    dom.metrics.file.hidden = name === null;
    dom.metrics.file.textContent = name ?? "";
    if (name !== null) dom.metrics.file.title = name;
    else dom.metrics.file.removeAttribute("title");
}

/**
 * Re-runs the metrics pipeline at the player's current position. timeupdate,
 * langchange, unitschange share this - all want "show metrics for where the
 * player is right now, using current language and units". The tolerance check
 * matches interpolatePosition (parser.ts) so player numbers and map marker
 * hide together when the GPS window ends before the video.
 *
 * `tripCurrentSec` is trip-relative seconds (getTripCurrentTime). Passed in
 * so this module does not pull in the playback module.
 */
export function refreshMetricsFromActiveFrame(tripCurrentSec: number): void {
    // The clip name is not a GPS value - it stays current on trips with no
    // track at all, so it is resolved before any of the bail-outs below.
    refreshFileName();
    const af = activeFrame();
    if (!af || af.trip.records.length === 0) {
        refreshMetrics(null, null, null);
        // Clear on EVERY bail-out: state.active can go null outside playFrame
        // (a regroup that fails to relocate the active file), and a stale
        // marker would sit on the placeholder clock forever.
        markTimelapseClock(false);
        return;
    }
    // tripCurrentSec is footage-axis; map to wall-clock to find the GPS record.
    const targetUnix = contentToWallUtc(af.trip.timeline, tripCurrentSec);
    const metrics = resolvePlayerMetrics(af.trip.records, targetUnix);
    refreshMetrics(metrics.record, af.trip.cameraTzSec, metrics.distanceKm, metrics.fix);
    markTimelapseClock(metrics.fix === "ok" && currentClipIsTimelapse(af.trip, tripCurrentSec));
}

// Trips overwhelmingly contain no time-lapse clips; remember that per Trip so
// the per-timeupdate segment lookup below runs only on trips that need it.
// Trip objects are rebuilt on every regroup/refresh, so the map self-invalidates.
const tripHasTimelapse = new WeakMap<Trip, boolean>();

/** Whether the clip under the current footage position is a time-lapse. The
 *  frame's channels are all the same clip, so any one answers. */
function currentClipIsTimelapse(trip: Trip, tripCurrentSec: number): boolean {
    let has = tripHasTimelapse.get(trip);
    if (has === undefined) {
        has = trip.frames.some((f) => Object.values(f.channels).some((c) => c?.isTimelapse));
        tripHasTimelapse.set(trip, has);
    }
    if (!has) return false;
    const frame = trip.frames[contentToFrame(trip.timeline, tripCurrentSec).index];
    if (!frame) return false;
    return Object.values(frame.channels).some((c) => c?.isTimelapse);
}

// Last-applied flag: timeupdate calls this several times a second - skip the DOM writes
// and the t() lookup when nothing changed. No one else touches the class/title.
let timelapseClockShown = false;

/** Flags the metrics clock as time-lapse: its time runs at playback speed, not
 *  real elapsed time. Tooltip + a dotted-underline style (see player-bar.css). */
function markTimelapseClock(isTimelapse: boolean): void {
    if (isTimelapse === timelapseClockShown) return;
    timelapseClockShown = isTimelapse;
    dom.metrics.time.classList.toggle("is-timelapse", isTimelapse);
    if (isTimelapse) dom.metrics.time.title = t("trip.fileChip.timelapseHint");
    else dom.metrics.time.removeAttribute("title");
}

// Set by initPlayerMetrics. Reading the playhead through a getter keeps the
// playback module out of this one's import graph.
let readTripCurrentSec: (() => number) | null = null;

/**
 * Re-resolves every readout for a newly activated trip. Called on trip change
 * only - on a file change the values keep flowing from timeupdate.
 *
 * It re-resolves rather than blanking. The first timeupdate after activation
 * can be arbitrarily far off (a player that never starts never fires one), and
 * a blank row is not neutral: the fix state would sit on "no GPS data" over a
 * trip that carries a full track.
 */
export function resyncMetricsForTrip(): void {
    shownRecord = undefined;
    syncGpsSyncLaunchers();
    if (readTripCurrentSec === null) return;
    refreshMetricsFromActiveFrame(readTripCurrentSec());
}

/**
 * Copies `text` and flashes a confirmation on the element that was clicked.
 *
 * The Clipboard API needs a secure context: https and localhost have one, a
 * self-hosted copy served over plain http on a LAN address does not. There the
 * write rejects, so we select the text instead and let the user copy it with
 * the keyboard - the selection is its own feedback.
 */
async function copyFromElement(el: HTMLElement, text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
    }
    // The flash lives on the element, not in a toast: the confirmation belongs
    // where the click landed, and a toast for copying a number is a lot of
    // furniture for a very small event.
    el.classList.add("is-copied");
    el.dataset.copiedLabel = t("readout.copied");
    window.setTimeout(() => {
        el.classList.remove("is-copied");
        delete el.dataset.copiedLabel;
    }, COPIED_FLASH_MS);
}

const COPIED_FLASH_MS = 1200;

/**
 * Wires the readout row: the units toggle on both speed copies, click-to-copy
 * on the coordinates and the clip name, and the unit-change subscription. The
 * timeupdate-driven refresh stays in player.ts (it shares the listener with
 * progress UI updates). Language is fixed for the page lifetime, so there is no
 * lang-change subscription.
 */
export function initPlayerMetrics(getTripCurrentSec: () => number): void {
    readTripCurrentSec = getTripCurrentSec;
    syncGpsSyncLaunchers();
    for (const toggle of [dom.metrics.speedToggle, dom.metrics.barSpeedToggle]) {
        toggle.addEventListener("click", () => {
            toggleUnits();
        });
    }
    // Raw degrees next to a map are read for one reason - to paste them
    // somewhere else. Same for the clip name, which is what you need before
    // going looking for the file on the card.
    dom.metrics.coords.addEventListener("click", () => {
        const text = dom.metrics.coords.textContent;
        if (text) void copyFromElement(dom.metrics.coords, text);
    });
    dom.metrics.file.addEventListener("click", () => {
        const text = dom.metrics.file.textContent;
        if (text) void copyFromElement(dom.metrics.file, text);
    });
    subscribeUnitsChange(() => {
        refreshMetricsFromActiveFrame(getTripCurrentSec());
    });
}
