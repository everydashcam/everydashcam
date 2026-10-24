import { describe, expect, it } from "vitest";

import { buildStructureReport, buildStructureReportFromSnapshot, looksLikeRecordings } from "./report-structure.js";
import { snapshotIngestStructure, type IngestStructureEntry } from "./ingest-structure.js";
import type { VendorFile } from "./parsers/types.js";

/** Builds a VendorFile with a real File; name is the basename of relativePath. */
function vf(relativePath: string, opts: { size?: number; mtime?: number } = {}): VendorFile {
    const slash = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
    const name = slash < 0 ? relativePath : relativePath.slice(slash + 1);
    const size = opts.size ?? 1;
    const file = new File([new Uint8Array(size)], name, { lastModified: opts.mtime ?? 0 });
    return { file, relativePath };
}

describe("looksLikeRecordings", () => {
    it("is true when a video-like file is present", () => {
        expect(looksLikeRecordings([vf("DCIM/FILE0001.MP4"), vf("info.txt")])).toBe(true);
    });

    it("is false when nothing looks like a recording", () => {
        expect(looksLikeRecordings([vf("readme.txt"), vf("photo.jpg")])).toBe(false);
    });

    it("is false for an empty drop", () => {
        expect(looksLikeRecordings([])).toBe(false);
    });
});

