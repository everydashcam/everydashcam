// Single source for "save a Blob to the user's disk via a temporary <a download>".
// No backend - the blob never leaves the machine. Used by the log export, frame
// capture, the feedback report .txt, and the GPX/clip export fallback path.

/**
 * Triggers a browser download of blob under filename via a hidden anchor.
 * The object URL is revoked after a short delay - an immediate revoke can
 * cancel the download on slower engines that have not started reading the
 * blob yet. Requires a DOM (no-op in workers/node where document is absent).
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch (err) {
        // Revoke now: the deferred revoke below is never reached on this path, and
        // a created-but-unused object URL leaks for the page lifetime otherwise.
        // Preserve the original failure without putting a private download name
        // into an exception that the global error reporter may transmit.
        URL.revokeObjectURL(url);
        throw new Error("download failed", { cause: err });
    }
    // Deferred revoke - an immediate revoke can cancel the download on slower
    // engines that have not started reading the blob yet.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
