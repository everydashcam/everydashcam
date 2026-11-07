// Diagnostics collection for the feedback report. Merges the log ring buffer
// and a state snapshot into a payload, rendered as readable plain text (NOT
// JSON - the user opens the file, so it must not look like a scary data dump)
// and folded into the single report .txt the user emails (see ui/feedback.ts).
//
// What is included:
//  - NOT included: video content, GPS coordinates.
//  - Included: file basename (File.name), size, duration, codec, vendor,
//    canPlay/startSource flags, relativePath from the DnD session,
//    log ring buffer (may also contain file names, see log.ts),
//    state snapshot (trips/active/preferredChannel etc.).
//
// PII note: File.name and relativePath are user-controlled - if the user
// named a folder "Ivan_dashcam_2024" or a file "Anna_birthday.mp4", it
// appears verbatim. No automatic scrubbing: there is no reliable heuristic
// to detect a person's name in a basename. Instead the report is a plain-text
// file the user downloads and can open IN FULL before emailing it - nothing
// leaves the machine without that explicit send. The modal's "what's inside"
// preview shows a representative sample (env + folder layout), not the whole
// file, so the download is the real review point.

import { getLogBuffer } from "./log.js";
import { capabilitySignature, detectCapabilities } from "./capabilities.js";
import { collectGraphicsDiagnostics, type GraphicsDiagnostics } from "./graphics-diagnostics.js";
import { tripAllCandidates, type VideoCandidate } from "./trips.js";
import { mainChannel, state } from "./ui/state.js";
import { APP_VERSION } from "./version.js";

interface DiagFileEntry {
    name: string;
    sizeBytes: number;
    durationSec: number | null;
    codec: string | null;
    /** RFC 6381 string with profile and level, so a camera setting change
     *  (resolution, frame rate, HDR) shows up between two reports. */
    codecString: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    /** Stable camera key (camera-fingerprint.ts). Replaces the old vendorId. */
    fingerprint: string;
    /** Extractor ids that produced GPS records for this file. Empty if no GPS. */
    appliedExtractors: string[];
    /** Filename technique ids (from filename/index.ts) that recognised the filename. */
    classifierMatches: {
        time: string | null;
        channel: string | null;
        mode: string | null;
        sequence: string | null;
    };
    channel: string | null;
    startSource: string;
    hasStaleGps: boolean;
    hasUncalibratedClock: boolean;
    canPlay: boolean;
}

interface DiagTripEntry {
    startUtcSec: number;
    durationSec: number;
    framesCount: number;
    filesCount: number;
    totalBytes: number;
    distanceKm: number;
    eventsCount: number;
    gpsRecordsCount: number;
    fingerprints: string[];
    /** Union of extractor ids across all files in the trip. */
    appliedExtractors: string[];
}

interface DiagPayload {
    schemaVersion: 1;
    capturedAt: string;
    appVersion: string;
    edition: "portable" | "web";
    userAgent: string;
    languages: readonly string[];
    timezone: string;
    viewport: { w: number; h: number; dpr: number };
    onLine: boolean;
    hardwareConcurrency: number | null;
    deviceMemory: number | null;
    capabilities: string;
    graphics: GraphicsDiagnostics;
    storageQuota: number | null;
    storageUsage: number | null;
    state: {
        tripsCount: number;
        activeTripIndex: number | null;
        activeFrameIndex: number | null;
        preferredChannel: string;
        viewMode: string;
        followMode: string;
        chartZoomed: boolean;
        mapExpanded: boolean;
        sortKey: string;
        sortDir: string;
        ingestInProgress: boolean;
        unindexedCount: number;
        gpsRecordsCount: number;
    };
    files: DiagFileEntry[];
    trips: DiagTripEntry[];
    /** Last log entries from the ring buffer (see src/log.ts). */
    logTail: ReturnType<typeof getLogBuffer>;
}

/**
 * Collects a local snapshot, including a short-lived graphics probe.
 *
 * Synchronous by design: navigator.storage.estimate() could provide quota/usage
 * but is async. Callers that need it can call estimate() themselves and pass the
 * results via `extras`.
 */
