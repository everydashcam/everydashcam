// Pure UI formatters - time/distance/channel/event strings, export clip name, sort comparators.
// Depends only on i18n and domain types. No DOM, no state.

import type { EventKind, TripEvent } from "../events.js";
import { getDateLocale, t } from "../i18n/index.js";
import { totalDistanceKm } from "../parser.js";
import type { Channel, RecordingMode } from "../parsers/types.js";
import {
    displayClockDate,
    tripAllCandidates,
    tripChannels,
    contentToWallUtc,
    type Trip,
    type VideoCandidate,
} from "../trips.js";
import { formatDistanceFromKm } from "../units-pref.js";

import type { TripSortKey } from "./state.js";

/** True when both display-clock dates (displayClockDate) fall on the same calendar day. */
function isSameDisplayDay(a: Date, b: Date): boolean {
    return (
        a.getUTCFullYear() === b.getUTCFullYear() &&
        a.getUTCMonth() === b.getUTCMonth() &&
        a.getUTCDate() === b.getUTCDate()
    );
}

/**
 * Trip title on the display clock - the camera's own clock when the
 * per-fingerprint estimate exists, browser-local otherwise (displayClockDate).
 * "Apr 29, 18:26 → 18:42" for same-day trips, "Apr 29 18:26 → Apr 30 02:15" for overnight.
 * Year is shown only when the trip year differs from the current year.
 *
 * `now` defaults to the wall clock; injectable so the "hide the current year"
 * branch is deterministically testable (and mockable) without freezing time.
 */
export function formatTripTitle(trip: Trip, now: Date = new Date()): string {
    const { start, end, dateFmt, timeFmt } = tripTitleClock(trip, now);
    if (isSameDisplayDay(start, end)) {
        return `${dateFmt.format(start)}, ${timeFmt.format(start)} → ${timeFmt.format(end)}`;
    }
    return `${dateFmt.format(start)} ${timeFmt.format(start)} → ${dateFmt.format(end)} ${timeFmt.format(end)}`;
}

/** Formats only the known start while the trip's end is still being read. */
export function formatTripStartTitle(trip: Trip, now: Date = new Date()): string {
    const { start, dateFmt, timeFmt } = tripTitleClock(trip, now);
    return `${dateFmt.format(start)}, ${timeFmt.format(start)}`;
}

function tripTitleClock(
    trip: Trip,
    now: Date,
): {
    start: Date;
    end: Date;
    dateFmt: Intl.DateTimeFormat;
    timeFmt: Intl.DateTimeFormat;
} {
    const start = displayClockDate(trip.startUtc, trip.cameraTzSec);
    const end = displayClockDate(trip.endUtc, trip.cameraTzSec);
    // hour12:false forces 24-hour format regardless of system locale (en-US otherwise gives "04:43 PM").
    // Explicit locale from i18n (ru-RU or en-US) keeps date language in sync with UI language.
    const locale = getDateLocale();
    // `now` is the viewer's clock - project it the same way (browser zone) so
    // the year comparison happens between display-clock values.
    const currentYear = displayClockDate(now.getTime() / 1000, null).getUTCFullYear();
    // Show year if EITHER edge is in a different year - covers the rare Dec 31 crossing: both edges show the year for consistency.
    const includeYear = start.getUTCFullYear() !== currentYear || end.getUTCFullYear() !== currentYear;
    // timeZone:"UTC" everywhere a displayClockDate is formatted - the shift is
    // already inside the Date (see the displayClockDate contract).
    const { dateFmt, timeFmt } = tripTitleFormatters(locale, includeYear);
    return { start, end, dateFmt, timeFmt };
}

// Intl.DateTimeFormat construction resolves locale data and compiles a
// pattern; the sidebar builds two per card on every full render, which on a
// long list is the single most expensive part of the rebuild. The pair only
// varies by locale and year visibility, so it is memoized on that key.
const tripTitleFormatterCache = new Map<string, { dateFmt: Intl.DateTimeFormat; timeFmt: Intl.DateTimeFormat }>();

function tripTitleFormatters(
    locale: string,
    includeYear: boolean,
): { dateFmt: Intl.DateTimeFormat; timeFmt: Intl.DateTimeFormat } {
    const key = `${locale}|${includeYear ? "y" : "n"}`;
    const cached = tripTitleFormatterCache.get(key);
    if (cached) return cached;
    const dateOpts: Intl.DateTimeFormatOptions = includeYear
        ? { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }
        : { day: "numeric", month: "short", timeZone: "UTC" };
    const formatters = {
        dateFmt: new Intl.DateTimeFormat(locale, dateOpts),
        timeFmt: new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "UTC",
        }),
    };
    tripTitleFormatterCache.set(key, formatters);
    return formatters;
}

