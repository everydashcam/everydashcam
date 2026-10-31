// Per-file MSE backend: plays one MP4/TS file through MediaSource on the main
// thread, with all CPU-heavy work (mediabunny demux + fragmented MP4 mux +
// feed loop) offloaded to a dedicated Web Worker (workers/per-file-mse-worker.ts).
//
// Why a worker:
//   Profiling cold-start TS attach on a 350 MB Juscar file showed ~100% main
//   thread busy in mediabunny operations (readSection 49%, addEncodedVideoPacket
//   18%, our feedVideo 15%, markNextPacket 15%) for 5+ seconds. With main
//   thread saturated, MediaSource.sourceopen / SourceBuffer.updateend events
//   sit in the event-loop queue and do not dispatch, which manifests as 4-10
//   sec playback start latency on TS and hev1 HEVC files. MP4 native pipeline
//   does not hit this because the browser demuxes off the main thread in
//   native code; we only hit it when our own JS-based pipeline is required.
//
// Scope of this backend: HEVC sample entry hev1 (mediabunny remuxes to hvc1),
// MPEG-TS/Matroska containers, and otherwise-native MP4/MOV whose ADPCM audio
// must be decoded and re-encoded. Ordinary ISOBMFF goes straight to <video>.
//
// Main side responsibilities:
//   - Lifecycle of WorkerClient, MediaSource, SourceBuffer.
//   - appendBuffer ordering through a local queue (SB.updating blocks direct
//     calls; ordering across the queue preserves moof/mdat sequence).
//   - Sliding-window trim and QuotaExceededError aggressive trim+retry.
//   - Periodic "tick" notification so the worker can drive backpressure
//     without touching the <video> element.
//
// Architecturally simpler than the removed src/seamless.ts (per-trip MSE):
// scope = ONE FILE. One worker -> one MediaSource -> one SourceBuffer.
// At file end: worker emits feed-done, we call endOfStream.

import { createSerialQueue } from "./serial-queue.js";
import { createLogger } from "./log.js";
import {
    MSE_NOTIFY_DROP_AUDIO,
    MSE_NOTIFY_ERROR,
    MSE_NOTIFY_FEED_DONE,
    MSE_NOTIFY_INIT_SEGMENT,
    MSE_NOTIFY_MEDIA_SEGMENT,
    MSE_NOTIFY_SEEK,
    MSE_NOTIFY_SEEK_DONE,
    MSE_NOTIFY_START_FEED,
    MSE_NOTIFY_TICK,
    MSE_REQUEST_INIT,
    getMseAdpcmPlaybackCodecs,
    type InitRequestData,
    type InitResult,
    type PerFileMseWorkerContract,
    type SeekNotificationData,
    type StartFeedNotificationData,
    type TickNotificationData,
} from "./workers/per-file-mse-protocol.js";
import { createTypedWorkerClient, type TypedWorkerClient } from "./workers/_protocol/worker-client.js";
import type { WorkerMessage } from "./workers/_protocol/worker-contract.js";

const log = createLogger("per-file-mse");

const READY_TIMEOUT_MS = 10000;
const SOURCE_OPEN_TIMEOUT_MS = 5000;

// Safety timeout for seek-done: worker emits first media segment at the
// new startSec. Includes any in-queue ops in the worker's serialize chain,
// the keyframe read from disk, and the mediabunny mux. Healthy: < 500 ms.
// Slow SD card: a few seconds. 8 s caps the wait so a wedged worker does
// not appear hung indefinitely; on timeout the caller is told (warn) and
// the next seek tries again. We do NOT mark the file unplayable on this
// timeout - it can fire just because the worker had a packed serialize
// queue, and recovery is automatic on the next user gesture.
const SEEK_DONE_TIMEOUT_MS = 8000;

/**
 * Races a promise against a millisecond timeout. Returns `true` if the
 * timeout fired (i.e. promise did not settle in time), `false` if the promise
 * resolved normally. Rejections of the underlying promise are surfaced.
 */
function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const t = setTimeout(() => resolve(true), ms);
        p.then(
            () => {
                clearTimeout(t);
                resolve(false);
            },
            (err) => {
                clearTimeout(t);
                reject(err);
            },
        );
    });
}

// Sliding window trim: seconds of buffer to keep behind video.currentTime
// before remove(0, ct - behind). Lower = higher chance that a backward
// scrub requires a full re-feed; higher = more memory. 3 s is enough for
// the browser's own seek-backward smoothing while leaving headroom for
// the worker's scaled ahead-window at high playbackRate: at 8x, ahead
// peaks at 30 s of video which is ~37 MB on 10 Mbit/s TS, and Chrome's
// SourceBuffer quota is ~50 MB - the behind window has to stay small.
const DEFAULT_BUFFER_BEHIND_SEC = 3;

// Trim loop interval. At 8x playback currentTime advances 8 s per second
// of wall clock; with 500 ms cadence the un-trimmed tail between ticks
// grows by ~4 s of video, keeping the SB total well below quota.
const TRIM_TICK_MS = 500;

