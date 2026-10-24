// Builds the plain-text "folder structure" report bundled into the feedback
// report (src/ui/feedback.ts) as camera-structure.txt - the key artifact for an
// unrecognised camera. Pure and byte-free: everything is derived
// from file paths, sizes and modified-times plus the filename techniques - which
// read names/paths only, never video content. The user sends this on purpose,
// by email, so it is a diagnostic body: English and technical terms are fine
// (voice.md allows jargon in the report body). It never contains GPS
// coordinates - no supported format encodes them in a filename.

import {
    classifyFilenameCameraKey,
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameSequence,
    matchFilenameTime,
} from "./parsers/filename/index.js";
import type { VendorFile } from "./parsers/types.js";
import { ignoredPathReason, type IngestIgnoreReason } from "./ingest-filter.js";
import { type IngestStructureEntry, snapshotIngestStructure } from "./ingest-structure.js";
import { APP_VERSION } from "./version.js";

// Extensions that look like a dashcam recording. Used only to decide whether a
// zero-trips ingest is "an unrecognised camera" (worth offering the report) vs
// "the user dropped the wrong folder" (no video at all). Intentionally broad -
// a false positive just means the offer appears for a non-dashcam video folder,
// which is harmless.
const RECORDING_EXTENSIONS: ReadonlySet<string> = new Set([
    ".mp4",
    ".mov",
    ".ts",
    ".m2ts",
    ".mts",
    ".mkv",
    ".avi",
    ".wmv",
    ".3gp",
    ".insv",
    ".360",
    ".lrv",
    ".jdr",
    ".mdt",
]);

/** True if at least one file looks like a video recording. Gate for offering
 *  the "help add my camera" flow after a zero-trips ingest. */
export function looksLikeRecordings(files: readonly VendorFile[]): boolean {
    return files.some((f) => RECORDING_EXTENSIONS.has(extOf(f.file.name)));
}

/** Lowercased extension with leading dot, or "" when the name has none. */
function extOf(name: string): string {
    const dot = name.lastIndexOf(".");
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    return dot <= slash ? "" : name.slice(dot).toLowerCase();
}

/** Basename without the trailing extension, lowercased - the pairing key that
 *  basename-sidecar formats (GPX / .map / .gps / .nmea / .3gf) rely on. */
function stemOf(name: string): string {
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    const base = slash < 0 ? name : name.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    return (dot < 0 ? base : base.slice(0, dot)).toLowerCase();
}

/** Human-readable byte size: "3.1 MB", "12 KB", "840 B". */
function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** UTC "YYYY-MM-DD HH:MM" from an epoch-ms timestamp. Deterministic (UTC, not
 *  locale) so two reports of the same card read identically. */
function fmtMtime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// Separate budgets keep excluded paths and directory names visible even when
// thousands of normal recordings fill their own section.
const MAX_LISTED_PATHS = 3000;
const MAX_LISTED_EXTENSIONS = 100;
const MAX_LISTED_SIDECARS = 30;

/** Fields the filename techniques resolve, aggregated across the whole drop:
 *  the top matching technique id per field and how many files it covered. */
interface FieldSummary {
    field: string;
    topTechnique: string | null;
    matchedFiles: number;
    totalFiles: number;
}

function summarizeField(
    field: string,
    files: readonly VendorFile[],
    match: (f: VendorFile) => { matchedId: string | null },
): FieldSummary {
    const byTechnique = new Map<string, number>();
    for (const f of files) {
        const id = match(f).matchedId;
        if (id) byTechnique.set(id, (byTechnique.get(id) ?? 0) + 1);
    }
    let topTechnique: string | null = null;
    let matchedFiles = 0;
    for (const [id, n] of byTechnique) {
        if (n > matchedFiles) {
            matchedFiles = n;
            topTechnique = id;
        }
    }
    return { field, topTechnique, matchedFiles, totalFiles: files.length };
}

function renderFieldLine(s: FieldSummary): string {
    const label = s.field.padEnd(9);
    if (!s.topTechnique) return `  ${label} not recognised`;
    return `  ${label} ${s.topTechnique} (${s.matchedFiles}/${s.totalFiles} files)`;
}

