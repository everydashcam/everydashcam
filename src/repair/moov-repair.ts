// Combined container-repair DETECTION over moov bytes the indexer already read.
// Both defects we repair (phantom no-data tracks, broken hvcC) live entirely
// inside the moov box, so the indexer worker - which reads moov once per file
// for indexing - can detect them with zero extra IO and hand the main thread a
// ready-to-splice patched moov. This replaces the two separate post-index repair
// stages (repairHvcc + repairPhantomTracks), each of which re-read the moov via
// findMoovInFile on the main thread (1-2 redundant moov reads per file, costly
// on mobile SAF where every slice is a 5-30 ms IPC round-trip).
//
// This module is pure (bytes in, descriptor out) so it runs inside the worker
// and stays unit-testable. The File construction (zero-copy Blob splice) lives
// on the main thread - see src/ui/ingest.ts applyMoovRepair.

import type { VideoCodec } from "mediabunny";

import { createLogger } from "../log.js";
import { needsHevcRemux } from "../hevc-remux.js";
import { hevcCodecStringFromHvcc } from "../parsers/internal/mp4-walker.js";
import { detectHvcCRepair } from "./hvcc.js";
import { findPhantomTracks, type PhantomEdit } from "./phantom-track.js";

const log = createLogger("repair:moov");

/** Repair descriptor for one file's moov, produced from the moov bytes alone. */
export interface MoovRepair {
    /**
     * Patched copy of the moov bytes (constant size - all edits are in-place
     * rewrites). The main thread splices it back via
     * [file.slice(0, moovFileStart), patchedMoov, file.slice(moovFileEnd)].
     */
    patchedMoov: Uint8Array;
    /** Handler types of neutralized phantom tracks ('soun', 'meta', ...) - for the status toast. */
    phantomNeutralized: string[];
    /**
     * hvcC repair result when an HEVC file's hvcC was patched, else null.
     * needsHevcRemux is recomputed on the rebuilt payload so the candidate's
     * playback path (native vs MSE) reflects the fix. videoCodecString is
     * re-derived from the rebuilt hvcC: the string parsed at index time came from
     * the broken header (bogus profile/level), and a config-aware canPlay probe on
     * that string would falsely reject a file that decodes fine after the splice.
     */
    hvcc: { needsHevcRemux: boolean; reason: "header" | "arrays"; videoCodecString: string | null } | null;
}

/**
 * Detects and patches both container defects on the moov bytes. Returns null
 * when the moov is clean (the common case - no allocation, no patched copy).
 * hvcC detection runs only for HEVC (codec === "hevc"); phantom-track detection
 * is codec-independent.
 *
 * The returned patchedMoov is a fresh copy with the edits applied; the original
 * moovBytes are left untouched (the indexer still forwards them to gps-extract).
 */
export function detectMoovRepairs(moovBytes: Uint8Array, codec: VideoCodec | null): MoovRepair | null {
    // A malformed sample table must never discard the already-built index: a
    // repair-detection throw degrades to "no phantom edits" (the file still
    // plays; only the best-effort phantom fix is skipped), mirroring the
    // standalone repairPhantomTracks wrapper. detectHvcCRepair is self-guarded.
    let phantomEdits: PhantomEdit[];
    try {
        phantomEdits = findPhantomTracks(moovBytes);
    } catch (err) {
        log.debug("phantom detection failed", { err: err instanceof Error ? err.message : String(err) });
        phantomEdits = [];
    }
    const hvccRepair = codec === "hevc" ? detectHvcCRepair(moovBytes) : null;
    if (phantomEdits.length === 0 && !hvccRepair) return null;

    // One copy, both edit sets applied in place. Phantom edits zero entry_count
    // u32s; the hvcC edit overwrites its payload with the rebuilt bytes. Neither
    // changes the byte length, so every file offset outside moov stays valid.
    const patchedMoov = new Uint8Array(moovBytes);
    const dv = new DataView(patchedMoov.buffer, patchedMoov.byteOffset, patchedMoov.byteLength);
    for (const edit of phantomEdits) {
        for (const off of edit.countOffsets) dv.setUint32(off, 0);
    }
    let hvcc: MoovRepair["hvcc"] = null;
    if (hvccRepair) {
        patchedMoov.set(hvccRepair.rebuilt, hvccRepair.moovRelPayloadStart);
        hvcc = {
            needsHevcRemux: needsHevcRemux("hevc", hvccRepair.rebuilt),
            reason: hvccRepair.reason,
            videoCodecString: hevcCodecStringFromHvcc(hvccRepair.rebuilt, hvccRepair.sampleEntry),
        };
    }

    return {
        patchedMoov,
        phantomNeutralized: phantomEdits.map((e) => e.handler),
        hvcc,
    };
}
