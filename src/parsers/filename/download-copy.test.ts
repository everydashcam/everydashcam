import { describe, expect, it } from "vitest";

import { cameraFingerprint } from "../camera-fingerprint.js";
import { classifyGpsSource } from "../gps-source-hints.js";
import type { VendorFile } from "../types.js";
import { asOriginalDownload, isRepeatedDownloadName, originalDownloadName } from "./download-copy.js";
import { matchFilenameChannel, matchFilenameTime } from "./index.js";

function vf(relativePath: string): VendorFile {
    const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    return { file: new File([new Uint8Array(4)], name, { lastModified: 7 }), relativePath, sourceKey: "s" };
}

describe("originalDownloadName", () => {
    it.each([
        ["clip (1).mp4", "clip.mp4"],
        ["clip (12).MP4", "clip.MP4"],
        ["clip(1).mp4", "clip.mp4"],
        ["clip (1) (2).mp4", "clip (1).mp4"],
        ["clip.mp4", "clip.mp4"],
        ["clip (1)", "clip (1)"],
        ["clip (a).mp4", "clip (a).mp4"],
        ["clip (1).tar.gz", "clip (1).tar.gz"],
        ["clip-1.mp4", "clip-1.mp4"],
    ])("reads %s as %s", (name, original) => {
        expect(originalDownloadName(name)).toBe(original);
        expect(isRepeatedDownloadName(name)).toBe(name !== original);
    });
});

describe("asOriginalDownload", () => {
    it("keeps an unsuffixed file as the same object", () => {
        const file = vf("dl/clip.mp4");
        expect(asOriginalDownload(file)).toBe(file);
    });

    it("renames the file and the last path segment, keeping the rest", () => {
        const copy = asOriginalDownload(vf("dl (1)/clip (1).mp4"));
        expect(copy.file.name).toBe("clip.mp4");
        expect(copy.file.lastModified).toBe(7);
        expect(copy.relativePath).toBe("dl (1)/clip.mp4");
        expect(copy.sourceKey).toBe("s");
    });
});

describe("a repeated download classifies like its original", () => {
    it.each(["Normal/Front/NO20260101-120000-000042F", "DCIM/Movie/2026_0101_120000_0042F", "DCIM/20260101_120000_F"])(
        "%s",
        (stem) => {
            const original = vf(`${stem}.MP4`);
            for (const copy of [vf(`${stem} (1).MP4`), vf(`${stem}(2).MP4`)]) {
                expect(matchFilenameTime(copy), copy.file.name).toEqual(matchFilenameTime(original));
                expect(matchFilenameChannel(copy), copy.file.name).toEqual(matchFilenameChannel(original));
                expect(cameraFingerprint(copy), copy.file.name).toBe(cameraFingerprint(original));
                expect(classifyGpsSource(copy), copy.file.name).toBe(classifyGpsSource(original));
            }
        },
    );

    it("shares the fallback camera of an unrecognised name", () => {
        expect(cameraFingerprint(vf("trip/ride (1).mp4"))).toBe(cameraFingerprint(vf("trip/ride.mp4")));
    });
});
