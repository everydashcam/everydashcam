import type { CropRect } from "../transcode/compose.js";
import { type DetectedTrack, iou } from "./detect-track.js";
import type { TimeInterval } from "./interval-set.js";

export interface PropagatedObservation {
    contentSec: number;
    rect: CropRect;
}

export interface SourceFrameTiming {
    contentSec: number;
    durationSec: number;
}

export interface PropagationEvidence {
    detHits: number;
    bestScore: number;
    strongScore: number;
}

export interface PropagationPrefix {
    seedIndex: number;
    /** Raw normalized geometry, keyed by source frame index. */
    observations: ReadonlyMap<number, CropRect>;
    /** Independent seed-eligible detector hits, never tracker predictions. */
    detectorAnchors: ReadonlyMap<number, CropRect>;
    /** Omit after all reverse passes have completed. */
    backwardComplete?: boolean;
    /** Final observations or known absence at every index from here onwards.
     * Set only after prediction and same-frame detector reanchoring finish.
     * Before reverse starts, the seed index marks the known forward suffix. */
    backwardKnownFromIndex?: number;
}

export interface PropagationGapSpan extends PropagationEvidence {
    observations: ReadonlyMap<number, CropRect>;
    windowStartIndex: number;
    canBridgeBefore: boolean;
    canBridgeAfter: boolean;
}

export interface PropagationGapBridge {
    before: number;
    observations: ReadonlyMap<number, CropRect>;
}

const TIME_EPSILON_SEC = 1e-6;
const MIN_MATCH_IOU = 0.2;
const MAX_MATCH_SIZE_RATIO = 2;
const MATCH_TIE_EPSILON = 1e-9;
const DUPLICATE_PREFIX_IOU = 0.8;
const MIN_DUPLICATE_PREFIX_FRAMES = 3;
const MAX_GAP_FRAMES = 2;
const MAX_GAP_SEC = 0.12;
const MIN_GAP_IOU = 0.5;

function validRect(rect: CropRect): boolean {
    return [rect.xPct, rect.yPct, rect.wPct, rect.hPct].every(Number.isFinite) && rect.wPct > 0 && rect.hPct > 0;
}

function sameRect(a: CropRect, b: CropRect): boolean {
    return a.xPct === b.xPct && a.yPct === b.yPct && a.wPct === b.wPct && a.hPct === b.hPct;
}

export function interpolateRect(a: CropRect, b: CropRect, fraction: number): CropRect {
    return {
        xPct: a.xPct + (b.xPct - a.xPct) * fraction,
        yPct: a.yPct + (b.yPct - a.yPct) * fraction,
        wPct: a.wPct + (b.wPct - a.wPct) * fraction,
        hPct: a.hPct + (b.hPct - a.hPct) * fraction,
    };
}

function observationIndexBounds(observations: ReadonlyMap<number, CropRect>): { first: number; last: number } | null {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const index of observations.keys()) {
        if (!Number.isSafeInteger(index) || index < 0) return null;
        first = Math.min(first, index);
        last = Math.max(last, index);
    }
    return first <= last ? { first, last } : null;
}

/** Fill a short loss only when two independently confirmed trajectories
 * bracket it inside one decoded window. Both directions must have stopped
 * from missing image evidence, not an exit or identity/geometry rejection.
 * A compatible alternative on either side makes the association ambiguous;
 * no trajectory borrows another's confirmation evidence or final tail. */