export function collectDiagnostics(extras?: { storageQuota?: number; storageUsage?: number }): DiagPayload {
    const navAny = navigator as Navigator & { deviceMemory?: number };
    const trips: DiagTripEntry[] = state.trips.map((trip) => {
        const candidates = tripAllCandidates(trip);
        const fingerprintSet = new Set<string>();
        const extractorSet = new Set<string>();
        for (const c of candidates) {
            if (c.fingerprint) fingerprintSet.add(c.fingerprint);
            for (const eid of c.appliedExtractors) extractorSet.add(eid);
        }
        return {
            startUtcSec: trip.startUtc,
            durationSec: Math.round(trip.durationSec),
            framesCount: trip.frames.length,
            filesCount: candidates.length,
            totalBytes: trip.totalBytes,
            distanceKm: Number(trip.distanceKm.toFixed(2)),
            eventsCount: trip.events.length,
            gpsRecordsCount: trip.records.length,
            fingerprints: [...fingerprintSet],
            appliedExtractors: [...extractorSet],
        };
    });

    // Walk all candidates across all trips - names/sizes/durations, no content.
    // Use a WeakSet on File refs to avoid counting two channels of the same
    // frame as separate files.
    const fileEntries: DiagFileEntry[] = [];
    const seenFiles = new WeakSet<File>();
    for (const trip of state.trips) {
        for (const frame of trip.frames) {
            for (const [channel, cand] of Object.entries(frame.channels)) {
                if (!cand || seenFiles.has(cand.file)) continue;
                seenFiles.add(cand.file);
                fileEntries.push({
                    name: cand.file.name,
                    sizeBytes: cand.file.size,
                    durationSec: Number.isFinite(cand.durationSec) ? Math.round(cand.durationSec) : null,
                    codec: cand.codec ?? null,
                    codecString: cand.videoCodecString,
                    width: cand.width,
                    height: cand.height,
                    fps: cand.fps,
                    fingerprint: cand.fingerprint,
                    appliedExtractors: cand.appliedExtractors,
                    classifierMatches: cand.classifierMatches,
                    channel,
                    startSource: cand.startSource,
                    hasStaleGps: cand.hasStaleGps === true,
                    hasUncalibratedClock: cand.hasUncalibratedClock === true,
                    canPlay: cand.canPlay,
                });
            }
        }
    }

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const w = typeof window !== "undefined" ? window.innerWidth : 0;
    const h = typeof window !== "undefined" ? window.innerHeight : 0;

    return {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        edition: __PORTABLE__ ? "portable" : "web",
        userAgent: navigator.userAgent,
        languages: navigator.languages,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: { w, h, dpr },
        onLine: navigator.onLine,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemory: navAny.deviceMemory ?? null,
        capabilities: capabilitySignature(detectCapabilities()),
        graphics: collectGraphicsDiagnostics(),
        storageQuota: extras?.storageQuota ?? null,
        storageUsage: extras?.storageUsage ?? null,
        state: {
            tripsCount: state.trips.length,
            activeTripIndex: state.active?.trip ?? null,
            activeFrameIndex: state.active?.frame ?? null,
            preferredChannel: mainChannel(),
            viewMode: state.composition.mode,
            followMode: state.followMode,
            chartZoomed: state.chartZoomed,
            mapExpanded: state.mapExpanded,
            sortKey: state.tripSortKey,
            sortDir: state.tripSortDir,
            ingestInProgress: state.ingestController !== null,
            unindexedCount: state.unindexed.size,
            gpsRecordsCount: state.gpsLog?.records.length ?? 0,
        },
        files: fileEntries,
        trips,
        // Full ring buffer (~500 entries by default). This is our primary
        // diagnostic channel - click timestamps, ingest stage transitions,
        // errors. Without it, 80% of bug reports are unactionable.
        logTail: getLogBuffer(),
    };
}

/** One log record, without needing LogRecord exported from log.ts. */
type LogRec = ReturnType<typeof getLogBuffer>[number];

