// Slave-position resolution for multi-channel playback. One invariant for
// every camera: a slave tile shows the file+position that matches the wall
// moment the master is showing. Per-channel drift corrections
// (candidate.driftLeadSec, see channel-drift.ts) and per-channel file-length
// asymmetries both fall out of the same arithmetic - there is deliberately no
// special-cased "drift mode", so the boundary machinery is exercised by every
// multi-channel trip, not only by the one camera family with a measured lead.
//
// DOM-free on purpose: player.ts binds the active trip/frame and does the
// <video> work; everything decision-shaped lives here where node-env unit
// tests can reach it.

import type { Channel } from "../parsers/types.js";
import { frameMediaOffset, type TripFrame, type VideoCandidate } from "../trips.js";
import { requiresMseBackend } from "./player-video-src.js";

export interface SlaveTarget {
    cand: VideoCandidate;
    /** Position in cand's file. May fall outside [0, duration] when no file
     *  holds the moment (trip edge, gap, missing neighbour channel) - the
     *  caller then holds the nearest boundary frame. */
    positionSec: number;
}

/**
 * Resolves the file + position the slave channel needs to show the same wall
 * moment as the master at `masterPosSec` (file-local seconds) in frame
 * `frameIndex`. The master may itself carry a drift lead (the user can prefer
 * the drifting channel), so positions offset by the difference of leads; the
 * master always plays its own file linearly.
 *
 * The moment may live in the NEIGHBOUR frame's file: a drifting channel's
 * files are cut at different wall instants than their names claim, and even
 * healthy channels' files end a fraction apart. The neighbour is used only
 * when the moment actually lands inside it - frames translate via their
 * nominal wall spacing, so an overlapping protected copy or a recording gap
 * fails the range check and falls back to the own-file clamp/hold. A
 * neighbour must also be native-playable, since the caller swaps <video>.src.
 *
 * Returns null when the slave channel is absent from the frame.
 */
export function resolveSlaveTarget(
    frames: readonly TripFrame[],
    frameIndex: number,
    masterChannel: Channel,
    slaveChannel: Channel,
    masterPosSec: number,
): SlaveTarget | null {
    const frame = frames[frameIndex];
    const cand = frame?.channels[slaveChannel];
    if (!frame || !cand) return null;
    const masterLead = frame.channels[masterChannel]?.driftLeadSec ?? 0;
    const framePosSec = masterPosSec - frameMediaOffset(frame, masterChannel);
    const inFrame = framePosSec + frameMediaOffset(frame, slaveChannel) + masterLead - (cand.driftLeadSec ?? 0);

    if (inFrame < 0) {
        const prevFrame = frames[frameIndex - 1];
        const prevCand = prevFrame?.channels[slaveChannel];
        if (prevFrame && isNativeNeighbour(prevCand)) {
            const spacing = frame.startUtc - prevFrame.startUtc;
            const positionSec =
                framePosSec +
                spacing +
                frameMediaOffset(prevFrame, slaveChannel) +
                masterLead -
                (prevCand.driftLeadSec ?? 0);
            if (positionSec >= 0 && positionSec <= prevCand.durationSec) return { cand: prevCand, positionSec };
        }
    } else if (inFrame > cand.durationSec) {
        const nextFrame = frames[frameIndex + 1];
        const nextCand = nextFrame?.channels[slaveChannel];
        if (nextFrame && isNativeNeighbour(nextCand)) {
            const spacing = nextFrame.startUtc - frame.startUtc;
            const positionSec =
                framePosSec -
                spacing +
                frameMediaOffset(nextFrame, slaveChannel) +
                masterLead -
                (nextCand.driftLeadSec ?? 0);
            if (positionSec >= 0 && positionSec <= nextCand.durationSec) return { cand: nextCand, positionSec };
        }
    }
    return { cand, positionSec: inFrame };
}

/** The element state nativeSlaveSyncStep decides from (a subset of
 *  HTMLVideoElement, so the rule runs without a DOM). */
export interface SlaveElementState {
    currentTime: number;
    duration: number;
    paused: boolean;
    ended: boolean;
}

/** What one drift-sync pass does to a native slave, applied in this order:
 *  pause, then seek, then resume. */
export interface SlaveSyncStep {
    shouldPause: boolean;
    seekSec: number | null;
    shouldResume: boolean;
}

/**
 * One drift-sync pass for a native slave whose element already holds the
 * target's file. `targetSec` is the resolved file position (resolveSlaveTarget),
 * possibly outside the file when no file holds the moment: the slave then
 * pauses on the nearest boundary frame instead of stutter-looping between the
 * boundary and the resync threshold. Inside the file it seeks only past
 * `toleranceSec` and resumes when paused, after the seek, because play() on an
 * ended element restarts its file from the start. A slave that ran ahead of
 * its master within the tolerance and already ended stays on its last frame.
 */
export function nativeSlaveSyncStep(
    targetSec: number,
    element: SlaveElementState,
    toleranceSec: number,
): SlaveSyncStep {
    const duration = Number.isFinite(element.duration) ? element.duration : Number.POSITIVE_INFINITY;
    if (targetSec < 0 || targetSec > duration) {
        const boundarySec = targetSec < 0 ? 0 : duration;
        return {
            shouldPause: !element.paused,
            seekSec: Math.abs(element.currentTime - boundarySec) > toleranceSec ? boundarySec : null,
            shouldResume: false,
        };
    }
    const seekSec = Math.abs(element.currentTime - targetSec) > toleranceSec ? targetSec : null;
    if (element.ended && seekSec === null) return { shouldPause: false, seekSec: null, shouldResume: false };
    return { shouldPause: false, seekSec, shouldResume: element.paused };
}

function isNativeNeighbour(cand: VideoCandidate | undefined): cand is VideoCandidate {
    if (cand === undefined) return false;
    return cand.canPlay && !requiresMseBackend(cand);
}
