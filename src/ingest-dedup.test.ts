import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { dropDuplicateFiles } from "./ingest-dedup.js";
import { cameraFingerprint } from "./parsers/camera-fingerprint.js";
import { associateRecordsWithVideos, recordsForVideo } from "./gps-association.js";
import { mergeIntoGpsLog } from "./parser.js";
import { csv70maiPrimitive } from "./parsers/primitives/csv-70mai.js";
import type { VendorFile } from "./parsers/types.js";

// Big enough to exercise the separate tail probe (> 64 KiB head window).
const LARGE_SIZE = 200 * 1024;

/** File filled with `fill`, with optional byte patches at given offsets. */
function makeContent(size: number, fill: number, patches: Record<number, number> = {}): Uint8Array<ArrayBuffer> {
    const buf = new Uint8Array(size).fill(fill);
    for (const [offset, value] of Object.entries(patches)) {
        buf[Number(offset)] = value;
    }
    return buf;
}

function vf(
    relativePath: string,
    content: Uint8Array<ArrayBuffer> | string,
    options: { lastModified?: number; sourceKey?: string } = {},
): VendorFile {
    const name = relativePath.split("/").pop()!;
    return {
        file: new File([content], name, { lastModified: options.lastModified ?? 1 }),
        relativePath,
        sourceKey: options.sourceKey,
    };
}

