import { describe, expect, it } from "vitest";

import { hasDroppedVideoTrack } from "./native-video-track.js";

describe("hasDroppedVideoTrack", () => {
    it.each([
        { name: "no metadata yet", readyState: 0, videoWidth: 0, videoHeight: 0, expected: false },
        { name: "metadata with picture size", readyState: 1, videoWidth: 1920, videoHeight: 1080, expected: false },
        { name: "buffered video", readyState: 4, videoWidth: 3840, videoHeight: 2160, expected: false },
        { name: "metadata without picture size", readyState: 1, videoWidth: 0, videoHeight: 0, expected: true },
        { name: "buffered audio only", readyState: 4, videoWidth: 0, videoHeight: 0, expected: true },
    ])("reports $name as dropped=$expected", ({ readyState, videoWidth, videoHeight, expected }) => {
        expect(hasDroppedVideoTrack({ readyState, videoWidth, videoHeight })).toBe(expected);
    });
});
