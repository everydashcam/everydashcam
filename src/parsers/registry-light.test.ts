import { describe, expect, it } from "vitest";

import { isVideoFile, splitVideosByExtension } from "./registry-light.js";
import type { VendorFile } from "./types.js";

function vf(relativePath: string, sourceKey?: string): VendorFile {
    const name = relativePath.split("/").pop()!;
    return {
        file: new File([new Uint8Array(0)], name),
        relativePath,
        ...(sourceKey === undefined ? {} : { sourceKey }),
    };
}

const SEGMENT = "00000001--0000000000--4";

describe("isVideoFile", () => {
    it("admits raw HEVC only under the openpilot route layout", () => {
        expect(isVideoFile(vf(`${SEGMENT}/fcamera.hevc`))).toBe(true);
        expect(isVideoFile(vf(`${SEGMENT}/ecamera.hevc`))).toBe(true);
        expect(isVideoFile(vf(`${SEGMENT}/dcamera.hevc`))).toBe(true);
        expect(isVideoFile(vf(`0123456789abcdef_${SEGMENT}--fcamera (1).hevc`))).toBe(true);
        expect(isVideoFile(vf("export/clip.hevc"))).toBe(false);
        expect(isVideoFile(vf("fcamera.hevc"))).toBe(false);
        expect(isVideoFile(vf(`${SEGMENT}/qlog.zst`))).toBe(false);
    });

    it("keeps container extensions as the only test for every other file", () => {
        expect(isVideoFile(vf(`${SEGMENT}/qcamera.ts`))).toBe(true);
        expect(isVideoFile(vf("DCIM/20260101_120000_F.MP4"))).toBe(true);
        expect(isVideoFile(vf("DCIM/20260101_120000_F.hevc.txt"))).toBe(false);
    });
});

describe("splitVideosByExtension with openpilot previews", () => {
    const names = (entries: Array<{ file: VendorFile }>) => entries.map((entry) => entry.file.relativePath);

    it("drops a segment's preview only when its full-res road video is in the same drop and folder", () => {
        const files = [
            vf(`a/${SEGMENT}/fcamera.hevc`, "s"),
            vf(`a/${SEGMENT}/qcamera.ts`, "s"),
            // Another route folder, another source and another segment keep theirs.
            vf(`b/${SEGMENT}/qcamera.ts`, "s"),
            vf(`a/${SEGMENT}/qcamera.ts`, "t"),
            vf("a/00000001--0000000000--5/qcamera.ts", "s"),
        ];
        expect(names(splitVideosByExtension(files).videoEntries)).toEqual([
            `a/${SEGMENT}/fcamera.hevc`,
            `b/${SEGMENT}/qcamera.ts`,
            `a/${SEGMENT}/qcamera.ts`,
            "a/00000001--0000000000--5/qcamera.ts",
        ]);
    });

    it("keeps the preview instead of the full-res file when raw HEVC cannot play", () => {
        const files = [vf(`${SEGMENT}/fcamera.hevc`), vf(`${SEGMENT}/qcamera.ts`), vf(`${SEGMENT}/dcamera.hevc`)];
        expect(names(splitVideosByExtension(files, [], false).videoEntries)).toEqual([
            `${SEGMENT}/qcamera.ts`,
            `${SEGMENT}/dcamera.hevc`,
        ]);
    });

    it("leaves out every downloaded copy of the superseded view", () => {
        const flat = (stream: string) => vf(`dl/0123456789abcdef_${SEGMENT}--${stream}`);
        const files = [flat("fcamera.hevc"), flat("qcamera.TS"), flat("qcamera (1).TS"), flat("fcamera (2).hevc")];
        expect(names(splitVideosByExtension(files).videoEntries)).toEqual([
            files[0]!.relativePath,
            files[3]!.relativePath,
        ]);
        expect(names(splitVideosByExtension(files, [], false).videoEntries)).toEqual([
            files[1]!.relativePath,
            files[2]!.relativePath,
        ]);
    });

    it("keeps the preview when only the wide or driver camera came along", () => {
        const files = [vf(`${SEGMENT}/ecamera.hevc`), vf(`${SEGMENT}/dcamera.hevc`), vf(`${SEGMENT}/qcamera.ts`)];
        expect(splitVideosByExtension(files).videoEntries).toHaveLength(3);
    });
});
