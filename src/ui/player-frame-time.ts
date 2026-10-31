// Privacy geometry uses the frame each channel actually displays, including
// neighbour-file playback and held boundary frames. The timeline playhead is
// intentionally separate: it may report a pending seek or another camera.

import { createSubscribers } from "../subscribers.js";
import { candidateContentStart } from "../export-range.js";
import type { Channel } from "../parsers/types.js";
import { tripCandidatesByChannel, type Trip, type VideoCandidate } from "../trips.js";
import { isEditableContentTime, presentedMediaTime, type PresentedFrame } from "../video-frame-time.js";
import { channelPlayers, forEachVideoSlot } from "./dom.js";
import { videoAttachedFile } from "./player-video-src.js";
import { activeTrip } from "./state.js";

let frames = new WeakMap<HTMLVideoElement, PlayerFrameObservation>();
let pendingFrames = new WeakSet<HTMLVideoElement>();
let candidates = new WeakMap<Trip, Map<Channel, Map<File, VideoCandidate>>>();
const listeners = createSubscribers("player-frames");

export interface PlayerFrameObservation extends Readonly<PresentedFrame> {
    readonly observedAtMs: number;
}

export interface ChannelPresentedFrame {
    trip: Trip;
    video: HTMLVideoElement;
    file: File;
    contentSec: number;
}

export function subscribePlayerFrames(listener: () => void): () => void {
    return listeners.subscribe(listener);
}

/** Returns the cached physical-slot observation, unchanged until another
 *  compositor callback. observedAtMs uses the performance.now() clock. A seek
 *  can retain the previous observation; this does not imply editing is ready. */
export function videoPresentedFrame(video: HTMLVideoElement): PlayerFrameObservation | null {
    const frame = frames.get(video);
    if (
        !frame ||
        video.readyState < 2 ||
        frame.file !== videoAttachedFile.get(video) ||
        frame.src !== video.src ||
        !Number.isFinite(frame.mediaTime) ||
        !Number.isFinite(frame.observedAtMs)
    )
        return null;
    return frame;
}

/** Resolves a supplied capture PTS, or the latest compositor PTS for preview. */
export function channelPresentedFrame(
    channel: Channel,
    requireSettled = false,
    mediaTime?: number,
): ChannelPresentedFrame | null {
    const trip = activeTrip();
    const video = channelPlayers[channel];
    const file = videoAttachedFile.get(video);
    if (!trip || !file) return null;
    const supplied = mediaTime === undefined ? null : { file, src: video.src, mediaTime };
    const time = presentedMediaTime(
        {
            file,
            src: video.src,
            currentTime: video.currentTime,
            readyState: video.readyState,
            seeking: video.seeking,
            isFramePending: supplied === null && pendingFrames.has(video),
            hasFrameCallbacks: supplied !== null || typeof video.requestVideoFrameCallback === "function",
        },
        supplied ?? frames.get(video) ?? null,
        requireSettled,
    );
    if (time === null) return null;
    let byChannel = candidates.get(trip);
    if (!byChannel) {
        byChannel = new Map();
        candidates.set(trip, byChannel);
    }
    let byFile = byChannel.get(channel);
    if (!byFile) {
        // Frame slots own the resolved channel. A generic MP4 can have null
        // channel metadata while being assigned to the front slot.
        byFile = new Map(tripCandidatesByChannel(trip, channel).map((candidate) => [candidate.file, candidate]));
        byChannel.set(channel, byFile);
    }
    const candidate = byFile.get(file);
    if (!candidate) return null;
    const contentSec = candidateContentStart(trip.timeline, candidate) + time;
    if (requireSettled && !isEditableContentTime(contentSec, trip.timeline.contentDurationSec)) return null;
    return { trip, video, file, contentSec };
}

/** Gestures remain attached to the frame where they began. A seek, source
 *  promotion or playback resumed mid-drag must not write a new seed. */
export function samePresentedFrame(a: ChannelPresentedFrame | null, b: ChannelPresentedFrame | null): boolean {
    return (
        a !== null &&
        b !== null &&
        a.trip === b.trip &&
        a.video === b.video &&
        a.file === b.file &&
        a.contentSec === b.contentSec
    );
}

/** Observe both physical slots before any source is loaded, so entering
 *  export on a paused frame already has its exact presentation timestamp. */
export function initPlayerFrameTimes(): void {
    forEachVideoSlot((video) => {
        if (typeof video.requestVideoFrameCallback !== "function") return;
        let callbackId: number | null = null;
        const cancel = (): void => {
            if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
            callbackId = null;
        };
        const arm = (): void => {
            if (callbackId !== null) return;
            const file = videoAttachedFile.get(video);
            const src = video.src;
            if (!file || !src) return;
            callbackId = video.requestVideoFrameCallback((now, metadata) => {
                callbackId = null;
                // An MSE attachment can claim the element before disposal of
                // the old source finishes. Never label its final frame anew.
                if (videoAttachedFile.get(video) !== file || video.src !== src) return;
                // Presentation can precede the readyState update. Preserve its
                // PTS now; readers still require decoded pixels before use.
                const previous = frames.get(video);
                frames.set(video, { file, src, mediaTime: metadata.mediaTime, observedAtMs: now });
                // A seek's frame can arrive before seeked, with its PTS before
                // the requested media time. Acknowledge it now; the seeking
                // guard still blocks edits until the media element settles.
                // A repeated old PTS does not acknowledge the pending seek.
                if (!video.seeking || previous?.mediaTime !== metadata.mediaTime) pendingFrames.delete(video);
                listeners.emit();
                arm();
            });
        };
        video.addEventListener("emptied", () => {
            cancel();
            frames.delete(video);
            pendingFrames.add(video);
        });
        video.addEventListener("loadstart", () => {
            cancel();
            frames.delete(video);
            pendingFrames.add(video);
            arm();
        });
        // A paused source may present its only frame before loadedmetadata is
        // delivered. Subscribe at loadstart and retain that first observation.
        video.addEventListener("loadedmetadata", arm);
        video.addEventListener("play", arm);
        video.addEventListener("seeking", () => {
            pendingFrames.add(video);
            // Keep the pending callback: cancelling after the seek's frame
            // reaches the compositor can miss the only frame of a paused seek.
            arm();
        });
        video.addEventListener("seeked", () => {
            const frame = frames.get(video);
            // A seek to the already displayed PTS can finish without another
            // compositor submission, especially the initial slave seek to 0.
            if (
                !video.seeking &&
                frame?.file === videoAttachedFile.get(video) &&
                frame?.src === video.src &&
                frame.mediaTime === video.currentTime
            )
                pendingFrames.delete(video);
        });
        arm();
    });
}

export function _resetForTests(): void {
    frames = new WeakMap();
    pendingFrames = new WeakSet();
    candidates = new WeakMap();
    listeners.clear();
}
