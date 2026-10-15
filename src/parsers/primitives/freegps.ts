// Novatek freeGPS extractor. Covers the chipset family: VIOFO, Vantrue,
// Akaso, Azdome, Kenwood, Nextbase, iBox, many anonymous Chinese clones on
// NTK96670/NT9669X - all share one `freeGPS ` block contract inside mdat.
//
// Two strategies (cheap to expensive):
//   1. Structural: moov -> `gps ` atom with a table of (offset, size) entries.
//      Cheap - sparse block reads via the table (tens of KB per recording
//      minute). Available on VIOFO/Vantrue/Akaso, where the firmware honestly
//      writes the table. Machinery is shared (internal/freegps.ts
//      tryStructuralPath) with the 70mai-embedded primitive.
//   2. Streaming: walk mdat in 4 MB chunks up to EOF (cap 4 GB). Files
//      without a usable `gps ` atom land here - VIOFO old firmware,
//      Azdome XOR Type-1, anonymous clones.
//
// Markers (see Mp4Index in internal/mp4-index.ts):
//   - a usable `gps ` table (hasUsableNovatekGpsTable) -> structural path.
//     Cheap (light in kind-classification). A placeholder or junk table is
//     not a marker: such a file is claimed only through the probe below.
//   - hasFreeGpsMarker -> streaming. Heavy (may require user prompt).

import { type GpsRecord, type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Mp4Index } from "../internal/mp4-index.js";
import {
    createFreeGpsBlockParser,
    type FreeGpsFileBlockParser,
    GRAVITY_INCLUDED_VARIANT_NAMES,
    hasUsableNovatekGpsTable,
    REXING_KODAK_VERSION,
    streamScanFreeGps,
    tryStructuralPath,
} from "../internal/freegps.js";
import { removeGravityBaselineOrZero } from "../internal/accel-baseline.js";
import { classifyFilenameTime } from "../filename/index.js";
import type { Primitive } from "./types.js";

export const freegpsPrimitive: Primitive = {
    id: "freegps",
    displayName: "Novatek freeGPS (VIOFO/Vantrue/Azdome/...)",
    kind: "video-embedded",

    async marker(_file: VendorFile, index?: Mp4Index): Promise<boolean> {
        if (!index) return false;
        // Either marker is a valid signal. Final confirmation is in parse();
        // the streaming probe self-limits to the first chunks if no blocks
        // are found.
        return hasUsableNovatekGpsTable(index) || index.hasFreeGpsMarker === true;
    },

    async parse(file: VendorFile, index?: Mp4Index, signal?: AbortSignal): Promise<ParsedRecords> {
        if (!index) throw new WrongFormatError("freegps requires Mp4Index");
        // ONE block parser per file: its anchor-scan consistency lock must
        // observe blocks across both the structural and streaming paths (and
        // across a jump-scan bail into the linear rerun).
        //
        // rexingAffine: exact-match on the firmware version from the top-level
        // frea/'ver ' atom - the only safe trigger for the Rexing coordinate
        // deobfuscation (obfuscated raws overlap valid DDmm ranges, so a
        // value-shape heuristic would corrupt genuine Type-3 files; see the
        // Rexing banner in internal/freegps.ts).
        const parseBlock = createFreeGpsBlockParser({
            rexingAffine: index.kodakVersion === REXING_KODAK_VERSION,
        });
        // Structural path first - cheap when it works.
        const structural = await tryStructuralPath(file.file, index, parseBlock, signal);
        if (structural) {
            removeGravityIncludedAccelBaseline(structural.records, parseBlock);
            attachLocalClockOffsetHint(structural, parseBlock, file);
            return structural;
        }
        // Streaming fallback. Can eat up to 4 GB IO on a long clip - the
        // orchestrator should have decided heavy/light via kind-classification.
        // freeGpsSeedOffsets let streamScanFreeGps start in its predicted-
        // offset jump mode instead of bootstrapping it from a linear walk. The
        // signal is threaded through so a cancelled ingest stops the multi-GB
        // scan promptly instead of running it to completion.
        const streamed = await streamScanFreeGps(file.file, signal, index.freeGpsSeedOffsets, parseBlock);
        if (streamed.records.length === 0 && streamed.skipped.length === 0) {
            throw new WrongFormatError("no freeGPS markers found via streaming scan");
        }
        if (streamed.records.length === 0) {
            throw new WrongFormatError(
                `found ${streamed.skipped.length} freeGPS markers but no variant matched - encrypted or unsupported firmware`,
            );
        }
        removeGravityIncludedAccelBaseline(streamed.records, parseBlock);
        attachLocalClockOffsetHint(streamed, parseBlock, file);
        return streamed;
    },
};

