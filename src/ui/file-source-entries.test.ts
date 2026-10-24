import { describe, expect, it, vi } from "vitest";

import { MAX_EXCLUDED_DIRECTORY_DEPTH, MAX_EXCLUDED_STRUCTURE_ENTRIES } from "../excluded-traversal-budget.js";
import { collectFilesFromDataTransfer } from "./file-source-entries.js";

interface FakeEntry {
    name: string;
    fullPath: string;
    isFile: boolean;
    isDirectory: boolean;
}

function fakeFile(fullPath: string, shouldFail = false) {
    const name = fullPath.split("/").at(-1)!;
    return {
        name,
        fullPath,
        isFile: true,
        isDirectory: false,
        file: vi.fn((success: FileCallback, failure: ErrorCallback) => {
            if (shouldFail) failure(new DOMException("file disappeared", "NotFoundError"));
            else success(new File(["x"], name, { lastModified: 1234 }));
        }),
    };
}

function fakeDir(fullPath: string, batches: FakeEntry[][] = [], shouldFail = false) {
    let nextBatch = 0;
    return {
        name: fullPath.split("/").at(-1)!,
        fullPath,
        isFile: false,
        isDirectory: true,
        createReader: vi.fn(() => ({
            readEntries: vi.fn((success: (entries: FakeEntry[]) => void, failure: ErrorCallback) => {
                if (nextBatch < batches.length) success(batches[nextBatch++]!);
                else if (shouldFail) failure(new DOMException("permission denied", "NotAllowedError"));
                else success([]);
            }),
        })),
    };
}

// Stand-ins provide the browser callbacks; traversal and File objects are real.
function transfer(entries: FakeEntry[]): DataTransfer {
    return { items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })) } as unknown as DataTransfer;
}

