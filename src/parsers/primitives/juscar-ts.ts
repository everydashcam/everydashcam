// Juscar TS extractor - MPEG-TS container with a LigoGPS payload in a
// private-data PES (plaintext). Mp4Index is valid for TS files too (first
// 16 MB stored in headerBytes), and `hasLigoGpsMarker` is set there when the
// payload is present. Parsing lives in internal/juscar-ts-extract.ts.
//
// Juscar writes an identical GPS stream into front (F.ts) and rear (R.ts) of
// each pair - cloneAcrossGroup returns key "YYYYMMDD_HHMMSS" without the F/R
// suffix, so the orchestrator parses only the first file of the group and
// copies records onto the second.

import { type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Mp4Index } from "../internal/mp4-index.js";
import { extractJuscarTsGps } from "../internal/juscar-ts-extract.js";
import { findLigoGpsTsPesPid } from "../internal/ligogps-ts-pes.js";
import { looksLikeMpegTs } from "../internal/ts-walk.js";
// Name regex + group key live in clone-groups.ts so the main-thread shard
// planner shares them without importing this (worker-weight) module.
import { juscarTsCloneGroup } from "./clone-groups.js";
import type { Primitive } from "./types.js";

export const juscarTsPrimitive: Primitive = {
    id: "juscar-ts",
    displayName: "Juscar MPEG-TS (LigoGPS plaintext)",
    kind: "video-embedded",

    async marker(_file: VendorFile, index?: Mp4Index): Promise<boolean> {
        // hasLigoGpsMarker in Mp4Index searches "LIGOGPSINFO" in the first
        // 16 MB. Paired MPEG-TS sync bytes replace the old filename gate: a
        // renamed recording remains importable, while MP4 LigoGPS carriers do
        // not enter a full-file TS scan. A verified GPS table at EOF names a
        // trailer camera (Blackview X5S PRO muxes an enciphered LigoGPS PES
        // next to it, so the literal alone cannot tell them apart); its
        // stream never carries plaintext records, and the full-file scan
        // that proves so is pure waste - also on a no-fix clip whose empty
        // table lets the dispatcher walk on to this primitive. The enciphered
        // PES dialect of ligogps-ts-pes is excluded for the same reason: it
        // never carries plaintext either.
        return (
            index?.hasLigoGpsMarker === true &&
            !!index.headerBytes &&
            looksLikeMpegTs(index.headerBytes) &&
            index.tsGpsTrailer == null &&
            findLigoGpsTsPesPid(index.headerBytes) === null
        );
    },

    async parse(file: VendorFile, index?: Mp4Index): Promise<ParsedRecords> {
        if (!index) throw new WrongFormatError("juscar-ts requires Mp4Index");
        return extractJuscarTsGps(file, index);
    },

    cloneAcrossGroup: juscarTsCloneGroup,
};
