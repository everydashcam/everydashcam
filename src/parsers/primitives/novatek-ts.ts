// Novatek-TS extractor - MPEG-TS container with the classic Novatek GPS
// record struct in a private-data PES (stream_id 0xbf, PID auto-detected;
// 0x300 on the known samples). Shared by VIOFO, Avylet and COMTEC; filenames
// follow `YYYYMMDDHHMMSS_NNNNNN.TS`.
// Parsing: internal/novatek-ts-extract.ts; format: docs/format-novatek-ts.md.
//
// Marker strategy, two gates in order:
//   1. Content probe over Mp4Index.headerBytes (probeMarkers populates them
//      for TS files too) - renamed files still parse. The GPS PES is absent
//      from the PMT, so the probe looks for the record signature itself, not
//      for PSI.
//   2. Filename-shape fallback: the first GPS PES sits ~1 s of video into
//      the stream (3-4 MB at the observed ~25 Mbps bitrate) and can fall
//      past the probe window on higher-bitrate firmware. For the canonical
//      name we accept on "starts like MPEG-TS" and let parse() self-reject
//      with WrongFormatError (the dispatcher then moves on).

import { RX_NOVATEK_TS } from "../filename/_patterns.js";
import { extractNovatekTsGps, findNovatekTsGpsPid } from "../internal/novatek-ts-extract.js";
import type { Mp4Index } from "../internal/mp4-index.js";
import { looksLikeMpegTs, TS_SIZE } from "../internal/ts-walk.js";
import type { ParsedRecords, VendorFile } from "../types.js";
import type { Primitive } from "./types.js";

export const novatekTsPrimitive: Primitive = {
    id: "novatek-ts",
    displayName: "Novatek GPS in MPEG-TS private PES",
    kind: "video-embedded",

    async marker(file: VendorFile, index?: Mp4Index): Promise<boolean> {
        const headerBytes = index?.headerBytes ?? null;
        // Content gate: a GPS record signature inside the probe window claims
        // the file regardless of its name.
        if (headerBytes && findNovatekTsGpsPid(headerBytes) !== null) return true;
        // Filename fallback for the canonical shape (see file header). Kept
        // regex-first so foreign .ts files never pay even the tiny head read.
        if (!RX_NOVATEK_TS.test(file.file.name)) return false;
        // probeMarkers fills headerBytes with min(4 MB, fileSize), so a short
        // buffer means a short file - a re-read would return the same bytes.
        if (headerBytes) return looksLikeMpegTs(headerBytes);
        // headerBytes absent (marker probe skipped or failed): one 376-byte read.
        const head = new Uint8Array(await file.file.slice(0, 2 * TS_SIZE).arrayBuffer());
        return looksLikeMpegTs(head);
    },

    async parse(file: VendorFile, index?: Mp4Index, signal?: AbortSignal): Promise<ParsedRecords> {
        return extractNovatekTsGps(file, index, signal);
    },
};
