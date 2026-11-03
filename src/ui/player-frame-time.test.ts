import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlurRegion, regionRectAt } from "../blur-regions.js";
import { sliceTripChannelForRange } from "../export-range.js";
import { buildTripTimeline, groupTrips, type Trip, type TripFrame, type VideoCandidate } from "../trips.js";

const ui = vi.hoisted(() => ({ video: null as HTMLVideoElement | null, trip: null as Trip | null }));
vi.mock("./dom.js", () => ({
    channelPlayers: {
        get front() {
            return ui.video;
        },
        get rear() {
            return ui.video;
        },
    },
    forEachVideoSlot: (visit: (video: HTMLVideoElement) => void) => visit(ui.video!),
}));
vi.mock("./state.js", () => ({ activeTrip: () => ui.trip }));

import {
    _resetForTests,
    channelPresentedFrame,
    initPlayerFrameTimes,
    videoPresentedFrame,
} from "./player-frame-time.js";
import { videoAttachedFile } from "./player-video-src.js";

function makeTrip(file: File): Trip {
    const candidate: VideoCandidate = {
        file,
        relativePath: file.name,
        fingerprint: "generic",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: null,
        channelConfident: false,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc: 1000,
        durationSec: 4,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "mp4",
        cameraTzSec: null,
        createdUtc: null,
        records: [],
        codec: null,
        codecParam: null,
        videoCodecString: null,
        rotation: 0,
        width: null,
        height: null,
        fps: null,
        audio: null,
        canPlay: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
    const frames: TripFrame[] = [
        { startUtc: 1000, durationSec: 4, wallDurationSec: 4, channels: { front: candidate } },
    ];
    return {
        frames,
        timeline: buildTripTimeline(frames),
        startUtc: 1000,
        endUtc: 1004,
        durationSec: 4,
        totalBytes: file.size,
        distanceKm: 0,
        records: [],
        events: [],
        inferredSegments: [],
        isParking: false,
        confidentChannels: new Set(),
        cameraTzSec: null,
    };
}

function makeVideo() {
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let nextId = 0;
    const target = Object.assign(new EventTarget(), {
        src: "",
        readyState: 0,
        currentTime: 0,
        seeking: false,
        requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
        },
        cancelVideoFrameCallback(id: number): void {
            callbacks.delete(id);
        },
    });
    // Only the browser event/metadata boundary is replaced; frame identity and
    // canonical time are resolved by the actual player adapter.
    const video = target as unknown as HTMLVideoElement;
    return {
        target,
        video,
        present(mediaTime: number, now = 0): void {
            const pending = [...callbacks.values()];
            callbacks.clear();
            for (const callback of pending)
                callback(now, {
                    mediaTime,
                    expectedDisplayTime: 0,
                    presentationTime: 0,
                    presentedFrames: 1,
                    width: 1920,
                    height: 1080,
                    processingDuration: 0,
                });
        },
    };
}