/** Formats a single log record as one readable line (no JSON blob). */
function formatLogLine(e: LogRec): string {
    // HH:MM:SS.mmm from the wall clock; nsec is scope-relative and not useful here.
    const time = new Date(e.ts).toISOString().slice(11, 23);
    const scope = e.scope === "worker" ? "W" : "M";
    let line = `${time} ${e.level.toUpperCase().padEnd(5)} ${scope} [${e.ns}] ${e.msg}`;
    if (e.ctx && Object.keys(e.ctx).length > 0) {
        const kv = Object.entries(e.ctx)
            .map(([k, v]) => `${k}=${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join(" ");
        line += ` · ${kv}`;
    }
    if (e.err) {
        line += `\n    ! ${e.err.name}: ${e.err.message}`;
        // First few stack frames are enough to locate the throw; the full trace
        // bloats the report and rarely adds signal past the top frames.
        if (e.err.stack) line += `\n    ${e.err.stack.split("\n").slice(0, 4).join("\n    ")}`;
    }
    return line;
}

/**
 * Renders the diagnostics payload as a readable plain-text report - the body of
 * the single .txt the user emails. Deliberately NOT JSON: the user opens the
 * file, and a data dump reads as scary and unreviewable.
 */
export function serializeDiagnosticsText(p: DiagPayload): string {
    const out: string[] = [];
    const push = (s = "") => out.push(s);

    push("== environment ==");
    push(`everydashcam: ${p.appVersion} (${p.edition})`);
    push(`browser: ${p.userAgent}`);
    push(`languages: ${p.languages.join(", ")}`);
    push(`timezone: ${p.timezone}`);
    push(`viewport: ${p.viewport.w}x${p.viewport.h} @${p.viewport.dpr}x`);
    push(`online: ${p.onLine}`);
    if (p.hardwareConcurrency != null) push(`cpu threads: ${p.hardwareConcurrency}`);
    if (p.deviceMemory != null) push(`device memory: ${p.deviceMemory} GB`);
    push(`startup capabilities: ${p.capabilities}`);
    if (p.storageQuota != null || p.storageUsage != null) {
        push(`storage: ${p.storageUsage ?? "?"} / ${p.storageQuota ?? "?"} bytes`);
    }
    push(`captured: ${p.capturedAt}`);
    push();

    const g = p.graphics;
    push("== graphics ==");
    push(`context: ${g.context}`);
    push(`vendor: ${g.vendor ?? "unavailable"}`);
    push(`renderer: ${g.renderer ?? "unavailable"}`);
    push(`unmasked vendor: ${g.unmaskedVendor ?? "unavailable"}`);
    push(`unmasked renderer: ${g.unmaskedRenderer ?? "unavailable"}`);
    if (g.error) push(`probe error: ${g.error}`);
    push("The WebGL renderer does not identify the video encoder.");
    push("Video encoder implementation and driver: not exposed by WebCodecs.");
    push();

    const s = p.state;
    push("== app state ==");
    push(`trips: ${s.tripsCount}`);
    push(`active: trip ${s.activeTripIndex ?? "-"} / frame ${s.activeFrameIndex ?? "-"}`);
    push(`preferred camera: ${s.preferredChannel}`);
    push(`view: ${s.viewMode} · follow: ${s.followMode}`);
    push(`chart zoomed: ${s.chartZoomed} · map expanded: ${s.mapExpanded}`);
    push(`sort: ${s.sortKey} ${s.sortDir}`);
    push(`ingest in progress: ${s.ingestInProgress} · unindexed: ${s.unindexedCount}`);
    push(`gps records: ${s.gpsRecordsCount}`);
    push();

    push(`== files (${p.files.length}) ==`);
    for (const f of p.files) {
        const dur = f.durationSec != null ? `${f.durationSec}s` : "?";
        const cm = f.classifierMatches;
        const nameMatch = `time=${cm.time ?? "-"} cam=${cm.channel ?? "-"} mode=${cm.mode ?? "-"} seq=${cm.sequence ?? "-"}`;
        const gps = f.appliedExtractors.length > 0 ? f.appliedExtractors.join("+") : "none";
        push(
            `${f.name} · ${f.sizeBytes} B · ${dur} · ${formatVideoTrack(f)} · fp=${f.fingerprint} · cam=${f.channel ?? "-"} · start=${f.startSource} · play=${f.canPlay} · gps=${gps}${f.hasStaleGps ? " · gps-clock=repeated" : ""}${f.hasUncalibratedClock ? " · clock=uncalibrated" : ""} · name[${nameMatch}]`,
        );
    }
    push();

    push(`== trips (${p.trips.length}) ==`);
    p.trips.forEach((t, i) => {
        push(
            `#${i}: start=${t.startUtcSec} dur=${t.durationSec}s frames=${t.framesCount} files=${t.filesCount} ${t.totalBytes}B dist=${t.distanceKm}km events=${t.eventsCount} gps=${t.gpsRecordsCount} fp=[${t.fingerprints.join(",")}] gpsFrom=[${t.appliedExtractors.join(",")}]`,
        );
    });
    push();

    push(`== recent log (${p.logTail.length}) ==`);
    for (const e of p.logTail) push(formatLogLine(e));

    return out.join("\n");
}

