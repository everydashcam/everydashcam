// Pre-ingest path filter: drops hidden/system files and known low-resolution
// previews before they reach classify/index/dedup. Directory walkers retain
// excluded names for the structure report without opening their file handles.
//
// Hidden directories cover 70mai `.s_Front` / `.s_Back` previews. DDPai Z60
// writes its low-resolution previews to a visible `small/` directory instead.

const RX_SMALL_PREVIEW_PATH = /(?:^|\/)small\/\d{14}_\d{2,7}_S\.mp4$/i;

// Exact-match (case-insensitive) directory names that are OS/filesystem junk
// but not dot-prefixed, so the hidden-segment rule below would miss them.
const JUNK_DIR_NAMES = new Set<string>([
    "system volume information", // Windows
    "$recycle.bin", // Windows recycle bin
    "recycler", // Windows (pre-Vista) recycle bin
    "lost.dir", // Android FAT recovery
]);

// Windows chkdsk recovery folders: FOUND.000, FOUND.001, ...
const FOUND_DIR_RE = /^found\.\d{3}$/;

// WinMp4Extract's author reports .GPS logs for some 70mai models:
// https://mail.amicus.ba/index.php/programi/397-winmp4extract-program
// This is a supported layout, not a claim that every card uses it. Our hidden
// layout fixtures relocate an existing log to exercise the import filter.
const ALLOWED_HIDDEN_SEGMENTS: ReadonlySet<string> = new Set([".gps"]);

export type IngestIgnoreReason = "hidden path" | "system path" | "preview recording";

/**
 * Whether a single path segment is a hidden or junk directory/file name.
 * Explicitly allowed telemetry paths remain readable.
 */
export function isIgnoredSegment(segment: string): boolean {
    return ignoredSegmentReason(segment) !== null;
}

export function ignoredSegmentReason(segment: string): IngestIgnoreReason | null {
    const lower = segment.toLowerCase();
    if (segment.startsWith(".") && !ALLOWED_HIDDEN_SEGMENTS.has(lower)) return "hidden path";
    if (JUNK_DIR_NAMES.has(lower) || FOUND_DIR_RE.test(lower)) return "system path";
    return null;
}

/**
 * Whether a file at `relativePath` should be skipped at ingest. Hidden/junk
 * segments and known preview paths are ignored.
 *
 * Accepts both "/" (DnD fullPath) and "\\" (some Windows webkitRelativePath)
 * separators. An empty path is never ignored (treated as a bare filename).
 */
export function isIgnoredPath(relativePath: string): boolean {
    return ignoredPathReason(relativePath) !== null;
}

/** The same decision drives import filtering and its diagnostic annotation. */
export function ignoredPathReason(relativePath: string): IngestIgnoreReason | null {
    if (!relativePath) return null;
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (RX_SMALL_PREVIEW_PATH.test(normalizedPath)) return "preview recording";
    const segments = normalizedPath.split("/");
    for (const segment of segments) {
        if (segment.length === 0) continue; // leading slash, double slash
        const reason = ignoredSegmentReason(segment);
        if (reason) return reason;
    }
    return null;
}

/**
 * Distinct top-level (root) segments across `relativePaths` that the filter
 * classifies as junk. Diagnostic-only: used when the filter emptied the whole
 * selection, to name the folder the user actually picked (a ".backup" copy, a
 * chkdsk "FOUND.000") in a bug-report log line instead of a generic "nothing
 * loaded". A clean root with junk deeper in the tree contributes nothing - the
 * root is what the user chose, so it is the useful signal here.
 */
export function ignoredRootSegments(relativePaths: string[]): string[] {
    const roots = new Set<string>();
    for (const relativePath of relativePaths) {
        if (!relativePath) continue;
        const root = relativePath.split(/[/\\]/).find((segment) => segment.length > 0);
        if (root && isIgnoredSegment(root)) roots.add(root);
    }
    return [...roots];
}
