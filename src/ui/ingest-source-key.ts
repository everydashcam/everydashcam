import type { DedupResult } from "../ingest-dedup.js";
import type { VendorFile } from "../parsers/types.js";
import type { IngestOrigin } from "./state.js";

let nextSourceId = 1;
let sourceKeyByHandle = new WeakMap<FileSystemDirectoryHandle, string>();
// Every handle that scopes files in this session, oldest first. Scopes key by
// handle object, so a repeated pick must resolve to the object that scoped the
// folder first (scopedDirectoryHandle).
let scopedHandles: FileSystemDirectoryHandle[] = [];

function sourceKeyFor(origin: IngestOrigin | null): string {
    if (!origin) return `drop:${nextSourceId++}`;
    const existing = sourceKeyByHandle.get(origin.handle);
    const key = origin.folderId ? `folder:${origin.folderId}` : (existing ?? `handle:${nextSourceId++}`);
    if (existing === undefined) {
        sourceKeyByHandle.set(origin.handle, key);
        scopedHandles.push(origin.handle);
    }
    return key;
}

/**
 * Returns the handle that already scopes this session's files from the same
 * folder as `picked`, or `picked` itself for a folder not opened before. The
 * directory picker returns a new object for every pick, so without this a
 * second pick of a folder that has gained recordings would place them under
 * another camera and split a continuous trip. Call before ingest keys the
 * batch by its origin. A handle that cannot be compared (unplugged media)
 * counts as another folder.
 */
export async function scopedDirectoryHandle(picked: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
    if (sourceKeyByHandle.has(picked)) return picked;
    for (const known of scopedHandles) {
        try {
            if (await picked.isSameEntry(known)) return known;
        } catch {
            // Without a comparison there is no proof this is the same folder.
        }
    }
    return picked;
}

/** An ad-hoc drop has no handle, so the browser gives it no physical identity. */
function isAdHocSourceKey(sourceKey: string | undefined): sourceKey is string {
    return sourceKey?.startsWith("drop:") ?? false;
}

/** Root folder name of a relative path, or "" when the file was dropped
 *  without a folder around it (a bare filename has no leading segment). An
 *  ad-hoc drop names one source per root. */
export function sourceRootOf(relativePath: string): string {
    const segments = relativePath.split(/[/\\]/).filter((segment) => segment.length > 0);
    return segments.length > 1 ? segments[0]! : "";
}

/**
 * Gives every file in one picker/drop batch a source scope. Queued batches
 * already carry their scope and pass through unchanged when dequeued.
 */
export function scopeIngestFiles(files: VendorFile[], origin: IngestOrigin | null): VendorFile[] {
    if (files.length === 0 || files.every((file) => file.sourceKey !== undefined)) return files;
    const sourceKey = sourceKeyFor(origin);
    return files.map((file) => (file.sourceKey === undefined ? { ...file, sourceKey } : file));
}

/**
 * Moves each root of an ad-hoc drop into the earlier ad-hoc drop whose files
 * it duplicates. Every ad-hoc drop gets a fresh scope, so without this a
 * second pick of the same card would stay another camera: a front clip
 * picked first and its rear picked later with it would form two trips. A
 * copy proves one card only when every match of the root points to the same
 * loaded drop. Remembered folders and picked handles keep their own identity:
 * a repeated pick already resolved its folder through scopedDirectoryHandle.
 * Call before anything keys files by source; returns the input unchanged
 * when nothing moves.
 */
export function adoptDuplicatedDropSources(dedup: DedupResult): DedupResult {
    const rootKey = (file: VendorFile): string =>
        JSON.stringify([file.sourceKey ?? null, sourceRootOf(file.relativePath)]);
    const loadedKeysByRoot = new Map<string, Set<string | undefined>>();
    for (const { incoming, loaded } of dedup.sourceMatches) {
        if (!isAdHocSourceKey(incoming.sourceKey)) continue;
        const key = rootKey(incoming);
        const loadedKeys = loadedKeysByRoot.get(key) ?? new Set();
        loadedKeys.add(loaded.sourceKey);
        loadedKeysByRoot.set(key, loadedKeys);
    }
    const targetByRoot = new Map<string, string>();
    for (const [key, loadedKeys] of loadedKeysByRoot) {
        const [target] = loadedKeys;
        if (loadedKeys.size === 1 && isAdHocSourceKey(target)) targetByRoot.set(key, target);
    }
    if (targetByRoot.size === 0) return dedup;

    // Replace each moved file by one new view, so every reference to it in
    // the result keeps agreeing on its identity.
    const moved = new Map<VendorFile, VendorFile>();
    const move = (file: VendorFile): VendorFile => {
        const target = targetByRoot.get(rootKey(file));
        if (target === undefined || target === file.sourceKey) return file;
        let view = moved.get(file);
        if (!view) {
            view = { ...file, sourceKey: target };
            moved.set(file, view);
        }
        return view;
    };
    return {
        kept: dedup.kept.map(move),
        dropped: dedup.dropped,
        sourceMatches: dedup.sourceMatches.map(({ incoming, loaded }) => ({ incoming: move(incoming), loaded })),
        copies: dedup.copies.map(({ kept, duplicate }) => ({ kept: move(kept), duplicate: move(duplicate) })),
    };
}

/** Clears module state between unit tests. */
export function _resetForTests(): void {
    nextSourceId = 1;
    sourceKeyByHandle = new WeakMap();
    scopedHandles = [];
}
