import type { VendorFile } from "./parsers/types.js";

/** Names observed during enumeration, including entries excluded from import.
 * Excluded files need no File handle; unavailable metadata stays absent. */
export interface IngestStructureEntry {
    relativePath: string;
    kind: "file" | "directory";
    size?: number;
    lastModified?: number;
    unreadable?: boolean;
    truncated?: "entry limit" | "depth limit";
}

/** Combines enumerated names with available metadata. Classic file inputs
 * expose no directory entries, so their parent directories are inferred.
 * File paths may repeat in flat selections; each occurrence remains separate. */
export function snapshotIngestStructure(
    files: readonly VendorFile[],
    entries: readonly IngestStructureEntry[] = [],
): IngestStructureEntry[] {
    const snapshot: IngestStructureEntry[] = [];
    const directories = new Map<string, IngestStructureEntry>();
    const readableFiles = new Map<string, { entries: IngestStructureEntry[]; next: number }>();
    const addDirectory = (entry: IngestStructureEntry) => {
        const existing = directories.get(entry.relativePath);
        if (existing) Object.assign(existing, entry);
        else {
            directories.set(entry.relativePath, entry);
            snapshot.push(entry);
        }
    };
    const normalizePath = (path: string) => {
        const parts = path.split(/[/\\]+/).filter(Boolean);
        const relativePath = parts.join("/");
        let parent = "";
        for (let i = 1; i < parts.length; i++) {
            parent = parent ? `${parent}/${parts[i - 1]!}` : parts[i - 1]!;
            if (!directories.has(parent)) addDirectory({ relativePath: parent, kind: "directory" });
        }
        return relativePath;
    };
    for (const entry of entries) {
        const relativePath = normalizePath(entry.relativePath);
        if (!relativePath) continue;
        const observed = { ...entry, relativePath };
        if (entry.kind === "directory") {
            addDirectory(observed);
            continue;
        }
        snapshot.push(observed);
        // A failed entry and a successful file can share a flat name. Only
        // readable entries correspond to File objects returned by the walker.
        if (entry.unreadable) continue;
        let samePath = readableFiles.get(relativePath);
        if (!samePath) {
            samePath = { entries: [], next: 0 };
            readableFiles.set(relativePath, samePath);
        }
        samePath.entries.push(observed);
    }
    for (const { file, relativePath } of files) {
        const path = normalizePath(relativePath || file.name);
        if (!path) continue;
        const samePath = readableFiles.get(path);
        const observed = samePath?.entries[samePath.next++];
        if (observed) {
            observed.size = file.size;
            observed.lastModified = file.lastModified;
        } else {
            snapshot.push({ relativePath: path, kind: "file", size: file.size, lastModified: file.lastModified });
        }
    }
    return snapshot;
}
