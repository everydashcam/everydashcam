import { nearestIndexBy } from "../sorted-search.js";
// Dependency-light subset of registry.ts, safe to import from EAGER main-thread
// modules (ingest plumbing, progressive recording reads). registry.ts itself imports every
// primitive and internal extractor (~90 KB min), so a value import of it from
// the eager UI drags that whole graph into the landing entry chunk; the heavy
// dispatchers stay there and load with the ingest/GPS workers. Guarded by
// vite-plugins/lazy-boundaries.ts.

import { accelMagnitude } from "../parser.js";
import type { AccelSample, GpsRecord, VendorFile } from "./types.js";
import { parseOpenpilotFileName } from "./filename/_patterns.js";

// Video extensions - fast cutoff for role classification.
export const RX_VIDEO_EXT = /\.(mp4|mov|ts|m2ts|mkv)$/i;

/**
 * Whether a file is a recording. Container extensions decide alone; raw HEVC
 * elementary streams count only under the openpilot route layout, the one
 * source of containerless video we can time (its qlog dates every frame).
 * Any other `.hevc` stays unknown.
 */
export function isVideoFile(vf: VendorFile): boolean {
    if (RX_VIDEO_EXT.test(vf.file.name)) return true;
    const stream = parseOpenpilotFileName(vf)?.stream;
    return stream === "fcamera" || stream === "ecamera" || stream === "dcamera";
}

/**
 * openpilot records the road view twice per segment: fcamera.hevc at full
 * resolution and qcamera.ts as a 526x330 preview. Showing both would put two
 * files in one channel slot, so a segment keeps one. A view already loaded
 * stays, and every road view of its segment in the drop is left out; a
 * segment new to the session that brings both keeps the full-res file when
 * this browser can play raw HEVC (comma connect uploads the preview by default
 * and the full-res file only on request), the preview when it cannot. The
 * route name embeds a random id, so route and segment identify the recording
 * wherever its files sit. Returns the files to leave out.
 */
function supersededOpenpilotRoadViews(
    files: readonly VendorFile[],
    loadedVideos: readonly VendorFile[],
    rawHevcPlayable: boolean,
): Set<VendorFile> {
    const loadedSegments = new Set(loadedVideos.map(openpilotRoadViewSegment).filter((key) => key !== null));
    // Arrays: repeated downloads add copies of either view.
    const fullRes = new Map<string, VendorFile[]>();
    const previews = new Map<string, VendorFile[]>();
    const superseded = new Set<VendorFile>();
    for (const vf of files) {
        const key = openpilotRoadViewSegment(vf);
        if (key === null) continue;
        if (loadedSegments.has(key)) {
            superseded.add(vf);
            continue;
        }
        const views = parseOpenpilotFileName(vf)!.stream === "fcamera" ? fullRes : previews;
        views.set(key, [...(views.get(key) ?? []), vf]);
    }
    for (const [key, segmentPreviews] of previews) {
        const segmentFullRes = fullRes.get(key);
        if (!segmentFullRes) continue;
        for (const vf of rawHevcPlayable ? segmentPreviews : segmentFullRes) superseded.add(vf);
    }
    return superseded;
}

/** Segment of an openpilot road view (fcamera or qcamera), or null for any other file. */
function openpilotRoadViewSegment(vf: VendorFile): string | null {
    const name = parseOpenpilotFileName(vf);
    return name && (name.stream === "fcamera" || name.stream === "qcamera") ? `${name.route}--${name.segment}` : null;
}

/** What the session already holds, for classifying a new drop against it. */
export interface VideoSplitContext {
    /** Names of loaded videos and their copies; sidecar matching needs the full set. */
    existingVideoNames?: Iterable<string>;
    /** Loaded videos; an openpilot segment keeps the road view it already has. */
    loadedVideos?: readonly VendorFile[];
    /** Whether MSE plays raw HEVC; picks a new openpilot segment's road view. Defaults to true. */
    rawHevcPlayable?: boolean;
}

