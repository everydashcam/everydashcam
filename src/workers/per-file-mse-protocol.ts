// Wire payloads between PerFileMseBackend (src/per-file-mse.ts) and
// workers/per-file-mse-worker.ts.
//
// Why it does not fit a pure RPC shape: this is a long-lived feed loop with
// push events in both directions. "init" is a one-shot request/reply
// (metadata read → codec mime); after that, control messages from main
// (start-feed, tick, seek) are fire-and-forget, and data from the
// worker (init-segment, media-segment, feed-done, seek-done, error) is a
// push stream. So:
//   - init                                   → request (await ack)
//   - start-feed, tick, seek                 → main → worker notifications
//   - init-segment, media-segment, ...       → worker → main notifications
//
// Transfer note: init/media segment bytes are sent via the framework's
// ctx.transfer / notify(transfer) - zero-copy ownership move. The
// receiving side gets the ArrayBuffer and must treat it as immutable from
// the sender's perspective.

export type AdpcmPlaybackCodec = "opus" | "aac";

const ADPCM_PLAYBACK_CODEC_MIMES: readonly [AdpcmPlaybackCodec, string][] = [
    ["opus", 'audio/mp4; codecs="opus"'],
    ["aac", 'audio/mp4; codecs="mp4a.40.2"'],
];

/**
 * MSE-playable encode targets for live ADPCM playback, in preference order.
 * Opus comes first because it is the established Chromium/Firefox live path;
 * Safari rejects it and therefore naturally returns AAC only. The worker still
 * probes whether it can encode each returned codec before choosing one.
 */
export function getMseAdpcmPlaybackCodecs(isTypeSupported: (mime: string) => boolean): AdpcmPlaybackCodec[] {
    return ADPCM_PLAYBACK_CODEC_MIMES.filter(([, mime]) => isTypeSupported(mime)).map(([codec]) => codec);
}

/** "init" request payload. */
export interface InitRequestData {
    /** Source file. The worker reads it via blob.slice / blob.arrayBuffer. */
    file: File;
    /** Feed start position in seconds from file beginning. */
    startSec: number;
    /**
     * When true, the audio track is IMA ADPCM (Mio/Navman) that mediabunny
     * cannot read. The worker ignores the container's audio track and instead
     * decodes the ADPCM itself (transcode/adpcm-audio.ts) and re-encodes it to
     * the first codec that both MediaSource can play and the worker can encode.
     * Video stays a stream-copy. Default false.
     */
    transcodeAdpcmAudio?: boolean;
    /**
     * Encode codecs that the main thread's MediaSource reports as playable,
     * ordered by preference. Chromium/Firefox prefer Opus here: that is the
     * long-standing, manually verified live-ADPCM path. Safari rejects
     * Opus-in-MP4 and therefore sends AAC only. Export remains AAC-first.
     */
    adpcmPlaybackCodecs?: AdpcmPlaybackCodec[];
}

/** "init" reply payload. Lets the main thread set up MediaSource + SourceBuffer
 *  with the right mime AND fall back to a video-only mime when the audio codec
 *  the worker chose is not MSE-playable on this browser. */
export interface InitResult {
    /** Full RFC 6381 codec mime, including audio if the worker added a track. */
    codecMime: string;
    /**
     * Video-only mime (no audio codec). Main falls back to this - and tells the
     * worker to drop audio via MSE_NOTIFY_DROP_AUDIO - when the combined
     * video+audio mime is rejected despite the earlier audio-only preflight.
     * Silent video beats a hard fail.
     */
    videoOnlyMime: string;
    /** Whether the worker found a usable audio track - used by main for UI/log. */
    hasAudio: boolean;
    /** True when the audio in codecMime came from our ADPCM re-encode. */
    audioTranscoded: boolean;
}

/** "start-feed" notification: main thread is ready to accept fMP4 chunks.
 *  Worker starts mediabunny Output + feed loop on this signal. cycleId
 *  tags subsequent init/media-segment/seek-done messages so main can drop
 *  stale chunks emitted by a previous cycle whose cancellation callbacks
 *  fired AFTER this start-feed. */
export interface StartFeedNotificationData {
    cycleId: number;
    /**
     * Feed origin in seconds, overriding the init request's startSec. A worker
     * initialized ahead of time (the player warms the next clip's backend while
     * the current clip plays) starts wherever the clip is finally attached.
     */
    startSec?: number;
}

/** "tick" notification: periodic state push from main so the worker can
 *  drive backpressure without touching the <video> element. Sent every
 *  ~200 ms and on every SourceBuffer updateend. */
export interface TickNotificationData {
    /** video.currentTime at tick time. */
    currentTime: number;
    /** Pending append ops on the main side - worker pauses feed if too many in flight. */
    appendQueueLen: number;
    /** Current video.playbackRate. Worker scales its buffer-ahead target by
     *  this: at rate=N, the same wall-clock cushion requires N times more
     *  video seconds buffered. */
    playbackRate: number;
    /** SourceBuffer quota recovery keeps queued appends pending. */
    appendPaused?: boolean;
}

/** "seek" notification: in-backend reseek. Worker aborts the current feed,
 *  cancels its Output, AND starts a brand-new feed cycle from startSec all
 *  in one step. Worker tags every emitted segment with cycleId so main can
 *  drop stragglers from a cancelled prior cycle - so this path does NOT
 *  need a phase-1 ack round-trip. */
export interface SeekNotificationData {
    startSec: number;
    cycleId: number;
}

/** "init-segment" notification: ftyp + moov as one chunk. Atomic append. */
export interface InitSegmentNotificationData {
    cycleId: number;
    bytes: Uint8Array;
}

/** "media-segment" notification: moof + mdat as one chunk. */
export interface MediaSegmentNotificationData {
    cycleId: number;
    bytes: Uint8Array;
    /** Verified video keyframe timestamps in this fragment, in seconds. */
    videoKeyframeTimestamps: number[];
}

/** "feed-done" notification: mediabunny finished feeding the whole file. */
export interface FeedDoneNotificationData {
    cycleId: number;
}

/** "seek-done" notification: first video media segment after the new startSec emitted. */
export interface SeekDoneNotificationData {
    cycleId: number;
}

/** "error" notification: terminal failure inside the worker. The player
 *  classifies the failure before retrying or showing a playback error. */
export interface ErrorNotificationData {
    reason: string;
    message?: string;
}

export const MSE_REQUEST_INIT = "init";
export const MSE_NOTIFY_START_FEED = "start-feed";
/** "drop-audio" notification: main found the audio codec not MSE-playable on
 *  this browser and rebuilt the SourceBuffer video-only. Sent before start-feed,
 *  so the worker skips the audio track when it builds the Output. */
export const MSE_NOTIFY_DROP_AUDIO = "drop-audio";
export const MSE_NOTIFY_TICK = "tick";
export const MSE_NOTIFY_SEEK = "seek";
export const MSE_NOTIFY_INIT_SEGMENT = "init-segment";
export const MSE_NOTIFY_MEDIA_SEGMENT = "media-segment";
export const MSE_NOTIFY_FEED_DONE = "feed-done";
export const MSE_NOTIFY_SEEK_DONE = "seek-done";
export const MSE_NOTIFY_ERROR = "error";
