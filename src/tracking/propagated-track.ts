import type { CropRect } from "../transcode/compose.js";
import { type DetectedTrack } from "./detect-track.js";
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
}

const TIME_EPSILON_SEC = 1e-6;

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

/** Expand one continuous trusted trajectory into source-frame holds. The
 * caller sorts both tracking directions and bounds each independent seed at
 * checkpoints, losses and source discontinuities. The caller accepts each
 * detector seed before propagation; this function only builds its mask. */
export function buildPropagatedTrack(
    observations: readonly PropagatedObservation[],
    frameTimings: readonly SourceFrameTiming[],
    bounds: TimeInterval,
    evidence: PropagationEvidence,
): DetectedTrack | null {
    if (!Number.isFinite(bounds.startSec) || !Number.isFinite(bounds.endSec) || bounds.endSec <= bounds.startSec) {
        throw new Error("propagated track bounds are invalid");
    }
    if (!Number.isInteger(evidence.detHits) || evidence.detHits < 0 || !Number.isFinite(evidence.bestScore)) {
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
