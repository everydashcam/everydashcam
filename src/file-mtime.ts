import type { VendorFile } from "./parsers/types.js";

/**
 * lastModified pinned on a file whose modification time the browser cannot
 * report. Chromium answers File.lastModified with the current time on every
 * read when its snapshot has no time (blink `File::LastModifiedTime`), e.g. a
 * File System Access file whose OS time is null (a zero Windows FILETIME or a
 * POSIX epoch mtime). Identities built from it (`vendorFileKey`, persisted
 * cache and notes keys) would then change between two reads. A fixed value
 * keeps such a file identified by source, path and size, within a session and
 * across sessions. The Unix epoch is never a dashcam recording time, so code
 * that reads mtime as a time goes through `knownFileMtime`.
 */
export const UNKNOWN_FILE_MTIME = 0;

// Date.now() and the browser's file clock are not guaranteed to be one source.
// A wide margin only adds a cheap second read for files modified a second ago.
const CURRENT_TIME_MARGIN_MS = 1_000;

/** Modification time in Unix milliseconds, or null when the file has none.
 * Valid only for files that passed `pinUnknownFileMtimes`. A pre-epoch time
 * also counts as none: Chromium reports a picked file without an OS time as
 * 1601-01-01, and persisted note times cannot be negative. */
export function knownFileMtime(file: File): number | null {
    return file.lastModified <= UNKNOWN_FILE_MTIME ? null : file.lastModified;
}

/**
 * Replaces every file whose lastModified follows the current time with a copy
 * pinned to `UNKNOWN_FILE_MTIME`; other entries are returned unchanged,
 * including future-dated files from a camera with a wrong clock. Run it before
 * anything derives identity from the batch. The copy reads the same bytes and
 * keeps name and type; `relativePath` lives on the VendorFile, not the File.
 * Waits a few milliseconds only when some file needs a second read.
 */
export async function pinUnknownFileMtimes(files: readonly VendorFile[]): Promise<VendorFile[]> {
    const readStartedAt = Date.now();
    const firstReads = new Map<VendorFile, number>();
    for (const vendorFile of files) {
        const lastModified = vendorFile.file.lastModified;
        if (lastModified >= readStartedAt - CURRENT_TIME_MARGIN_MS) firstReads.set(vendorFile, lastModified);
    }
    if (firstReads.size === 0) return [...files];

    // A current-time answer moves once the clock passes the first reads; a
    // stored time does not. Two clock ticks leave at least one whole
    // millisecond, whatever the phase of the browser's file clock.
    const firstReadsFinishedAt = Date.now();
    while (Date.now() <= firstReadsFinishedAt + 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return files.map((vendorFile) => {
        const firstRead = firstReads.get(vendorFile);
        if (firstRead === undefined || vendorFile.file.lastModified === firstRead) return vendorFile;
        const { file } = vendorFile;
        return {
            ...vendorFile,
            file: new File([file], file.name, { type: file.type, lastModified: UNKNOWN_FILE_MTIME }),
        };
    });
}