/** Max |filename clock - first synced record| for the local-stamp verdict:
 *  covers a fix acquired minutes into the clip plus RTC drift, while staying
 *  under half a zone-grid step so a real zone gap can never pass. */
const LOCAL_STAMP_NAME_TOLERANCE_SEC = 450;

/**
 * Attaches ParsedRecords.localClockOffsetHintSec when this file proves its
 * record clocks are the camera's LOCAL wall time. Two independent pieces of
 * evidence must agree:
 *
 *  1. The cold-start clock jump (parseBlock.coldStartClockJumpSec): pre-fix
 *     RTC blocks and the first satellite-synced record disagree by a clean
 *     zone-grid step.
 *  2. The filename clock matches the synced records. The filename is written
 *     by the same clock the OSD shows, so agreement means the satellite
 *     stamps run local. Without this gate the opposite firmware - a LOCAL
 *     RTC with honest-UTC satellite stamps - would produce the same jump
 *     with the opposite sign convention, and "correcting" it would corrupt
 *     an already-true-UTC axis.
 *
 * No-op (hint absent) when either piece is missing.
 */
function attachLocalClockOffsetHint(result: ParsedRecords, parseBlock: FreeGpsFileBlockParser, file: VendorFile): void {
    const jumpSec = parseBlock.coldStartClockJumpSec();
    if (jumpSec === null) return;
    const nameDate = classifyFilenameTime(file);
    if (nameDate === null) return;
    let firstSyncedUnix: number | null = null;
    for (const record of result.records) {
        if (record.timeUnsynced !== true) {
            firstSyncedUnix = record.unixSeconds;
            break;
        }
    }
    if (firstSyncedUnix === null) return;
    if (Math.abs(nameDate.getTime() / 1000 - firstSyncedUnix) > LOCAL_STAMP_NAME_TOLERANCE_SEC) return;
    result.localClockOffsetHintSec = jumpSec;
}

/**
 * Some freeGPS variants store gravity-INCLUDED accel (Azdome/EEEkit XOR,
 * confirmed on real Roadgid Tube samples: a constant ~1 g + mount-tilt vector
 * on every record, moving or parked; Vantrue Type-15, whose upstream hexdump
 * shows the same ~1 g), while GpsRecord wants the dynamic component (at rest =
 * 0,0,0). The mount orientation varies per install, so the per-axis mean
 * over the whole file is the gravity estimate (Thinkware/Nextbase
 * precedent) - which is why this runs here after a full parse pass, not
 * per-block. Blocks without an accel group emit exact (0,0,0) - already the
 * "no data" value downstream, so they are excluded from the mean and left
 * untouched. With <2 accel samples the mean cannot separate bias from
 * motion: zero them so a gravity-included ~1 g floor never reaches impact
 * detection (nextbase-subtitle policy). No-op unless one of those variants
 * produced the file's records.
 */
function removeGravityIncludedAccelBaseline(records: GpsRecord[], parseBlock: FreeGpsFileBlockParser): void {
    const claimed = parseBlock.claimedVariantName();
    if (claimed === null || !GRAVITY_INCLUDED_VARIANT_NAMES.has(claimed)) return;
    removeGravityBaselineOrZero(records);
}

// Test-only: this baseline path (unlike the other four subtractAxisMean call
// sites) has no other direct coverage. It owns the WHEN of the gravity removal
// - variant gating, the >=2-sample rule, and the <2 zeroing.
export const _internal = { removeGravityIncludedAccelBaseline };
