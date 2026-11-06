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
import { frameChannels, frameMediaOffset, type TripFrame, type VideoCandidate } from "../trips.js";
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

// Paired intervals are cut at file ends with the same arithmetic that places
// the next interval, so only float noise separates a file's end from it.
const PAIRED_TAIL_JOIN_TOLERANCE_SEC = 0.001;

/**
 * The file whose last frame `channel` keeps on screen in frame `frameIndex`,
 * or null. When paired channels end a moment apart, the trip plays the longer
 * one's tail as an interval without the shorter channel (trips.ts). That
 * channel holds its last frame there instead of disappearing for the tail.
 * It holds only when the previous frame paired it, from the same media
 * origin, with a sibling that plays on in this frame, and its file ends
 * where this frame starts. A recording gap or an independently cut camera
 * shows nothing, as before.
 */
export function pairedTailHoldCandidate(
    frames: readonly TripFrame[],
    frameIndex: number,
    channel: Channel,
): VideoCandidate | null {
    const frame = frames[frameIndex];
    const previous = frames[frameIndex - 1];
    if (!frame || !previous || frame.channels[channel]) return null;
    const cand = previous.channels[channel];
    if (!cand) return null;
    const mediaOffsetSec = frameMediaOffset(previous, channel);
    const fileEndUtc = previous.startUtc - mediaOffsetSec + cand.durationSec;
    if (Math.abs(fileEndUtc - frame.startUtc) > PAIRED_TAIL_JOIN_TOLERANCE_SEC) return null;
    const hasContinuingSibling = frameChannels(frame).some(
        (sibling) =>
            previous.channels[sibling] === frame.channels[sibling] &&
            Math.abs(frameMediaOffset(previous, sibling) - mediaOffsetSec) <= PAIRED_TAIL_JOIN_TOLERANCE_SEC,
    );
    return hasContinuingSibling ? cand : null;
}

function isNativeNeighbour(cand: VideoCandidate | undefined): cand is VideoCandidate {
    if (cand === undefined) return false;
    return cand.canPlay && !requiresMseBackend(cand);
}
