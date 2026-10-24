import { describe, expect, it, vi } from "vitest";

import { MAX_EXCLUDED_DIRECTORY_DEPTH, MAX_EXCLUDED_STRUCTURE_ENTRIES } from "../excluded-traversal-budget.js";
import { enumerateFolder } from "./folders.js";

// Fakes stand in for FileSystemDirectoryHandle: the real API needs a browser
// and a user gesture, while the walk under test is pure iteration. vi.fn wraps
// let the tests verify enumeration never opens excluded files.

interface FakeEntry {
    kind: "file" | "directory";
    name: string;
}

function fakeFile(name: string) {
    return {
        kind: "file" as const,
        name,
        getFile: vi.fn(async () => new File(["x"], name, { lastModified: 1234 })),
    };
}

function fakeDir(name: string, children: FakeEntry[] = []) {
    return {
        kind: "directory" as const,
        name,
        values: vi.fn(async function* () {
            yield* children;
        }),
    };
}

// Mirrors how the platform surfaces OS metadata directories: the handle
// enumerates fine as a child, but iterating it rejects.
function fakeUnreadableDir(name: string) {
    return {
        kind: "directory" as const,
        name,
        values: vi.fn(() => ({
            [Symbol.asyncIterator]() {
                return this;
            },
            async next(): Promise<IteratorResult<FakeEntry>> {
                throw new Error("permission denied by the platform");
            },
        })),
    };
}

function asHandle(dir: unknown): FileSystemDirectoryHandle {
    return dir as FileSystemDirectoryHandle;
}