export interface ClassifiedFile {
    file: VendorFile;
    role: "video" | "gps-log" | "sidecar" | "accel-sidecar" | "unknown";
    // Sidecar handler id (sidecar/accel-sidecar role). null otherwise.
    sidecarId: string | null;
    sidecarMp4: string | null;
    // log-sidecar extractor id (for gps-log role). null otherwise.
    logExtractorId: string | null;
}

/**
 * Separates files into video entries (decided cheaply by extension) and the
 * rest. Both the main-thread classifier and the worker-pool classifier in
 * src/ui/ingest-shim.ts start here, then diverge on how they classify the
 * non-video remainder. knownVideos is seeded with existingVideoNames plus the
 * just-found videos because sidecar matching needs the full set.
 */
export function splitVideosByExtension(
    files: VendorFile[],
    context: VideoSplitContext = {},
): { videoEntries: ClassifiedFile[]; knownVideos: Set<string>; nonVideo: VendorFile[] } {
    const videoEntries: ClassifiedFile[] = [];
    const knownVideos = new Set<string>(context.existingVideoNames ?? []);
    const nonVideo: VendorFile[] = [];
    const superseded = supersededOpenpilotRoadViews(files, context.loadedVideos ?? [], context.rawHevcPlayable ?? true);
    for (const vf of files) {
        if (isVideoFile(vf) && !superseded.has(vf)) {
            videoEntries.push({
                file: vf,
                role: "video",
                sidecarId: null,
                sidecarMp4: null,
                logExtractorId: null,
            });
            knownVideos.add(vf.file.name);
        } else {
            nonVideo.push(vf);
        }
    }
    return { videoEntries, knownVideos, nonVideo };
}

// Half-window for the mergeAccelSamples pick: keep the +-0.5 s outer bound the
// nearest-sample version used, now as a scan window rather than a reject gate.
const WINDOW_SEC = 0.5;

/**
 * Combines the two places accel can come from - a paired sidecar file and the
 * video container itself - into the single file-identity map mergeAccelSamples
 * consumes.
 *
 * A sidecar wins a collision. It is the path validated against a real
 * recording, and a camera that writes a separate accel file is writing it as
 * the primary record rather than as a duplicate of an in-container stream;
 * silently preferring the embedded copy would change which bytes feed impact
 * detection with nothing to justify the switch.
 */
export function combineAccelSources(
    sidecarAccelByMp4: Map<string, AccelSample[]>,
    embeddedAccelByMp4: Map<string, AccelSample[]>,
): Map<string, AccelSample[]> {
    if (embeddedAccelByMp4.size === 0) return sidecarAccelByMp4;
    const combined = new Map(embeddedAccelByMp4);
    for (const [mp4Name, samples] of sidecarAccelByMp4) combined.set(mp4Name, samples);
    return combined;
}

/**
 * Merges accel samples into existing GpsRecords in-place. For each record we
 * scan every AccelSample whose absolute time (videoStartUtc + msSinceStart/1000)
 * falls within +-0.5 s of the record and attach the one with the largest
 * gravity-removed magnitude; if none is within 0.5 s the record is left
 * untouched. Returns the count of mutated records.
 *
 * Windowed max-|G|, not nearest-sample: a dense IMU (BlackVue .3gf ~10 Hz) runs
 * far faster than 1 Hz GPS, and a hard brake/impact lasts ~100-300 ms and almost
 * never peaks on a GPS second - the nearest sample is a low shoulder value, so
 * picking it silently drops the peak and no brake marker fires. The gravity
 * offset is subtracted BEFORE comparing magnitudes: raw values are dominated by
 * the ~1 g gravity vector, which would otherwise mask the dynamic component.
 */
