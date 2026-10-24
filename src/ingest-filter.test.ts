import { describe, expect, it } from "vitest";

import { ignoredRootSegments, isIgnoredPath } from "./ingest-filter.js";

describe("isIgnoredPath", () => {
    it("keeps normal recordings", () => {
        const keep = [
            "Normal/Front/NO20260101-120000-000001F.MP4",
            "Normal/Back/NO20260101-120000-000001R.MP4",
            "DCIM/Movie/FILE0001.MP4",
            "TeslaCam/SentryClips/2024-01-01_12-00-00-front.mp4",
            "clip.mp4", // bare filename, no path
            "DCIM/200video/front/20260817190140_0060.mp4",
            "DCIM/200video/front/20260817190140_0060_S.mp4", // suffix alone is not a preview
            "DCIM/200video/front/small/other.mp4", // path alone is not enough
        ];
        for (const path of keep) {
            expect(isIgnoredPath(path), path).toBe(false);
        }
    });

    it("drops 70mai low-res proxy directories", () => {
        // The crash that motivated this filter: .s_Front shares a basename with
        // the full-res clip in Normal/Front, collides on basename in ingest.
        expect(isIgnoredPath(".s_Front/NO20260101-120000-000001F.MP4")).toBe(true);
        expect(isIgnoredPath(".s_Back/NO20260101-120000-000001R.MP4")).toBe(true);
    });

    it("keeps 70mai logs in the hidden GPS directory", () => {
        const keep = [
            ".GPS/GPSData000001.txt",
            "SD/.gps/GPSData000001.txt",
            "SD/.Gps/GPSData000001.txt",
            "SD\\.GPS\\GPSData000001.txt",
        ];
        for (const path of keep) {
            expect(isIgnoredPath(path), path).toBe(false);
        }
    });

    it("still drops junk within and around the GPS directory", () => {
        const drop = [
            "SD/.GPS/.DS_Store",
            "SD/.GPS/.hidden/GPSData000001.txt",
            "SD/.GPS/System Volume Information/file.txt",
            "SD/.GPS/.s_Front/clip.mp4",
            "SD/.backup/.GPS/GPSData000001.txt",
            "SD/.GPS-backup/GPSData000001.txt",
            "SD\\.GPS\\._GPSData000001.txt",
        ];
        for (const path of drop) {
            expect(isIgnoredPath(path), path).toBe(true);
        }
    });

    it("drops Z60 small previews even without their full-size files", () => {
        const preview = "disk/DCIM/200video/front/small/20260817190140_0060_S.mp4";
        expect(isIgnoredPath(preview)).toBe(true);
        expect(isIgnoredPath("small/20260817200209_0060_S.MP4")).toBe(true);
        expect(isIgnoredPath(preview.replaceAll("/", "\\"))).toBe(true);
    });

    it("drops any hidden segment, anywhere in the path", () => {
        const drop = [
            ".Trashes/501/clip.mp4",
            ".Spotlight-V100/store.db",
            ".fseventsd/0000",
            ".DS_Store",
            "._clip.mp4", // AppleDouble sidecar at the leaf
            "Normal/.hidden/clip.mp4", // hidden mid-path
            ".Trash-1000/files/clip.mp4", // Linux
        ];
        for (const path of drop) {
            expect(isIgnoredPath(path), path).toBe(true);
        }
    });

    it("drops known non-dot OS junk directories, case-insensitively", () => {
        const drop = [
            "System Volume Information/IndexerVolumeGuid",
            "system volume information/x",
            "$RECYCLE.BIN/S-1-5-21/clip.mp4",
            "RECYCLER/clip.mp4",
            "LOST.DIR/12345.mp4",
            "FOUND.000/FILE0000.CHK",
            "found.123/FILE0000.CHK",
        ];
        for (const path of drop) {
            expect(isIgnoredPath(path), path).toBe(true);
        }
    });

    it("does not treat a FOUND-like leaf with wrong shape as junk", () => {
        // Only "found.NNN" exactly (3 digits) is chkdsk junk; a real folder
        // named "found" or "found.1" must survive.
        expect(isIgnoredPath("found/clip.mp4")).toBe(false);
        expect(isIgnoredPath("found.1/clip.mp4")).toBe(false);
        expect(isIgnoredPath("recovered.000/clip.mp4")).toBe(false);
    });

    it("accepts backslash separators and empty paths", () => {
        expect(isIgnoredPath(".s_Front\\clip.mp4")).toBe(true);
        expect(isIgnoredPath("Normal\\Front\\clip.mp4")).toBe(false);
        expect(isIgnoredPath("")).toBe(false);
    });
});

describe("ignoredRootSegments", () => {
    it("names the distinct junk roots the user picked", () => {
        // The "everything was filtered" case: a card copied into a ".backup"
        // folder plus a chkdsk recovery folder. The diagnostic must surface the
        // folder names (deduped), so a bug report says WHICH folder we rejected.
        const roots = ignoredRootSegments([
            ".backup/Normal/Front/clip.mp4",
            ".backup/Normal/Back/clip.mp4",
            "FOUND.000/FILE0000.CHK",
        ]);
        expect(roots).toHaveLength(2);
        expect(new Set(roots)).toEqual(new Set([".backup", "FOUND.000"]));
    });

    it("reports nothing for a clean selection (the genuinely-empty / normal case)", () => {
        // Distinguishes "everything filtered because the root is junk" from a
        // selection whose roots are fine - the latter never triggers the toast.
        expect(ignoredRootSegments(["Normal/Front/clip.mp4", "DCIM/Movie/FILE0001.MP4"])).toEqual([]);
        expect(ignoredRootSegments([])).toEqual([]);
    });

    it("only considers the root, not junk deeper in the tree", () => {
        // The root is what the user chose; a clean root with a hidden subfolder
        // is not the "you picked a junk folder" situation, so it contributes
        // nothing even though isIgnoredPath would drop the individual file.
        expect(isIgnoredPath("Normal/.hidden/clip.mp4")).toBe(true);
        expect(ignoredRootSegments(["Normal/.hidden/clip.mp4"])).toEqual([]);
    });

    it("handles backslash separators and empty paths", () => {
        expect(ignoredRootSegments([".stversions\\clip.mp4"])).toEqual([".stversions"]);
        expect(ignoredRootSegments([""])).toEqual([]);
    });
});
