// Remembered-folder store plus the File System Access helpers around it:
// permission checks, dedupe via isSameEntry, recursive enumeration into
// VendorFile[]. UI-free - ui/persistent-folders.ts owns the UX on top.

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
import { openPersistDb } from "./db.js";
import { canPersistFileHandles } from "./file-handle-support.js";
import type { RememberedFolder } from "./types.js";

const log = createLogger("persist-folders");

/** All remembered folders, most recently opened first. */
export async function listFolders(): Promise<RememberedFolder[]> {
    if (!canPersistFileHandles()) return [];
    const db = await openPersistDb();
    const all = await db.getAll("folders");
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * Adds a folder to the remembered list, or refreshes the existing entry when
 * the same directory is already remembered (compared via isSameEntry, so
 * re-picking a folder never creates a duplicate). Marks it last-opened.
 */
export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<RememberedFolder> {
    if (!canPersistFileHandles()) throw new Error("folder access cannot be remembered in this browser");
    const db = await openPersistDb();
    const existing = await db.getAll("folders");
    for (const folder of existing) {
        let same = false;
        try {
            same = await handle.isSameEntry(folder.handle);
        } catch {
            // isSameEntry can reject on a dead stored handle - treat as distinct;
            // the stale entry stays greyed in the list until the user forgets it.
        }
        if (same) {
            const updated: RememberedFolder = {
                ...folder,
                handle,
                label: handle.name,
                lastOpenedAt: Date.now(),
            };
            await db.put("folders", updated);
            return updated;
        }
    }
    const record: RememberedFolder = {
        id: crypto.randomUUID(),
        handle,
        label: handle.name,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
    };
    await db.put("folders", record);
    return record;
}

/** Removes a folder from the list (annotations keyed by folderId stay - the
 *  user may remember the folder again later and they re-attach). */
export async function forgetFolder(id: string): Promise<void> {
    const db = await openPersistDb();
    await db.delete("folders", id);
}

/** Clears the whole remembered list. Annotations stay, same as forgetFolder. */
export async function forgetAllFolders(): Promise<void> {
    const db = await openPersistDb();
    await db.clear("folders");
}

/** Stamps the folder as most recently opened; drives the chip ordering. */
export async function markFolderOpened(id: string): Promise<void> {
    if (!canPersistFileHandles()) return;
    const db = await openPersistDb();
    // Keep the read and write atomic so a concurrent Forget cannot be undone.
    const tx = db.transaction("folders", "readwrite");
    const folder = await tx.store.get(id);
    if (folder) {
        folder.lastOpenedAt = Date.now();
        await tx.store.put(folder);
    }
    await tx.done;
}

/**
 * Permission state of a stored handle without prompting. "granted" does NOT
 * mean the folder still exists - only an actual read reveals a moved or
 * unplugged folder (NotFoundError at enumeration time). Returns "denied" when
 * the API is absent or the query itself throws.
 */
export async function queryFolderPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
    try {
        if (typeof handle.queryPermission !== "function") return "denied";
        return await handle.queryPermission({ mode: "read" });
    } catch (err) {
        log.warn("queryPermission failed", { err: err instanceof Error ? err.message : String(err) });
        return "denied";
    }
}

export type FolderAvailability = "available" | "unavailable" | "unknown";

/**
 * Whether a stored handle still points at a readable folder. queryPermission
 * never checks liveness, so a granted handle gets one actual directory read -
 * a moved/unplugged folder throws (NotFoundError) right there. Without granted
 * permission the read would prompt, so the answer is "unknown" (the folder may
 * well exist; a click-driven requestPermission resolves it).
 */
export async function probeFolderAvailability(handle: FileSystemDirectoryHandle): Promise<FolderAvailability> {
    if ((await queryFolderPermission(handle)) !== "granted") return "unknown";
    const iterator = handle.keys();
    try {
        await iterator.next();
        return "available";
    } catch {
        return "unavailable";
    } finally {
        // One entry is all the probe needs - release the OS enumeration
        // instead of leaving the iterator dangling until GC.
        void iterator.return?.().catch?.(() => {});
    }
}

/**
 * Prompts for read access on a stored handle. Must be called from a user
 * gesture - the browser rejects gesture-less requestPermission calls.
 */
export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    try {
        if (typeof handle.requestPermission !== "function") return false;
        return (await handle.requestPermission({ mode: "read" })) === "granted";
    } catch (err) {
        log.warn("requestPermission failed", { err: err instanceof Error ? err.message : String(err) });
        return false;
    }
}