export function propagationGapBridges(
    spans: readonly PropagationGapSpan[],
    frames: readonly SourceFrameTiming[],
): PropagationGapBridge[] {
    const bounds = spans.map((span) => observationIndexBounds(span.observations));
    const starts = new Map<number, number[]>();
    for (let index = 0; index < bounds.length; index++) {
        const first = bounds[index]?.first;
        if (first === undefined) continue;
        const at = starts.get(first) ?? [];
        at.push(index);
        starts.set(first, at);
    }
    const interior = (rect: CropRect): boolean =>
        validRect(rect) && rect.xPct >= 0 && rect.yPct >= 0 && rect.xPct + rect.wPct <= 1 && rect.yPct + rect.hPct <= 1;
    const confirmed = (span: PropagationGapSpan): boolean =>
        span.detHits > 0 && (span.detHits >= 2 || span.bestScore >= span.strongScore);
    const pairs: Array<{ before: number; after: number }> = [];
    const successors = new Map<number, number>();
    const predecessors = new Map<number, number>();
    for (let before = 0; before < spans.length; before++) {
        const a = spans[before]!;
        const aBounds = bounds[before];
        if (!confirmed(a) || !aBounds) continue;
        const aRect = a.observations.get(aBounds.last)!;
        if (!interior(aRect)) continue;
        const candidates = Array.from(
            { length: MAX_GAP_FRAMES },
            (_, offset) => starts.get(aBounds.last + offset + 2) ?? [],
        ).flat();
        for (const after of candidates) {
            const b = spans[after]!;
            const bBounds = bounds[after];
            if (!confirmed(b) || !bBounds || a.windowStartIndex !== b.windowStartIndex) continue;
            const bRect = b.observations.get(bBounds.first)!;
            if (!interior(bRect) || iou(aRect, bRect) < MIN_GAP_IOU) continue;
            const first = frames[aBounds.last];
            const last = frames[bBounds.first];
            if (
                !first ||
                !last ||
                last.contentSec - first.contentSec - first.durationSec > MAX_GAP_SEC + TIME_EPSILON_SEC
            )
                continue;
            let continuous = true;
            for (let index = aBounds.last; index < bBounds.first; index++) {
                const frame = frames[index];
                const next = frames[index + 1];
                if (
                    !frame ||
                    !next ||
                    !Number.isFinite(frame.durationSec) ||
                    !(frame.durationSec > 0) ||
                    !Number.isFinite(next.contentSec) ||
                    !(next.contentSec > frame.contentSec) ||
                    next.contentSec > frame.contentSec + frame.durationSec + TIME_EPSILON_SEC
                ) {
                    continuous = false;
                    break;
                }
            }
            if (continuous) {
                pairs.push({ before, after });
                successors.set(before, (successors.get(before) ?? 0) + 1);
                predecessors.set(after, (predecessors.get(after) ?? 0) + 1);
            }
        }
    }
    const bridges: PropagationGapBridge[] = [];
    for (const pair of pairs) {
        if (successors.get(pair.before) !== 1 || predecessors.get(pair.after) !== 1) continue;
        if (!spans[pair.before]!.canBridgeAfter || !spans[pair.after]!.canBridgeBefore) continue;
        const firstIndex = bounds[pair.before]!.last;
        const lastIndex = bounds[pair.after]!.first;
        const firstSec = frames[firstIndex]!.contentSec;
        const lastSec = frames[lastIndex]!.contentSec;
        const firstRect = spans[pair.before]!.observations.get(firstIndex)!;
        const lastRect = spans[pair.after]!.observations.get(lastIndex)!;
        const observations = new Map<number, CropRect>();
        for (let index = firstIndex + 1; index < lastIndex; index++) {
            observations.set(
                index,
                interpolateRect(firstRect, lastRect, (frames[index]!.contentSec - firstSec) / (lastSec - firstSec)),
            );
        }
        // A third confirmed trajectory inside the gap may already own this
        // object. It need not be eligible for a bridge itself to make these
        // endpoints ambiguous; avoid adding a second cover over its evidence.
        const competes = [...observations].some(([index, rect]) =>
            spans.some((span, spanIndex) => {
                if (spanIndex === pair.before || spanIndex === pair.after || !confirmed(span)) return false;
                const other = span.observations.get(index);
                return other !== undefined && iou(rect, other) >= MIN_GAP_IOU;
            }),
        );
        if (competes) continue;
        bridges.push({ before: pair.before, observations });
    }
    return bridges;
}

/** Find an already covered reverse prefix without joining identities or
 * transferring evidence. Every shared source frame must agree, including an
 * older detector anchor. Identity needs three settled current frames; a
 * provisional leading hold can be removed only if the older settled geometry
 * covers it too. Ambiguous predecessors and uncovered early frames prevent
 * trimming; the current seed and all following frames remain intact. */
