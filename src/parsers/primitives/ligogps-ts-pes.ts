// Enciphered, fuzzed LigoGPS in an MPEG-TS private PES. Detection and parsing
// live in internal/ligogps-ts-pes.ts; the gate is the exact dialect of the one
// real sample, see there for why it is that narrow.

import { extractLigoGpsTsPes, findLigoGpsTsPesPid } from "../internal/ligogps-ts-pes.js";
import type { Mp4Index } from "../internal/mp4-index.js";
import { type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive } from "./types.js";

export const ligoGpsTsPesPrimitive: Primitive = {
    id: "ligogps-ts-pes",
    displayName: "LigoGPS enciphered PES (MPEG-TS)",
    kind: "video-embedded",

    async marker(_file: VendorFile, index?: Mp4Index): Promise<boolean> {
        // hasLigoGpsMarker already found the literal in the probe; the PMT and
        // chunk-header check below it is in-memory. A file with a plaintext
        // trailer belongs to ligogps-trailer-ts.
        return (
            index?.hasLigoGpsMarker === true &&
            index.tsGpsTrailer == null &&
            !!index.headerBytes &&
            findLigoGpsTsPesPid(index.headerBytes) !== null
        );
    },

    async parse(file: VendorFile, index?: Mp4Index, signal?: AbortSignal): Promise<ParsedRecords> {
        if (!index?.headerBytes) throw new WrongFormatError("ligogps-ts-pes requires Mp4Index header bytes");
        return extractLigoGpsTsPes(file, index.headerBytes, signal);
    },
};
