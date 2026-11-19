import { beforeEach, describe, expect, it } from "vitest";

import { type DedupResult, dropDuplicateFiles } from "../ingest-dedup.js";
import { cameraFingerprint } from "../parsers/camera-fingerprint.js";
import type { VendorFile } from "../parsers/types.js";
import { groupTrips, tripChannels } from "../trips.js";
import { buildProvisionalCandidate } from "./ingest-candidate.js";
import type { IngestOrigin } from "./state.js";
import {
    _resetForTests,
    adoptDuplicatedDropSources,
    scopeIngestFiles,
    scopedDirectoryHandle,
} from "./ingest-source-key.js";

function files(): VendorFile[] {
    return [{ file: new File(["x"], "clip.mp4"), relativePath: "CARD/clip.mp4" }];
}

function origin(folderId = ""): IngestOrigin {
    return { handle: {} as FileSystemDirectoryHandle, folderId };
}

describe("scopeIngestFiles", () => {
    beforeEach(_resetForTests);

    it("keeps one scope for repeated reads through the same handle", () => {
        const picked = origin();
        expect(scopeIngestFiles(files(), picked)[0]!.sourceKey).toBe(scopeIngestFiles(files(), picked)[0]!.sourceKey);
    });

    it("gives independent ad-hoc drops independent scopes", () => {
        expect(scopeIngestFiles(files(), null)[0]!.sourceKey).not.toBe(scopeIngestFiles(files(), null)[0]!.sourceKey);
    });

    it("uses a remembered folder id as the stable scope", () => {
        expect(scopeIngestFiles(files(), origin("folder-id"))[0]!.sourceKey).toBe("folder:folder-id");
    });

    it("does not rescope a queued batch", () => {
        const scoped = scopeIngestFiles(files(), null);
        expect(scopeIngestFiles(scoped, null)).toBe(scoped);
    });
});

describe("scopedDirectoryHandle", () => {
    beforeEach(_resetForTests);

    // The picker returns a new object for every pick of a folder; isSameEntry
    // compares the folder behind it.
    function pickedHandle(folder: string, comparable = true): FileSystemDirectoryHandle {
        const handle = {
            name: folder,
            folder,
            isSameEntry: async (other: { folder?: string }) => {
                if (!comparable) throw new DOMException("entry is gone", "NotFoundError");
                return other.folder === folder;
            },
        };
        return handle as unknown as FileSystemDirectoryHandle;
    }

    function scopeOf(handle: FileSystemDirectoryHandle, folderId = ""): string | undefined {
        return scopeIngestFiles(files(), { handle, folderId })[0]!.sourceKey;
    }

    it("resolves a repeated pick of a folder to the scope of its first pick", async () => {
        const first = pickedHandle("CARD");
        const firstScope = scopeOf(first);

        const again = await scopedDirectoryHandle(pickedHandle("CARD"));

        expect(again).toBe(first);
        expect(scopeOf(again)).toBe(firstScope);
    });

    it("resolves a pick of a folder opened as remembered to the folder scope", async () => {
        scopeOf(pickedHandle("CARD"), "remembered");
        const again = await scopedDirectoryHandle(pickedHandle("CARD"));
        expect(scopeOf(again)).toBe("folder:remembered");
    });

    it("keeps another folder in its own scope", async () => {
        const firstScope = scopeOf(pickedHandle("CARD"));
        const other = pickedHandle("BACKUP");

        expect(await scopedDirectoryHandle(other)).toBe(other);
        expect(scopeOf(other)).not.toBe(firstScope);
    });

    it("treats a folder that cannot be compared as another folder", async () => {
        scopeOf(pickedHandle("CARD"));
        const unplugged = pickedHandle("CARD", false);
        expect(await scopedDirectoryHandle(unplugged)).toBe(unplugged);
    });
});