export function mergeAccelSamples(
    records: GpsRecord[],
    accelByFileKey: Map<string, AccelSample[]>,
    videoStartUtcByFileKey: Map<string, number>,
): number {
    if (accelByFileKey.size === 0) return 0;
    let mutated = 0;
    const recordsByFileKey = new Map<string, GpsRecord[]>();
    for (const r of records) {
        const key = r.videoKey ?? r.mp4Filename;
        let arr = recordsByFileKey.get(key);
        if (!arr) {
            arr = [];
            recordsByFileKey.set(key, arr);
        }
        arr.push(r);
    }

    for (const [fileKey, samples] of accelByFileKey.entries()) {
        const recs = recordsByFileKey.get(fileKey);
        if (!recs || recs.length === 0) continue;
        const startUtc = videoStartUtcByFileKey.get(fileKey);
        if (startUtc === undefined) continue;

        // Per-file gravity removal: mean values of each drift axis are
        // subtracted so GpsRecord.accel*g is gravity-removed (~0 at rest).
        const n = samples.length;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let isSorted = true;
        let previousTime = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < n; i++) {
            const s = samples[i]!;
            sx += s.accelXg;
            sy += s.accelYg;
            sz += s.accelZg;
            const time = startUtc + s.msSinceStart / 1000;
            if (!(time >= previousTime)) isSorted = false;
            previousTime = time;
        }
        // Preserve absolute-time rounding and stable ties without cloning each IMU row.
        const orderedSamples = isSorted
            ? samples
            : [...samples].sort((a, b) => startUtc + a.msSinceStart / 1000 - (startUtc + b.msSinceStart / 1000));

        const offsets = n > 0 ? { x: sx / n, y: sy / n, z: sz / n } : { x: 0, y: 0, z: 0 };

        // Overlapping GPS windows share samples; compute only magnitudes a window visits.
        const magnitudes = new Float64Array(n).fill(-1);
        const windowMag = (index: number): number => {
            let magnitude = magnitudes[index]!;
            if (magnitude < 0) {
                const s = orderedSamples[index]!;
                magnitude = accelMagnitude(s.accelXg - offsets.x, s.accelYg - offsets.y, s.accelZg - offsets.z);
                magnitudes[index] = magnitude;
            }
            return magnitude;
        };

        for (const r of recs) {
            const idx = nearestSampleIndex(orderedSamples, startUtc, r.unixSeconds);
            if (idx === -1) continue;
            // Walk outward from the nearest sample keeping the strongest sample
            // within +-0.5 s. Samples are sorted, so the signed time delta is
            // monotonic in each direction - stop as soon as it clears the bound.
            let bestIdx = -1;
            let bestMag = -1;
            for (let j = idx; j < n; j++) {
                const dt = startUtc + orderedSamples[j]!.msSinceStart / 1000 - r.unixSeconds;
                if (dt > WINDOW_SEC) break;
                if (dt < -WINDOW_SEC) continue;
                const mag = windowMag(j);
                if (mag > bestMag) {
                    bestMag = mag;
                    bestIdx = j;
                }
            }
            for (let j = idx - 1; j >= 0; j--) {
                const dt = r.unixSeconds - (startUtc + orderedSamples[j]!.msSinceStart / 1000);
                if (dt > WINDOW_SEC) break;
                if (dt < -WINDOW_SEC) continue;
                const mag = windowMag(j);
                if (mag > bestMag) {
                    bestMag = mag;
                    bestIdx = j;
                }
            }
            if (bestIdx === -1) continue;
            const s = orderedSamples[bestIdx]!;
            r.accelXg = s.accelXg - offsets.x;
            r.accelYg = s.accelYg - offsets.y;
            r.accelZg = s.accelZg - offsets.z;
            mutated++;
        }
    }
    return mutated;
}

function nearestSampleIndex(samples: readonly AccelSample[], startUtc: number, target: number): number {
    return nearestIndexBy(samples, target, (sample) => startUtc + sample.msSinceStart / 1000, "later");
}