/**
 * Re-arms the readwrite grant on a stored file handle (the annotations
 * sidecar). The grant from a file picker can be session-scoped -
 * after a browser restart it reads "prompt", and later gesture-less writes
 * can only skip. This must run while user activation is live (a click); it
 * may show the permission prompt, where Chromium offers "Allow on every
 * visit" to end the asking. Returns whether write access is available after
 * the attempt; false when denied or when activation is already spent.
 */
export async function ensureFileReadwritePermission(handle: FileSystemFileHandle): Promise<boolean> {
    // Some adapter-backed handles omit the permission methods and rely on the
    // operation itself. Preserve that path instead of declaring it denied.
    if (typeof handle.queryPermission !== "function" || typeof handle.requestPermission !== "function") return true;
    try {
        const current = await handle.queryPermission({ mode: "readwrite" });
        if (current === "granted") return true;
        if (current !== "prompt") return false;
        if (navigator.userActivation && !navigator.userActivation.isActive) return false;
        return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    } catch (err) {
        log.warn("sidecar permission re-arm failed", { err: err instanceof Error ? err.message : String(err) });
        return false;
    }
}

export interface FolderEnumeration {
    files: VendorFile[];
    structure: IngestStructureEntry[];
    /** Eligible entries that failed to read; excluded directory failures stay
     *  in the structure without warning about an otherwise healthy card. */
    readErrors: number;
}

/**
 * Recursively lists a directory handle into VendorFile[]. relativePath is
 * prefixed with the root folder name to match the webkitRelativePath shape of
 * the classic <input webkitdirectory> path - filename techniques and the
 * cross-session cache identity rely on the two picker paths producing
 * identical paths for the same folder. Throws when the root itself cannot be
 * read (folder moved/unplugged/permission revoked - caller decides the UX);
 * per-child failures remain in the structure and eligible failures are counted.
 * Excluded names have a diagnostic traversal budget; marked partial listings
 * never prevent eligible siblings from loading.
 */
export async function enumerateFolder(handle: FileSystemDirectoryHandle): Promise<FolderEnumeration> {
    const out: VendorFile[] = [];
    const root: IngestStructureEntry = { relativePath: handle.name, kind: "directory" };
    const structure: IngestStructureEntry[] = [root];
    const errors = { count: 0 };
    await walkDirectory(
        handle,
        root,
        out,
        structure,
        errors,
        createExcludedTraversalBudget(),
        isIgnoredPath(handle.name) ? 1 : 0,
    );
    return { files: out, structure, readErrors: errors.count };
}

// Iteration errors here propagate to the caller: for the root that is the
// "whole folder is gone" signal; for subdirectories the recursive call site
// below catches them into the skip counter.
async function walkDirectory(
    dir: FileSystemDirectoryHandle,
    parent: IngestStructureEntry,
    out: VendorFile[],
    structure: IngestStructureEntry[],
    errors: { count: number },
    budget: ExcludedTraversalBudget,
    excludedDepth: number,
): Promise<void> {
    const limit = excludedDirectoryLimit(budget, excludedDepth);
    if (limit) {
        parent.truncated = limit;
        return;
    }
    for await (const child of dir.values()) {
        const relativePath = `${parent.relativePath}/${child.name}`;
        const isIgnored = isIgnoredPath(relativePath);
        if (isIgnored && !takeExcludedStructureEntry(budget)) {
            parent.truncated = "entry limit";
            // A normal parent must still reveal eligible siblings. Every child
            // below an excluded parent is excluded, so release its iterator.
            if (excludedDepth > 0) return;
            continue;
        }
        const entry: IngestStructureEntry = { relativePath, kind: child.kind };
        structure.push(entry);
        if (child.kind === "file") {
            // Excluded files remain visible in diagnostics without opening
            // them. Directory handles alone expose names, not file metadata.
            if (isIgnored) continue;
            try {
                const file = await child.getFile();
                entry.size = file.size;
                entry.lastModified = file.lastModified;
                out.push({ file, relativePath });
            } catch (err) {
                entry.unreadable = true;
                errors.count++;
                log.warn("fsa: failed to read file entry", {
                    name: child.name,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        } else {
            try {
                await walkDirectory(child, entry, out, structure, errors, budget, isIgnored ? excludedDepth + 1 : 0);
            } catch (err) {
                entry.unreadable = true;
                // OS metadata folders often deny enumeration. Preserve that
                // fact in the report without warning about a healthy card.
                if (isIgnored) continue;
                errors.count++;
                log.warn("fsa: failed to read directory", {
                    name: child.name,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
}
