// Filename / path metadata techniques - aggregate walk API.
//
// Each process (time / channel / mode / sequence) is a flat list of
// FilenameTechnique entries (see types.ts). The walk takes the first specific
// match, falling back to the first heuristic only when no specific technique
// recognizes the file, and reports the matching technique id for diagnostics.
//
// Adding support for a new camera typically means adding one or two entries
// to the relevant per-field file - never a new "vendor file". When a
// technique applies to several brands it is shared across them by virtue of
// living in a per-field list rather than per-vendor file.

import type { RecordingMode, VendorFile } from "../types.js";
import { FILENAME_CAMERA_KEY } from "./camera-key.js";
import { asOriginalDownload } from "./download-copy.js";
import { FILENAME_CHANNEL } from "./channel.js";
import { FILENAME_MODE } from "./mode.js";
import { FILENAME_SEQUENCE } from "./sequence.js";
import { FILENAME_RECORDING_KEY } from "./recording-key.js";
import { FILENAME_TIME } from "./time.js";
import { FILENAME_CLOCK_TIMELAPSE, FILENAME_TIMELAPSE } from "./timelapse.js";
import type { ChannelMatch, FilenameMatch, FilenameTechnique } from "./types.js";

export type { FilenameMatch } from "./types.js";

// Every technique reads a browser's repeated download under its original
// name (download-copy.ts), so the copy classifies exactly like the original.
function walk<T>(techniques: readonly FilenameTechnique<T>[], downloaded: VendorFile): FilenameMatch<T> {
    const file = asOriginalDownload(downloaded);
    let heuristic: FilenameMatch<T> | null = null;
    for (const t of techniques) {
        const value = t.extract(file);
        if (value === null) continue;
        const match = { value, matchedId: t.id };
        if ((t.evidence?.(file, value) ?? "specific") === "specific") return match;
        heuristic ??= match;
    }
    return heuristic ?? { value: null, matchedId: null };
}

// Walk results with the matched technique id - for diagnostics.
export function matchFilenameTime(file: VendorFile): FilenameMatch<Date> {
    return walk(FILENAME_TIME, file);
}

export function matchFilenameChannel(file: VendorFile): FilenameMatch<ChannelMatch> {
    return walk(FILENAME_CHANNEL, file);
}

export function matchFilenameMode(file: VendorFile): FilenameMatch<RecordingMode> {
    return walk(FILENAME_MODE, file);
}

export function matchFilenameSequence(file: VendorFile): FilenameMatch<number> {
    return walk(FILENAME_SEQUENCE, file);
}

// Convenience shortcuts for callers that don't need the matched id.
export function classifyFilenameTime(file: VendorFile): Date | null {
    return matchFilenameTime(file).value;
}
export function classifyFilenameChannel(file: VendorFile): ChannelMatch | null {
    return matchFilenameChannel(file).value;
}
export function classifyFilenameMode(file: VendorFile): RecordingMode | null {
    return matchFilenameMode(file).value;
}
export function classifyFilenameSequence(file: VendorFile): number | null {
    return matchFilenameSequence(file).value;
}
/** Whether the filename marks a time-lapse recording (see FILENAME_TIMELAPSE).
 *  Defaults to false - only an explicit vendor time-lapse marker flips it. */
export function classifyFilenameTimelapse(file: VendorFile): boolean {
    return walk(FILENAME_TIMELAPSE, file).value ?? false;
}
/** Whether this filename family allows the container clocks to prove that an
 *  otherwise ambiguous clip is time-lapse. This is eligibility, not a verdict. */
export function classifyFilenameClockTimelapse(file: VendorFile): boolean {
    return walk(FILENAME_CLOCK_TIMELAPSE, file).value ?? false;
}
/**
 * Cross-channel camera key - first non-null technique match, or null when no
 * technique recognises the format. Callers that need a guaranteed-non-null
 * key wrap this with a fallback - see `cameraFingerprint`.
 */
export function classifyFilenameCameraKey(file: VendorFile): string | null {
    return walk(FILENAME_CAMERA_KEY, file).value;
}

/** Exact recording identity shared by synchronized sibling channels. */
export function classifyFilenameRecordingKey(file: VendorFile): string | null {
    return walk(FILENAME_RECORDING_KEY, file).value;
}
