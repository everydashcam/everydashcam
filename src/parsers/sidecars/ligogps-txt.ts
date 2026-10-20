// Plaintext LigoGPS TXT log next to a .TS of the same name: one line per
// second, the unfuzzed twin of the enciphered PES in the video (format and
// evidence: docs/format-ligogps-ts-pes.md). Preferred over that PES because it
// needs no fuzz scale; the embedded probe is skipped once this yields records.

import { parseLigoGpsTextLog } from "../internal/ligogps.js";
import type { GpsRecord, SidecarHandler, VendorFile } from "../types.js";
import { WrongFormatError } from "../types.js";
import { matchByBasename } from "./_basename.js";
import { readSidecarText } from "./_read.js";

const RX_TXT = /\.txt$/i;
/** The record line shape; checked on the head so a large foreign .txt is not read whole. */
const RX_RECORD_HEAD = /^\uFEFF?\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+[NS?]:/;
const HEAD_PROBE_BYTES = 256;

export const ligoGpsTxtSidecar: SidecarHandler = {
    id: "ligogps-txt",
    matches(file: VendorFile, knownVideos: Set<string>): string | null {
        return matchByBasename(file, knownVideos, RX_TXT);
    },
    async parse(file: VendorFile, mp4Filename: string, signal?: AbortSignal): Promise<GpsRecord[]> {
        const head = await readSidecarText(file, signal, HEAD_PROBE_BYTES);
        if (!RX_RECORD_HEAD.test(head)) throw new WrongFormatError("ligogps-txt: first line is not a record");
        return parseLigoGpsTextLog(await readSidecarText(file, signal), mp4Filename);
    },
};