describe("collectFilesFromDataTransfer", () => {
    it("reports excluded descendants and empty directories while retaining GPS logs", async () => {
        const hiddenLog = fakeFile("/SD/.telemetry/trip/track.gps");
        const proxy = fakeFile("/SD/small/20260817190140_0060_S.mp4");
        const gpsLog = fakeFile("/SD/.GPS/GPSData000001.txt");
        const clip = fakeFile("/SD/clip.mp4");
        const root = fakeDir("/SD", [
            [fakeDir("/SD/.telemetry", [[fakeDir("/SD/.telemetry/trip", [[hiddenLog]])]])],
            [fakeDir("/SD/small", [[proxy]]), fakeDir("/SD/.GPS", [[gpsLog]]), fakeDir("/SD/empty"), clip],
        ]);

        const result = await collectFilesFromDataTransfer(transfer([root]));

        expect(result.structure).toEqual([
            { relativePath: "SD", kind: "directory" },
            { relativePath: "SD/.telemetry", kind: "directory" },
            { relativePath: "SD/.telemetry/trip", kind: "directory" },
            { relativePath: "SD/.telemetry/trip/track.gps", kind: "file" },
            { relativePath: "SD/small", kind: "directory" },
            { relativePath: "SD/small/20260817190140_0060_S.mp4", kind: "file" },
            { relativePath: "SD/.GPS", kind: "directory" },
            { relativePath: "SD/.GPS/GPSData000001.txt", kind: "file", size: 1, lastModified: 1234 },
            { relativePath: "SD/empty", kind: "directory" },
            { relativePath: "SD/clip.mp4", kind: "file", size: 1, lastModified: 1234 },
        ]);
        expect(result.files.map((file) => file.relativePath)).toEqual(["SD/.GPS/GPSData000001.txt", "SD/clip.mp4"]);
        expect(hiddenLog.file).not.toHaveBeenCalled();
        expect(proxy.file).not.toHaveBeenCalled();
        expect(result.readErrors).toBe(0);
    });

    it("reports an excluded root without opening its files", async () => {
        const clip = fakeFile("/.backup/Normal/clip.mp4");
        const root = fakeDir("/.backup", [[fakeDir("/.backup/Normal", [[clip]])]]);

        const result = await collectFilesFromDataTransfer(transfer([root]));

        expect(result.files).toEqual([]);
        expect(result.structure).toEqual([
            { relativePath: ".backup", kind: "directory" },
            { relativePath: ".backup/Normal", kind: "directory" },
            { relativePath: ".backup/Normal/clip.mp4", kind: "file" },
        ]);
        expect(clip.file).not.toHaveBeenCalled();
    });

    it("shares the excluded entry budget across roots without skipping eligible siblings or reading later batches", async () => {
        const hiddenFiles = Array.from({ length: MAX_EXCLUDED_STRUCTURE_ENTRIES + 1 }, (_, i) => ({
            name: `entry-${i}.dat`,
            fullPath: `/FIRST/.hidden/entry-${i}.dat`,
            isFile: true,
            isDirectory: false,
        }));
        const hidden = fakeDir("/FIRST/.hidden", [hiddenFiles, [fakeFile("/FIRST/.hidden/later.dat")]]);
        const laterHidden = fakeDir("/SECOND/.later", [[fakeFile("/SECOND/.later/ignored.dat")]]);
        const clip = fakeFile("/SECOND/clip.mp4");
        const gpsLog = fakeFile("/SECOND/.GPS/GPSData000001.txt");

        const result = await collectFilesFromDataTransfer(
            transfer([
                fakeDir("/FIRST", [[hidden]]),
                fakeDir("/SECOND", [[laterHidden, clip, fakeDir("/SECOND/.GPS", [[gpsLog]])]]),
            ]),
        );

        expect(hidden.createReader.mock.results[0]!.value.readEntries).toHaveBeenCalledOnce();
        expect(laterHidden.createReader).not.toHaveBeenCalled();
        expect(result.structure.filter((entry) => entry.relativePath.startsWith("FIRST/.hidden"))).toHaveLength(
            MAX_EXCLUDED_STRUCTURE_ENTRIES,
        );
        expect(result.structure).toContainEqual({
            relativePath: "FIRST/.hidden",
            kind: "directory",
            truncated: "entry limit",
        });
        expect(result.structure).toContainEqual({
            relativePath: "SECOND",
            kind: "directory",
            truncated: "entry limit",
        });
        expect(result.files.map((file) => file.relativePath)).toEqual([
            "SECOND/clip.mp4",
            "SECOND/.GPS/GPSData000001.txt",
        ]);
        expect(result.readErrors).toBe(0);
    });

    it("limits excluded nesting while normal and GPS trees keep their deepest files", async () => {
        const depth = MAX_EXCLUDED_DIRECTORY_DEPTH + 2;
        const tree = (name: string) => {
            const paths = [`/SD/${name}`];
            for (let i = 1; i < depth; i++) paths.push(`${paths[i - 1]}/level${i}`);
            const file = fakeFile(`${paths.at(-1)}/track.txt`);
            let child: FakeEntry = file;
            const dirs: ReturnType<typeof fakeDir>[] = [];
            for (const path of paths.reverse()) {
                const dir = fakeDir(path, [[child]]);
                dirs.unshift(dir);
                child = dir;
            }
            return { root: dirs[0]!, dirs, file };
        };
        const hidden = tree(".hidden");
        const normal = tree("Normal");
        const gps = tree(".GPS");

        const result = await collectFilesFromDataTransfer(
            transfer([fakeDir("/SD", [[hidden.root, normal.root, gps.root]])]),
        );

        expect(hidden.dirs[MAX_EXCLUDED_DIRECTORY_DEPTH - 2]!.createReader).toHaveBeenCalledOnce();
        expect(hidden.dirs[MAX_EXCLUDED_DIRECTORY_DEPTH - 1]!.createReader).not.toHaveBeenCalled();
        expect(hidden.file.file).not.toHaveBeenCalled();
        expect(normal.file.file).toHaveBeenCalledOnce();
        expect(gps.file.file).toHaveBeenCalledOnce();
        expect(result.structure.filter((entry) => entry.truncated)).toEqual([
            {
                relativePath: hidden.dirs[MAX_EXCLUDED_DIRECTORY_DEPTH - 1]!.fullPath.slice(1),
                kind: "directory",
                truncated: "depth limit",
            },
        ]);
        expect(result.files).toHaveLength(2);
        expect(result.readErrors).toBe(0);
    });

    it("retains inaccessible entries and partial listings while counting only eligible failures", async () => {
        const hiddenLog = fakeFile("/SD/.telemetry/track.gps");
        const root = fakeDir("/SD", [
            [
                fakeDir("/SD/.telemetry", [[hiddenLog]], true),
                fakeDir("/SD/.Spotlight-V100", [], true),
                fakeDir("/SD/Normal", [], true),
                fakeFile("/SD/clip.mp4", true),
            ],
        ]);

        const result = await collectFilesFromDataTransfer(transfer([root]));

        expect(result.files).toEqual([]);
        expect(result.readErrors).toBe(2);
        expect(result.structure).toEqual([
            { relativePath: "SD", kind: "directory" },
            { relativePath: "SD/.telemetry", kind: "directory", unreadable: true },
            { relativePath: "SD/.telemetry/track.gps", kind: "file" },
            { relativePath: "SD/.Spotlight-V100", kind: "directory", unreadable: true },
            { relativePath: "SD/Normal", kind: "directory", unreadable: true },
            { relativePath: "SD/clip.mp4", kind: "file", unreadable: true },
        ]);
        expect(hiddenLog.file).not.toHaveBeenCalled();
    });

    it("retains a failed root directory in the diagnostic structure", async () => {
        const result = await collectFilesFromDataTransfer(transfer([fakeDir("/SD", [], true)]));

        expect(result).toEqual({
            files: [],
            structure: [{ relativePath: "SD", kind: "directory", unreadable: true }],
            readErrors: 1,
        });
    });

    it("falls back to the file list when entry enumeration is unavailable", async () => {
        const file = new File(["x"], "clip.mp4", { lastModified: 1234 });
        const result = await collectFilesFromDataTransfer({ files: [file] } as unknown as DataTransfer);

        expect(result).toEqual({ files: [{ file, relativePath: "clip.mp4" }], structure: [], readErrors: 0 });
        expect(await collectFilesFromDataTransfer(null)).toEqual({ files: [], structure: [], readErrors: 0 });
    });
});