/**
 * Maps a trip's startUtc to a date bucket label for the sidebar separator.
 * The trip's calendar day is taken on the display clock (camera clock when
 * known); "how long ago" compares against the viewer's own calendar day -
 * that is what "today"/"yesterday" mean to the person looking at the screen.
 * `now` is injectable so bucket boundaries are deterministically testable.
 *
 * "Future" keys on the INSTANT, not on the calendar difference: a camera set
 * far enough east of the viewer puts a clip recorded hours ago on tomorrow's
 * camera-clock date, and that is a zone gap, not the clock skew the bucket
 * warns about.
 */
export function dateBucketLabel(unixTs: number, cameraTzSec: number | null, now: Date = new Date()): string {
    if (unixTs > now.getTime() / 1000) return t("buckets.future");
    const d = displayClockDate(unixTs, cameraTzSec);
    const n = displayClockDate(now.getTime() / 1000, null);
    const ds = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const ns = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    const dayDiff = Math.round((ns - ds) / 86400000);
    if (dayDiff <= 0) return t("buckets.today");
    if (dayDiff === 1) return t("buckets.yesterday");
    if (dayDiff < 7) return t("buckets.thisWeek");
    if (dayDiff < 30) return t("buckets.thisMonth");
    return t("buckets.earlier");
}

/** Which recording fact is still being resolved for a trip card. */
export type TripLoadingState = "loaded" | "recordings-pending" | "recordings-inflight" | "gps-pending" | "gps-inflight";

export function formatTripMeta(trip: Trip, loading: TripLoadingState = "loaded"): string {
    // Footage duration (recording pauses removed) - the wall-clock span would
    // inflate a parking-stitched trip's apparent length. Pauses are surfaced
    // separately below so a stitched trip is recognizable.
    const dur = formatDuration(trip.timeline.contentDurationSec);
    const sizePart = formatBytes(trip.totalBytes);
    if (loading === "recordings-pending" || loading === "recordings-inflight") {
        const sourceFilesPart = t("plurals.file", { n: tripAllCandidates(trip).length });
        return `${sourceFilesPart} · ${sizePart}`;
    }

    let distStr = "";
    if (loading === "loaded") {
        if (trip.distanceKm > 0) {
            distStr = ` · ${formatTripDistance(trip.distanceKm)}`;
        }
    } else if (loading === "gps-pending") {
        distStr = ` · ${t("gpsLoad.pending")}`;
    } else {
        distStr = ` · ${t("gpsLoad.reading")}`;
    }
    // A stitched trip (recording paused below the gap threshold) shows its pause
    // count so the user knows the footage is not one continuous run.
    const pausesPart =
        trip.timeline.gaps.length > 0 ? ` · ${t("plurals.pause", { n: trip.timeline.gaps.length })}` : "";
    const filesPart = t("plurals.file", { n: tripAllCandidates(trip).length });
    const camerasPart = t("plurals.camera", { n: tripChannels(trip).length });
    return `${dur} · ${filesPart} · ${camerasPart}${pausesPart}\n${sizePart}${distStr}`;
}

export function formatFileMeta(video: VideoCandidate, tripStartUtc: number, gpsPending = false): string {
    const sizeMb = formatNumber(video.file.size / (1024 * 1024), 1);
    if (video.metadataFailed === true) {
        return `${t("trip.chip.readFailed")} · ${sizeMb} ${t("units.mb")}`;
    }
    if (video.metadataReady === false) {
        return `${sizeMb} ${t("units.mb")}`;
    }
    const offsetSec = Math.max(0, video.startUtc - tripStartUtc);
    const offsetStr = formatTime(offsetSec); // mm:ss or h:mm:ss - same format as the player scrubber
    const dur = formatDuration(video.durationSec);
    const distKm = totalDistanceKm(video.records);
    let distStr = "";
    if (distKm > 0) {
        const d = formatDistanceFromKm(distKm);
        distStr = ` · ${formatNumber(d.value, 1)} ${t(d.unitKey)}`;
    }
    // "GPS: N" is not useful - omit. Explicitly signal when there are no records at all (video without a track).
    const noGps = video.records.length === 0 && !gpsPending ? t("trip.fileMeta.noGps") : "";
    return `+${offsetStr} · ${dur} · ${sizeMb} ${t("units.mb")}${distStr}${noGps}`;
}

