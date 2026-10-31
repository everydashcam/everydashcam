// Main function of the transcode pipeline for the Simple Export Modal.
//
// Architecture (flat contract - see src/transcode/types.ts):
//
// 1. One main range (TranscodeSource = trip + channel + [startTripSec, endTripSec]).
//    The range may span multiple MP4 files in the trip - sliceTripChannelForRange
//    splits it at file boundaries; we then iterate over segments[].
//
// 2. For each segment:
//    - open Input + VideoSampleSink, iterate samples in [startInFile, endInFile)
//      decoding via the mediabunny WebCodecs decoder;
//    - per frame: drawMain (with crop) → overlays → drawWatermark (if
//      watermarkAnchor != null), then push the composited canvas to the video
//      source with the shifted output-timeline timestamp - mediabunny runs it
//      through the WebCodecs encoder and writes to the muxer.
//    - a run that paints NOTHING over the video takes the composite-free path:
//      the decoded frame goes to the encoder as-is (see noOverlayLayer).
//
// 3. Audio in parallel: AudioSampleSink → AudioSampleSource (re-encoded as
//    AAC-LC 48k/stereo). Forced resample - dashcams with mono 16k would fail
//    on encoder config otherwise (HE-AAC v1 is not supported by the Chromium
//    encoder).
//
// 4. Between segments, timestamp shifting is done via videoAccumOutSec -
//    mediabunny assembles a continuous output timeline.
//
// 5. AbortSignal is checked in the hot loop before every frame and audio sample.
//
// 6. PiP - lazy decoder: when the current pip file changes (at a trip frame
//    boundary) we swap Input/VideoSampleSink.
//
// Memory safety:
//  - VideoSampleSource.add() returns a Promise that waits for writer
//    backpressure - enough to prevent the decoder from running too far ahead.
//  - sample.close() immediately after add - VideoFrames in Chrome are counted
//    (limit ~60 in the decoder queue); forgetting close stalls the decoder.
//  - canvas - one OffscreenCanvas for the entire exec, reused.

import { throwIfCancelled } from "../abort-signals.js";
import { resolveOutputFps } from "./frame-rate.js";
import { createVideoEncodingDiagnostics } from "./encoder-diagnostics.js";
import { hasCameraFlip } from "../camera-flip.js";
import { Input, VideoSample, VideoSampleSink } from "mediabunny";
import { createRetryingBlobSource } from "../retrying-blob-source.js";
import { getInputTimeOrigin } from "../media-time.js";

import { openAdpcmAudioAuto } from "./adpcm-audio.js";
import { createVideoSourceResolver } from "./normalize-degenerate-video.js";
import { probeAudioUniformity } from "../export.js";
import { rangeSourceFps, sliceTripChannelForRange } from "../export-range.js";
import { createLogger } from "../log.js";
import { VIDEO_INPUT_FORMATS } from "../video-formats.js";

import { createRegionBlurResolver } from "../blur-region-resolver.js";
import { computeOutputSize, createBlurHelper, createRegionBlurHelper, drawMain } from "./compose.js";
import { drawWatermark } from "./watermark.js";
import type { BlurHelper, RegionBlurHelper } from "./compose.js";
import { clampSpeedFactor, framesForSpeed, resolveBitrate, type TranscodeArgs, type TranscodeResult } from "./types.js";
import { ensureWatermarkFontReady } from "./watermark.js";
import { createOverlayFrameResolver, hasAnyOverlay } from "./overlay-pipeline-helpers.js";
import { ensureOverlayFontsReady } from "./overlay-styles.js";
import { type FramePos, recordsHaveAccel } from "./frame-pos.js";
import {
    achievedKbps,
    type ActiveAudioPlan,
    consumeMapSnapshot,
    createH264SampleSource,
    createH264VideoSource,
    createTranscodeOutput,
    startTranscodeOutput,
    createTranscodeProgressReporter,
    discardOutputQuietly,
    feedSegmentAudio,
    feedSegmentAudioAdpcm,
    feedSegmentAudioCopy,
    applyAudioPlan,
    finalizeTranscodeOutput,
    frameNeedsNoComposite,
    joinAllOrThrowFirst,
    nextTolerant,
    type DecodeProgress,
    round2,
} from "./pipeline-common.js";
import { drawMapPlaceholder } from "./map-overlay.js";
import { createReusingMapSnapshotter } from "./map-snapshot-camera.js";
import { drawTelemetryOverlays } from "./telemetry-overlays.js";