// Tick interval for currentTime/buffered reports to the worker. The worker
// uses these for its backpressure decisions; finer = more accurate gating
// at higher postMessage rate.
const TICK_MS = 200;
const QUOTA_STALL_TIMEOUT_MS = 10000;
// Stay before the keyframe despite MP4 timestamp rounding (video uses 57600 Hz).
const TRIM_KEYFRAME_MARGIN_SEC = 0.001;

interface PerFileMseBackendOptions {
    /** Source file. */
    file: File;
    /**
     * Feed start position in seconds from file beginning. Default 0. For
     * out-of-buffer seek the caller disposes the old backend and creates a
     * new one with startSec=target; the worker snaps to the nearest preceding
     * keyframe internally.
     */
    startSec?: number;
    /**
     * Total duration of the file in seconds, from the indexer. Used to set
     * MediaSource.duration immediately after sourceopen - without it the
     * browser leaves duration as NaN until the first media segment lands,
     * and `<video>.currentTime = N` for any N outside the (still empty)
     * buffered range silently snaps to 0. Manifested as: after an
     * out-of-buffer seek the backend re-attached, the SourceBuffer filled
     * with [seekTarget, seekTarget+5], yet `<video>.currentTime` stayed at
     * 0 and the screen went black.
     */
    durationSec?: number;
    /**
     * IMA-ADPCM audio (Mio/Navman): the worker decodes the ADPCM and re-encodes
     * it (AAC, else Opus, else drops it) on the fly rather than stream-copying
     * the (unreadable) audio track. Passed straight through to the worker's init
     * request. Default false.
     */
    transcodeAdpcmAudio?: boolean;
    /**
     * Called on init or runtime failure. The caller decides whether to retry
     * or show a playback error; a runtime fault does not imply an unsupported codec.
     */
    onError?: (reason: string, error?: unknown) => void;
}

type AppendOp =
    | { type: "data"; bytes: Uint8Array; videoKeyframeTimestamps?: number[] }
    | { type: "remove"; from: number; to: number };

/**
 * Per-file MSE backend. Lifecycle:
 *   - constructor: stores options only, allocates nothing.
 *   - attach(video): spawns worker, opens MediaSource + SourceBuffer, kicks
 *     off the worker feed. Resolves when MediaSource is open AND the worker
 *     has confirmed codec readiness; actual playback starts later (first
 *     keyframe lands in SB, <video> fires loadedmetadata).
 *   - dispose(): MUST be called on every file change.
 */
export class PerFileMseBackend {
    private readonly _file: File;
    private startSec: number;
    private readonly knownDurationSec: number | null;
    private readonly transcodeAdpcmAudio: boolean;
    private onErrorCb: ((reason: string, error?: unknown) => void) | undefined;
    private readonly logger = log.child("");

    private client: TypedWorkerClient<PerFileMseWorkerContract> | null = null;
    // Worker init reply. Set by ensureWorkerReady, whether attach() or an
    // earlier prewarm() ran it.
    private initResult: InitResult | null = null;
    private mediaSource: MediaSource | null = null;
    private blobUrl: string | null = null;
    private sourceBuffer: SourceBuffer | null = null;
    private video: HTMLVideoElement | null = null;
    private tickInterval: ReturnType<typeof setInterval> | null = null;
    private trimInterval: ReturnType<typeof setInterval> | null = null;
    private updateEndHandler: (() => void) | null = null;
    private appendQueue: AppendOp[] = [];
    // updating can become false before updateend is dispatched. Keep the op
    // until its event so a late completion cannot confirm the next append.
    private lastSubmittedOp: AppendOp | null = null;
    private lastSubmittedCycleId = 0;
    private bufferedVideoKeyframes: number[] = [];
    private quotaRetryAttempted = false;
    private quotaBlocked = false;
    private quotaLastProgressAt = 0;
    private quotaLastCurrentTime = 0;
    // Pending seek-done waiter. Single-valued because enqueueOp serializes
    // attach/seekTo: only one in-flight seek can exist at a time.
    private seekDoneResolver: (() => void) | null = null;
    // Serialization gate for attach/seekTo: rapid chart-drag seekTo() bursts
    // would otherwise interleave - each in-flight seek owns the single
    // seekDoneResolver and would clobber a parallel one. The queue keeps
    // ops strictly sequential.
    private readonly enqueueOp = createSerialQueue();
    // Seek coalescing: chart-drag emits many seekTo() calls per second; we
    // only ever need to actually seek to the LATEST target. Concurrent
    // callers piggyback on the same in-flight promise and the impl reads
    // the latest target right before executing.
    private pendingSeekTarget: number | null = null;
    private pendingSeekPromise: Promise<void> | null = null;
    // pausedBySeek = true while seekTo's own pause() is in force. Cleared
    // by seekPlayListener when the user presses play during the seek,
    // which signals "do NOT auto-resume" in seekTo's finally.
    private pausedBySeek = false;
    private seekPlayListener: (() => void) | null = null;
    // Monotonic id of the feed cycle currently expected in worker messages.
    // Incremented on every seek; passed to worker in start-feed. Worker
    // tags each emitted segment/seek-done with the cycle id of the cycle
    // that produced it. Main drops messages whose cycleId is below
    // this counter - they are stragglers from a cancelled cycle.
    private currentCycleId = 0;
    // AbortController for the init request. dispose() aborts it so the
    // attach() promise unwinds without waiting for the 10-second timeout.
    private initAbort: AbortController | null = null;
    private disposed = false;
    private failed = false;
    private done = false;