/** Localized full channel name ("Задняя камера" / "Rear camera") for tooltips and selectors. */
export function channelLabel(ch: Channel): string {
    switch (ch) {
        case "front":
            return t("channel.front");
        case "rear":
            return t("channel.rear");
        case "interior":
            return t("channel.interior");
        case "side":
            return t("channel.side");
    }
}

/**
 * Localized label for a sidebar file-row chip on a clip whose recording mode
 * isn't the default loop recording ("normal" is the default and gets no chip -
 * see the call site in sidebar.ts).
 */
export function recordingModeLabel(mode: Exclude<RecordingMode, "normal">): string {
    switch (mode) {
        case "event":
            return t("trip.fileChip.mode.event");
        case "parking":
            return t("trip.fileChip.mode.parking");
        case "manual":
            return t("trip.fileChip.mode.manual");
    }
}

/** Short single-character channel badge ("З" / "R") for sidebar clip name chips where full labels don't fit. */
export function channelShortLabel(ch: Channel): string {
    switch (ch) {
        case "front":
            return t("channel.front.short");
        case "rear":
            return t("channel.rear.short");
        case "interior":
            return t("channel.interior.short");
        case "side":
            return t("channel.side.short");
    }
}

/** 1-based position of a channel within a trip's channels, in canonical order. Used to number un-trusted channels. */
function channelNumber(ch: Channel, trip: Trip): number {
    const idx = tripChannels(trip).indexOf(ch);
    return idx >= 0 ? idx + 1 : 1;
}

/**
 * Channel label as shown to the user. When the trip trusts this channel's mount
 * (see Trip.confidentChannels) it returns the semantic name ("Rear camera");
 * otherwise the mount was guessed from an index letter and we show a positional
 * "Channel N" so we never assert a mount we can't verify.
 */
export function channelDisplayLabel(ch: Channel, trip: Trip): string {
    if (trip.confidentChannels.has(ch)) return channelLabel(ch);
    return t("channel.numbered", { n: channelNumber(ch, trip) });
}

/** Short channel badge for sidebar chips: mnemonic letter ("R") when trusted, channel number otherwise. */
export function channelDisplayShortLabel(ch: Channel, trip: Trip): string {
    if (trip.confidentChannels.has(ch)) return channelShortLabel(ch);
    return String(channelNumber(ch, trip));
}

export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "?";
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    // Units are localized via t() (RU "ч"/"м"/"с", EN "h"/"min"/"s").
    if (h > 0) return `${h}${t("units.h")} ${m}${t("units.m")}`;
    if (m > 0) return `${m}${t("units.m")} ${s}${t("units.s")}`;
    return `${s}${t("units.s")}`;
}

/**
 * mm:ss or h:mm:ss depending on duration. padMinutes forces two-digit minutes
 * even below an hour (mm:ss for export progress timecodes vs m:ss for the
 * player scrubber).
 */
