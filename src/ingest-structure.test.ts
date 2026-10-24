import { describe, expect, it } from "vitest";
import { snapshotIngestStructure, type IngestStructureEntry } from "./ingest-structure.js";

describe("snapshotIngestStructure", () => {
    it("keeps excluded and empty directories while adding available file metadata", () => {
        const entries: IngestStructureEntry[] = [
            { relativePath: "SD/.hidden/clip.mp4", kind: "file" },
            { relativePath: "SD/empty", kind: "directory" },
            { relativePath: "SD/System Volume Information", kind: "directory", unreadable: true },
            { relativePath: "SD/.GPS/GPSData.txt", kind: "file" },
        ];
        const snapshot = snapshotIngestStructure(
            [{ relativePath: "SD\\.GPS\\GPSData.txt", file: new File(["$V02"], "GPSData.txt", { lastModified: 12 }) }],
            entries,
        );
        expect(snapshot).toContainEqual({ relativePath: "SD/.hidden/clip.mp4", kind: "file" });
        expect(snapshot).toContainEqual({ relativePath: "SD/empty", kind: "directory" });
        expect(snapshot).toContainEqual({
            relativePath: "SD/System Volume Information",
            kind: "directory",
            unreadable: true,
        });
        expect(snapshot.filter((entry) => entry.relativePath === "SD/.GPS/GPSData.txt")).toEqual([
            { relativePath: "SD/.GPS/GPSData.txt", kind: "file", size: 4, lastModified: 12 },
        ]);
        expect(entries[3]).toEqual({ relativePath: "SD/.GPS/GPSData.txt", kind: "file" });
    });

    it("infers parents for a classic folder input and falls back to a bare filename", () => {
        const file = new File(["x"], "clip.mp4", { lastModified: 0 });
        expect(snapshotIngestStructure([{ file, relativePath: "/SD//Normal\\Front/clip.mp4" }])).toEqual([
            { relativePath: "SD", kind: "directory" },
            { relativePath: "SD/Normal", kind: "directory" },
            { relativePath: "SD/Normal/Front", kind: "directory" },
            { relativePath: "SD/Normal/Front/clip.mp4", kind: "file", size: 1, lastModified: 0 },
        ]);
        expect(snapshotIngestStructure([{ file, relativePath: "" }])).toEqual([
            { relativePath: "clip.mp4", kind: "file", size: 1, lastModified: 0 },
        ]);
    });

    it("preserves same-name files from a flat selection, including identical metadata", () => {
        const files = [
            new File(["first"], "clip.mp4", { lastModified: 1 }),
            new File(["second recording"], "clip.mp4", { lastModified: 2 }),
            new File(["third"], "clip.mp4", { lastModified: 1 }),
        ].map((file) => ({ file, relativePath: file.name }));

        expect(snapshotIngestStructure(files)).toEqual([
            { relativePath: "clip.mp4", kind: "file", size: 5, lastModified: 1 },
            { relativePath: "clip.mp4", kind: "file", size: 16, lastModified: 2 },
            { relativePath: "clip.mp4", kind: "file", size: 5, lastModified: 1 },
        ]);
    });

    it("enriches repeated enumerated file paths one-to-one without changing unreadable occurrences", () => {
        const entries: IngestStructureEntry[] = [
            { relativePath: "SD/clip.mp4", kind: "file", unreadable: true },
            { relativePath: "SD/clip.mp4", kind: "file" },
            { relativePath: "SD\\clip.mp4", kind: "file" },
            { relativePath: "SD/clip.mp4", kind: "file", unreadable: true },
        ];
        const files = [
            { relativePath: "SD/clip.mp4", file: new File(["first"], "clip.mp4", { lastModified: 1 }) },
            { relativePath: "SD/clip.mp4", file: new File(["second"], "clip.mp4", { lastModified: 2 }) },
        ];
        const snapshot = snapshotIngestStructure(files, entries);

        expect(snapshot).toEqual([
            { relativePath: "SD", kind: "directory" },
            { relativePath: "SD/clip.mp4", kind: "file", unreadable: true },
            { relativePath: "SD/clip.mp4", kind: "file", size: 5, lastModified: 1 },
            { relativePath: "SD/clip.mp4", kind: "file", size: 6, lastModified: 2 },
            { relativePath: "SD/clip.mp4", kind: "file", unreadable: true },
        ]);
        expect(snapshotIngestStructure(files, snapshot)).toEqual(snapshot);
        expect(entries[1]).toEqual({ relativePath: "SD/clip.mp4", kind: "file" });
    });

    it("retains enumeration-only duplicate files and truncation on an inferred parent", () => {
        const snapshot = snapshotIngestStructure(
            [],
            [
                { relativePath: "SD/.hidden/log.txt", kind: "file" },
                { relativePath: "SD/.hidden/log.txt", kind: "file" },
                { relativePath: "SD/.hidden", kind: "directory", truncated: "entry limit" },
            ],
        );

        expect(snapshot.filter((entry) => entry.kind === "file")).toHaveLength(2);
        expect(snapshot.filter((entry) => entry.relativePath === "SD/.hidden")).toEqual([
            { relativePath: "SD/.hidden", kind: "directory", truncated: "entry limit" },
        ]);
    });
});