    constructor(opts: PerFileMseBackendOptions) {
        this._file = opts.file;
        this.startSec = Math.max(0, opts.startSec ?? 0);
        this.knownDurationSec = opts.durationSec ?? null;
        this.transcodeAdpcmAudio = opts.transcodeAdpcmAudio ?? false;
        this.onErrorCb = opts.onError;
    }

    /** Backing File. Used by player.ts to check same-file reuse before seekTo. */
    get file(): File {
        return this._file;
    }

    /** Feed start position in seconds from the beginning of the file. */
    get fileStartSec(): number {
        return this.startSec;
    }

    /**
     * Moves the feed origin of a backend that has not started feeding yet: a
     * prewarmed backend is taken for whatever position the clip is attached
     * at. Once the feed runs, seekTo() is the only way to move.
     */
    setFeedStart(startSec: number): void {
        if (this.sourceBuffer) throw new Error("feed already started");
        this.startSec = Math.max(0, startSec);
    }

    /**
     * Replaces the failure callback. A prewarmed backend is created before the
     * player knows which attach will consume it; the real handler is bound
     * when it is taken.
     */
    setErrorHandler(onError: ((reason: string, error?: unknown) => void) | undefined): void {
        this.onErrorCb = onError;
    }

    /**
     * true once the file has been fully fed (mediaSource.endOfStream() called).
     * Caller must do a full dispose + new attach rather than an idempotent
     * skip - e.g. for trip loop mode on a single file.
     */
    get isDone(): boolean {
        return this.done;
    }

    /** True after fail() - backend is no longer usable; caller should dispose+attach fresh. */
    get isFailed(): boolean {
        return this.failed;
    }

    /** True while seekTo() holds the <video> paused for its own reseek. The
     *  player must not read that pause as the user stopping playback. */
    get isPausedBySeek(): boolean {
        return this.pausedBySeek;
    }

    /**
     * Spawns the worker, opens MediaSource + SourceBuffer on the main thread,
     * lets the worker drive demux+mux+feed via wire messages. Resolves once
     * MediaSource is open AND the worker has reported its codec mime - at
     * that point playback can start as soon as the first keyframe reaches SB.
     */
    attach(video: HTMLVideoElement): Promise<void> {
        return this.enqueueOp(() => this.attachImpl(video));
    }

    /**
     * Runs the worker phase ahead of attach(): spawns the worker and reads the
     * file's metadata without touching any <video>. The player warms the next
     * clip's backend while the current clip plays, so the attach at the clip
     * boundary only has to open the MediaSource. Resolves either way; a
     * failure reaches the error handler, after which the backend is dead
     * (isFailed) and attach() exits silently - the player drops such a
     * backend and attaches a fresh one instead.
     */
    prewarm(): Promise<void> {
        return this.enqueueOp(async () => {
            await this.ensureWorkerReady();
        });
    }

    /**
     * Phase 1: spawns the worker and awaits its init reply. The worker opens
     * the mediabunny Input, reads metadata and replies with the codec mime -
     * addSourceBuffer needs the mime, so attach waits for this before touching
     * MediaSource. The timeout is enforced via a local AbortSignal combined
     * with the dispose() path (initAbort). Null when the backend was disposed
     * or failed meanwhile; the failure has already been reported.
     */
    private async ensureWorkerReady(): Promise<InitResult | null> {
        if (this.disposed || this.failed) return null;
        if (this.initResult) return this.initResult;
        try {
            const worker = new Worker(new URL("./workers/per-file-mse-worker.ts", import.meta.url), {
                type: "module",
                name: "per-file-mse-worker",
            });
            this.client = createTypedWorkerClient<PerFileMseWorkerContract>(worker, {
                name: "per-file-mse",
                // Playback reports only after its retry/tail recovery fails.
                reportIdleCrash: false,
                onCrash: () => this.fail("worker-crashed"),
                onNotification: (msg) => this.onWorkerNotification(msg),
            });
            this.initAbort = new AbortController();
            const timeoutTimer = setTimeout(() => this.initAbort?.abort(), READY_TIMEOUT_MS);
            let initResult: InitResult;
            try {
                // Live playback and exported files have different codec
                // priorities. Chromium's original, manually verified ADPCM
                // path was Opus; prefer it whenever MSE can consume
                // Opus-in-MP4. Safari reports Opus unsupported and keeps the
                // AAC path added specifically for it.
                const adpcmPlaybackCodecs = this.transcodeAdpcmAudio
                    ? getMseAdpcmPlaybackCodecs((mime) => MediaSource.isTypeSupported(mime))
                    : undefined;
                const initReq: InitRequestData = {
                    file: this._file,
                    startSec: this.startSec,
                    transcodeAdpcmAudio: this.transcodeAdpcmAudio,
                    adpcmPlaybackCodecs,
                };
                initResult = await this.client.request(MSE_REQUEST_INIT, initReq, {
                    signal: this.initAbort.signal,
                });
            } catch (e) {
                clearTimeout(timeoutTimer);
                // dispose() during await is the normal "abandoned attach" path;
                // not a failure, no onError.
                if (this.disposed) return null;
                this.fail("worker-ready-failed", e);
                return null;
            }
            clearTimeout(timeoutTimer);
            this.initAbort = null;
            if (this.disposed) return null;
            this.initResult = initResult;
            return initResult;
        } catch (e) {
            if (this.disposed) return null;
            this.fail("attach-uncaught", e);
            return null;
        }
    }

