import { describe, expect, it } from "vitest";
import { knownFileMtime, pinUnknownFileMtimes, UNKNOWN_FILE_MTIME } from "./file-mtime.js";
import type { VendorFile } from "./parsers/types.js";
import { vendorFileKey } from "./vendor-file-key.js";

/** Reproduces Chromium for a file without a modification time: every read of
 * lastModified returns the current time. */
function fileWithoutMtime(content: string, name: string, type: string): File {
    const file = new File([content], name, { type });
    Object.defineProperty(file, "lastModified", { get: () => Date.now() });
    return file;
}

describe("pinUnknownFileMtimes", () => {
    it("pins a file whose lastModified follows the clock and keeps its bytes and identity fields", async () => {
        const unknown: VendorFile = {
            file: fileWithoutMtime("frames", "FILE0001.MP4", "video/mp4"),
            relativePath: "DCIM/FILE0001.MP4",
            sourceKey: "drop:1",
        };

        const [pinned] = await pinUnknownFileMtimes([unknown]);

        expect(pinned).toBeDefined();
        expect(pinned!.file).not.toBe(unknown.file);
        expect(pinned!.file.lastModified).toBe(UNKNOWN_FILE_MTIME);
        expect(pinned!.file.name).toBe("FILE0001.MP4");
        expect(pinned!.file.type).toBe("video/mp4");
        expect(await pinned!.file.text()).toBe("frames");
        expect(pinned!.relativePath).toBe("DCIM/FILE0001.MP4");
        expect(pinned!.sourceKey).toBe("drop:1");
        const keyBefore = vendorFileKey(pinned!);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(vendorFileKey(pinned!), "identity after the clock advanced").toBe(keyBefore);
    });

    it("returns files with a stored time unchanged, including a future-dated one", async () => {
        const dated: VendorFile = {
            file: new File(["a"], "A.MP4", { lastModified: 1_700_000_000_000 }),
            relativePath: "",
        };
        const futureDated: VendorFile = {
            // A camera clock set years ahead keeps the same answer on every read.
            file: new File(["b"], "B.MP4", { lastModified: Date.now() + 365 * 24 * 3600 * 1000 }),
            relativePath: "",
        };
        const unknown: VendorFile = { file: fileWithoutMtime("c", "C.MP4", ""), relativePath: "" };

        const result = await pinUnknownFileMtimes([dated, futureDated, unknown]);

        expect(result).toHaveLength(3);
        expect(result[0]).toBe(dated);
        expect(result[1]).toBe(futureDated);
        expect(result[2]!.file.lastModified).toBe(UNKNOWN_FILE_MTIME);
    });
});

describe("knownFileMtime", () => {
    it("reports pinned and pre-epoch times as unknown and passes a stored time through", () => {
        expect(knownFileMtime(new File([], "a", { lastModified: UNKNOWN_FILE_MTIME }))).toBeNull();
        expect(knownFileMtime(new File([], "c", { lastModified: -11_644_473_600_000 })), "chromium 1601").toBeNull();
        expect(knownFileMtime(new File([], "b", { lastModified: 1_700_000_000_000 }))).toBe(1_700_000_000_000);
    });
});
