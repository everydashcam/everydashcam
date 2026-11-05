// A browser never overwrites an earlier download: saving `clip.mp4` again into
// the same folder writes `clip (1).mp4` in Chromium and `clip(1).mp4` in
// Firefox. Facts read from a name (time, channel, camera, segment) describe the
// recording, not the download, so filename consumers read the name without
// that suffix. Safari-style `clip-1.mp4` stays as it is: a trailing
// `-<digits>` is part of many camera names.

import type { VendorFile } from "../types.js";

const RX_REPEATED_DOWNLOAD_SUFFIX = / ?\(\d+\)(\.[^./]+)$/;

/** The name before a browser's repeated-download suffix; any other name unchanged. */
export function originalDownloadName(name: string): string {
    return name.replace(RX_REPEATED_DOWNLOAD_SUFFIX, "$1");
}

/** Whether a name carries a browser's repeated-download suffix. */
export function isRepeatedDownloadName(name: string): boolean {
    return RX_REPEATED_DOWNLOAD_SUFFIX.test(name);
}

/**
 * The file as filename classification sees it: under its original download
 * name, in its file name and the last segment of its path. Returns the same
 * object for a name without the suffix. The replacement File is empty and
 * exists only to carry the name; never read bytes from it.
 */
export function asOriginalDownload(file: VendorFile): VendorFile {
    const name = originalDownloadName(file.file.name);
    if (name === file.file.name) return file;
    const slash = file.relativePath.lastIndexOf("/");
    return {
        ...file,
        file: new File([], name, { lastModified: file.file.lastModified, type: file.file.type }),
        relativePath: file.relativePath.slice(0, slash + 1) + originalDownloadName(file.relativePath.slice(slash + 1)),
    };
}
