import { RX_E_ACE, parseOpenpilotFileName } from "./_patterns.js";
import type { VendorFile } from "../types.js";
import type { FilenameRecordingKeyTechnique } from "./types.js";

/** Exact sibling identity for filename families with synchronized channel cuts.
 *  Camera and source scope must be supplied by the caller. */
const eaceRecordingKey: FilenameRecordingKeyTechnique = {
    id: "e-ace-recording-key",
    extract(file: VendorFile): string | null {
        const match = file.file.name.match(RX_E_ACE);
        return match?.[3] ? `${match[1]}_${match[2]}` : null;
    },
};

/** Every camera of one openpilot segment is cut at the same frame. */
const openpilotRecordingKey: FilenameRecordingKeyTechnique = {
    id: "openpilot-recording-key",
    extract(file: VendorFile): string | null {
        const name = parseOpenpilotFileName(file);
        return name ? `${name.route}--${name.segment}` : null;
    },
};

export const FILENAME_RECORDING_KEY: readonly FilenameRecordingKeyTechnique[] = [
    openpilotRecordingKey,
    eaceRecordingKey,
];
