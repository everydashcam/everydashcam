// Blur-region tracks: user-marked rectangles over the video, blurred in the
// exported clip (privacy: plates / faces). Pure logic shared by the UI editor,
// the live preview and the transcode worker - keep it free of UI/DOM deps.
//
// Model: a region is active over an explicit content-axis span [startSec,
// endSec] (the YouTube-style timeline bar); its geometry comes from keyframes.
// Before the first keyframe the first rect holds, after the last the last rect
// holds, between keyframes manual masks interpolate linearly. Detector masks
// hold the observed rectangle and exclude the span's end. Keyframes live on the
// FOOTAGE (content) axis - the same axis GPS overlays interpolate on - so
// multi-file ranges and timelapse exports resolve them the same way.

import type { Channel } from "./parsers/types.js";
import type { CropRect } from "./transcode/compose.js";

/** Redaction style burned into the region. "pixelate" (coarse mosaic) is the
 *  privacy default; "fill" is the maximum-privacy solid cover; "blur" is a
 *  cosmetic soft blur - the weakest option (gaussian-blurred faces are
 *  demonstrably re-identifiable), kept for users who want the familiar look. */
export type BlurStyle = "pixelate" | "fill" | "blur";

export interface BlurKeyframe {
    /** Position on the trip's footage (content) axis, seconds. */
    contentSec: number;
    /** Region rect in normalized source coordinates (0..1) of the channel frame. */
    rect: CropRect;
    /** true = user-placed/adjusted; false = produced by an auto-tracker pass.
     *  Pinned keyframes are authoritative: a re-track replaces only unpinned ones. */
    pinned: boolean;
}

export interface BlurRegion {
    /** Stable id for list rendering / lookups. */
    id: string;
    /** Which channel's source frame the rects refer to. */
    channel: Channel;
    style: BlurStyle;
    /** Active span on the content axis. The blur is drawn only inside it. */
    startSec: number;
    endSec: number;
    /** true = the end is owned by auto-tracking (the "Follow a moving object"
     *  path): a pass follows through the footage, shortening endSec only for a
     *  confidently confirmed frame exit. On uncertain loss it keeps the full
     *  span and freeze-holds the last cover, so the failure is over-redaction.
     *  false = the end is the user's (drawn default, "whole clip", or a manual
     *  set-end); a track pass then freeze-holds on loss and never shortens it.
     *  This one flag is what keeps "follow until gone" and "cover this exact
     *  span" from fighting over endSec. */
    autoEnd: boolean;
    /** true when the last auto-track pass ended non-routinely (confirmed exit or
     *  target/decode loss). The tail may need review, so the panel keeps a
     *  warning until a successful re-track. */
    lastTrackLost: boolean;
    /** Detector observations belong to the displayed source frame. Hold their
     *  rectangles until the next frame; manual and Follow paths interpolate. */
    interpolation?: "linear" | "hold";
    /** Sorted by contentSec, at least one entry. */
    keyframes: BlurKeyframe[];
}

/** Deep copy suitable for an export/capture snapshot. Regions are mutable in
 *  the editor, so copying only the array would still let a later drag or style
 *  change alter work that has already started. */
export function cloneBlurRegion(region: BlurRegion): BlurRegion {
    return {
        ...region,
        keyframes: region.keyframes.map((keyframe) => ({
            ...keyframe,
            rect: { ...keyframe.rect },
        })),
    };
}

/** Deep-copy a region collection while preserving its readonly input API. */
export function cloneBlurRegions(regions: readonly BlurRegion[]): BlurRegion[] {
    return regions.map(cloneBlurRegion);
}

/** Two keyframes closer than this merge into one on upsert. Half a 60 fps frame
 *  step (16.7 ms) so frame-by-frame stepping still creates distinct keyframes. */
const KEYFRAME_MERGE_EPS_SEC = 0.005;

/** MSE remuxing quantizes source PTS to Mediabunny's default 57600 Hz clock;
 *  browser frame callbacks then round to microseconds. Cover one muxer tick
 *  (17.36 us) plus browser rounding so held masks select the displayed frame.
 *  Manual interpolation and its boundaries stay exact. */
export const DETECTOR_FRAME_TIME_EPS_SEC = 20e-6;

/** Back-off applied when anchoring a zone START at the playhead. A paused
 *  player displays the frame whose timestamp is <= currentTime, so an
 *  exact-playhead start excludes the very frame the user drew on - the export
 *  resolves at frame timestamps and would ship it unredacted for one frame
 *  while the preview shows it censored. One 30fps frame covers 60fps too. */
export const ZONE_START_PLAYHEAD_BACKOFF_SEC = 1 / 30;