/** Codec, codec string, size and frame rate, e.g. "hevc hev1.2.4.L153 3840x2160@30". */
export function formatVideoTrack(f: Pick<DiagFileEntry, "codec" | "codecString" | "width" | "height" | "fps">): string {
    let text = f.codec ?? "?";
    if (f.codecString) text += ` ${f.codecString}`;
    if (f.width && f.height) text += ` ${f.width}x${f.height}`;
    if (f.fps) text += `@${Number(f.fps.toFixed(2))}`;
    return text;
}

/** What the browser says about decoding the open recording at report time. */
export interface PlaybackProbe {
    file: string;
    codecString: string;
    canPlayType: string;
    mediaSource: string;
    webCodecs: string;
    mediaCapabilities: string;
}

// A probe that never settles must not hold the report back.
const PROBE_TIMEOUT_MS = 3000;

/** Resolves to the probe's text, or a reason when the API is missing, throws or stalls. */
async function settleProbe(run: () => Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([run(), timeout]);
    } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Asks every browser decode API about the open recording's exact codec. Two
 * reports from the same user then show whether the browser itself changed its
 * answer, which no state snapshot reveals. The codec string keeps the file's
 * sample entry (hvc1 vs hev1), as the native player sees it. Returns null when
 * the recording has no full codec string (AVC MP4, undetermined codec).
 */
export async function probePlayback(cand: VideoCandidate): Promise<PlaybackProbe | null> {
    const full = cand.videoCodecString;
    if (!full) return null;
    const dot = full.indexOf(".");
    const codecString = cand.codecParam && dot > 0 ? `${cand.codecParam}${full.slice(dot)}` : full;
    const contentType = `video/mp4; codecs="${codecString}"`;

    let canPlayType = "unavailable";
    if (typeof document !== "undefined") {
        const verdict = document.createElement("video").canPlayType(contentType);
        canPlayType = verdict === "" ? "no" : verdict;
    }
    let mediaSource = "unavailable";
    if (typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function") {
        mediaSource = MediaSource.isTypeSupported(contentType) ? "yes" : "no";
    }

    const width = cand.width ?? 0;
    const height = cand.height ?? 0;
    const webCodecs = await settleProbe(async () => {
        if (typeof VideoDecoder === "undefined") return "unavailable";
        const config: VideoDecoderConfig =
            width && height ? { codec: codecString, codedWidth: width, codedHeight: height } : { codec: codecString };
        const result = await VideoDecoder.isConfigSupported(config);
        return result.supported ? "supported" : "unsupported";
    });
    const mediaCapabilities = await settleProbe(async () => {
        if (typeof navigator === "undefined" || !navigator.mediaCapabilities) return "unavailable";
        if (!width || !height) return "skipped: no frame size";
        const bitrate = cand.durationSec > 0 ? Math.round((cand.file.size * 8) / cand.durationSec) : 10_000_000;
        const info = await navigator.mediaCapabilities.decodingInfo({
            type: "file",
            video: { contentType, width, height, bitrate, framerate: cand.fps ?? 30 },
        });
        if (!info.supported) return "unsupported";
        return [
            "supported",
            info.smooth ? "smooth" : "not smooth",
            info.powerEfficient ? "power efficient" : "not power efficient",
        ].join(", ");
    });
    return { file: cand.file.name, codecString, canPlayType, mediaSource, webCodecs, mediaCapabilities };
}

/** Renders a probe as a report section. "pending" marks a report saved before the probe settled. */
export function serializePlaybackProbe(probe: PlaybackProbe | "pending"): string {
    const lines = ["== playback probe =="];
    if (probe === "pending") {
        lines.push("still running when the report was saved");
        return lines.join("\n");
    }
    lines.push(`file: ${probe.file}`);
    lines.push(`codec string: ${probe.codecString}`);
    lines.push(`video element canPlayType: ${probe.canPlayType}`);
    lines.push(`MediaSource.isTypeSupported: ${probe.mediaSource}`);
    lines.push(`WebCodecs isConfigSupported: ${probe.webCodecs}`);
    lines.push(`mediaCapabilities.decodingInfo: ${probe.mediaCapabilities}`);
    return lines.join("\n");
}

/** UTC timestamp slug `YYYY-MM-DD-HHMM` for downloadable artifact filenames
 *  (the report .txt name; see ui/feedback.ts reportFilename). */
export function utcTimestampSlug(ts: Date = new Date()): string {
    const z = (n: number) => String(n).padStart(2, "0");
    return `${ts.getUTCFullYear()}-${z(ts.getUTCMonth() + 1)}-${z(ts.getUTCDate())}-${z(ts.getUTCHours())}${z(ts.getUTCMinutes())}`;
}