describe("buildStructureReport", () => {
    it("includes header, extension histogram and the file listing", () => {
        const report = buildStructureReport([
            vf("Front/FILE0001.MP4", { size: 3_200_000, mtime: Date.UTC(2024, 5, 14, 16, 16) }),
            vf("Front/FILE0002.MP4", { size: 3_100_000 }),
            vf("info.txt", { size: 40 }),
        ]);
        expect(report).toContain("everydashcam camera report");
        expect(report).toContain("files: 3");
        // Extension histogram, .mp4 twice.
        expect(report).toMatch(/\.mp4\s+2/);
        expect(report).toMatch(/\.txt\s+1/);
        // File listing carries the paths and the UTC modified time.
        expect(report).toContain("Front/FILE0001.MP4");
        expect(report).toContain("2024-06-14 16:16");
        // Privacy reassurance line is part of the body.
        expect(report).toContain("No video, no GPS coordinates");
    });

    it("recognises a path-based channel technique (Front/ folder)", () => {
        const report = buildStructureReport([vf("Front/FILE0001.MP4"), vf("Rear/FILE0001.MP4")]);
        const channelLine = report.split("\n").find((l) => l.trim().startsWith("channel"));
        expect(channelLine).toBeDefined();
        // A Front/Rear directory layout is a known channel technique - must not
        // report the field as unrecognised.
        expect(channelLine).not.toContain("not recognised");
    });

    it("flags a basename sidecar pairing (video + companion file)", () => {
        const report = buildStructureReport([vf("REC/20240614.MP4"), vf("REC/20240614.NMEA")]);
        const sidecarBlock = report.slice(report.indexOf("== possible sidecars"));
        expect(sidecarBlock).toContain("20240614");
        expect(sidecarBlock).not.toContain("none found");
    });

    it("truncates the listing past the cap and announces it", () => {
        const many: VendorFile[] = [];
        for (let i = 0; i < 3005; i++) many.push(vf(`DCIM/FILE${String(i).padStart(5, "0")}.MP4`));
        const report = buildStructureReport(many);
        expect(report).toMatch(/and \d+ more \(list truncated\)/);
        expect(report).toContain("files: 3005");
    });

    it("reports excluded files and inferred directories with filter reasons", () => {
        const report = buildStructureReport([
            vf("SD\\Normal\\clip.mp4"),
            vf("SD\\.GPS\\GPSData000001.txt"),
            vf("SD/.s_Front/clip.mp4"),
            vf("SD/System Volume Information/IndexerVolumeGuid"),
            vf("SD/DCIM/200video/front/small/20260817200209_0060_S.mp4"),
        ]);

        expect(report).toContain("files: 5");
        expect(report).toMatch(/\.mp4\s+3/);
        expect(report).toMatch(/SD\/\s+\[directory; kept\]/);
        expect(report).toMatch(/SD\/\.GPS\/\s+\[directory; kept\]/);
        expect(report).toMatch(/SD\/\.GPS\/GPSData000001\.txt[^\n]+\[kept\]/);
        expect(report).toMatch(/SD\/\.s_Front\/clip\.mp4[^\n]+excluded: hidden path/);
        expect(report).toMatch(/SD\/System Volume Information\/IndexerVolumeGuid[^\n]+excluded: system path/);
        expect(report).toMatch(/small\/20260817200209_0060_S\.mp4[^\n]+excluded: preview recording/);
        expect(report).not.toContain("SD\\");
    });

    it("includes enumeration-only files in counts, extensions and sidecar candidates", () => {
        const report = buildStructureReport(
            [vf("SD/Normal/clip.mp4", { size: 10 })],
            [
                { relativePath: "SD/Normal/clip.mp4", kind: "file" },
                { relativePath: "SD/.hidden/clip.NMEA", kind: "file", size: 5, lastModified: 0 },
                { relativePath: "SD/.hidden/no-extension", kind: "file", size: 0, lastModified: 0 },
                { relativePath: "SD/empty", kind: "directory" },
            ],
        );

        expect(report).toContain("files: 3");
        expect(report).toContain("total: 15 B");
        expect(report).toMatch(/\.nmea\s+1/);
        expect(report).toMatch(/\(no ext\)\s+1/);
        expect(report).toContain("clip: .mp4 + .nmea");
        expect(report).toContain("based on 1 available File objects");
        expect(report).toMatch(/SD\/empty\/\s+\[directory; kept\]/);
        expect(report).toMatch(/SD\/Normal\/clip\.mp4\s+10 B/);
    });

    it("marks unavailable contents and metadata without claiming a complete total", () => {
        const report = buildStructureReport(
            [vf("SD/Normal/clip.mp4", { size: 10 })],
            [
                { relativePath: "SD/System Volume Information", kind: "directory", unreadable: true },
                { relativePath: "SD/.hidden/log.txt", kind: "file", unreadable: true },
            ],
        );

        expect(report).toContain("files: 2");
        expect(report).toContain("known file sizes: 10 B (1/2 observed files)");
        expect(report).toContain("Unreadable directories: 1; file counts and sizes are incomplete.");
        expect(report).toMatch(/SD\/System Volume Information\/[^\n]+excluded: system path; contents unavailable/);
        expect(report).toMatch(/SD\/\.hidden\/log\.txt[^\n]+size unavailable[^\n]+file metadata unavailable/);
        expect(report).not.toContain("total:");
    });

    it("reports unknown file sizes even without a read failure", () => {
        const report = buildStructureReport([], [{ relativePath: "SD/log.txt", kind: "file" }]);

        expect(report).toContain("files: 1");
        expect(report).toContain("known file sizes: 0 B (0/1 observed files)");
        expect(report).toContain("size unavailable");
        expect(report).not.toContain("total:");
    });

    it("counts and lists every same-path file in a prepared snapshot", () => {
        const files = [vf("clip.mp4", { size: 5 }), vf("clip.mp4", { size: 16 })];
        const report = buildStructureReportFromSnapshot(files, snapshotIngestStructure(files));

        expect(report).toContain("files: 2");
        expect(report).toContain("total: 21 B");
        expect(report).toMatch(/\.mp4\s+2/);
        expect(report).toContain("based on 2 available File objects");
        expect(report.match(/^ {2}clip\.mp4\s+/gm)).toHaveLength(2);
        expect(report).toMatch(/clip\.mp4\s+5 B/);
        expect(report).toMatch(/clip\.mp4\s+16 B/);
    });

    it("renders prepared metadata without re-enriching it from File objects", () => {
        const report = buildStructureReportFromSnapshot(
            [vf("clip.mp4", { size: 16 })],
            [{ relativePath: "clip.mp4", kind: "file", size: 5, lastModified: 0 }],
        );

        expect(report).toContain("total: 5 B");
        expect(report).toContain("based on 1 available File objects");
        expect(report).not.toContain("16 B");
    });

    it("marks bounded traversal as incomplete even when every observed file has a known size", () => {
        const report = buildStructureReport(
            [vf("SD/Normal/clip.mp4", { size: 10 })],
            [
                { relativePath: "SD", kind: "directory", truncated: "entry limit" },
                { relativePath: "SD/.hidden/deep", kind: "directory", truncated: "depth limit" },
            ],
        );

        expect(report).toContain("known file sizes: 10 B (1/1 observed files)");
        expect(report).toContain("Truncated directories: 2; file and directory counts and sizes are incomplete.");
        expect(report).toMatch(/SD\/\s+\[directory; kept; traversal truncated: entry limit\]/);
        expect(report).toMatch(/SD\/\.hidden\/deep\/[^\n]+excluded: hidden path; traversal truncated: depth limit/);
        expect(report).not.toContain("total:");
    });

    it("keeps excluded paths and empty directories visible beyond the recording cap", () => {
        const many = Array.from({ length: 3005 }, (_, i) => vf(`SD/FILE${String(i).padStart(5, "0")}.MP4`));
        const report = buildStructureReport(many, [
            { relativePath: "SD/z/.unknown/log.txt", kind: "file", size: 10 },
            { relativePath: "SD/zz-empty", kind: "directory" },
        ]);

        expect(report).toContain("files: 3006");
        expect(report).toContain("== excluded directories (1) ==");
        expect(report).toContain("== excluded files (1) ==");
        expect(report).toMatch(/SD\/z\/\.unknown\/log\.txt[^\n]+excluded: hidden path/);
        expect(report).toMatch(/SD\/zz-empty\/\s+\[directory; kept\]/);
        expect(report).toContain("... and 5 more (list truncated)");
    });

    it("announces truncation in the excluded section independently", () => {
        const structure: IngestStructureEntry[] = Array.from({ length: 3005 }, (_, i) => ({
            relativePath: `.hidden/file-${i}.txt`,
            kind: "file",
        }));
        const report = buildStructureReport([], structure);
        const excluded = report.slice(report.indexOf("== excluded files"), report.indexOf("== kept directories"));

        expect(report).toContain("files: 3005");
        expect(report).toMatch(/\.txt\s+3005/);
        expect(excluded).toContain("... and 5 more (list truncated)");
        expect(report).toMatch(/\.hidden\/\s+\[directory; excluded: hidden path\]/);
    });
});