/** Minimum content-axis span of a zone. Zone creation and the set-start/set-end
 *  edit buttons both enforce it so a zone can never collapse to zero length -
 *  a zero-span zone still forces re-encode and lists a row but paints on ~no
 *  frames, i.e. a silently unprotected zone the user thinks is covering. */
export const MIN_ZONE_SPAN_SEC = 1;

/** Default forward span of a freshly drawn zone (and of a zone dropped into the
 *  Custom duration mode out of whole-clip), seconds. A plate is legible for a few
 *  seconds; the set-start/set-end edits adjust from there. */
export const DEFAULT_ZONE_SPAN_SEC = 5;

let regionIdCounter = 0;

/** Creates a region with a single pinned keyframe at `contentSec`. The span is
 *  the caller's business (clamping to trip bounds included). */
export function createBlurRegion(
    channel: Channel,
    style: BlurStyle,
    startSec: number,
    endSec: number,
    contentSec: number,
    rect: CropRect,
): BlurRegion {
    regionIdCounter += 1;
    return {
        id: `blur-${regionIdCounter}`,
        channel,
        style,
        startSec,
        endSec,
        // A fresh zone covers a fixed spot: its end is the user's until they
        // hit "Follow", which flips this on and lets tracking own the end.
        autoEnd: false,
        lastTrackLost: false,
        keyframes: [{ contentSec, rect: { ...rect }, pinned: true }],
    };
}

/** Index of the last keyframe with contentSec <= sec, or -1 when sec precedes
 *  all keyframes. Binary search - keyframes are kept sorted by upsertKeyframe. */