describe("dropDuplicateFiles", () => {
    it("preserves identical external logs owned by distinct surviving recordings", async () => {
        const root = new URL("../tests/testdata/70mai-multichannel/", import.meta.url);
        const name = "NO20260101-120000-000001F.MP4";
        const a = vf(`A/Normal/Front/${name}`, readFileSync(new URL(`Normal/Front/${name}`, root)));
        const b = vf(
            `B/Normal/Front/${name}`,
            readFileSync(new URL("Normal/Back/NO20260101-120000-000001B.MP4", root)),
        );
        const bytes = readFileSync(new URL("GPSData000001.txt", root));
        const logA = vf("A/GPSData000001.txt", bytes);
        const logB = vf("B/GPSData000001.txt", bytes);
        const { kept } = await dropDuplicateFiles([a, b, logA, logB], []);
        expect(kept).toEqual([a, b, logA, logB]);
        let log = null;
        for (const source of kept.filter((item) => item.file.name.endsWith(".txt"))) {
            const parsed = await csv70maiPrimitive.parse(source);
            associateRecordsWithVideos(parsed.records, source, [a, b]);
            log = mergeIntoGpsLog(log, { records: parsed.records, skipped: parsed.skipped, appliedExtractors: [] });
        }
        expect(log).not.toBeNull();
        expect(recordsForVideo(log!, a, [a, b])).toHaveLength(3);
        expect(recordsForVideo(log!, b, [a, b])).toHaveLength(3);
    });

    it("keeps same-content auxiliary files without reading their bytes", async () => {
        const incoming = ["gps", "gpx", "3gf", "map"].flatMap((ext) => [
            vf(`A/clip.${ext}`, "shared"),
            vf(`B/clip.${ext}`, "shared"),
        ]);
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            expect((await dropDuplicateFiles(incoming, [])).kept).toEqual(incoming);
            expect(sliceSpy).not.toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("passes unique files through untouched, preserving order", async () => {
        const incoming = [
            vf("Normal/Front/A.MP4", makeContent(1024, 1)),
            vf("Normal/Front/B.MP4", makeContent(1024, 2)),
            vf("Normal/Back/C.MP4", makeContent(2048, 3)),
        ];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept).toEqual(incoming);
        expect(dropped).toEqual([]);
    });

    it("keeps same-name files of different sizes without probing", async () => {
        // 70mai .s_* proxies share a basename with the full-res clip but differ
        // in size - they must never collide on the metadata key.
        const incoming = [vf("Normal/Front/X.MP4", makeContent(4096, 1)), vf("proxy/X.MP4", makeContent(1024, 1))];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept).toHaveLength(2);
        expect(dropped).toEqual([]);
    });

    it("drops a byte-identical copy from another subfolder", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const incoming = [vf("Movie/front/0001.MP4", content), vf("backupcopy/0001.MP4", content)];
        const { kept, dropped, copies } = await dropDuplicateFiles(incoming, []);
        expect(kept).toHaveLength(1);
        expect(dropped).toEqual([{ droppedPath: "backupcopy/0001.MP4", keptPath: "Movie/front/0001.MP4" }]);
        expect(copies).toEqual([{ kept: incoming[0], duplicate: incoming[1] }]);
    });

    it.each(["EV", "VL", "PA"])("collapses a real-time 70mai NO/%s copy while retaining the event", async (prefix) => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content);
        const event = vf(`card/Event/Front/${prefix}20260101-120000-000042F.MP4`, content);

        for (const incoming of [
            [normal, event],
            [event, normal],
        ]) {
            const result = await dropDuplicateFiles(incoming, []);
            expect(result.kept).toEqual([event]);
            expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
        }
    });

    it("prefers event evidence for a same-name copy in normal and event folders", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/EV20260101-120000-000042F.MP4", content);
        const event = vf("card/Event/Front/EV20260101-120000-000042F.MP4", content);
        const result = await dropDuplicateFiles([normal, event], []);
        expect(result.kept).toEqual([event]);
        expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
    });

    it.each([
        ["20260101_120000_NF.mp4", "20260101_120000_EF.mp4"],
        ["2026_1017_120000_000042F.MP4", "2026_1017_120000_000042EF.MP4"],
    ])("recognises a protected copy across existing filename mode techniques: %s", async (normalName, eventName) => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf(`card/recordings/${normalName}`, content);
        const event = vf(`card/recordings/${eventName}`, content);
        for (const incoming of [
            [normal, event],
            [event, normal],
        ]) {
            const result = await dropDuplicateFiles(incoming, []);
            expect(result.kept).toEqual([event]);
            expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
        }
    });

    it.each([
        ["NO20260101-120000-000042F.MP4", "EV20260101-120000-000042F.MP4"],
        ["20260101_120000_NF.mp4", "20260101_120000_EF.mp4"],
    ])("matches flat protected copies across separate source scopes: %s", async (normalName, eventName) => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf(normalName, content, { sourceKey: "normal" });
        const event = vf(eventName, content, { sourceKey: "event" });
        const result = await dropDuplicateFiles([event], [normal]);
        expect(result.kept).toEqual([]);
        expect(result.copies).toEqual([{ kept: normal, duplicate: event }]);
    });

    it("retains a generic same-name protected copy without a filename timestamp", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/clip.mp4", content);
        const event = vf("card/Event/Front/clip.mp4", content);
        const result = await dropDuplicateFiles([normal, event], []);
        expect(result.kept).toEqual([event]);
        expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
    });

    it("recognises a manual copy through the existing filename mode technique", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/20260101_120000_NF.mp4", content, { sourceKey: "normal" });
        const manual = vf("card/20260101_120000_MF.mp4", content, { sourceKey: "manual" });
        const result = await dropDuplicateFiles([manual], [normal]);
        expect(result.kept).toEqual([]);
        expect(result.copies).toEqual([{ kept: normal, duplicate: manual }]);
    });

    it("confirms a renamed protected copy even when its counter changed", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content);
        const event = vf("card/Event/Front/EV20260101-120000-000043F.MP4", content);
        const result = await dropDuplicateFiles([normal, event], []);
        expect(result.kept).toEqual([event]);
        expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
    });

    it("reports a protected copy matching multiple independently kept normal recordings", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const first = vf("card/2026_1017_120000_0001F.MP4", content);
        const second = vf("card/2026_1017_120000_0002F.MP4", content);
        const event = vf("card/2026_1017_120000_0003EF.MP4", content);
        const result = await dropDuplicateFiles([event, second, first], []);
        expect(result.kept).toEqual([second, first]);
        expect(result.copies).toEqual([
            { kept: first, duplicate: event },
            { kept: second, duplicate: event },
        ]);
    });

    it("reports loaded and incoming owners without assigning an ambiguous protected copy", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const first = vf("card/2026_1017_120000_0001F.MP4", content, { sourceKey: "first" });
        const second = vf("card/2026_1017_120000_0002F.MP4", content, { sourceKey: "second" });
        const normal = vf("card/2026_1017_120000_0003F.MP4", content, { sourceKey: "incoming" });
        const event = vf("card/2026_1017_120000_0004EF.MP4", content, { sourceKey: "incoming" });
        const result = await dropDuplicateFiles([normal, event], [first, second]);
        expect(result.kept).toEqual([normal]);
        expect(result.copies).toEqual([
            { kept: first, duplicate: event },
            { kept: second, duplicate: event },
            { kept: normal, duplicate: event },
        ]);
        expect(result.sourceMatches).toHaveLength(2);
    });

    it("does not connect distinct channels through a protected copy with an unknown channel", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const front = vf("card/Normal/Front/clip.mp4", content);
        const rear = vf("card/Normal/Rear/clip.mp4", content);
        const event = vf("card/Event/clip.mp4", content);
        const result = await dropDuplicateFiles([event, rear, front], []);
        expect(result.kept).toEqual([rear, front]);
        expect(result.copies).toEqual([
            { kept: front, duplicate: event },
            { kept: rear, duplicate: event },
        ]);
    });

    it.each([
        ["20260101_120000_NF.mp4", "20260101_120000_PF.mp4"],
        ["NO20260101-120000-000042F.MP4", "NO20260101-120000-000043F.MP4"],
        ["20260101_120000_NF.mp4", "20260101_120001_EF.mp4"],
        ["20260101_120000_NF.mp4", "EV20260101-120000-000042F.MP4"],
        ["20260101120000_ordinary.mp4", "20260101120000_protected.mp4"],
    ])("keeps distinct names without matching protected-recording evidence: %s", async (firstName, secondName) => {
        const content = makeContent(LARGE_SIZE, 7);
        const first = vf(`card/${firstName}`, content);
        const second = vf(`card/${secondName}`, content);
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            const result = await dropDuplicateFiles([first, second], []);
            expect(result.kept).toEqual([first, second]);
            expect(result.copies).toEqual([]);
            expect(sliceSpy).not.toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("preserves independent camera paths for renamed mode copies in one source", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/camera-a/Normal/Front/NO20260101-120000-000042F.MP4", content);
        const event = vf("card/camera-b/Event/Front/EV20260101-120000-000042F.MP4", content);
        const result = await dropDuplicateFiles([normal, event], []);
        expect(result.kept).toEqual([normal, event]);
        expect(result.copies).toEqual([]);
    });

    it("matches renamed copies across separately selected folder roots", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("normal-card/camera/Normal/Front/NO20260101-120000-000042F.MP4", content, {
            sourceKey: "normal-source",
        });
        const event = vf("event-card/camera/Event/Front/EV20260101-120000-000042F.MP4", content, {
            sourceKey: "event-source",
        });
        for (const [loaded, incoming] of [
            [normal, event],
            [event, normal],
        ]) {
            const result = await dropDuplicateFiles([incoming!], [loaded!]);
            expect(result.kept).toEqual([]);
            expect(result.copies).toEqual([{ kept: loaded, duplicate: incoming }]);
            expect(result.sourceMatches).toEqual([{ incoming, loaded }]);
        }
    });

    it("retains distinct inner camera paths across selected folder roots", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("normal-card/camera-a/Normal/Front/NO20260101-120000-000042F.MP4", content, {
            sourceKey: "normal-source",
        });
        const event = vf("event-card/camera-b/Event/Front/EV20260101-120000-000042F.MP4", content, {
            sourceKey: "event-source",
        });
        const result = await dropDuplicateFiles([event], [normal]);
        expect(result.kept).toEqual([event]);
        expect(result.copies).toEqual([]);
    });

    it.each([false, true])(
        "keeps independent camera parents for BlackVue copies across sources: %s",
        async (separate) => {
            const content = makeContent(LARGE_SIZE, 7);
            const normal = vf("card-a/camera-a/20260101_120000_NF.mp4", content, { sourceKey: "first" });
            const event = vf("card-b/camera-b/20260101_120000_EF.mp4", content, {
                sourceKey: separate ? "second" : "first",
            });
            const result = await dropDuplicateFiles([event], [normal]);
            expect(result.kept).toEqual([event]);
            expect(result.copies).toEqual([]);
        },
    );

    it.each(["NO", "EV"])("retains different folder-only channels with a %s copy", async (prefix) => {
        const content = makeContent(LARGE_SIZE, 7);
        const front = vf("card/Normal/Front/NO20260101-120000-000042.MP4", content);
        const rear = vf(`card/Event/Rear/${prefix}20260101-120000-000042.MP4`, content);
        const result = await dropDuplicateFiles([front, rear], []);
        expect(result.kept).toEqual([front, rear]);
        expect(result.copies).toEqual([]);
    });

    it("matches a copy with a folder-only channel", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042.MP4", content);
        const event = vf("card/Event/Front/EV20260101-120000-000042.MP4", content);
        const result = await dropDuplicateFiles([normal, event], []);
        expect(result.kept).toEqual([event]);
        expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
    });

    it.each([
        "LA20260101-120000-000042F.MP4",
        "XX20260101-120000-000042F.MP4",
        "EV20260101-120001-000042F.MP4",
        "EV20260101-120000-000042R.MP4",
        "EV20260101-120000-000042F-extra.MP4",
    ])("does not normalize an unrelated recording name %s", async (name) => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content);
        const other = vf(`card/Event/Front/${name}`, content);
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            const result = await dropDuplicateFiles([normal, other], []);
            expect(result.kept).toEqual([normal, other]);
            expect(result.copies).toEqual([]);
            expect(sliceSpy).not.toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it.each(["NO", "EV"])("retains a %s clip that differs in a sampled interior window", async (prefix) => {
        const normal = vf(
            "card/Normal/Front/NO20260101-120000-000042F.MP4",
            makeContent(4 * 1024 * 1024, 7, { 589924: 1 }),
        );
        const other = vf(
            `card/Event/Front/${prefix}20260101-120000-000042F.MP4`,
            makeContent(4 * 1024 * 1024, 7, { 589924: 2 }),
        );
        const result = await dropDuplicateFiles([normal, other], []);
        expect(result.kept).toEqual([normal, other]);
        expect(result.copies).toEqual([]);
    });

    it.each(["NO", "EV"])(
        "limits a %s copy comparison to eight evenly spaced 64 KiB windows per file",
        async (prefix) => {
            const content = makeContent(4 * 1024 * 1024, 7);
            const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content);
            const event = vf(`card/Event/Front/${prefix}20260101-120000-000042F.MP4`, content);
            const ranges: { file: File; start: number; end: number }[] = [];
            const originalSlice = File.prototype.slice;
            const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
                this: File,
                start?: number,
                end?: number,
                contentType?: string,
            ) {
                ranges.push({ file: this, start: start ?? 0, end: end ?? this.size });
                return originalSlice.call(this, start, end, contentType);
            });
            try {
                const result = await dropDuplicateFiles([normal, event], []);
                expect(result.kept).toEqual([event]);
                for (const file of [normal.file, event.file]) {
                    const reads = ranges.filter((range) => range.file === file).sort((a, b) => a.start - b.start);
                    expect(reads).toHaveLength(8);
                    expect(reads.map((range) => range.start)).toEqual([
                        0, 589824, 1179648, 1769472, 2359296, 2949120, 3538944, 4128768,
                    ]);
                    expect(reads.at(-1)!.end).toBe(file.size);
                    expect(reads.every((range) => range.end - range.start <= 64 * 1024)).toBe(true);
                    expect(reads.reduce((sum, range) => sum + range.end - range.start, 0)).toBe(512 * 1024);
                }
            } finally {
                sliceSpy.mockRestore();
            }
        },
    );

    it("can match files that differ outside the sampled windows", async () => {
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", makeContent(4 * 1024 * 1024, 7));
        const event = vf(
            "card/Event/Front/EV20260101-120000-000042F.MP4",
            makeContent(4 * 1024 * 1024, 7, { 100000: 2 }),
        );
        const result = await dropDuplicateFiles([normal, event], []);
        expect(result.kept).toEqual([event]);
        expect(result.copies).toEqual([{ kept: event, duplicate: normal }]);
    });

    it("reuses all sampled windows when one incoming copy matches several loaded owners", async () => {
        const content = makeContent(4 * 1024 * 1024, 7);
        const loaded = [vf("a/X.MP4", content), vf("b/X.MP4", content), vf("c/X.MP4", content)];
        const incoming = vf("d/X.MP4", content);
        const ranges = new Map<File, { start: number; end: number }[]>();
        const originalSlice = File.prototype.slice;
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
            this: File,
            start?: number,
            end?: number,
            contentType?: string,
        ) {
            const reads = ranges.get(this) ?? [];
            reads.push({ start: start ?? 0, end: end ?? this.size });
            ranges.set(this, reads);
            return originalSlice.call(this, start, end, contentType);
        });
        try {
            const result = await dropDuplicateFiles([incoming], loaded);
            expect(result.kept).toEqual([]);
            expect(result.copies).toEqual(loaded.map((kept) => ({ kept, duplicate: incoming })));
            for (const vf of [...loaded, incoming]) {
                const reads = ranges.get(vf.file)!;
                expect(reads).toHaveLength(8);
                expect(reads.reduce((sum, range) => sum + range.end - range.start, 0)).toBe(512 * 1024);
            }
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("prefers the copy whose path is recognised by a channel technique", async () => {
        // The backup copy comes FIRST in the drop; the channel-matched path
        // (/front/ folder) must still survive - relativePath feeds the
        // path-based classifiers, so the structure-less copy is the one to drop.
        const content = makeContent(LARGE_SIZE, 7);
        const incoming = [vf("backupcopy/0001.MP4", content), vf("Movie/front/0001.MP4", content)];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept.map((f) => f.relativePath)).toEqual(["Movie/front/0001.MP4"]);
        expect(dropped).toEqual([{ droppedPath: "backupcopy/0001.MP4", keptPath: "Movie/front/0001.MP4" }]);
    });

    it("keeps same-name same-size files whose heads differ", async () => {
        const incoming = [
            vf("Movie/front/0001.MP4", makeContent(LARGE_SIZE, 7, { 100: 1 })),
            vf("Movie/rear/0001.MP4", makeContent(LARGE_SIZE, 7, { 100: 2 })),
        ];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept).toHaveLength(2);
        expect(dropped).toEqual([]);
    });

    it("keeps same-name same-size files that differ only in the tail", async () => {
        // Identical head (shared container prefix), divergence past the head
        // probe window - the tail probe must catch it.
        const incoming = [
            vf("a/0001.MP4", makeContent(LARGE_SIZE, 7, { [LARGE_SIZE - 10]: 1 })),
            vf("b/0001.MP4", makeContent(LARGE_SIZE, 7, { [LARGE_SIZE - 10]: 2 })),
        ];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept).toHaveLength(2);
        expect(dropped).toEqual([]);
    });

    it("collapses three identical copies into one", async () => {
        const content = makeContent(LARGE_SIZE, 5);
        const incoming = [vf("a/X.MP4", content), vf("b/X.MP4", content), vf("c/X.MP4", content)];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(2);
    });

    it("handles tiny files (whole file inside the head probe)", async () => {
        const content = makeContent(16, 9);
        const incoming = [vf("a/S.MP4", content), vf("b/S.MP4", content)];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(1);
    });

    it("drops a copy of an already-loaded file (cross-drop dedup)", async () => {
        const content = makeContent(LARGE_SIZE, 3);
        const loaded = [vf("Normal/Front/Y.MP4", content, { sourceKey: "first-open" })];
        const incoming = [vf("Backup/Y.MP4", content, { sourceKey: "second-open" })];
        const { kept, dropped, sourceMatches } = await dropDuplicateFiles(incoming, loaded);
        expect(kept).toEqual([]);
        expect(dropped).toEqual([{ droppedPath: "Backup/Y.MP4", keptPath: "Normal/Front/Y.MP4" }]);
        expect(sourceMatches).toEqual([{ incoming: incoming[0], loaded: loaded[0] }]);
    });

    it("recognises a remembered raw alias after its canonical playback file is repaired", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const path = "card/Normal/Front/NO20260101-120000-000042F.MP4";
        const normal = vf(path, content, { sourceKey: "card" });
        const loaded = {
            ...vf("card/Event/Front/EV20260101-120000-000042F.MP4", makeContent(LARGE_SIZE, 7, { 100000: 9 }), {
                sourceKey: "card",
            }),
            recordingCopies: [normal],
        };
        const incoming = vf(path, content, { sourceKey: "card" });
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            const result = await dropDuplicateFiles([incoming], [loaded]);
            expect(result.kept).toEqual([]);
            expect(result.copies).toEqual([{ kept: loaded, duplicate: incoming }]);
            expect(result.sourceMatches).toEqual([{ incoming, loaded }]);
            expect(sliceSpy).not.toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("compares a new source against a retained raw alias of a repaired recording", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content, { sourceKey: "first" });
        const loaded = {
            ...vf("card/Event/Front/EV20260101-120000-000042F.MP4", makeContent(LARGE_SIZE, 7, { 100000: 9 }), {
                sourceKey: "first",
            }),
            recordingCopies: [normal],
        };
        const incoming = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content, { sourceKey: "second" });
        const result = await dropDuplicateFiles([incoming], [loaded]);
        expect(result.kept).toEqual([]);
        expect(result.copies).toEqual([{ kept: loaded, duplicate: incoming }]);
        expect(result.sourceMatches).toEqual([{ incoming, loaded }]);
    });

    it("uses known alias identity when reading its canonical file would fail", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content, { sourceKey: "card" });
        const loaded = {
            ...vf("card/Event/Front/EV20260101-120000-000042F.MP4", content, { sourceKey: "card" }),
            recordingCopies: [normal],
        };
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(() => {
            throw new Error("device unavailable");
        });
        try {
            const result = await dropDuplicateFiles([normal], [loaded]);
            expect(result.kept).toEqual([]);
            expect(result.copies).toEqual([{ kept: loaded, duplicate: normal }]);
            expect(sliceSpy).not.toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("tries a retained raw alias after its canonical file read fails", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const normal = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content, { sourceKey: "first" });
        const loaded = {
            ...vf("card/Event/Front/EV20260101-120000-000042F.MP4", content, { sourceKey: "first" }),
            recordingCopies: [normal],
        };
        const incoming = vf("card/Normal/Front/NO20260101-120000-000042F.MP4", content, { sourceKey: "second" });
        const originalSlice = File.prototype.slice;
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
            this: File,
            start?: number,
            end?: number,
            contentType?: string,
        ) {
            if (this === loaded.file) throw new Error("device unavailable");
            return originalSlice.call(this, start, end, contentType);
        });
        try {
            const result = await dropDuplicateFiles([incoming], [loaded]);
            expect(result.kept).toEqual([]);
            expect(result.copies).toEqual([{ kept: loaded, duplicate: incoming }]);
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("reports every matching loaded source instead of inventing an owner for an identical copy", async () => {
        const content = makeContent(LARGE_SIZE, 3);
        const loaded = [
            vf("CARD-A/Y.MP4", content, { sourceKey: "card-a" }),
            vf("CARD-B/Y.MP4", content, { sourceKey: "card-b" }),
        ];
        const incoming = [vf("CARD-C/Y.MP4", content, { sourceKey: "card-c" })];

        const { kept, sourceMatches, copies } = await dropDuplicateFiles(incoming, loaded);

        expect(kept).toEqual([]);
        expect(sourceMatches).toEqual([
            { incoming: incoming[0], loaded: loaded[0] },
            { incoming: incoming[0], loaded: loaded[1] },
        ]);
        expect(copies).toEqual([
            { kept: loaded[0], duplicate: incoming[0] },
            { kept: loaded[1], duplicate: incoming[0] },
        ]);
    });

    it("keeps a same-name same-size file whose content differs from the loaded one", async () => {
        const loaded = [vf("Normal/Front/Y.MP4", makeContent(LARGE_SIZE, 3, { 50: 1 }))];
        const incoming = [vf("Other/Y.MP4", makeContent(LARGE_SIZE, 3, { 50: 2 }))];
        const { kept, dropped } = await dropDuplicateFiles(incoming, loaded);
        expect(kept).toHaveLength(1);
        expect(dropped).toEqual([]);
    });

    it("preserves incoming order across multiple groups", async () => {
        const c1 = makeContent(1024, 1);
        const c2 = makeContent(1024, 2);
        const incoming = [
            vf("z/late.MP4", c1),
            vf("a/early.MP4", c2),
            vf("copy/late.MP4", c1), // dup of [0]; wins lexicographically (no channel/depth signal)
        ];
        const { kept } = await dropDuplicateFiles(incoming, []);
        // Survivors keep their incoming positions: a/early at [1], copy/late at [2].
        expect(kept.map((f) => f.relativePath)).toEqual(["a/early.MP4", "copy/late.MP4"]);
    });

    it("keeps a camera's channels in one folder so they do not split into separate frames", async () => {
        // Regression: a duplicated front channel that survives from a DIFFERENT
        // parent than its (non-duplicated) rear sibling gets a different camera
        // fingerprint, so the two channels stop merging into one multichannel
        // trip and the player plays front then rear sequentially. Here a Juscar
        // dual recording lives in `rig/video/{front,rear}` and a partial copy
        // (front only, no rear) sits in `rig mono/video/front`. The front copies
        // are byte-identical; the survivor must stay in `rig/video` (where the
        // camera also has its rear) so both channels keep one fingerprint.
        const frontContent = makeContent(LARGE_SIZE, 11);
        const rearContent = makeContent(LARGE_SIZE, 22);
        const incoming = [
            vf("Samples/rig/video/front/20260512_150820F.ts", frontContent),
            vf("Samples/rig/video/rear/20260512_150820R.ts", rearContent),
            // Byte-identical front copy in a sibling folder that lacks the rear.
            // The old lexicographic tie-break kept THIS one ("rig mono" < "rig"
            // because space < "/"), splitting the channels.
            vf("Samples/rig mono/video/front/20260512_150820F.ts", frontContent),
        ];
        const { kept, dropped } = await dropDuplicateFiles(incoming, []);

        const keptFront = kept.find((f) => f.file.name.endsWith("F.ts"));
        const keptRear = kept.find((f) => f.file.name.endsWith("R.ts"));
        expect(keptFront, "front survivor").toBeDefined();
        expect(keptRear, "rear survivor").toBeDefined();
        // The front survives from the folder that holds the rear, not the mono copy.
        expect(keptFront!.relativePath).toBe("Samples/rig/video/front/20260512_150820F.ts");
        expect(dropped).toEqual([
            {
                droppedPath: "Samples/rig mono/video/front/20260512_150820F.ts",
                keptPath: "Samples/rig/video/front/20260512_150820F.ts",
            },
        ]);
        // The point of the fix: both channels share one camera fingerprint, so
        // groupTrips merges them into one multichannel frame.
        expect(cameraFingerprint(keptFront!)).toBe(cameraFingerprint(keptRear!));
    });

    it("drops the same source/path/metadata identity with zero content probes (B4)", async () => {
        // Re-reading the same scoped folder: source, path, size, and mtime all
        // agree, so no slice() (head/tail probe) should run.
        const content = makeContent(LARGE_SIZE, 3);
        const loaded = [vf("Normal/Front/Y.MP4", content, { sourceKey: "card" })];
        const incoming = [vf("Normal/Front/Y.MP4", content, { sourceKey: "card" })];
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            const { kept, dropped } = await dropDuplicateFiles(incoming, loaded);
            expect(kept).toEqual([]);
            expect(dropped).toEqual([{ droppedPath: "Normal/Front/Y.MP4", keptPath: "Normal/Front/Y.MP4" }]);
            expect(sliceSpy).not.toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("keeps an overwritten same-path file when its metadata and content changed", async () => {
        const loaded = [vf("Normal/Front/Y.MP4", makeContent(LARGE_SIZE, 3), { lastModified: 1, sourceKey: "card" })];
        const incoming = [vf("Normal/Front/Y.MP4", makeContent(LARGE_SIZE, 4), { lastModified: 2, sourceKey: "card" })];
        const { kept, dropped } = await dropDuplicateFiles(incoming, loaded);
        expect(kept).toEqual(incoming);
        expect(dropped).toEqual([]);
    });

    it("does not treat an equal path on another source as path identity", async () => {
        const loaded = [vf("DCIM/Y.MP4", makeContent(LARGE_SIZE, 3), { sourceKey: "card-a" })];
        const incoming = [vf("DCIM/Y.MP4", makeContent(LARGE_SIZE, 4), { sourceKey: "card-b" })];
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            const { kept, dropped } = await dropDuplicateFiles(incoming, loaded);
            expect(kept).toEqual(incoming);
            expect(dropped).toEqual([]);
            expect(sliceSpy).toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("still probes distinct-path same-(name,size) files with different content (B4 negative case)", async () => {
        // Different relativePath must not short-circuit sampling; the first
        // window here finds distinct content.
        const loaded = [vf("Normal/Front/Y.MP4", makeContent(LARGE_SIZE, 3, { 50: 1 }))];
        const incoming = [vf("Other/Y.MP4", makeContent(LARGE_SIZE, 3, { 50: 2 }))];
        const sliceSpy = vi.spyOn(File.prototype, "slice");
        try {
            const { kept, dropped } = await dropDuplicateFiles(incoming, loaded);
            expect(kept).toHaveLength(1);
            expect(dropped).toEqual([]);
            expect(sliceSpy).toHaveBeenCalled();
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("reads each colliding File head at most once across pairwise comparisons", async () => {
        const incoming = [
            vf("a/X.MP4", makeContent(LARGE_SIZE, 1)),
            vf("b/X.MP4", makeContent(LARGE_SIZE, 2)),
            vf("c/X.MP4", makeContent(LARGE_SIZE, 3)),
        ];
        const calls = new Map<File, number>();
        const originalSlice = File.prototype.slice;
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
            this: File,
            start?: number,
            end?: number,
            contentType?: string,
        ) {
            calls.set(this, (calls.get(this) ?? 0) + 1);
            return originalSlice.call(this, start, end, contentType);
        });
        try {
            const { kept, dropped } = await dropDuplicateFiles(incoming, []);
            expect(kept).toEqual(incoming);
            expect(dropped).toEqual([]);
            for (const item of incoming) expect(calls.get(item.file)).toBe(1);
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("caches a failed sample within the pass and retries only on a later import", async () => {
        const content = makeContent(LARGE_SIZE, 7);
        const incoming = [vf("a/X.MP4", content), vf("b/X.MP4", content), vf("c/X.MP4", content)];
        const first = incoming[0]!.file;
        const originalSlice = File.prototype.slice;
        let firstHeadCalls = 0;
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
            this: File,
            start?: number,
            end?: number,
            contentType?: string,
        ) {
            if (this === first && start === 0) {
                firstHeadCalls++;
                if (firstHeadCalls === 1) {
                    return {
                        arrayBuffer: async () => {
                            throw new Error("transient read failure");
                        },
                    } as unknown as Blob;
                }
            }
            return originalSlice.call(this, start, end, contentType);
        });
        try {
            const { kept, dropped } = await dropDuplicateFiles(incoming, []);
            expect(kept.map((item) => item.relativePath)).toEqual(["a/X.MP4", "b/X.MP4"]);
            expect(dropped).toEqual([{ droppedPath: "c/X.MP4", keptPath: "b/X.MP4" }]);
            expect(firstHeadCalls).toBe(1);
            expect((await dropDuplicateFiles(incoming, [])).kept).toEqual([incoming[0]]);
            expect(firstHeadCalls).toBe(2);
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("throws AbortError when the signal is already aborted and probing is needed", async () => {
        const content = makeContent(1024, 4);
        const incoming = [vf("a/X.MP4", content), vf("b/X.MP4", content)];
        const controller = new AbortController();
        controller.abort();
        await expect(dropDuplicateFiles(incoming, [], controller.signal)).rejects.toThrowError(/aborted/);
    });

    it("honors cancellation even when no duplicate probes are needed", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            dropDuplicateFiles([vf("X.MP4", makeContent(1024, 4))], [], controller.signal),
        ).rejects.toMatchObject({
            name: "AbortError",
        });
    });

    it("honors cancellation during the final content probe", async () => {
        const content = makeContent(1024, 4);
        const incoming = [vf("a/X.MP4", content), vf("b/X.MP4", content)];
        const controller = new AbortController();
        const originalSlice = File.prototype.slice;
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
            this: File,
            start?: number,
            end?: number,
            contentType?: string,
        ) {
            controller.abort();
            return originalSlice.call(this, start, end, contentType);
        });
        try {
            await expect(dropDuplicateFiles(incoming, [], controller.signal)).rejects.toMatchObject({
                name: "AbortError",
            });
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("stops before the next interior window when sampling is cancelled", async () => {
        const content = makeContent(4 * 1024 * 1024, 7);
        const incoming = [vf("a/X.MP4", content), vf("b/X.MP4", content)];
        const controller = new AbortController();
        const starts: number[] = [];
        const originalSlice = File.prototype.slice;
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(function (
            this: File,
            start?: number,
            end?: number,
            contentType?: string,
        ) {
            starts.push(start ?? 0);
            if (start === 589824) controller.abort();
            return originalSlice.call(this, start, end, contentType);
        });
        try {
            await expect(dropDuplicateFiles(incoming, [], controller.signal)).rejects.toMatchObject({
                name: "AbortError",
            });
            expect(starts).toContain(589824);
            expect(starts).not.toContain(1179648);
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("propagates an AbortError from a content read unchanged", async () => {
        const content = makeContent(1024, 4);
        const incoming = [vf("a/X.MP4", content), vf("b/X.MP4", content)];
        const error = Object.assign(new Error("read cancelled"), { name: "AbortError" });
        const sliceSpy = vi.spyOn(File.prototype, "slice").mockImplementation(() => {
            throw error;
        });
        try {
            await expect(dropDuplicateFiles(incoming, [])).rejects.toBe(error);
        } finally {
            sliceSpy.mockRestore();
        }
    });

    it("returns empty result for an empty drop", async () => {
        const { kept, dropped } = await dropDuplicateFiles([], []);
        expect(kept).toEqual([]);
        expect(dropped).toEqual([]);
    });
});