export function duplicatePropagationPrefixEndIndex(
    current: PropagationPrefix,
    olderTrajectories: readonly PropagationPrefix[],
): number | null {
    const currentBounds = observationIndexBounds(current.observations);
    if (!currentBounds || !current.observations.has(current.seedIndex)) return null;
    const currentKnownFromIndex = current.backwardKnownFromIndex ?? currentBounds.first;
    if (
        !Number.isSafeInteger(currentKnownFromIndex) ||
        currentKnownFromIndex < 0 ||
        currentKnownFromIndex > current.seedIndex
    ) {
        return null;
    }
    const settledStartIndex = Math.max(currentBounds.first, currentKnownFromIndex);
    // The overlap only reads indices at or after the current prefix's first
    // frame. Earlier future observations cannot change coverage, geometry,
    // detector anchors, or competing predecessors inside that settled suffix.
    if (
        olderTrajectories.some((older) => {
            if (older.seedIndex >= current.seedIndex || older.backwardComplete !== false) return false;
            const knownFromIndex = older.backwardKnownFromIndex ?? older.seedIndex;
            return (
                !Number.isSafeInteger(knownFromIndex) ||
                knownFromIndex < 0 ||
                knownFromIndex > older.seedIndex ||
                knownFromIndex > currentBounds.first
            );
        })
    ) {
        return null;
    }
    let duplicateEndIndex: number | null = null;
    for (const older of olderTrajectories) {
        if (older.seedIndex >= current.seedIndex || !older.observations.has(older.seedIndex)) continue;
        const olderBounds = observationIndexBounds(older.observations);
        if (
            !olderBounds ||
            olderBounds.first > currentBounds.first ||
            olderBounds.last >= current.seedIndex ||
            olderBounds.last - settledStartIndex + 1 < MIN_DUPLICATE_PREFIX_FRAMES
        ) {
            continue;
        }
        let compatible = true;
        let hasDetectorAnchor = false;
        for (let index = currentBounds.first; index <= olderBounds.last; index++) {
            const currentRect = current.observations.get(index);
            const olderRect = older.observations.get(index);
            if (
                !currentRect ||
                !olderRect ||
                !validRect(currentRect) ||
                !validRect(olderRect) ||
                !(iou(currentRect, olderRect) >= DUPLICATE_PREFIX_IOU)
            ) {
                compatible = false;
                break;
            }
            const anchor = older.detectorAnchors.get(index);
            if (
                index >= settledStartIndex &&
                anchor &&
                validRect(anchor) &&
                iou(currentRect, anchor) >= DUPLICATE_PREFIX_IOU &&
                iou(olderRect, anchor) >= DUPLICATE_PREFIX_IOU
            ) {
                hasDetectorAnchor = true;
            }
        }
        if (!compatible || !hasDetectorAnchor) continue;
        if (duplicateEndIndex !== null) return null;
        duplicateEndIndex = olderBounds.last;
    }
    return duplicateEndIndex;
}

/** Expand one continuous trusted trajectory into source-frame holds. The
 * caller sorts both tracking directions, removes duplicate observations, and
 * splits losses or source discontinuities before assembly. Only detector
 * evidence confirms a track; successful propagation adds no detector hits. */