export function formatTime(seconds: number, padMinutes = false): string {
    if (!Number.isFinite(seconds) || seconds < 0) return padMinutes ? "00:00" : "0:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number): string => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${padMinutes ? pad(m) : m}:${pad(s)}`;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

/** UI numbers use the page locale. Fixed precision by default; pass a lower
 * minimum to omit insignificant trailing zeros. Never use for inputs or CSS. */
export function formatNumber(
    value: number,
    maximumFractionDigits = 0,
    minimumFractionDigits = maximumFractionDigits,
): string {
    const key = `${minimumFractionDigits}:${maximumFractionDigits}`;
    let formatter = numberFormatters.get(key);
    if (!formatter) {
        formatter = new Intl.NumberFormat(getDateLocale(), { minimumFractionDigits, maximumFractionDigits });
        numberFormatters.set(key, formatter);
    }
    return formatter.format(value);
}

/** Keeps short routes distinct from a stationary recording. */
export function formatTripDistance(km: number): string {
    const { value, unitKey } = formatDistanceFromKm(km);
    const rounded = formatNumber(value, value < 10 ? 1 : 0, 0);
    const distance = value > 0 && value < 0.1 ? `<${formatNumber(0.1, 1)}` : rounded;
    return `${distance} ${t(unitKey)}`;
}

/** Human-readable file size: bytes → KB/MB/GB via localized unit keys. */
export function formatBytes(b: number): string {
    if (b < 1024 * 1024) return `${formatNumber(b / 1024)} ${t("units.kb")}`;
    if (b < 1024 * 1024 * 1024) return `${formatNumber(b / 1024 / 1024)} ${t("units.mb")}`;
    return `${formatNumber(b / 1024 / 1024 / 1024, 2)} ${t("units.gb")}`;
}

/**
 * Same scale as formatBytes but one decimal in the MB band, for a per-second
 * data rate. Whole megabytes are too coarse here: the quality tiers and the
 * source reference sit next to each other and differ by tens of percent, which
 * rounding to "2 MB" vs "2 MB" erases exactly where the reader is comparing.
 * The caller appends the "/s".
 */
export function formatRateBytes(bytesPerSecond: number): string {
    if (bytesPerSecond < 1024 * 1024) return `${formatNumber(bytesPerSecond / 1024)} ${t("units.kb")}`;
    if (bytesPerSecond < 1024 * 1024 * 1024) {
        return `${formatNumber(bytesPerSecond / 1024 / 1024, 1)} ${t("units.mb")}`;
    }
    return `${formatNumber(bytesPerSecond / 1024 / 1024 / 1024, 2)} ${t("units.gb")}`;
}

/**
 * Base filename for the exported clip.
 *
 * Format:
 *   - same calendar day (typical): everydashcam_YYYYMMDD_HHMMSS-HHMMSS
 *   - clip crossing midnight:       everydashcam_YYYYMMDD_HHMMSS-YYYYMMDD_HHMMSS
 *
 * Date/time on the display clock (camera clock when known - matches the trip
 * header the user sees). Single source of truth for both the FSA picker
 * suggestedName and the export done summary.
 */
export function clipBasename(trip: Trip, startTripSec: number, endTripSec: number): string {
    // start/end are footage-axis seconds; map to wall-clock for the filename's
    // real timestamps (so a clip across a pause shows its true end time).
    const start = displayClockDate(contentToWallUtc(trip.timeline, startTripSec), trip.cameraTzSec);
    const end = displayClockDate(contentToWallUtc(trip.timeline, endTripSec), trip.cameraTzSec);
    const sameDay = isSameDisplayDay(start, end);
    const startStr = formatClockForFilename(start, true);
    const endStr = formatClockForFilename(end, !sameDay);
    return `everydashcam_${startStr}-${endStr}`;
}

/**
 * Random 4-character suffix [A-Za-z0-9] appended to export filenames.
 * Prevents a second export of the same range from suggesting the same name as an already-saved file
 * (FSA Replace on an open writable gives "TypeError: network error" and silently overwrites the previous clip).
 * 62^4 ≈ 14.7 M combinations - collision probability is negligible within one session.
 */
const FILENAME_SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function randomFilenameSuffix(length = 4): string {
    const alphabet = FILENAME_SUFFIX_ALPHABET;
    const n = alphabet.length;
    // 256 = 4 * 62 + 8: bytes 0..247 are uniformly distributable across 62
    // buckets, bytes 248..255 are dropped to avoid modulo bias.
    const maxAcceptable = Math.floor(256 / n) * n;
    let out = "";
    const buf = new Uint8Array(length * 2);
    while (out.length < length) {
        crypto.getRandomValues(buf);
        for (let i = 0; i < buf.length && out.length < length; i++) {
            const b = buf[i]!;
            if (b < maxAcceptable) out += alphabet[b % n];
        }
    }
    return out;
}

/** Timestamp for a filename: YYYYMMDD_HHMMSS when withDate=true, HHMMSS otherwise
 *  (for same-day end timestamps). `d` is a displayClockDate - UTC fields carry
 *  the display clock. */
function formatClockForFilename(d: Date, withDate: boolean): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    if (!withDate) return time;
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${time}`;
}

// Labels are re-localized on each call (cheap, one Map lookup) to stay in sync with the current language.
export function eventLabel(_kind: EventKind): string {
    return t("event.brake.label");
}

/** Formats brake-event severity for a tooltip ("0.42 g"). */
export function formatEventSeverity(ev: TripEvent): string {
    return `${formatNumber(ev.severity, 2)} g`;
}

/** Returns a comparator for the given sort key. Distance, duration, and size are pre-computed by finalizeTrip, so comparison is O(1). */
export function comparatorFor(key: TripSortKey): (a: Trip, b: Trip) => number {
    switch (key) {
        case "distance":
            return (a, b) => a.distanceKm - b.distanceKm;
        case "duration":
            return (a, b) => a.durationSec - b.durationSec;
        case "size":
            return (a, b) => a.totalBytes - b.totalBytes;
        default:
            return (a, b) => a.startUtc - b.startUtc;
    }
}