const log = createLogger("transcode");

/**
 * Main entry point. Resolves after successful finalization (mp4 on disk).
 * Throws AbortError on cancel, generic Error on decoder/encoder failure.
 */
export async function transcode(args: TranscodeArgs): Promise<TranscodeResult> {
    const { source, output, writable, signal, onProgress, mapSnapshotter } = args;
    throwIfCancelled(signal);

    const startMs = performance.now();

    const dims = computeOutputSize(output.height, output.aspect);
    const widthPx = dims.width;
    const heightPx = dims.height;
    const bitrate = output.bitrate ?? resolveBitrate(widthPx, heightPx);

    const overlays = output.overlays;
    const anyOverlay = !!overlays && hasAnyOverlay(overlays);
    // Fonts must be registered before the first rasterization - the system
    // fallback otherwise gets cached for the whole encode. ensureOverlayFontsReady
    // loads Inter + JetBrains Mono in the subset the overlay locale needs (Latin,
    // plus Cyrillic for ru). The watermark loads its own face separately.
    if (anyOverlay) await ensureOverlayFontsReady(overlays?.localeScript ?? "latin");
    if (output.watermarkAnchor) await ensureWatermarkFontReady();

    // Main-channel segments covering the full range.
    const mainSegments = sliceTripChannelForRange(source.trip, source.channel, source.startTripSec, source.endTripSec);
    if (mainSegments.length === 0) {
        throw new Error("transcode: empty source range (no main candidates intersect range)");
    }

    // Timelapse speed-up: keep every Nth in-range source frame and compress the
    // output timestamps by N. At N > 1 audio is dropped upstream (export-flow),
    // so the audio loop below never runs - no need to speed-adjust audio here.
    const speedFactor = clampSpeedFactor(output.speedFactor);

    // Every source frame in range is kept (at 1x), so the frame count - and the
    // progress bar and ETA built on it - must follow the source's real rate.
    const outputFps = resolveOutputFps(rangeSourceFps(mainSegments));
    const totalOutputSec = source.endTripSec - source.startTripSec;
    const framesTotal = framesForSpeed(totalOutputSec, outputFps, speedFactor);

    log.info("transcode started", {
        channel: source.channel,
        outputW: widthPx,
        outputH: heightPx,
        aspect: output.aspect,
        bitrateKbps: Math.round(bitrate / 1000),
        fps: outputFps,
        speedFactor,
        audio: output.withAudio,
        watermarkAnchor: output.watermarkAnchor,
        crop: !!output.crop,
        segmentsCount: mainSegments.length,
        startTripSec: round2(source.startTripSec),
        endTripSec: round2(source.endTripSec),
        totalOutputSec: round2(totalOutputSec),
        framesTotal,
    });

    // === Output muxer ===
    const outputSession = createTranscodeOutput(writable, signal);
    const out = outputSession.out;

    // Composition canvas: created up front because the canvas-flavour video
    // source binds to it (mediabunny captures the canvas on each add()).
    const canvas = new OffscreenCanvas(widthPx, heightPx);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    // Source (often 1440p/4K) is drawn onto the output canvas; the canvas default
    // imageSmoothingQuality "low" visibly softens any downscale. Match the
    // mini-map overlay, which already requests "high".
    ctx.imageSmoothingQuality = "high";

    // Nothing is painted over the video for this run, so a decoded frame that
    // already matches the output frame exactly can be handed to the encoder
    // untouched - skipping the decode -> RGBA canvas -> capture round trip, which
    // is two colour conversions and a texture copy on every frame. The run-wide
    // half of the gate is here; frameNeedsNoComposite checks each frame itself,
    // so a resize, a rotated source or a non-square pixel aspect still routes
    // through the canvas.
    const noOverlayLayer =
        !hasCameraFlip(output.flip) &&
        !output.crop &&
        !output.watermarkAnchor &&
        !anyOverlay &&
        !output.blurRegions?.length;
    // Both sources use the same encoder config; CanvasSource wraps the composed
    // frame in a VideoSample internally.
    const encoderDiagnostics = createVideoEncodingDiagnostics();
    const canvasSource = noOverlayLayer
        ? null
        : createH264VideoSource(canvas, bitrate, encoderDiagnostics, output.hardwareAcceleration);
    const sampleSource = noOverlayLayer
        ? createH264SampleSource(bitrate, encoderDiagnostics, output.hardwareAcceleration)
        : null;
    out.addVideoTrack(canvasSource ?? sampleSource!, { frameRate: outputFps });

    /** Encodes the frame currently on the canvas at the output-axis timing. */
    const encodeCanvas = async (outTs: number, duration: number): Promise<void> => {
        if (canvasSource) {
            await canvasSource.add(outTs, duration);
            return;
        }
        const framed = new VideoSample(canvas, { timestamp: outTs, duration });
        try {
            await sampleSource!.add(framed);
        } finally {
            framed.close();
        }
    };

    // Audio plan: passthrough (stream-copy AAC/MP3 packets, no encoder), encode
    // (decode + re-encode to AAC, or Opus when AAC encode is unavailable), or
    // skip. Decided once from the first audio-bearing segment - see resolveAudioPlan.
    let audioPlan: ActiveAudioPlan | null = null;
    let firstAudioFile = mainSegments[0]!.file;
    // Passthrough state threaded across segments: monotonic-timeline guard +
    // one-time decoder-config push. Unused on the encode path.
    let audioCopyLastEndSec = 0;
    let audioConfigPushed = false;
    // True when audio was requested but the range mixes audio formats; surfaced
    // to the user (export.notify.audioFormatMixed) and reported in the result.
    let audioDroppedHeterogeneous = false;
    // True when audio was requested but no encoder exists and the source could not
    // be stream-copied (ADPCM / exotic codec on a no-encoder browser). Drop+notify.
    let audioDroppedNoEncoder = false;
    // Open the first segment's Input once and reuse it for BOTH the audio probe
    // and the loop's first iteration (segIdx 0). On a single-file recording that
    // file is the whole trip, so reading its (large) moov twice dominated the
    // "Preparing" wait; sharing one Input reads it once. Disposed in the loop's
    // finally below (mirrors exportClip's firstInput pattern).
    const firstInput = new Input({
        source: createRetryingBlobSource(mainSegments[0]!.file, signal),
        formats: VIDEO_INPUT_FORMATS,
    });
    try {
        const videoResolver = createVideoSourceResolver(signal);
        if (output.withAudio) {
            // Probe all segments: heterogeneous audio (e.g. an original clip spliced
            // with a re-export) cannot share one track, so drop audio rather than
            // crash the muxer mid-stream. A range that starts on an audio-less clip
            // (e.g. parking mode) followed by clips with audio still keeps audio -
            // the per-segment loop fills the leading clip with silence (encode) or a
            // gap (passthrough). reuseFirstInput shares segment 0's already-open Input
            // so a one-big-file recording does not read its moov twice.
            const probe = await probeAudioUniformity(
                mainSegments.map((s) => s.file),
                {
                    reuseFirstInput: firstInput,
                    signal,
                },
            );
            firstAudioFile = probe.firstFile ?? firstAudioFile;
            const audio = await applyAudioPlan(out, probe, firstAudioFile, speedFactor === 1);
            audioPlan = audio.audioPlan;
            audioDroppedHeterogeneous = audio.audioDroppedHeterogeneous;
            audioDroppedNoEncoder = audio.audioDroppedNoEncoder;
        }

        // Blur helper is created only when letterbox fill is "blur". Pre-allocated
        // canvas for downscale-blur-upscale, reused across all frames.
        const blurHelper: BlurHelper | null = output.letterboxFill === "blur" ? createBlurHelper() : null;
        // Privacy-region scratch canvas, same allocate-once rationale.
        const regionBlurHelper: RegionBlurHelper | null = output.blurRegions?.length ? createRegionBlurHelper() : null;
        const resolveRegionBlurs = createRegionBlurResolver(
            output.blurRegions ?? [],
            source.channel,
            source.startTripSec,
        );
        const renderOpts = { fill: output.letterboxFill, blurHelper, regionBlurHelper };

        const resolveOverlayFrame =
            anyOverlay && overlays
                ? createOverlayFrameResolver(overlays, source.trip.timeline, source.startTripSec, source.endTripSec)
                : null;
        if (resolveOverlayFrame && overlays) {
            log.debug("overlays enabled", {
                style: overlays.style,
                gSource: recordsHaveAccel(overlays.gpsRecords) ? "recorded" : "derived",
            });
        }
        // Every map snapshot is a main-thread MapLibre render (the single most
        // expensive per-frame step when the map is on), so frames whose camera
        // did not visibly move paint the previous render again. Owns every
        // bitmap it hands out; disposed once the frame loop is over.
        const mapSnapshots =
            mapSnapshotter && overlays?.map
                ? createReusingMapSnapshotter(mapSnapshotter, {
                      headingUp: overlays.map.headingUp,
                      adaptiveZoom: overlays.map.adaptiveZoom,
                  })
                : null;

        await startTranscodeOutput(out, onProgress, framesTotal);

        // === Main loop ===
        // videoAccumOutSec accumulates SOURCE seconds across segments. The muxer
        // (output) timestamp is derived from it by dividing by speedFactor; GPS
        // overlays use the raw source time so a sped-up clip still shows the speed /
        // coordinates of the actual moment each kept frame was recorded.
        let videoAccumOutSec = 0;
        let framesDone = 0;
        // Frames that went to the encoder without touching the composition canvas.
        // Reported once at the end: a "the export is slow" report is otherwise
        // undiagnosable on this axis - it separates "the fast path never engaged"
        // (a resize, a rotated source, an overlay the user forgot about) from a
        // genuinely encoder-bound run, and only the first is ours to fix.
        let framesDirect = 0;
        // Counts in-range frames (after the pre-roll guard) to drive the timelapse
        // frame-drop: keep one every speedFactor frames. Global across segments so
        // the cadence does not reset at file boundaries.
        let inRangeFrameIdx = -1;
        // Latched after the first map-snapshot failure. We prefer saving the file
        // without the map overlay over aborting the whole export: speed/coords text
        // and the video itself are still useful. Logged exactly once to avoid
        // flooding the ring buffer with N-per-frame copies of the same error.
        let mapOverlayFailed = false;
        // Latched when a source decoder stops early on a damaged tail (see
        // nextTolerant). The clip still finalizes with the frames decoded so far;
        // the caller turns this into a soft "damaged end" notice.
        let decodeTruncated = false;

        const reportProgress = createTranscodeProgressReporter(framesTotal, onProgress);

        // mediabunny is already pipelined internally (decoder/encoder/muxer run
        // in parallel via async queues), and videoSource.add() provides the right
        // backpressure depth by itself. We do NOT add an encoder-frame buffer on top
        // (on long clips that built up frames in the encoder queue and throughput
        // dropped toward the end - trust mediabunny). The decode-ahead below is a
        // DIFFERENT, bounded thing: it holds exactly ONE decoded frame + its in-flight
        // map snapshot, so the snapshot for frame N renders on the main thread while
        // this worker composites+encodes frame N-1. videoSource.add stays awaited once
        // per frame, so the encoder queue depth is unchanged.

        // Composites one decoded frame onto the shared canvas and encodes it. Split
        // out so the loop can flush the PREVIOUS frame (whose map snapshot already
        // resolved) while the CURRENT frame's snapshot renders on the main thread -
        // overlapping the worker->main->worker snapshot round-trip with this encode.
        // Owns the frame's VideoSample (always closed) and its snapshot bitmap.
        interface PendingFrame {
            sample: VideoSample;
            outTs: number;
            duration: number;
            // Frame position on the trip's footage (content) axis - the axis blur
            // regions keyframe on. seg.tripStart + sample.timestamp, NOT the
            // gap-collapsing videoAccumOutSec form (same rationale as the GPS
            // overlays' frameContentSec, see the comment in the decode loop).
            contentSec: number;
            // Telemetry position for this frame, or null when there is no overlay.
            framePos: FramePos | null;
            // In-flight map snapshot issued at decode time, or null (no map / disabled).
            snapPromise: Promise<ImageBitmap> | null;
        }

        const flushFrame = async (p: PendingFrame): Promise<void> => {
            let sampleClosed = false;
            // A skipped/aborted frame leaves its snapshot promise unconsumed: that
            // is fine, the reusing snapshotter owns the bitmap and the rejection
            // handler attached at issue time keeps a late failure from surfacing
            // as unhandled.
            try {
                throwIfCancelled(signal);
                if (sampleSource && frameNeedsNoComposite(p.sample, widthPx, heightPx)) {
                    // Untouched frame: retime it onto the output axis and hand it
                    // straight to the encoder. Mutating the sample is safe - we own
                    // it, and add() does not take ownership, so we still close it.
                    p.sample.setTimestamp(p.outTs);
                    p.sample.setDuration(p.duration);
                    await sampleSource.add(p.sample);
                    p.sample.close();
                    sampleClosed = true;
                    framesDirect++;
                    framesDone++;
                    reportProgress(framesDone, outputSession.bytesWritten, false);
                    return;
                }
                // Privacy blur rects for this frame's content time (empty -> null,
                // so drawMain skips the paint pass entirely on unaffected frames).
                const regionBlurs = output.blurRegions?.length ? resolveRegionBlurs(p.contentSec) : null;
                // Composition. drawMain does keep-aspect-fit internally: output.crop=null
                // fits the whole frame; a crop rect fits that region.
                drawMain(ctx, p.sample, output.crop, widthPx, heightPx, renderOpts, regionBlurs, output.flip);
                if (p.framePos && overlays) {
                    drawTelemetryOverlays(ctx, widthPx, heightPx, overlays, p.framePos);
                    // No fix -> no snapshot was issued; hold the slot with the
                    // placeholder so the map neither vanishes nor freezes on a
                    // stale position. Skipped once the map is disabled for the run.
                    if (overlays.map && !p.framePos.hasFix && !mapOverlayFailed) {
                        drawMapPlaceholder(ctx, widthPx, heightPx, overlays.map);
                    }
                    // Map disabled by an earlier frame's failure after this frame's
                    // request was already in flight: leave it undrawn.
                    if (p.snapPromise && overlays.map) {
                        if (!mapOverlayFailed) {
                            // Failure policy (disable-for-the-run latch, AbortError
                            // rethrow) lives in consumeMapSnapshot.
                            mapOverlayFailed = await consumeMapSnapshot(
                                ctx,
                                widthPx,
                                heightPx,
                                overlays.map,
                                p.snapPromise,
                                framesDone,
                            );
                        }
                    }
                }
                // Watermark last - on top of scrim + telemetry so the brand mark stays crisp.
                if (output.watermarkAnchor) {
                    drawWatermark(ctx, widthPx, heightPx, output.watermarkAnchor);
                }
                // The composited frame is already on `canvas` (drawMain + overlays
                // above). The capture is synchronous here, so the decoded source frame
                // can be closed right after; the next frame is drawn in the following
                // flushFrame, after this add() resolves.
                p.sample.close();
                sampleClosed = true;
                await encodeCanvas(p.outTs, p.duration);
                framesDone++;
                reportProgress(framesDone, outputSession.bytesWritten, false);
            } finally {
                if (!sampleClosed) p.sample.close();
            }
        };

        try {
            for (let segIdx = 0; segIdx < mainSegments.length; segIdx++) {
                throwIfCancelled(signal);
                const seg = mainSegments[segIdx]!;
                const segDur = seg.endInFile - seg.startInFile;

                // Decode-ahead buffer (depth 1). Declared at segment scope so the
                // finally below can close a leftover frame on an error/abort that
                // escaped the loop. Flushed (and nulled) at the end of the video loop,
                // so it never crosses a segment boundary - output stays strictly ordered.
                // A box, not a bare `let`: the video loop is a closure now, and a local
                // assigned only from inside one stays narrowed to null for the finally.
                const decodeAhead: { frame: PendingFrame | null } = { frame: null };

                // Normalized copies contain video only; audio keeps the original file.
                const videoFile = await videoResolver.resolve(seg.file);
                const videoRedirected = videoFile !== seg.file;
                // segIdx 0 reuses firstInput for video only when NOT redirected
                // (firstInput is over the original seg.file, already parsed by the audio
                // probe); a redirected segment opens a fresh input over the clean copy.
                const input =
                    segIdx === 0 && !videoRedirected
                        ? firstInput
                        : new Input({
                              source: createRetryingBlobSource(videoFile, signal),
                              formats: VIDEO_INPUT_FORMATS,
                          });
                // Audio input over the original file. firstInput is over the original,
                // so reuse it at segIdx 0; otherwise reuse the video input when it was
                // not redirected, or open a dedicated original-file input when video
                // points at the clean copy.
                const audioInput =
                    segIdx === 0
                        ? firstInput
                        : videoRedirected
                          ? new Input({
                                source: createRetryingBlobSource(seg.file, signal),
                                formats: VIDEO_INPUT_FORMATS,
                            })
                          : input;
                try {
                    const videoTrack = await input.getPrimaryVideoTrack();
                    if (!videoTrack) {
                        log.warn("no video track, skipping segment", { file: seg.file.name });
                        videoAccumOutSec += segDur;
                        continue;
                    }
                    const videoSink = new VideoSampleSink(videoTrack);
                    const timeOrigin = await getInputTimeOrigin(input);
                    // Both producers place samples relative to the segment's base on
                    // the output axis. Captured before either starts so neither reads
                    // it mid-advance (the loop bumps it only after both finish).
                    const segBaseOutSec = videoAccumOutSec;

                    const runSegmentVideo = async (): Promise<void> => {
                        // Only the bounded tail policy may tolerate a decoder failure;
                        // composition, encoding and cancellation always propagate.
                        const decodeProgress: DecodeProgress = {
                            startTimestamp: seg.startInFile + timeOrigin,
                            endTimestamp: seg.endInFile + timeOrigin,
                            fileEndTimestamp: seg.fileDurationSec + timeOrigin,
                            lastSampleEnd: null,
                            segmentIndex: segIdx,
                        };
                        const sampleIter = videoSink
                            .samples(seg.startInFile + timeOrigin, seg.endInFile + timeOrigin)
                            [Symbol.asyncIterator]();
                        try {
                            for (;;) {
                                const pull = await nextTolerant(sampleIter, decodeProgress);
                                if (pull.done) {
                                    if (pull.truncated) {
                                        decodeTruncated = true;
                                        log.warn("decode stopped early", {
                                            file: seg.file.name,
                                            ...decodeProgress,
                                            framesDone,
                                            err: pull.error,
                                        });
                                    }
                                    break;
                                }
                                const sample = pull.value;
                                // Decide keep/skip and, for kept frames, ISSUE the map snapshot
                                // (it renders on the main thread while flushFrame(prev) encodes
                                // below). try/finally closes a SKIPPED sample here; a KEPT sample
                                // is handed to `pending` and closed later by flushFrame. The
                                // snapshot request is the last thing issued before keep=true,
                                // with no await/throw after it, so a kept frame always reaches
                                // `pending` and its in-flight bitmap is never orphaned here.
                                let keep = false;
                                let outTs = 0;
                                let frameContentSec = 0;
                                let framePos: FramePos | null = null;
                                let snapPromise: Promise<ImageBitmap> | null = null;
                                try {
                                    throwIfCancelled(signal);

                                    // Source-relative timestamp. Guard: drop samples whose
                                    // timestamp is before startInFile (mediabunny snapped to
                                    // the keyframe BEFORE startInFile); without this a negative
                                    // ts would reach the muxer. Computed before any compositing
                                    // so dropped/skipped frames are never drawn (wasted work).
                                    const srcRelTs = segBaseOutSec + (sample.timestamp - timeOrigin - seg.startInFile);
                                    if (srcRelTs < -1e-3) {
                                        continue;
                                    }

                                    // Timelapse frame-drop: keep one frame every speedFactor.
                                    // At 1x this keeps every frame. Skipped frames still decode
                                    // (inter-frame deps) but are not drawn or encoded, and never
                                    // enter the decode-ahead pipeline.
                                    inRangeFrameIdx++;
                                    if (speedFactor > 1 && inRangeFrameIdx % speedFactor !== 0) {
                                        continue;
                                    }

                                    // Output (muxer) timestamp: compress by speedFactor. Clamp
                                    // near-zero double-precision drift to 0, else
                                    // muxer.validateAndNormalize throws "Timestamps must be
                                    // non-negative".
                                    outTs = Math.max(0, srcRelTs) / speedFactor;

                                    // The frame's ABSOLUTE footage-axis position. Shared by
                                    // the GPS overlays (below) and the blur-region resolve
                                    // in flushFrame. Deliberately NOT the startTripSec+
                                    // srcRelTs form: videoAccumOutSec collapses inter-segment
                                    // gaps, so with a missing file mid-range every post-gap
                                    // frame would resolve GPS / blur rects from a moment
                                    // earlier by the gap length (stale overlays).
                                    frameContentSec = seg.tripStart + sample.timestamp - timeOrigin;
                                    if (resolveOverlayFrame && overlays) {
                                        framePos = resolveOverlayFrame(frameContentSec);
                                        // Issue (do NOT await) the snapshot now so it renders
                                        // on the main thread while flushFrame(prev) composites
                                        // + encodes below - this is the decode-ahead overlap
                                        // that the prewarm + synchronous redraw make cheap.
                                        // It is consumed one iteration later in flushFrame.
                                        // Gated on hasFix, not just finiteness: a long dropout
                                        // interpolates finite-but-fabricated coordinates, and
                                        // the map placeholder is drawn instead.
                                        if (framePos.hasFix && overlays.map && mapSnapshots && !mapOverlayFailed) {
                                            snapPromise = mapSnapshots.snapshot({
                                                lat: framePos.lat,
                                                lon: framePos.lon,
                                                bearingDeg: framePos.headingDeg,
                                                zoomKm: overlays.map.zoomKm,
                                                speedMs: framePos.speedMs,
                                            });
                                            snapPromise.catch(() => {});
                                        }
                                    }
                                    keep = true;
                                } finally {
                                    if (!keep) sample.close();
                                }

                                // Publish THIS frame as pending BEFORE flushing the previous one:
                                // if flushFrame throws (abort mid-encode), the segment finally
                                // then still sees this frame in `pending` and closes its sample +
                                // drains its snapshot (flushFrame closes the previous frame itself).
                                const prev = decodeAhead.frame;
                                decodeAhead.frame = {
                                    sample,
                                    outTs,
                                    duration: sample.duration,
                                    contentSec: frameContentSec,
                                    framePos,
                                    snapPromise,
                                };
                                if (prev) await flushFrame(prev);
                            }
                            // Flush the segment's last decoded frame here, so `pending` never
                            // crosses a segment boundary (keeps output ordered).
                            if (decodeAhead.frame) {
                                await flushFrame(decodeAhead.frame);
                                decodeAhead.frame = null;
                            }
                        } finally {
                            await sampleIter.return?.();
                        }
                    };

                    // === Audio for this segment ===
                    // Single-channel segments are back-to-back on the output axis
                    // (segBaseOutSec); the feed helpers cover an audio-less segment
                    // (silence on encode, a gap on passthrough) internally.
                    const runSegmentAudio = async (): Promise<void> => {
                        if (!audioPlan || !output.withAudio) return;
                        if (audioPlan.mode === "passthrough") {
                            // Stream-copy the source AAC/MP3 packets - no encoder.
                            const res = await feedSegmentAudioCopy({
                                audioSource: audioPlan.source,
                                input: audioInput,
                                startInFile: seg.startInFile,
                                endInFile: seg.endInFile,
                                segBaseOutSec,
                                audioLastEndSec: audioCopyLastEndSec,
                                pushDecoderConfig: !audioConfigPushed,
                                signal,
                                onTruncated: () => {
                                    decodeTruncated = true;
                                },
                            });
                            audioCopyLastEndSec = res.audioLastEndSec;
                            if (res.configPushed) audioConfigPushed = true;
                        } else if (audioPlan.adpcmReader) {
                            // ADPCM source: decode this segment ourselves (mediabunny
                            // can't read it). Reuse the probed audio-bearing file's
                            // reader; an earlier silent segment must stay silent.
                            const reader =
                                seg.file === firstAudioFile
                                    ? audioPlan.adpcmReader
                                    : await openAdpcmAudioAuto(seg.file);
                            await feedSegmentAudioAdpcm({
                                audioSource: audioPlan.source,
                                reader,
                                startInFile: seg.startInFile,
                                endInFile: seg.endInFile,
                                segBaseOutSec,
                                silenceFormat: audioPlan.silenceFormat,
                                signal,
                            });
                        } else {
                            await feedSegmentAudio({
                                audioSource: audioPlan.source,
                                input: audioInput,
                                fileDurationSec: seg.fileDurationSec,
                                startInFile: seg.startInFile,
                                endInFile: seg.endInFile,
                                segBaseOutSec,
                                silenceFormat: audioPlan.silenceFormat,
                                signal,
                                fileName: seg.file.name,
                                onTruncated: () => {
                                    decodeTruncated = true;
                                },
                            });
                        }
                    };

                    // Concurrently, not back-to-back. The two producers feed separate
                    // muxer tracks (mediabunny guards the muxer with its own mutex) and
                    // share nothing else, so the audio pass used to leave the video
                    // decoder and encoder completely idle once per segment - on a trip
                    // split into per-minute files that is a stall per file.
                    await joinAllOrThrowFirst([runSegmentVideo(), runSegmentAudio()]);
                } finally {
                    // Decode-ahead leftover: on an error/abort that escaped the loop
                    // before the final flush, the box still holds one decoded frame.
                    // Close it so we do not leak a VideoSample (Chromium's ~60-frame
                    // decoder queue -> stall); its in-flight snapshot belongs to the
                    // reusing snapshotter. No-op on the normal path (nulled above).
                    const leftover = decodeAhead.frame;
                    if (leftover) {
                        try {
                            leftover.sample.close();
                        } catch {
                            /* already closed */
                        }
                        decodeAhead.frame = null;
                    }
                    // firstInput (segIdx 0) is held for the whole loop and disposed
                    // once in the finally below, not here. The audio input is a
                    // distinct object only for a redirected (MKV) segment; dispose it
                    // when it is neither firstInput nor the shared video input.
                    if (input !== firstInput) input.dispose();
                    if (audioInput !== firstInput && audioInput !== input) audioInput.dispose();
                }

                videoAccumOutSec += segDur;
            }
        } catch (err) {
            log.error("transcode aborted or failed", { framesDone, err: String(err) });
            throw err;
        } finally {
            // Release the reused input before flushing the output encoder. Every
            // frame has been composited by now, so the retained map bitmaps go too.
            firstInput.dispose();
            mapSnapshots?.dispose();
        }

        // Output duration is the source span compressed by the speed factor.
        const outputDurationSec = videoAccumOutSec / speedFactor;
        const result = await finalizeTranscodeOutput({
            out,
            writable,
            signal,
            onProgress,
            framesDone,
            framesTotal,
            getBytesWritten: () => outputSession.bytesWritten,
            durationSec: outputDurationSec,
        });

        // Opus fallback (the encode path could not use AAC) means audio is present
        // but less compatible - the caller surfaces a soft notice.
        const audioReencodedToOpus = audioPlan?.mode === "encode" && audioPlan.codec === "opus";

        log.info("transcode done", {
            framesEncoded: framesDone,
            framesDirect,
            durationSec: round2(outputDurationSec),
            sizeBytes: outputSession.bytesWritten,
            // The file rate includes audio and container overhead; packet statistics isolate video.
            bitrateKbps: Math.round(bitrate / 1000),
            achievedKbps: achievedKbps(outputSession.bytesWritten, outputDurationSec),
            ...encoderDiagnostics.summarize(),
            elapsedMs: Math.round(performance.now() - startMs),
            // Render vs reuse split of the map snapshots: tells a "slow export
            // with the map on" report whether the main-thread renders were the
            // bound and how much the pose reuse took off them.
            ...(mapSnapshots ? { mapSnapshots: mapSnapshots.stats() } : {}),
            mapOverlayDropped: mapOverlayFailed,
            decodeTruncated,
            audioDroppedHeterogeneous,
            audioDroppedNoEncoder,
            audioMode: audioPlan?.mode ?? "none",
            audioReencodedToOpus,
        });

        // mapOverlayFailed only ever becomes true on the map-overlay path, so it
        // already encodes "requested AND dropped" - safe to pass straight through.
        return {
            ...result,
            mapOverlayDropped: mapOverlayFailed,
            decodeTruncated,
            audioDroppedHeterogeneous,
            audioDroppedNoEncoder,
            audioReencodedToOpus,
            capturedMoov: outputSession.capturedMoov,
        };
    } catch (err) {
        if (out.state !== "canceled") await discardOutputQuietly(out, writable);
        throw err;
    } finally {
        firstInput.dispose();
    }
}

// Split-screen pipeline lives in ./pipeline-split.ts (transcodeSplit). Kept
// separate: split decodes N sources in parallel (one OffscreenCanvas, N
// decoders), while main+pip uses one decoder + lazy pip - different patterns.
