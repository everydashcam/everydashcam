// Which visible cameras have footage at a moment of a trip. Shared by the
// viewer and the export so both show the same tile for a camera without a
// recording and the same camera in the main place when the main one has none.
// Pure: decided from the trip's playback intervals only. The viewer still
// checks that a held tail's element really shows its file end.

import type { CameraArrangementMode } from "./camera-layout.js";
import type { Channel } from "./parsers/types.js";
import type { Trip, TripFrame, VideoCandidate } from "./trips.js";

/**
 * - "recording": the camera has footage in this interval.
 * - "held-tail": its paired file ended a moment ago while a sibling plays on;
 *   the camera keeps its last frame.
 * - "absent": the trip has this camera, but not at this moment.
 */
export type CameraPresence = "recording" | "held-tail" | "absent";

export interface CameraAvailability {
    /** Visible cameras in layout order: the arrangement order, except that in
     *  "main" mode a main camera without footage trades places with the first
     *  camera that has some, until its footage returns. */
    order: Channel[];
    presence: Partial<Record<Channel, CameraPresence>>;
}

/** A content-time span over which the availability does not change. */
export interface CameraAvailabilitySpan {
    startSec: number;
    endSec: number;
    availability: CameraAvailability;
}

// Longest run of tails a camera's last frame stands in for. Paired cameras end
// milliseconds to about a second apart. A longer run means that camera stopped
// recording (power cut, truncated file), and a frozen frame there would read
// as live footage of a standing car.
const PAIRED_TAIL_HOLD_MAX_SEC = 2;

/**
 * The file whose last frame `channel` may keep on screen in `frame`, or null.
 * When paired channels end a moment apart, the trip plays the longer ones'
 * tails as intervals without the channels that already ended, and marks them
 * (TripFrame.pairedTail). A channel the interval marks as ended holds only
 * while the time from its file end to the end of this interval stays within
 * PAIRED_TAIL_HOLD_MAX_SEC. Intervals the trip did not mark (a recording gap,
 * an independently cut camera) hold nothing. Whether a picture is actually on
 * screen is the player's question: this is the eligibility only.
 */
export function pairedTailHold(frame: TripFrame, channel: Channel): VideoCandidate | null {
    const tail = frame.pairedTail;
    const cand = tail?.endedChannels[channel];
    if (!tail || !cand) return null;
    const heldSec = tail.pairOffsetSec + frame.durationSec - cand.durationSec;
    return heldSec <= PAIRED_TAIL_HOLD_MAX_SEC ? cand : null;
}

export function cameraPresence(frame: TripFrame, channel: Channel): CameraPresence {
    if (frame.channels[channel]) return "recording";
    return pairedTailHold(frame, channel) ? "held-tail" : "absent";
}

/** First camera of `order` with footage in `frame`, or null - the camera that
 *  can drive playback and stand in for a main camera without footage. */
export function firstRecordingChannel(frame: TripFrame, order: readonly Channel[]): Channel | null {
    return order.find((channel) => frame.channels[channel]) ?? null;
}

/** Availability of the `visible` cameras (in arrangement order) in `frame`. A
 *  held tail keeps the main place: its last frame is the main picture. */
export function frameCameraAvailability(
    frame: TripFrame,
    visible: readonly Channel[],
    mode: CameraArrangementMode,
): CameraAvailability {
    const presence: Partial<Record<Channel, CameraPresence>> = {};
    for (const channel of visible) presence[channel] = cameraPresence(frame, channel);
    const order = [...visible];
    const main = order[0];
    if (mode === "main" && main && presence[main] === "absent") {
        const standIn = order.findIndex((channel) => presence[channel] === "recording");
        if (standIn > 0) {
            order[0] = order[standIn]!;
            order[standIn] = main;
        }
    }
    return { order, presence };
}

export function sameCameraAvailability(a: CameraAvailability, b: CameraAvailability): boolean {
    return (
        a.order.length === b.order.length &&
        a.order.every((channel, index) => b.order[index] === channel && a.presence[channel] === b.presence[channel])
    );
}

/**
 * Availability over the content range [startSec, endSec), split where it
 * changes. Adjacent intervals with the same availability merge, so the export
 * re-lays its frame only where the picture actually changes.
 */
export function cameraAvailabilitySpans(
    trip: Trip,
    visible: readonly Channel[],
    mode: CameraArrangementMode,
    startSec: number,
    endSec: number,
): CameraAvailabilitySpan[] {
    const spans: CameraAvailabilitySpan[] = [];
    for (const segment of trip.timeline.segments) {
        const from = Math.max(startSec, segment.contentStart);
        const to = Math.min(endSec, segment.contentEnd);
        if (from >= to) continue;
        const frame = trip.frames[segment.frameIndex];
        if (!frame) continue;
        const availability = frameCameraAvailability(frame, visible, mode);
        const previous = spans.at(-1);
        if (previous && previous.endSec >= from - 1e-9 && sameCameraAvailability(previous.availability, availability)) {
            previous.endSec = to;
        } else {
            spans.push({ startSec: from, endSec: to, availability });
        }
    }
    return spans;
}

/** Whether any of `visible` has footage somewhere in [startSec, endSec). */
export function anyCameraRecords(trip: Trip, visible: readonly Channel[], startSec: number, endSec: number): boolean {
    return cameraAvailabilitySpans(trip, visible, "equal", startSec, endSec).some((span) =>
        visible.some((channel) => span.availability.presence[channel] === "recording"),
    );
}