describe("player frame observations", () => {
    beforeEach(() => _resetForTests());

    it.each([-6, 6])("keeps paired privacy seeds on their displayed pixels with %s seconds of clock skew", (skew) => {
        const front = makeTrip(new File(["front"], "front.mp4")).frames[0]!.channels.front!;
        const rear = makeTrip(new File(["rear"], "rear.mp4")).frames[0]!.channels.front!;
        Object.assign(front, { channel: "front", durationSec: 45 });
        Object.assign(rear, { channel: "rear", durationSec: 46, startUtc: 1000 + skew });
        ui.trip = groupTrips([front, rear])[0]!;
        const source = makeVideo();
        ui.video = source.video;
        videoAttachedFile.set(source.video, rear.file);
        source.target.src = "blob:rear";
        source.target.readyState = 2;
        initPlayerFrameTimes();
        source.present(10);

        const seed = channelPresentedFrame("rear", true)!.contentSec;
        expect(seed).toBe(10);
        const follow = sliceTripChannelForRange(ui.trip, "rear", seed, seed + 5)[0]!;
        expect(follow.startInFile, "Follow decodes the pixels that were marked").toBe(10);
        const region = createBlurRegion("rear", "fill", seed, seed + 5, seed, {
            xPct: 0.2,
            yPct: 0.2,
            wPct: 0.1,
            hPct: 0.1,
        });
        expect(regionRectAt(region, follow.tripStart + 10), "export covers the marked source frame").not.toBeNull();

        source.present(45.5);
        expect(channelPresentedFrame("rear", true)?.contentSec, "the rear-only tail stays editable").toBe(45.5);
    });

    it("reads refined drift on an ordinary file before regrouping", () => {
        const source = makeVideo();
        ui.video = source.video;
        const file = new File(["video"], "generic.mp4");
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        source.target.readyState = 2;
        initPlayerFrameTimes();
        source.present(1);
        expect(channelPresentedFrame("front", true)?.contentSec).toBe(1);
        ui.trip.frames[0]!.channels.front!.driftLeadSec = 2;
        expect(channelPresentedFrame("front", true)?.contentSec).toBe(3);
    });

    it("retains a paused first PTS before metadata and decoded readiness arrive", () => {
        const source = makeVideo();
        ui.video = source.video;
        initPlayerFrameTimes();
        const file = new File(["video"], "generic.mp4");
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        source.target.dispatchEvent(new Event("loadstart"));
        source.target.readyState = 1;
        source.present(0);
        source.target.dispatchEvent(new Event("loadedmetadata"));
        expect(channelPresentedFrame("front", true)).toBeNull();
        source.target.readyState = 4;
        source.target.dispatchEvent(new Event("loadeddata"));

        expect(channelPresentedFrame("front", true)?.contentSec).toBe(0);
    });

    it("keeps a seek pending until a frame arrives after seeking finishes", () => {
        const source = makeVideo();
        ui.video = source.video;
        const file = new File(["video"], "generic.mp4");
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        initPlayerFrameTimes();
        source.target.readyState = 2;
        source.present(0);
        source.target.seeking = true;
        source.target.currentTime = 2;
        source.target.dispatchEvent(new Event("seeking"));
        source.present(0);
        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));

        expect(channelPresentedFrame("front")?.contentSec).toBe(0);
        expect(channelPresentedFrame("front", true)).toBeNull();
        source.present(2);
        expect(channelPresentedFrame("front", true)?.contentSec).toBe(2);
    });

    it("settles a seek to the exact displayed PTS without a second frame", () => {
        const source = makeVideo();
        ui.video = source.video;
        const file = new File(["video"], "generic.mp4");
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        initPlayerFrameTimes();
        source.target.readyState = 1;
        source.target.seeking = true;
        source.target.dispatchEvent(new Event("seeking"));
        source.present(0);
        source.target.readyState = 4;
        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));

        expect(channelPresentedFrame("front", true)?.contentSec).toBe(0);
    });
});

describe("physical video presentation tokens", () => {
    beforeEach(() => _resetForTests());

    function observeVideo(file = new File(["video"], "generic.mp4")) {
        const source = makeVideo();
        ui.video = source.video;
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        source.target.readyState = 2;
        initPlayerFrameTimes();
        return { ...source, file };
    }

    it("retains callback time and stable identity without treating media clock movement as presentation", () => {
        const source = observeVideo();
        expect(videoPresentedFrame(source.video)).toBeNull();
        source.target.readyState = 1;
        source.present(0.5, 120);
        expect(videoPresentedFrame(source.video)).toBeNull();
        source.target.readyState = 2;
        const first = videoPresentedFrame(source.video);
        expect(first).toEqual({ file: source.file, src: "blob:generic", mediaTime: 0.5, observedAtMs: 120 });

        source.target.currentTime = 0.54;
        expect(videoPresentedFrame(source.video)).toBe(first);
        source.present(0.5, 160);
        const repeatedPts = videoPresentedFrame(source.video);
        expect(repeatedPts).not.toBe(first);
        expect(repeatedPts?.observedAtMs).toBe(160);
        expect(repeatedPts?.mediaTime).toBe(0.5);
    });

    it.each(["file", "src"] as const)("rejects a replaced %s and its stale callback", (changed) => {
        const source = observeVideo();
        source.present(0.5, 120);
        const first = videoPresentedFrame(source.video);
        if (changed === "file") videoAttachedFile.set(source.video, new File(["replacement"], "next.mp4"));
        else source.target.src = "blob:replacement";
        expect(videoPresentedFrame(source.video)).toBeNull();
        source.present(0.75, 150);
        expect(videoPresentedFrame(source.video)).toBeNull();

        source.target.dispatchEvent(new Event("loadstart"));
        source.present(0, 180);
        const replacement = videoPresentedFrame(source.video);
        expect(replacement).not.toBe(first);
        expect(replacement?.file).toBe(videoAttachedFile.get(source.video));
        expect(replacement?.src).toBe(source.target.src);
        expect(replacement?.observedAtMs).toBe(180);
        source.target.dispatchEvent(new Event("emptied"));
        expect(videoPresentedFrame(source.video)).toBeNull();
    });

    it("keeps identical file and PTS observations separate across physical slots", () => {
        const first = observeVideo();
        first.present(0, 120);
        const token = videoPresentedFrame(first.video);
        const next = observeVideo(first.file);
        next.present(0, 130);

        expect(videoPresentedFrame(first.video)).toBe(token);
        expect(videoPresentedFrame(next.video)).not.toBe(token);
        expect(videoPresentedFrame(next.video)?.observedAtMs).toBe(130);
        expect(channelPresentedFrame("front")?.video).toBe(next.video);
    });

    it("preserves a displayed token during a pending seek without unlocking privacy edits", () => {
        const source = observeVideo();
        source.present(0, 100);
        const first = videoPresentedFrame(source.video);
        source.target.currentTime = 1.25;
        source.target.seeking = true;
        source.target.dispatchEvent(new Event("seeking"));
        expect(videoPresentedFrame(source.video)).toBe(first);
        expect(channelPresentedFrame("front", true)).toBeNull();

        source.present(1.233333, 150);
        expect(videoPresentedFrame(source.video)).not.toBe(first);
        expect(videoPresentedFrame(source.video)?.mediaTime).toBeCloseTo(1.233333);
        expect(channelPresentedFrame("front", true)).toBeNull();
        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));
        expect(channelPresentedFrame("front", true)?.contentSec).toBeCloseTo(1.233333);
    });

    it("leaves unsupported frame callbacks observable as unavailable without changing the privacy clock fallback", () => {
        const source = makeVideo();
        Object.defineProperty(source.target, "requestVideoFrameCallback", { value: undefined });
        const file = new File(["video"], "generic.mp4");
        ui.video = source.video;
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        source.target.readyState = 2;
        source.target.currentTime = 1;
        initPlayerFrameTimes();

        expect(videoPresentedFrame(source.video)).toBeNull();
        expect(channelPresentedFrame("front", true)?.contentSec).toBe(1);
    });
});

