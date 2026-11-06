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

// Longest run of tails a camera's last frame stands in for. Paired cameras end
// milliseconds to about a second apart. A longer run means that camera stopped
// recording (power cut, truncated file), and a frozen frame there would read
// as live footage of a standing car.
const PAIRED_TAIL_HOLD_MAX_SEC = 2;

/**
 * The file whose last frame `channel` keeps on screen in frame `frameIndex`,
 * or null. When paired channels end a moment apart, the trip plays the longer
 * ones' tails as intervals without the channels that already ended
 * (trips.ts). Such a channel holds its last frame there instead of
 * disappearing. It holds only when the frame that last carried it paired it,
 * from the same media origin, with a sibling that plays on into the first
 * tail; its file ends where that tail starts; each later tail plays on from
 * the one before; and the tails up to the end of this frame last at most
 * PAIRED_TAIL_HOLD_MAX_SEC. A recording gap, an independently cut camera or a
 * camera that stopped long before its sibling shows nothing, as before.
 */
export function pairedTailHoldCandidate(
    frames: readonly TripFrame[],
    frameIndex: number,
    channel: Channel,
): VideoCandidate | null {
    const frame = frames[frameIndex];
    if (!frame || frame.channels[channel]) return null;
    const holdEndUtc = frame.startUtc + frame.wallDurationSec;
    // Walk back over the tails that already lack the channel to the frame
    // that last carried it.
    let firstTailIndex = frameIndex;
    for (;;) {
        const tail = frames[firstTailIndex]!;
        if (holdEndUtc - tail.startUtc > PAIRED_TAIL_HOLD_MAX_SEC) return null;
        const previous = frames[firstTailIndex - 1];
        if (!previous) return null;
        if (previous.channels[channel]) break;
        if (!continuesInterval(previous, tail)) return null;
        firstTailIndex--;
    }
    const firstTail = frames[firstTailIndex]!;
    const paired = frames[firstTailIndex - 1]!;
    const cand = paired.channels[channel]!;
    const mediaOffsetSec = frameMediaOffset(paired, channel);
    const fileEndUtc = paired.startUtc - mediaOffsetSec + cand.durationSec;
    if (Math.abs(fileEndUtc - firstTail.startUtc) > PAIRED_TAIL_JOIN_TOLERANCE_SEC) return null;
    const hasContinuingSibling = frameChannels(firstTail).some(
        (sibling) =>
            paired.channels[sibling] === firstTail.channels[sibling] &&
            Math.abs(frameMediaOffset(paired, sibling) - mediaOffsetSec) <= PAIRED_TAIL_JOIN_TOLERANCE_SEC,
    );
    return hasContinuingSibling ? cand : null;
}

/** Whether `next` plays on from `previous` without a break: it starts where
 *  `previous` ends and keeps one of its files. */
function continuesInterval(previous: TripFrame, next: TripFrame): boolean {
    if (Math.abs(previous.startUtc + previous.wallDurationSec - next.startUtc) > PAIRED_TAIL_JOIN_TOLERANCE_SEC) {
        return false;
    }
    return frameChannels(next).some((channel) => previous.channels[channel] === next.channels[channel]);
}

function isNativeNeighbour(cand: VideoCandidate | undefined): cand is VideoCandidate {
    if (cand === undefined) return false;
    return cand.canPlay && !requiresMseBackend(cand);
}