describe("adoptDuplicatedDropSources", () => {
    beforeEach(_resetForTests);

    function clip(name: string, relativePath = name, sourceKey?: string): VendorFile {
        return {
            file: new File([new Uint8Array(4096).fill(name.charCodeAt(name.length - 5))], name, { lastModified: 1 }),
            relativePath,
            ...(sourceKey === undefined ? {} : { sourceKey }),
        };
    }

    function candidate(vendorFile: VendorFile) {
        return buildProvisionalCandidate({
            file: vendorFile,
            fingerprint: cameraFingerprint(vendorFile),
            startUtc: 1000,
            startSource: "name",
            cameraTzSec: null,
            durationSec: 60,
            records: [],
            appliedExtractors: [],
        });
    }

    function result(kept: VendorFile[], sourceMatches: DedupResult["sourceMatches"]): DedupResult {
        return { kept, dropped: [], sourceMatches, copies: [] };
    }

    it("pairs a rear clip with the front picked in an earlier drop of the same card", async () => {
        const front = "NO20260101-120000-000042F.MP4";
        const rear = "NO20260101-120000-000042B.MP4";
        const first = adoptDuplicatedDropSources(await dropDuplicateFiles(scopeIngestFiles([clip(front)], null), []));
        const loaded = first.kept.map(candidate);

        const second = adoptDuplicatedDropSources(
            await dropDuplicateFiles(scopeIngestFiles([clip(front), clip(rear)], null), loaded),
        );
        expect(second.kept.map((vendorFile) => vendorFile.file.name)).toEqual([rear]);
        expect(second.kept[0]!.sourceKey).toBe(loaded[0]!.sourceKey);

        const trips = groupTrips([...loaded, ...second.kept.map(candidate)]);
        expect(trips).toHaveLength(1);
        expect(tripChannels(trips[0]!)).toEqual(["front", "rear"]);
    });

    it("moves only the root whose copies matched", () => {
        const loaded = clip("a.mp4", "CARD/a.mp4", "drop:1");
        const matched = clip("b.mp4", "CARD/b.mp4", "drop:2");
        const other = clip("c.mp4", "OTHER/c.mp4", "drop:2");
        const adopted = adoptDuplicatedDropSources(
            result([matched, other], [{ incoming: clip("a.mp4", "CARD/a.mp4", "drop:2"), loaded }]),
        );
        expect(adopted.kept.map((vendorFile) => vendorFile.sourceKey)).toEqual(["drop:1", "drop:2"]);
        expect(adopted.sourceMatches[0]!.incoming.sourceKey).toBe("drop:1");
    });

    it("keeps a root whose copies match several loaded drops", () => {
        const kept = clip("c.mp4", "CARD/c.mp4", "drop:3");
        const adopted = adoptDuplicatedDropSources(
            result(
                [kept],
                [
                    { incoming: clip("a.mp4", "CARD/a.mp4", "drop:3"), loaded: clip("a.mp4", "CARD/a.mp4", "drop:1") },
                    { incoming: clip("b.mp4", "CARD/b.mp4", "drop:3"), loaded: clip("b.mp4", "CARD/b.mp4", "drop:2") },
                ],
            ),
        );
        expect(adopted.kept[0]!.sourceKey).toBe("drop:3");
    });

    it.each([
        ["a remembered folder", "folder:remembered", "drop:2"],
        ["a picked handle", "handle:1", "drop:2"],
        ["a drop matching a picked handle", "drop:1", "handle:2"],
    ])("keeps the identity of %s", (_label, loadedKey, incomingKey) => {
        const kept = clip("b.mp4", "CARD/b.mp4", incomingKey);
        const adopted = adoptDuplicatedDropSources(
            result(
                [kept],
                [
                    {
                        incoming: clip("a.mp4", "CARD/a.mp4", incomingKey),
                        loaded: clip("a.mp4", "CARD/a.mp4", loadedKey),
                    },
                ],
            ),
        );
        expect(adopted.kept[0]!.sourceKey).toBe(incomingKey);
    });
});