describe("paused seek presentation order", () => {
    beforeEach(() => _resetForTests());

    function loadedVideo() {
        const source = makeVideo();
        ui.video = source.video;
        const file = new File(["video"], "generic.mp4");
        ui.trip = makeTrip(file);
        videoAttachedFile.set(source.video, file);
        source.target.src = "blob:generic";
        source.target.readyState = 2;
        initPlayerFrameTimes();
        source.present(0);
        return source;
    }

    it("unlocks a new frame received before seeked even when its PTS precedes the target", () => {
        const source = loadedVideo();
        source.target.currentTime = 1.25;
        source.target.seeking = true;
        source.target.dispatchEvent(new Event("seeking"));
        source.present(1.233333);
        expect(channelPresentedFrame("front")?.contentSec).toBeCloseTo(1.233333);
        expect(channelPresentedFrame("front", true)).toBeNull();

        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));
        expect(channelPresentedFrame("front", true)?.contentSec).toBeCloseTo(1.233333);
    });

    it("requires a new observation after each successive seek", () => {
        const source = loadedVideo();
        source.target.currentTime = 1.25;
        source.target.seeking = true;
        source.target.dispatchEvent(new Event("seeking"));
        source.present(1.233333);
        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));

        source.target.currentTime = 0.75;
        source.target.seeking = true;
        source.target.dispatchEvent(new Event("seeking"));
        source.present(1.233333);
        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));
        expect(channelPresentedFrame("front", true)).toBeNull();

        source.present(0.733333);
        expect(channelPresentedFrame("front", true)?.contentSec).toBeCloseTo(0.733333);
    });

    it("rejects a previous source callback during a replacement seek", () => {
        const source = loadedVideo();
        const replacement = new File(["next video"], "next.mp4");
        videoAttachedFile.set(source.video, replacement);
        ui.trip = makeTrip(replacement);
        source.target.src = "blob:replacement";
        source.target.currentTime = 0.75;
        source.target.seeking = true;
        source.target.dispatchEvent(new Event("seeking"));
        source.present(0.733333);
        source.target.seeking = false;
        source.target.dispatchEvent(new Event("seeked"));
        expect(channelPresentedFrame("front", true)).toBeNull();

        source.target.dispatchEvent(new Event("loadstart"));
        source.present(0.733333);
        expect(channelPresentedFrame("front", true)?.contentSec).toBeCloseTo(0.733333);
    });
});
