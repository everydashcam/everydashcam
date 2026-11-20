// Filename/path metadata extraction techniques.
//
// Each "process" (time / channel / mode / sequence) is a flat library of
// techniques. A technique has a stable id (so diagnostics can report which
// regex actually matched) and an extract function that returns the value or
// null. The pipeline returns the first specific match; unscoped path
// heuristics remain fallbacks when no format-shaped technique matches.
//
// A new camera typically reuses existing techniques. When it does not, only
// the missing technique is added to the relevant list - we never grow files
// by vendor count, we grow by unique extraction variants.

import type { Channel, RecordingMode, VendorFile } from "../types.js";

export interface FilenameTechnique<T> {
    /** Stable id, surfaced in diagnostics (VideoCandidate.classifierMatches). */
    id: string;
    /** Returns the extracted value, or null when the technique does not apply. */
    extract(file: VendorFile): T | null;
    /**
     * Classifies the evidence behind a non-null result. Specific evidence is a
     * format-shaped filename or a path that was gated by one. Heuristic evidence
     * is an unscoped folder convention such as `Event/` or `Front/` that remains
     * useful for renamed files but must not override a later format-shaped name.
     * Omitted means specific.
     */
    evidence?(file: VendorFile, value: T): "specific" | "heuristic";
}

export type FilenameTimeTechnique = FilenameTechnique<Date>;

/**
 * Result of a channel technique. `channel` is the semantic mount (front / rear
 * / interior / side). `confident` says whether the technique recognised the
 * channel from a trustworthy signal:
 *   - true  - a mnemonic letter under a vendor-specific name pattern (F=front,
 *             R=rear, B=back, I=interior), a path/folder with a spelled-out name
 *             (Tesla front/back/cabin, FITCAMX Movie/Movie_E), or a
 *             single-channel model (only one camera, nothing to confuse).
 *   - false - an index letter whose letter->mount mapping is a pure vendor
 *             convention we cannot verify (CarCam A/B/C/D, Vantrue A/B/C where
 *             B is the cabin). The mount is still our best guess and is used for
 *             grid layout / grouping, but the UI shows a positional "Channel N"
 *             label instead of "Rear camera" to avoid asserting a mount we are
 *             only guessing.
 */
export interface ChannelMatch {
    channel: Channel;
    confident: boolean;
}

export type FilenameChannelTechnique = FilenameTechnique<ChannelMatch>;
export type FilenameModeTechnique = FilenameTechnique<RecordingMode>;
export type FilenameSequenceTechnique = FilenameTechnique<number>;
/**
 * Cross-channel camera key. Same string for every channel of one physical
 * camera (front + rear + interior + side share a key). Different string for
 * different cameras. Used as the cross-camera isolator in groupTrips so two
 * cameras dropped together do not collapse into one frame just because their
 * timestamps happen to fall inside the 30s snap window.
 */
export type FilenameCameraKeyTechnique = FilenameTechnique<string>;
export type FilenameRecordingKeyTechnique = FilenameTechnique<string>;

/** Walk result: the value plus the id of the technique that produced it. */
export interface FilenameMatch<T> {
    value: T | null;
    matchedId: string | null;
}