    private async attachImpl(video: HTMLVideoElement): Promise<void> {
        if (this.disposed) return;
        this.video = video;
        try {
            const initResult = await this.ensureWorkerReady();
            if (!initResult || !this.client) return;
            if (this.disposed) return;
            let hasAudio = initResult.hasAudio;
            // Pick the mime the SourceBuffer will actually use. The combined
            // (video+audio) mime is preferred. The per-codec preflight above is
            // necessarily audio-only; this final check catches a browser that
            // rejects the specific video+audio combination.
            // Audio support is independent of video support, including copied
            // tracks. Keep playable video and make the worker's track set match.
            let codecMime = initResult.codecMime;
            if (!MediaSource.isTypeSupported(codecMime)) {
                if (hasAudio && MediaSource.isTypeSupported(initResult.videoOnlyMime)) {
                    this.logger.warn("audio codec not MSE-playable, dropping audio and keeping video", {
                        file: this._file.name,
                        rejected: codecMime,
                        fallback: initResult.videoOnlyMime,
                    });
                    this.client.notify(MSE_NOTIFY_DROP_AUDIO);
                    codecMime = initResult.videoOnlyMime;
                    hasAudio = false;
                } else {
                    return this.fail(`mime-not-supported: ${codecMime}`);
                }
            }

            // Phase 2: MediaSource open + SourceBuffer add.
            this.mediaSource = new MediaSource();
            this.blobUrl = URL.createObjectURL(this.mediaSource);
            const sourceOpenPromise = new Promise<void>((resolve, reject) => {
                const ms = this.mediaSource!;
                const t = setTimeout(() => reject(new Error("sourceopen-timeout")), SOURCE_OPEN_TIMEOUT_MS);
                ms.addEventListener(
                    "sourceopen",
                    () => {
                        clearTimeout(t);
                        resolve();
                    },
                    { once: true },
                );
            });
            video.src = this.blobUrl;
            // Explicit load() is important when re-attaching to the same video
            // element after a previous backend - without it Chrome may not
            // pick up the new src and never fire sourceopen.
            video.load();
            try {
                await sourceOpenPromise;
            } catch (e) {
                return this.fail("sourceopen-timeout", e);
            }
            if (this.disposed) return;

            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(codecMime);
            } catch (e) {
                return this.fail("addSourceBuffer-threw", e);
            }
            // Publish duration up front so the browser knows the timeline span
            // even before the first media segment lands. Without this, an
            // out-of-buffer seek that triggers a backend re-attach loses the
            // pending currentTime: the new MediaSource has duration=NaN, and
            // `<video>.currentTime = N` silently snaps to 0 when N falls
            // outside the (still empty) buffered range.
            if (this.knownDurationSec !== null && this.knownDurationSec > 0) {
                try {
                    this.mediaSource.duration = this.knownDurationSec;
                } catch (e) {
                    this.logger.debug("set mediaSource.duration failed", e);
                }
            }
            this.sourceBuffer.mode = "segments";
            this.updateEndHandler = () => {
                const completed = this.lastSubmittedCycleId === this.currentCycleId ? this.lastSubmittedOp : null;
                this.lastSubmittedOp = null;
                if (completed?.type === "data") {
                    this.quotaRetryAttempted = false;
                    this.bufferedVideoKeyframes.push(...(completed.videoKeyframeTimestamps ?? []));
                } else if (completed?.type === "remove") {
                    this.bufferedVideoKeyframes = this.bufferedVideoKeyframes.filter((time) => time >= completed.to);
                }
                // Reactive trim on every successful op so the behind-window
                // tracks currentTime without waiting for the next interval.
                // At rate=8x the periodic 500ms tickTrim can be starved by
                // back-to-back appendBuffer ops; running it here keeps the
                // SB total below quota under sustained high-rate playback.
                this.maybeEnqueueTrim();
                this.drainAppendQueue();
                // Post an out-of-band tick so the worker sees buffered growth
                // immediately and can resume feeding without waiting up to
                // TICK_MS for the next periodic tick.
                this.sendTick();
            };
            this.sourceBuffer.addEventListener("updateend", this.updateEndHandler);

            // Phase 3: ask the worker to start feeding.
            const startNtf: StartFeedNotificationData = { cycleId: this.currentCycleId, startSec: this.startSec };
            this.client.notify(MSE_NOTIFY_START_FEED, startNtf);

            if (this.disposed) return;
            // Periodic tick + sliding-window trim.
            this.tickInterval = setInterval(() => this.sendTick(), TICK_MS);
            this.trimInterval = setInterval(() => this.tickTrim(), TRIM_TICK_MS);

            this.logger.info("attach: stream up", {
                file: this._file.name,
                codec: codecMime,
                hasAudio,
            });
        } catch (e) {
            if (this.disposed) return;
            return this.fail("attach-uncaught", e);
        }
    }

    /**
     * In-file reseek with coalescing. Asks the worker to abort current feed
     * and restart from newStartSec; concurrently clears SourceBuffer so the
     * browser does not find stale data when video.currentTime = newStartSec.
     * Resolves once the first media segment after the new startSec has
     * landed in SB.
     */
    seekTo(newStartSec: number): Promise<void> {
        this.pendingSeekTarget = newStartSec;
        if (this.pendingSeekPromise !== null) {
            return this.pendingSeekPromise;
        }
        // Pause the video for the duration of the seek - lets the browser
        // stop decoding the old position (no contention with worker mux/feed)
        // and shows the user a frozen frame as clear "seeking" feedback
        // instead of stale playback while data lands at the new target.
        //
        // pausedBySeek tracks whether our pause is still in force. If the
        // user takes control (presses play / space-toggle) during the seek,
        // a "play" event fires; the listener clears pausedBySeek so the
        // finally clause does NOT auto-resume.
        const v = this.video;
        const wasPlaying = v !== null && !v.paused && !v.ended;
        if (wasPlaying && v) {
            try {
                v.pause();
            } catch {
                /* ignore */
            }
            this.pausedBySeek = true;
            const onPlay = () => {
                this.pausedBySeek = false;
            };
            this.seekPlayListener = onPlay;
            v.addEventListener("play", onPlay);
        }
        const promise = this.enqueueOp(async () => {
            try {
                while (this.pendingSeekTarget !== null && !this.disposed) {
                    const t = this.pendingSeekTarget;
                    this.pendingSeekTarget = null;
                    await this.seekToImpl(t);
                }
            } finally {
                this.pendingSeekPromise = null;
                if (this.seekPlayListener && this.video) {
                    try {
                        this.video.removeEventListener("play", this.seekPlayListener);
                    } catch {
                        /* ignore */
                    }
                    this.seekPlayListener = null;
                }
                if (this.pausedBySeek && !this.disposed && !this.failed && this.video) {
                    this.pausedBySeek = false;
                    try {
                        await this.video.play();
                    } catch {
                        /* play() can reject if the user gestured away - ignore */
                    }
                }
            }
        });
        this.pendingSeekPromise = promise;
        return promise;
    }

    private async seekToImpl(newStartSec: number): Promise<void> {
        if (this.disposed || this.failed) return;
        if (!this.client || !this.sourceBuffer || !this.mediaSource) {
            this.logger.debug("seekTo: backend not yet attached, ignoring", { newStartSec });
            return;
        }
        const target = Math.max(0, newStartSec);

        this.logger.info("seekTo: in-backend reseek", {
            file: this._file.name,
            from: this.startSec,
            to: target,
        });

        // Bump cycle id BEFORE doing anything else. Any segment messages
        // currently in flight from the old cycle (still arriving from worker
        // because cancel is fire-and-forget on the worker side) will fail
        // the cycleId check on receipt in onWorkerNotification and be dropped -
        // they cannot pollute SourceBuffer with stale data.
        this.currentCycleId++;
        this.resetQuotaRecovery();
        this.bufferedVideoKeyframes = [];

        const seekDonePromise = new Promise<void>((resolve) => {
            this.seekDoneResolver = resolve;
        });

        // Drop everything pending - any old-cycle media-segments still
        // arriving from the worker get cycleId-filtered before they reach
        // the queue, so no synchronization with worker is needed.
        //
        // The remove(0, duration) is queued but NOT awaited. SourceBuffer
        // does the remove on the media element thread in parallel with the
        // worker's seek. New media-segments arriving from the worker
        // naturally queue behind the remove and append once it finishes
        // (drainAppendQueue serializes ops via the appendQueue).
        this.appendQueue.length = 0;
        const sb = this.sourceBuffer;
        if (sb && this.mediaSource.readyState === "open") {
            try {
                if (sb.updating) sb.abort();
            } catch {
                /* ignore */
            }
            const dur = Number.isFinite(this.mediaSource.duration) ? this.mediaSource.duration : 0;
            if (dur > 0) {
                let buffered: TimeRanges | null = null;
                try {
                    buffered = sb.buffered;
                } catch {
                    /* sb detached */
                }
                if (buffered && buffered.length > 0) {
                    this.appendQueue.push({ type: "remove", from: 0, to: dur });
                    this.drainAppendQueue();
                    // No await - remove runs in parallel with worker.
                }
            }
        }
        if (this.disposed) return;

        this.startSec = target;
        this.done = false;
        // Set video.currentTime to target up front (anticipated), before
        // the new cycle's first media segment lands. With
        // MediaSource.duration set up front, a currentTime inside
        // [0, duration] does not snap to 0 - the browser just enters
        // "seeking" state and waits for data.
        if (this.video) {
            try {
                this.video.currentTime = target;
            } catch (e) {
                this.logger.debug("seekTo: set video.currentTime threw", e);
            }
        }

        // Single message: worker aborts old cycle + starts new cycle from
        // target. seek-done fires once the first media segment of the new
        // cycle has been emitted.
        const seekNtf: SeekNotificationData = { startSec: target, cycleId: this.currentCycleId };
        this.client.notify(MSE_NOTIFY_SEEK, seekNtf);
        const doneTimedOut = await withTimeout(seekDonePromise, SEEK_DONE_TIMEOUT_MS);
        this.seekDoneResolver = null;
        if (doneTimedOut) {
            this.logger.warn("seekTo: timeout - returning, caller may see video snap", {
                file: this._file.name,
                target,
            });
        }
    }

    /**
     * Releases all resources. Idempotent. Call on file change, on runtime
     * failure (internal), and on playback close.
     *
     * Body is fully synchronous; returns a resolved Promise so callers can
     * `await backend.dispose()` to drain pending microtasks before opening
     * a new MediaSource on the same <video>. removeSourceBuffer is required:
     * without it Chrome holds the SB quota until GC, and the next
     * MediaSource on the same element throws QuotaExceededError on first
     * appendBuffer.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.resetQuotaRecovery();
        this.bufferedVideoKeyframes = [];
        this.lastSubmittedOp = null;
        if (this.tickInterval !== null) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
        if (this.trimInterval !== null) {
            clearInterval(this.trimInterval);
            this.trimInterval = null;
        }
        // Resolve any pending seek waiter so caller does not hang.
        this.seekDoneResolver?.();
        this.seekDoneResolver = null;
        if (this.seekPlayListener && this.video) {
            try {
                this.video.removeEventListener("play", this.seekPlayListener);
            } catch {
                /* ignore */
            }
            this.seekPlayListener = null;
        }
        this.pausedBySeek = false;
        // Abort the in-flight init request, if any. attachImpl checks
        // this.disposed in the catch and bails silently without onError.
        this.initAbort?.abort();
        this.initAbort = null;
        if (this.client) {
            // WorkerClient disposal terminates the worker and rejects any
            // remaining request; a notification immediately before terminate
            // has no delivery guarantee and therefore cannot own cleanup.
            this.client.dispose("backend disposed");
            this.client = null;
        }
        const sb = this.sourceBuffer;
        if (sb && this.updateEndHandler) {
            try {
                sb.removeEventListener("updateend", this.updateEndHandler);
            } catch {
                /* ignore */
            }
        }
        if (sb) {
            try {
                if (sb.updating) sb.abort();
            } catch {
                /* ignore */
            }
            if (this.mediaSource && this.mediaSource.readyState === "open") {
                try {
                    this.mediaSource.removeSourceBuffer(sb);
                } catch {
                    /* ignore */
                }
            }
        }
        if (this.mediaSource && this.mediaSource.readyState === "open") {
            try {
                this.mediaSource.endOfStream();
            } catch {
                /* ignore */
            }
        }
        if (this.blobUrl) {
            try {
                URL.revokeObjectURL(this.blobUrl);
            } catch {
                /* ignore */
            }
        }
        // Detach MediaSource from the video element. Without this, video.src
        // still points at the (now-revoked) blob URL and Chrome keeps the
        // MediaSource referenced - it shows up forever in the DevTools Media
        // panel and holds the decoder graph until the <video> element itself
        // is destroyed. removeAttribute + load() is the standard MSE teardown
        // sequence (cf. clearVideoSrc / clearPreloadSlot in player.ts for the
        // native pipeline). Fires a synchronous emptied event - callers that
        // need a loading overlay during a back-to-back dispose+attach should
        // (re)show it AFTER awaiting dispose, not before.
        if (this.video) {
            try {
                this.video.removeAttribute("src");
                this.video.load();
            } catch {
                /* ignore */
            }
        }
        this.sourceBuffer = null;
        this.mediaSource = null;
        this.blobUrl = null;
        this.appendQueue = [];
    }

    /**
     * Routes worker → main push events. cycleId-tagged messages get filtered
     * against currentCycleId so stragglers from a cancelled cycle cannot
     * pollute SourceBuffer.
     */
    private onWorkerNotification(message: WorkerMessage<PerFileMseWorkerContract["events"]>): void {
        if (this.disposed || this.failed) return;
        switch (message.type) {
            case MSE_NOTIFY_INIT_SEGMENT: {
                const ntf = message.data;
                if (ntf.cycleId !== this.currentCycleId) {
                    // Stale cycle - drop. Old worker output finalized its
                    // tail fragment after we already advanced past it.
                    return;
                }
                this.appendQueue.push({ type: "data", bytes: ntf.bytes });
                this.drainAppendQueue();
                return;
            }
            case MSE_NOTIFY_MEDIA_SEGMENT: {
                const ntf = message.data;
                if (ntf.cycleId !== this.currentCycleId) return;
                this.appendQueue.push({
                    type: "data",
                    bytes: ntf.bytes,
                    videoKeyframeTimestamps: ntf.videoKeyframeTimestamps,
                });
                this.drainAppendQueue();
                return;
            }
            case MSE_NOTIFY_SEEK_DONE: {
                const ntf = message.data;
                if (ntf.cycleId !== this.currentCycleId) return;
                const r = this.seekDoneResolver;
                this.seekDoneResolver = null;
                r?.();
                return;
            }
            case MSE_NOTIFY_FEED_DONE: {
                const ntf = message.data;
                if (ntf.cycleId !== this.currentCycleId) return;
                void this.finalizeFeed();
                return;
            }
            case MSE_NOTIFY_ERROR: {
                const ntf = message.data;
                this.fail(ntf.reason, ntf.message);
                return;
            }
        }
    }

    private async finalizeFeed(): Promise<void> {
        if (this.disposed) return;
        // The FEED_DONE handler already checked cycleId === currentCycleId, so
        // this is the cycle whose feed just completed.
        const cycleAtEntry = this.currentCycleId;
        // Wait for the queue to drain to SourceBuffer, then close the stream.
        await this.waitForSbIdle();
        // A seekTo() landing in the await window bumps currentCycleId and resets
        // done=false; bailing here avoids endOfStream-ing the new cycle's
        // MediaSource and clobbering its done=false (which would force a full
        // dispose + rescan on the next same-file seek).
        if (this.disposed || this.failed || this.currentCycleId !== cycleAtEntry) return;
        if (this.mediaSource && this.mediaSource.readyState === "open") {
            try {
                this.mediaSource.endOfStream();
            } catch (e) {
                this.logger.debug("finalizeFeed: endOfStream threw", e);
            }
        }
        this.done = true;
    }

    private fail(reason: string, error?: unknown): void {
        if (this.disposed || this.failed) return;
        this.failed = true;
        const message = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
        this.logger.warn(`backend fail: ${reason}${message ? `: ${message}` : ""}`, {
            file: this._file.name,
            reason,
            error: message,
        });
        // Resolve waiters so callers do not hang.
        this.seekDoneResolver?.();
        this.seekDoneResolver = null;
        this.initAbort?.abort();
        this.initAbort = null;
        try {
            this.onErrorCb?.(reason, error);
        } catch (e) {
            this.logger.warn("onError callback threw", e);
        }
    }

    private sendTick(): void {
        if (this.disposed || !this.client) return;
        const v = this.video;
        if (!v) return;
        const ct = v.currentTime || 0;
        const rate = v.playbackRate || 1;
        const ntf: TickNotificationData = {
            currentTime: ct,
            appendQueueLen: this.appendQueue.length,
            playbackRate: rate,
            appendPaused: this.quotaBlocked,
        };
        this.client.notify(MSE_NOTIFY_TICK, ntf);
    }

    private waitForSbIdle(): Promise<void> {
        return new Promise<void>((resolve) => {
            const tick = () => {
                if (this.disposed || this.failed) return resolve();
                const sb = this.sourceBuffer;
                if (!sb) return resolve();
                if (this.appendQueue.length === 0 && !sb.updating) return resolve();
                setTimeout(tick, 20);
            };
            tick();
        });
    }

    /**
     * Trims [0, currentTime - BUFFER_BEHIND_SEC] from SourceBuffer to keep
     * it within quota. Goes through the same appendQueue as data ops to
     * preserve strict append/remove ordering (SB.updating prevents direct
     * calls during another op).
     */
    private tickTrim(): void {
        this.maybeEnqueueTrim();
    }

    /**
     * Enqueues a sliding-window remove when there is more than
     * BUFFER_BEHIND_SEC of data behind currentTime AND there is not already
     * a pending remove in the queue (avoids piling up redundant trims when
     * the SB is slow to update at high playbackRate).
     */
    private maybeEnqueueTrim(): void {
        if (this.disposed || this.failed) return;
        if (this.quotaBlocked) {
            this.tryQuotaRecovery();
            return;
        }
        const sb = this.sourceBuffer;
        const v = this.video;
        const ms = this.mediaSource;
        if (!sb || !v || !ms || ms.readyState !== "open") return;
        const ct = v.currentTime || 0;
        const cutoff = this.safeTrimEnd(ct - DEFAULT_BUFFER_BEHIND_SEC);
        if (cutoff <= 0) return;
        let buffered: TimeRanges;
        try {
            buffered = sb.buffered;
        } catch {
            return;
        }
        if (buffered.length === 0) return;
        const firstStart = buffered.start(0);
        if (cutoff <= firstStart) return;
        for (const op of this.appendQueue) {
            if (op.type === "remove") return;
        }
        this.appendQueue.push({ type: "remove", from: 0, to: cutoff });
        this.drainAppendQueue();
    }

    private drainAppendQueue(): void {
        if (this.disposed || this.failed || this.quotaBlocked) return;
        const sb = this.sourceBuffer;
        if (!sb || sb.updating || this.lastSubmittedOp) return;
        const op = this.appendQueue.shift();
        if (!op) return;
        try {
            this.lastSubmittedOp = op;
            this.lastSubmittedCycleId = this.currentCycleId;
            if (op.type === "data") {
                sb.appendBuffer(op.bytes as Uint8Array<ArrayBuffer>);
            } else {
                sb.remove(op.from, op.to);
            }
        } catch (e) {
            this.lastSubmittedOp = null;
            // QuotaExceededError - SB hit its quota. Standard MSE-spec
            // mitigation: aggressive trim + retry once. On a second failure
            // we give up - file is too large for this device even after trim.
            if (op.type === "data" && this.isQuotaExceeded(e) && !this.quotaRetryAttempted) {
                this.quotaRetryAttempted = true;
                this.quotaBlocked = true;
                this.quotaLastCurrentTime = this.video?.currentTime ?? 0;
                this.quotaLastProgressAt = performance.now();
                this.logger.warn("appendBuffer quota exceeded, waiting for safe behind trim", {
                    file: this._file.name,
                    bytes: op.bytes.byteLength,
                });
                this.appendQueue.unshift(op);
                this.sendTick();
                this.tryQuotaRecovery();
                return;
            }
            this.fail(op.type === "data" ? "appendBuffer-threw" : "remove-threw", e);
        }
    }

    private isQuotaExceeded(e: unknown): boolean {
        if (e instanceof DOMException) {
            return e.name === "QuotaExceededError" || e.code === 22;
        }
        return false;
    }

    private safeTrimEnd(cutoff: number): number {
        let boundary = 0;
        for (const time of this.bufferedVideoKeyframes) {
            if (time <= cutoff) boundary = Math.max(boundary, time);
        }
        return Math.max(0, boundary - TRIM_KEYFRAME_MARGIN_SEC);
    }

    private resetQuotaRecovery(): void {
        this.quotaBlocked = false;
        this.quotaRetryAttempted = false;
        this.quotaLastProgressAt = 0;
        this.quotaLastCurrentTime = 0;
    }

    /** Keep the rejected append queued until playback frees a complete GOP. */
    private tryQuotaRecovery(): void {
        if (this.disposed || this.failed || !this.quotaBlocked) return;
        const sb = this.sourceBuffer;
        const v = this.video;
        if (!sb || !v) {
            this.fail("appendBuffer-quota-no-sb-after-trim");
            return;
        }
        if (sb.updating || this.lastSubmittedOp) return;
        const ct = v.currentTime || 0;
        let buffered: TimeRanges;
        try {
            buffered = sb.buffered;
        } catch {
            this.fail("appendBuffer-quota-buffered-failed");
            return;
        }
        if (buffered.length === 0) {
            this.fail("appendBuffer-quota-empty-buffered");
            return;
        }
        const bufferedStart = buffered.start(0);
        const bufferedEnd = buffered.end(buffered.length - 1);

        // remove() extends to the next random-access point. An arbitrary
        // time cutoff can remove the GOP that is still being displayed.
        const trimBehindTo = this.safeTrimEnd(ct - 1);
        if (trimBehindTo > bufferedStart) {
            this.logger.info("quota: trimming behind", {
                file: this._file.name,
                trimTo: trimBehindTo,
                bufferedStart,
            });
            this.quotaBlocked = false;
            this.appendQueue.unshift({ type: "remove", from: 0, to: trimBehindTo });
            this.drainAppendQueue();
            this.sendTick();
            return;
        }

        const now = performance.now();
        if (v.paused || ct > this.quotaLastCurrentTime + 0.01) {
            this.quotaLastCurrentTime = ct;
            this.quotaLastProgressAt = now;
        }
        if (v.paused) return;
        // Future bytes cannot be discarded: the worker has already advanced
        // beyond them. Keep playing them, but never wait forever at their end.
        if (ct >= bufferedEnd - 0.05 || now - this.quotaLastProgressAt >= QUOTA_STALL_TIMEOUT_MS) {
            this.fail("appendBuffer-quota-no-safe-trim");
        }
    }
}