describe("enumerateFolder", () => {
    it.each([".GPS", ".gps", ".Gps"])("reads 70mai logs from %s while reporting nested junk", async (name) => {
        const gpsLog = fakeFile("GPSData000001.txt");
        const spotlight = fakeUnreadableDir(".Spotlight-V100");
        const dsStore = fakeFile(".DS_Store");
        const gps = fakeDir(name, [gpsLog, spotlight, dsStore]);
        const clip = fakeFile("clip.mp4");
        const root = fakeDir("SD", [gps, fakeDir("Normal", [clip])]);

        const result = await enumerateFolder(asHandle(root));

        expect(result.files.map((vf) => vf.relativePath)).toEqual([
            `SD/${name}/GPSData000001.txt`,
            "SD/Normal/clip.mp4",
        ]);
        expect(result.readErrors).toBe(0);
        expect(gpsLog.getFile).toHaveBeenCalledOnce();
        expect(result.structure).toContainEqual({
            relativePath: `SD/${name}/.Spotlight-V100`,
            kind: "directory",
            unreadable: true,
        });
        expect(result.structure).toContainEqual({ relativePath: `SD/${name}/.DS_Store`, kind: "file" });
        expect(dsStore.getFile).not.toHaveBeenCalled();
    });

    it("reports inaccessible OS-junk directories without counting them as read errors", async () => {
        const spotlight = fakeUnreadableDir(".Spotlight-V100");
        const systemVolumeInformation = fakeUnreadableDir("System Volume Information");
        const dsStore = fakeFile(".DS_Store");
        const clip = fakeFile("clip.mp4");
        const root = fakeDir("SD", [spotlight, systemVolumeInformation, dsStore, fakeDir("Normal", [clip])]);

        const result = await enumerateFolder(asHandle(root));

        expect(result.files.map((vf) => vf.relativePath)).toEqual(["SD/Normal/clip.mp4"]);
        expect(result.readErrors, "excluded inaccessible content is not an ingest failure").toBe(0);
        expect(result.structure.filter((entry) => entry.unreadable)).toEqual([
            { relativePath: "SD/.Spotlight-V100", kind: "directory", unreadable: true },
            { relativePath: "SD/System Volume Information", kind: "directory", unreadable: true },
        ]);
        expect(dsStore.getFile).not.toHaveBeenCalled();
    });

    it("reports hidden descendants and empty directories without opening excluded files", async () => {
        const hiddenLog = fakeFile("track.gps");
        const proxy = fakeFile("20260817190140_0060_S.mp4");
        const clip = fakeFile("clip.mp4");
        const root = fakeDir("SD", [
            fakeDir(".telemetry", [fakeDir("trip", [hiddenLog])]),
            fakeDir("small", [proxy]),
            fakeDir("empty"),
            clip,
        ]);

        const result = await enumerateFolder(asHandle(root));

        expect(result.structure).toEqual([
            { relativePath: "SD", kind: "directory" },
            { relativePath: "SD/.telemetry", kind: "directory" },
            { relativePath: "SD/.telemetry/trip", kind: "directory" },
            { relativePath: "SD/.telemetry/trip/track.gps", kind: "file" },
            { relativePath: "SD/small", kind: "directory" },
            { relativePath: "SD/small/20260817190140_0060_S.mp4", kind: "file" },
            { relativePath: "SD/empty", kind: "directory" },
            { relativePath: "SD/clip.mp4", kind: "file", size: 1, lastModified: 1234 },
        ]);
        expect(result.files.map((vf) => vf.relativePath)).toEqual(["SD/clip.mp4"]);
        expect(hiddenLog.getFile).not.toHaveBeenCalled();
        expect(proxy.getFile).not.toHaveBeenCalled();
        expect(result.readErrors).toBe(0);
    });

    it("reports an explicitly selected hidden root without opening its files", async () => {
        const clip = fakeFile("clip.mp4");
        const root = fakeDir(".backup", [fakeDir("Normal", [clip])]);

        const result = await enumerateFolder(asHandle(root));

        expect(result.files).toEqual([]);
        expect(result.structure).toEqual([
            { relativePath: ".backup", kind: "directory" },
            { relativePath: ".backup/Normal", kind: "directory" },
            { relativePath: ".backup/Normal/clip.mp4", kind: "file" },
        ]);
        expect(clip.getFile).not.toHaveBeenCalled();
    });

    it("bounds a large excluded tree and still imports eligible siblings after the budget is spent", async () => {
        let yielded = 0;
        let released = false;
        const hidden = {
            kind: "directory" as const,
            name: ".hidden",
            values: async function* () {
                try {
                    for (let i = 0; i < MAX_EXCLUDED_STRUCTURE_ENTRIES * 2; i++) {
                        yielded++;
                        yield { kind: "file" as const, name: `entry-${i}.dat` };
                    }
                } finally {
                    released = true;
                }
            },
        };
        const laterHidden = fakeDir(".later", [fakeFile("ignored.dat")]);
        const clip = fakeFile("clip.mp4");
        const gpsLog = fakeFile("GPSData000001.txt");
        const root = fakeDir("SD", [hidden, laterHidden, clip, fakeDir(".GPS", [gpsLog])]);

        const result = await enumerateFolder(asHandle(root));

        expect(yielded, "the excluded iterator stops instead of draining the directory").toBe(
            MAX_EXCLUDED_STRUCTURE_ENTRIES,
        );
        expect(released, "the interrupted directory iterator is released").toBe(true);
        expect(laterHidden.values).not.toHaveBeenCalled();
        expect(result.structure.filter((entry) => entry.relativePath.startsWith("SD/.hidden"))).toHaveLength(
            MAX_EXCLUDED_STRUCTURE_ENTRIES,
        );
        expect(result.structure).toContainEqual({
            relativePath: "SD/.hidden",
            kind: "directory",
            truncated: "entry limit",
        });
        expect(result.structure).toContainEqual({ relativePath: "SD", kind: "directory", truncated: "entry limit" });
        expect(result.files.map((file) => file.relativePath)).toEqual(["SD/clip.mp4", "SD/.GPS/GPSData000001.txt"]);
        expect(result.readErrors).toBe(0);
    });

    it("limits excluded directory depth without limiting normal or GPS directories", async () => {
        const depth = MAX_EXCLUDED_DIRECTORY_DEPTH + 2;
        const tree = (name: string) => {
            const file = fakeFile("track.txt");
            let child: FakeEntry = file;
            const dirs: ReturnType<typeof fakeDir>[] = [];
            for (let i = depth - 1; i >= 0; i--) {
                const dir = fakeDir(i === 0 ? name : `level${i}`, [child]);
                dirs.unshift(dir);
                child = dir;
            }
            return { root: dirs[0]!, dirs, file };
        };
        const hidden = tree(".hidden");
        const normal = tree("Normal");
        const gps = tree(".GPS");

        const result = await enumerateFolder(asHandle(fakeDir("SD", [hidden.root, normal.root, gps.root])));

        expect(hidden.dirs[MAX_EXCLUDED_DIRECTORY_DEPTH - 2]!.values).toHaveBeenCalledOnce();
        expect(hidden.dirs[MAX_EXCLUDED_DIRECTORY_DEPTH - 1]!.values).not.toHaveBeenCalled();
        expect(hidden.file.getFile).not.toHaveBeenCalled();
        expect(normal.file.getFile).toHaveBeenCalledOnce();
        expect(gps.file.getFile).toHaveBeenCalledOnce();
        expect(result.structure.filter((entry) => entry.truncated)).toEqual([
            {
                relativePath: `SD/.hidden/${Array.from({ length: MAX_EXCLUDED_DIRECTORY_DEPTH - 1 }, (_, i) => `level${i + 1}`).join("/")}`,
                kind: "directory",
                truncated: "depth limit",
            },
        ]);
        expect(result.files).toHaveLength(2);
        expect(result.readErrors).toBe(0);
    });

    it("counts a non-junk unreadable subdirectory as a read error and keeps walking", async () => {
        const broken = fakeUnreadableDir("DCIM");
        const clip = fakeFile("clip.mp4");
        const root = fakeDir("SD", [broken, clip]);

        const result = await enumerateFolder(asHandle(root));

        expect(result.files.map((vf) => vf.relativePath)).toEqual(["SD/clip.mp4"]);
        expect(result.readErrors).toBe(1);
        expect(result.structure).toContainEqual({ relativePath: "SD/DCIM", kind: "directory", unreadable: true });
    });

    it("retains unreadable eligible filenames in the structure", async () => {
        const clip = fakeFile("clip.mp4");
        clip.getFile.mockRejectedValue(new Error("file disappeared"));

        const result = await enumerateFolder(asHandle(fakeDir("SD", [clip])));

        expect(result.files).toEqual([]);
        expect(result.readErrors).toBe(1);
        expect(result.structure).toContainEqual({ relativePath: "SD/clip.mp4", kind: "file", unreadable: true });
    });

    it("rejects when the selected root cannot be enumerated", async () => {
        await expect(enumerateFolder(asHandle(fakeUnreadableDir("SD")))).rejects.toThrow(
            "permission denied by the platform",
        );
    });
});