/**
 * Builds a byte-free report of every observed file and directory before path
 * filtering. Enumeration entries preserve paths even when no File could be
 * read; available File objects supply metadata and filename-technique evidence.
 * Each listing section has its own announced cap, while counts cover the full
 * snapshot. Unreadable directories make file counts and byte totals incomplete.
 */
export function buildStructureReport(
    files: readonly VendorFile[],
    structure?: readonly IngestStructureEntry[],
): string {
    return buildStructureReportFromSnapshot(files, snapshotIngestStructure(files, structure));
}

/** Renders the prepared ingest snapshot without repeating normalization or
 * metadata merging. File objects are used only for filename-technique evidence. */
export function buildStructureReportFromSnapshot(
    files: readonly VendorFile[],
    entries: readonly IngestStructureEntry[],
): string {
    const fileEntries = entries.filter((entry) => entry.kind === "file");
    const directories = entries.filter((entry) => entry.kind === "directory");
    const knownSizeFiles = fileEntries.filter(hasKnownSize);
    const unreadableDirectories = directories.filter((entry) => entry.unreadable).length;
    const truncatedDirectories = directories.filter((entry) => entry.truncated).length;
    const now = new Date();
    const totalBytes = knownSizeFiles.reduce((sum, entry) => sum + entry.size, 0);
    const hasCompleteSizes =
        knownSizeFiles.length === fileEntries.length && unreadableDirectories === 0 && truncatedDirectories === 0;
    const lines: string[] = [];

    lines.push("everydashcam camera report");
    lines.push(`app ${APP_VERSION}  ·  generated ${now.toISOString()}`);
    lines.push(`files: ${fileEntries.length}  ·  directories: ${directories.length}`);
    lines.push(
        hasCompleteSizes
            ? `total: ${humanSize(totalBytes)}`
            : `known file sizes: ${humanSize(totalBytes)} (${knownSizeFiles.length}/${fileEntries.length} observed files)`,
    );
    if (unreadableDirectories > 0) {
        lines.push(`Unreadable directories: ${unreadableDirectories}; file counts and sizes are incomplete.`);
    }
    if (truncatedDirectories > 0) {
        lines.push(
            `Truncated directories: ${truncatedDirectories}; file and directory counts and sizes are incomplete.`,
        );
    }
    lines.push("");
    lines.push("This lists observed file and directory names, available sizes and dates before filtering.");
    lines.push("Kept/excluded describes the path filter, not whether a file was parsed successfully.");
    lines.push("No video, no GPS coordinates.");
    lines.push("");

    // Extension histogram, most common first.
    const byExt = new Map<string, number>();
    for (const entry of fileEntries) {
        const e = extOf(entry.relativePath) || "(no ext)";
        byExt.set(e, (byExt.get(e) ?? 0) + 1);
    }
    lines.push("== extensions (all observed files, including excluded) ==");
    const extensions = [...byExt.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [e, n] of extensions.slice(0, MAX_LISTED_EXTENSIONS)) {
        lines.push(`  ${e.padEnd(10)} ${n}`);
    }
    if (extensions.length > MAX_LISTED_EXTENSIONS) {
        lines.push(`  ... and ${extensions.length - MAX_LISTED_EXTENSIONS} more extensions (list truncated)`);
    }
    lines.push("");

    // Filename technique triage - the key signal for the developer: which
    // fields already have a matching technique and which are missing.
    lines.push("== filename techniques ==");
    lines.push(`  based on ${files.length} available File objects; enumeration-only entries are not classified`);
    lines.push(renderFieldLine(summarizeField("time", files, matchFilenameTime)));
    lines.push(renderFieldLine(summarizeField("channel", files, matchFilenameChannel)));
    lines.push(renderFieldLine(summarizeField("mode", files, matchFilenameMode)));
    lines.push(renderFieldLine(summarizeField("sequence", files, matchFilenameSequence)));
    const cameraKeys = new Set<string>();
    for (const f of files) {
        const k = classifyFilenameCameraKey(f);
        if (k) cameraKeys.add(k);
        if (cameraKeys.size >= 5) break;
    }
    lines.push(`  camera-key ${cameraKeys.size ? [...cameraKeys].join(", ") : "not recognised"}`);
    lines.push("");

    // Likely basename sidecars: a stem carried by both a video and a non-video
    // file usually means the GPS lives in that companion file.
    const stems = new Map<string, { videos: Set<string>; others: Set<string> }>();
    for (const file of fileEntries) {
        const stem = stemOf(file.relativePath);
        const e = extOf(file.relativePath);
        let entry = stems.get(stem);
        if (!entry) {
            entry = { videos: new Set(), others: new Set() };
            stems.set(stem, entry);
        }
        if (RECORDING_EXTENSIONS.has(e)) entry.videos.add(e);
        else if (e) entry.others.add(e);
    }
    const sidecarPairs: string[] = [];
    for (const [stem, entry] of stems) {
        if (entry.videos.size > 0 && entry.others.size > 0) {
            sidecarPairs.push(`  ${stem}: ${[...entry.videos].join("/")} + ${[...entry.others].join("/")}`);
        }
    }
    lines.push("== possible sidecars (same name, video + companion file) ==");
    lines.push(...(sidecarPairs.length ? sidecarPairs.slice(0, MAX_LISTED_SIDECARS) : ["  none found"]));
    if (sidecarPairs.length > MAX_LISTED_SIDECARS) {
        lines.push(`  ... and ${sidecarPairs.length - MAX_LISTED_SIDECARS} more pairs (list truncated)`);
    }
    lines.push("");

    const excludedDirectories: ReportEntry[] = [];
    const excludedFiles: ReportEntry[] = [];
    const keptDirectories: ReportEntry[] = [];
    const keptFiles: ReportEntry[] = [];
    for (const entry of entries) {
        const reason = ignoredPathReason(entry.relativePath);
        if (entry.kind === "directory") {
            (reason === null ? keptDirectories : excludedDirectories).push({ entry, reason });
        } else {
            (reason === null ? keptFiles : excludedFiles).push({ entry, reason });
        }
    }
    appendStructureSection(lines, "excluded directories", excludedDirectories);
    appendStructureSection(lines, "excluded files", excludedFiles);
    appendStructureSection(lines, "kept directories", keptDirectories);
    appendStructureSection(lines, "kept files", keptFiles);

    return lines.join("\n");
}

