// Browser drag-and-drop traversal keeps diagnostic names independently of the
// File objects passed to ingest, with bounded work inside excluded subtrees.

import {
    createExcludedTraversalBudget,
    excludedDirectoryLimit,
    type ExcludedTraversalBudget,
    takeExcludedStructureEntry,
} from "../excluded-traversal-budget.js";
import { isIgnoredPath } from "../ingest-filter.js";
import type { IngestStructureEntry } from "../ingest-structure.js";
import { createLogger } from "../log.js";
import type { VendorFile } from "../parsers/types.js";
import { toVendorFiles } from "./ingest-core.js";

const log = createLogger("file-sources");

interface CollectResult {
    files: VendorFile[];
    structure: IngestStructureEntry[];
    readErrors: number;
}

/** Collects dropped files and observed directory names, marking bounded exclusions. */
export async function collectFilesFromDataTransfer(dt: DataTransfer | null): Promise<CollectResult> {
    if (!dt) return { files: [], structure: [], readErrors: 0 };
    const entries: FileSystemEntry[] = [];
    if (dt.items && dt.items.length > 0 && typeof dt.items[0]!.webkitGetAsEntry === "function") {
        for (let i = 0; i < dt.items.length; i++) {
            const entry = dt.items[i]!.webkitGetAsEntry?.();
            if (entry) entries.push(entry);
        }
    }
    if (entries.length === 0) {
        return { files: toVendorFiles(Array.from(dt.files || [])), structure: [], readErrors: 0 };
    }
    const result: CollectResult = { files: [], structure: [], readErrors: 0 };
    const budget = createExcludedTraversalBudget();
    for (const entry of entries) await walkEntry(entry, result, budget);
    return result;
}

// The Entries API exposes child names before file(). That lets the report
// include filtered subtrees while keeping their files out of the ingest path.
async function walkEntry(
    entry: FileSystemEntry,
    result: CollectResult,
    budget: ExcludedTraversalBudget,
    parent?: IngestStructureEntry,
    parentExcludedDepth = 0,
): Promise<void> {
    const relativePath = (entry.fullPath.startsWith("/") ? entry.fullPath.slice(1) : entry.fullPath) || entry.name;
    const isIgnored = isIgnoredPath(relativePath);
    if (parent && isIgnored && !takeExcludedStructureEntry(budget)) {
        parent.truncated = "entry limit";
        return;
    }
    const item: IngestStructureEntry = { relativePath, kind: entry.isFile ? "file" : "directory" };
    result.structure.push(item);
    if (entry.isFile) {
        if (isIgnored) return;
        const fileEntry = entry as FileSystemFileEntry;
        try {
            const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
            item.size = file.size;
            item.lastModified = file.lastModified;
            result.files.push({ file, relativePath });
        } catch (err) {
            item.unreadable = true;
            result.readErrors++;
            log.warn("dnd: failed to read file entry", { name: entry.name, err: String(err) });
        }
        return;
    }
    if (entry.isDirectory) {
        const excludedDepth = isIgnored ? parentExcludedDepth + 1 : 0;
        const limit = excludedDirectoryLimit(budget, excludedDepth);
        if (limit) {
            item.truncated = limit;
            return;
        }
        const dirEntry = entry as FileSystemDirectoryEntry;
        try {
            const reader = dirEntry.createReader();
            // Chromium returns directory entries in batches. An empty batch
            // ends traversal; a short nonempty batch does not.
            while (true) {
                const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
                    reader.readEntries(resolve, reject),
                );
                if (batch.length === 0) break;
                for (const child of batch) {
                    await walkEntry(child, result, budget, item, excludedDepth);
                    // Outside an excluded subtree the remaining batch can
                    // contain real recordings, so only stop excluded readers.
                    if (isIgnored && item.truncated === "entry limit") return;
                }
            }
        } catch (err) {
            item.unreadable = true;
            if (isIgnored) return;
            result.readErrors++;
            log.warn("dnd: failed to read directory entries", { name: entry.name, err: String(err) });
        }
    }
}
