// Pure folding of a tracker result into a mutable blur region. Kept outside the
// UI/worker modules so automatic spans end at the last trusted observation,
// while manually chosen spans keep their duration on loss.

import { MIN_ZONE_SPAN_SEC, replaceGeneratedKeyframes, type BlurRegion } from "./blur-regions.js";
import type { TrackResult, TrackResultKeyframe } from "./workers/tracker-protocol.js";

/** The seed geometry belongs to its pinned frame even when the user moves the
 *  cover's start later. Decode from that frame instead of seeding another image. */
export function followSeed(region: BlurRegion): TrackResultKeyframe | null {
    let seed = region.keyframes[0];
    for (let index = region.keyframes.length - 1; index >= 0; index--) {
        const keyframe = region.keyframes[index]!;
        // Automatic timing can continue from a correction at the stopped end.
        // A manual span needs footage after its seed within the fixed end.
        const canContinue =
            keyframe.contentSec < region.endSec || (region.autoEnd && keyframe.contentSec === region.endSec);
        if (keyframe.pinned && canContinue) {
            seed = keyframe;
            break;
        }
    }
    return seed ? { contentSec: seed.contentSec, rect: { ...seed.rect } } : null;
}

export function applyTrackResult(
    region: BlurRegion,
    fromSec: number,
    toSec: number,
    contentDurationSec: number,
    result: TrackResult,
): void {
    replaceGeneratedKeyframes(region, fromSec, toSec, result.keyframes);
    if (region.autoEnd) {
        region.endSec =
            result.endReason === "completed"
                ? contentDurationSec
                : Math.min(contentDurationSec, Math.max(result.trackedUntilSec, region.startSec + MIN_ZONE_SPAN_SEC));
    }
    // Keyframes beyond a manually shortened span remain available for later
    // edits. Anchor its end so their stale geometry cannot move an uncertain tail.
    for (let index = region.keyframes.length - 1; index >= 0; index--) {
        const keyframe = region.keyframes[index]!;
        if (keyframe.contentSec > region.endSec) continue;
        if (keyframe.contentSec < region.endSec && index < region.keyframes.length - 1) {
            // This boundary must stay exact: epsilon-merging into a nearby pin
            // outside the span would pull its geometry back into the held tail.
            region.keyframes.splice(index + 1, 0, {
                contentSec: region.endSec,
                rect: { ...keyframe.rect },
                pinned: false,
            });
        }
        break;
    }
    region.lastTrackLost = result.endReason !== "completed";
}