export function buildPropagatedTrack(
    observations: readonly PropagatedObservation[],
    frameTimings: readonly SourceFrameTiming[],
    bounds: TimeInterval,
    evidence: PropagationEvidence,
): DetectedTrack | null {
    if (!Number.isFinite(bounds.startSec) || !Number.isFinite(bounds.endSec) || bounds.endSec <= bounds.startSec) {
        throw new Error("propagated track bounds are invalid");
    }
    if (
        !Number.isInteger(evidence.detHits) ||
        evidence.detHits < 0 ||
        !Number.isFinite(evidence.bestScore) ||
        !Number.isFinite(evidence.strongScore)
    ) {
        throw new Error("propagated track evidence is invalid");
    }
    let previousSec = Number.NEGATIVE_INFINITY;
    for (const observation of observations) {
        if (!Number.isFinite(observation.contentSec) || !validRect(observation.rect)) {
            throw new Error("propagated observation is invalid");
        }
        if (observation.contentSec <= previousSec) throw new Error("propagated observations must be time ordered");
        previousSec = observation.contentSec;
    }
    previousSec = Number.NEGATIVE_INFINITY;
    for (const frame of frameTimings) {
        if (
            !Number.isFinite(frame.contentSec) ||
            !Number.isFinite(frame.durationSec) ||
            !(frame.durationSec > 0) ||
            !Number.isFinite(frame.contentSec + frame.durationSec)
        ) {
            throw new Error("propagated frame timing is invalid");
        }
        if (frame.contentSec <= previousSec) throw new Error("propagated frames must be time ordered");
        previousSec = frame.contentSec;
    }
    if (observations.length === 0 || frameTimings.length === 0 || evidence.detHits === 0) return null;
    if (evidence.detHits < 2 && evidence.bestScore < evidence.strongScore) return null;

    // Observations refer to real displayed frames, not nominal 15 Hz ticks.
    // In particular, the final observation needs that frame's verified duration.
    let frameIndex = 0;
    for (const observation of observations) {
        while (frameIndex < frameTimings.length && frameTimings[frameIndex]!.contentSec < observation.contentSec) {
            frameIndex++;
        }
        if (frameTimings[frameIndex]?.contentSec !== observation.contentSec) {
            throw new Error("propagated observation has no source frame");
        }
    }

    const firstSec = observations[0]!.contentSec;
    const lastSec = observations[observations.length - 1]!.contentSec;
    const keyframes: DetectedTrack["keyframes"] = [];
    let observationIndex = 0;
    let previousEndSec: number | null = null;
    let endSec = Number.NEGATIVE_INFINITY;
    for (const frame of frameTimings) {
        const frameEndSec = frame.contentSec + frame.durationSec;
        if (frame.contentSec < firstSec || frameEndSec <= bounds.startSec) continue;
        if (frame.contentSec > lastSec || frame.contentSec >= bounds.endSec) break;
        if (previousEndSec !== null && frame.contentSec > previousEndSec + TIME_EPSILON_SEC) {
            throw new Error("propagated track crosses a source frame gap");
        }
        while (
            observationIndex + 1 < observations.length &&
            observations[observationIndex + 1]!.contentSec <= frame.contentSec
        ) {
            observationIndex++;
        }
        const before = observations[observationIndex]!;
        const after = observations[observationIndex + 1];
        const rect =
            after && frame.contentSec > before.contentSec
                ? interpolateRect(
                      before.rect,
                      after.rect,
                      (frame.contentSec - before.contentSec) / (after.contentSec - before.contentSec),
                  )
                : { ...before.rect };
        // Holds need a keyframe only when geometry actually changes. Duration
        // still comes from every source frame, including a stationary tail.
        const last = keyframes[keyframes.length - 1];
        if (!last || !sameRect(last.rect, rect)) keyframes.push({ contentSec: frame.contentSec, rect });
        previousEndSec = frameEndSec;
        endSec = Math.min(bounds.endSec, frameEndSec);
    }
    if (keyframes.length === 0) return null;
    return {
        startSec: Math.max(bounds.startSec, keyframes[0]!.contentSec),
        endSec,
        keyframes,
        detHits: evidence.detHits,
        bestScore: evidence.bestScore,
    };
}

/** Match raw normalized boxes only when each is the other's unique best
 * overlap. A contested detection never falls back to another object's track;
 * equal overlaps remain unmatched rather than depending on array order. */
export function matchPropagationDetections(
    detectionRects: readonly CropRect[],
    trackRects: readonly CropRect[],
): number[] {
    const scores = detectionRects.map((detection) =>
        trackRects.map((track) => {
            if (!validRect(detection) || !validRect(track)) return 0;
            if (
                Math.max(detection.wPct, track.wPct) > Math.min(detection.wPct, track.wPct) * MAX_MATCH_SIZE_RATIO ||
                Math.max(detection.hPct, track.hPct) > Math.min(detection.hPct, track.hPct) * MAX_MATCH_SIZE_RATIO
            ) {
                return 0;
            }
            const overlap = iou(detection, track);
            return overlap >= MIN_MATCH_IOU ? overlap : 0;
        }),
    );
    const uniqueBest = (values: readonly number[]): number => {
        let best = -1;
        let bestScore = 0;
        let tied = false;
        for (let index = 0; index < values.length; index++) {
            const score = values[index]!;
            if (score <= 0) continue;
            if (score > bestScore + MATCH_TIE_EPSILON) {
                best = index;
                bestScore = score;
                tied = false;
            } else if (Math.abs(score - bestScore) <= MATCH_TIE_EPSILON) {
                tied = true;
            }
        }
        return tied ? -1 : best;
    };
    const trackMatches = trackRects.map((_, trackIndex) => uniqueBest(scores.map((row) => row[trackIndex]!)));
    return scores.map((row, detectionIndex) => {
        const trackIndex = uniqueBest(row);
        return trackIndex >= 0 && trackMatches[trackIndex] === detectionIndex ? trackIndex : -1;
    });
}