function lowerKeyframeIndex(keyframes: readonly BlurKeyframe[], sec: number): number {
    let lo = 0;
    let hi = keyframes.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (keyframes[mid]!.contentSec <= sec) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** True when the region's blur should be drawn at `contentSec`. */
export function regionActiveAt(region: BlurRegion, contentSec: number): boolean {
    if (region.interpolation === "hold") {
        const sec = contentSec + DETECTOR_FRAME_TIME_EPS_SEC;
        return sec >= region.startSec && sec < region.endSec;
    }
    return contentSec >= region.startSec && contentSec <= region.endSec;
}

/** True when the region carries auto-tracker output (any unpinned keyframe).
 *  The panel reads it to show a "following" state distinct from a static spot,
 *  independent of whether a pass is running right now. */
export function regionHasTrackedKeyframes(region: BlurRegion): boolean {
    return region.keyframes.some((k) => !k.pinned);
}

/** Grows a normalized rect symmetrically by `pct` of each dimension, clamped to
 *  the [0,1] frame. Used to pad auto-tracked boxes: vittrack tends to
 *  under-estimate the target size, and for a privacy blur over-covering by a
 *  hair is the safe direction - a plate edge peeking out is the failure that
 *  matters, an extra few pixels of mosaic is not. */
export function inflateRect(rect: CropRect, pct: number): CropRect {
    const dx = (rect.wPct * pct) / 2;
    const dy = (rect.hPct * pct) / 2;
    const xPct = Math.max(0, Math.min(1, rect.xPct - dx));
    const yPct = Math.max(0, Math.min(1, rect.yPct - dy));
    const right = Math.max(0, Math.min(1, rect.xPct + rect.wPct + dx));
    const bottom = Math.max(0, Math.min(1, rect.yPct + rect.hPct + dy));
    return {
        xPct,
        yPct,
        wPct: Math.max(0, right - xPct),
        hPct: Math.max(0, bottom - yPct),
    };
}

/**
 * Region rect at `contentSec`, or null when outside the active span.
 * Clamp-and-lerp: first rect before the first keyframe, last rect after the
 * last one, linear interpolation of x/y/w/h between neighbors.
 */
export function regionRectAt(region: BlurRegion, contentSec: number): CropRect | null {
    if (!regionActiveAt(region, contentSec)) return null;
    const kfs = region.keyframes;
    if (kfs.length === 0) return null;
    const i = lowerKeyframeIndex(kfs, contentSec + (region.interpolation === "hold" ? DETECTOR_FRAME_TIME_EPS_SEC : 0));
    if (i < 0) return { ...kfs[0]!.rect };
    if (i >= kfs.length - 1) return { ...kfs[kfs.length - 1]!.rect };
    const a = kfs[i]!;
    if (region.interpolation === "hold") return { ...a.rect };
    const b = kfs[i + 1]!;
    const span = b.contentSec - a.contentSec;
    // Guard: two keyframes closer than the merge epsilon should not exist, but
    // a zero span from clamped inputs must not divide to NaN.
    const t = span > 0 ? (contentSec - a.contentSec) / span : 0;
    return {
        xPct: a.rect.xPct + (b.rect.xPct - a.rect.xPct) * t,
        yPct: a.rect.yPct + (b.rect.yPct - a.rect.yPct) * t,
        wPct: a.rect.wPct + (b.rect.wPct - a.rect.wPct) * t,
        hPct: a.rect.hPct + (b.rect.hPct - a.rect.hPct) * t,
    };
}

/**
 * Inserts a keyframe at `contentSec`, or replaces an existing one within the
 * merge epsilon (frame-stepping never lands closer than the epsilon, so a
 * "replace" is always the user editing that same instant). Keeps the array
 * sorted. Mutates the region in place (direct-mutation convention, see
 * ui/state.ts).
 */
export function upsertKeyframe(region: BlurRegion, contentSec: number, rect: CropRect, pinned: boolean): void {
    const kfs = region.keyframes;
    // Insertion anchor from the exact time; the epsilon merge checks BOTH
    // neighbors. (Anchoring on contentSec+EPS could return a keyframe sitting
    // exactly EPS later, and splicing after it would break the sort order.)
    const i = lowerKeyframeIndex(kfs, contentSec);
    const mergeAt =
        i >= 0 && Math.abs(kfs[i]!.contentSec - contentSec) < KEYFRAME_MERGE_EPS_SEC
            ? i
            : i + 1 < kfs.length && Math.abs(kfs[i + 1]!.contentSec - contentSec) < KEYFRAME_MERGE_EPS_SEC
              ? i + 1
              : -1;
    if (mergeAt >= 0) {
        const existing = kfs[mergeAt]!;
        // A pinned keyframe is authoritative (see replaceGeneratedKeyframes: user
        // pins stay authoritative over re-tracks). An unpinned auto-tracked upsert
        // landing within the merge epsilon of a hand-placed pin must keep the
        // PIN's geometry, not overwrite it - only a pinned write (the user editing
        // that instant) or a write over an unpinned keyframe replaces the rect.
        const keepExistingRect = existing.pinned && !pinned;
        kfs[mergeAt] = {
            contentSec: existing.contentSec,
            rect: keepExistingRect ? existing.rect : { ...rect },
            pinned: pinned || existing.pinned,
        };
        return;
    }
    kfs.splice(i + 1, 0, { contentSec, rect: { ...rect }, pinned });
}

/**
 * Replaces the region's unpinned (tracker-produced) keyframes inside
 * [fromSec, toSec] with `generated`, keeping pinned ones. The seam for a
 * future auto-tracker pass: user pins stay authoritative over re-tracks.
 * `generated` entries are inserted as unpinned regardless of their flag.
 */
export function replaceGeneratedKeyframes(
    region: BlurRegion,
    fromSec: number,
    toSec: number,
    generated: ReadonlyArray<{ contentSec: number; rect: CropRect }>,
): void {
    region.keyframes = region.keyframes.filter(
        (k) =>
            k.pinned ||
            k.contentSec < fromSec - KEYFRAME_MERGE_EPS_SEC ||
            k.contentSec > toSec + KEYFRAME_MERGE_EPS_SEC,
    );
    for (const g of generated) {
        upsertKeyframe(region, g.contentSec, g.rect, false);
    }
}

/** Resolved paint instruction for one region at one frame time. */
export interface ResolvedRegionBlur {
    rect: CropRect;
    style: BlurStyle;
}

/** Stronger covers paint last so overlapping regions cannot weaken them. */
export function sortBlurRegionsForPaint<T extends { style: BlurStyle }>(regions: readonly T[]): T[] {
    const priority: Record<BlurStyle, number> = { blur: 0, pixelate: 1, fill: 2 };
    return [...regions].sort((a, b) => priority[a.style] - priority[b.style]);
}

/**
 * Rects to paint at `contentSec` for one channel. Used identically by the
 * export pipelines (per decoded frame) and the live preview (per rVFC tick).
 */
export function resolveRegionBlursAt(
    regions: readonly BlurRegion[],
    channel: Channel,
    contentSec: number,
): ResolvedRegionBlur[] {
    const out: ResolvedRegionBlur[] = [];
    for (const region of regions) {
        if (region.channel !== channel) continue;
        const rect = regionRectAt(region, contentSec);
        if (rect) out.push({ rect, style: region.style });
    }
    return sortBlurRegionsForPaint(out);
}

/** True when any region intersects [startSec, endSec] on one of `channels` -
 *  the stream-copy gate: such an export MUST re-encode or the blur is silently
 *  dropped. Inclusive on both ends to match regionActiveAt: a region touching
 *  the range boundary still paints one frame, so it must gate. */
export function anyRegionIntersectsRange(
    regions: readonly BlurRegion[],
    channels: readonly Channel[],
    startSec: number,
    endSec: number,
): boolean {
    return regions.some(
        (region) => channels.includes(region.channel) && region.startSec <= endSec && region.endSec >= startSec,
    );
}