function hasKnownSize(entry: IngestStructureEntry): entry is IngestStructureEntry & { size: number } {
    return entry.size !== undefined && Number.isFinite(entry.size) && entry.size >= 0;
}

interface ReportEntry {
    entry: IngestStructureEntry;
    reason: IngestIgnoreReason | null;
}

function appendStructureSection(lines: string[], title: string, entries: readonly ReportEntry[]): void {
    lines.push(`== ${title} (${entries.length}) ==`);
    const sorted = [...entries].sort((a, b) => a.entry.relativePath.localeCompare(b.entry.relativePath));
    for (const { entry, reason } of sorted.slice(0, MAX_LISTED_PATHS)) {
        const status = reason === null ? "kept" : `excluded: ${reason}`;
        if (entry.kind === "directory") {
            const unavailable = entry.unreadable ? "; contents unavailable" : "";
            const truncated = entry.truncated ? `; traversal truncated: ${entry.truncated}` : "";
            lines.push(`  ${entry.relativePath}/  [directory; ${status}${unavailable}${truncated}]`);
        } else {
            const size = hasKnownSize(entry) ? humanSize(entry.size) : "size unavailable";
            const mtime = entry.lastModified === undefined ? "date unavailable" : fmtMtime(entry.lastModified);
            const unavailable = entry.unreadable ? "; file metadata unavailable" : "";
            lines.push(`  ${entry.relativePath}  ${size}  ${mtime}  [${status}${unavailable}]`);
        }
    }
    if (sorted.length > MAX_LISTED_PATHS) {
        lines.push(`  ... and ${sorted.length - MAX_LISTED_PATHS} more (list truncated)`);
    }
    if (entries.length === 0) lines.push("  none");
    lines.push("");
}
