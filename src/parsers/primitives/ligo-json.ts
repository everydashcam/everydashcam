// LigoGPS-JSON extractor (Yada RoadCam Pro 4K 'LigoJSON' + GKU
// __V35AX_QVDATA__). Carrier: a TOP-LEVEL udta atom, usually in trailer
// position after mdat - far outside the headerBytes probe window, which is
// why the marker keys on Mp4Index.topLevelUdtaAtoms heads (dedicated head
// reads made by buildMp4Index) instead of any in-header scan. Every
// file-level udta is checked, so a generic leading udta cannot shadow the
// carrier. Decode lives in internal/ligo-json.ts; deliberately separate from
// the encrypted/'####' ligogps primitive (different carrier, marker, and
// record shape - those files keep routing through the chunk path untouched).
//
// Implemented from foreign source (ExifTool 13.59 LigoGPS.pm:273-281,
// 322-398 + QuickTime.pm:834-847). The GKU carrier has real Type S S403
// fixtures; direct LigoJSON remains foreign-source-only.

import {
    gkuJsonStart,
    hasGkuMarker,
    hasLigoJsonMarker,
    LIGO_JSON_MARKER,
    parseLigoJsonText,
} from "../internal/ligo-json.js";
import type { Mp4Index } from "../internal/mp4-index.js";
import { type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive } from "./types.js";

/**
 * Cap on the JSON window read from the udta payload. Records are chained
 * 512-byte blobs at ~1 Hz, so 4 MB covers ~2.3 h of continuous recording -
 * far beyond any real dashcam segment (1-5 min typical). The cap exists so
 * a corrupt udta size can never pull gigabytes into memory.
 */
const LIGO_JSON_SCAN_CAP = 4 << 20;

const LATIN1 = new TextDecoder("latin1");

export const ligoJsonPrimitive: Primitive = {
    id: "ligo-json",
    displayName: "LigoGPS JSON (Yada RoadCam / GKU)",
    kind: "video-embedded",

    async marker(_file: VendorFile, index?: Mp4Index): Promise<boolean> {
        if (!index) return false;
        return index.topLevelUdtaAtoms.some(
            (udta) => udta.head !== null && (hasLigoJsonMarker(udta.head) || hasGkuMarker(udta.head)),
        );
    },

    async parse(file: VendorFile, index?: Mp4Index): Promise<ParsedRecords> {
        if (!index) throw new WrongFormatError("ligo-json requires Mp4Index");
        // The carrier is the first top-level udta whose head matched - a
        // generic udta earlier in the file is skipped, mirroring marker().
        const udta = index.topLevelUdtaAtoms.find(
            (u) => u.head !== null && (hasLigoJsonMarker(u.head) || hasGkuMarker(u.head)),
        );
        const head = udta?.head;
        if (!udta || !head) throw new WrongFormatError("no top-level udta atom with a ligo json/gku head");

        const payloadSize = udta.size - udta.headerSize;
        let jsonStart = 0;
        if (!hasLigoJsonMarker(head)) {
            // GKU indirection: u32 LE at payload offset 0 points at the JSON
            // start within the payload (LigoGPS.pm:277-279).
            const gku = gkuJsonStart(head);
            if (gku === null) {
                throw new WrongFormatError("udta head carries neither ligo json nor gku signature");
            }
            jsonStart = gku;
        }
        if (jsonStart < 0 || jsonStart + LIGO_JSON_MARKER.length > payloadSize) {
            throw new WrongFormatError("gku json offset outside the udta payload");
        }

        const payloadStart = udta.offset + udta.headerSize;
        const readStart = payloadStart + jsonStart;
        const readEnd = Math.min(udta.offset + udta.size, readStart + LIGO_JSON_SCAN_CAP);
        const window = new Uint8Array(await file.file.slice(readStart, readEnd).arrayBuffer());
        // The 13-byte literal must sit exactly at the JSON start - for GKU
        // this validates the indirection (ProcessGKU does the same check);
        // for the direct form it re-validates the head against the real read.
        if (!hasLigoJsonMarker(window)) {
            throw new WrongFormatError("no LIGOGPSINFO json literal at the resolved offset");
        }

        const parsed = parseLigoJsonText(LATIN1.decode(window), file.file.name);
        if (parsed.records.length === 0 && parsed.skipped.length === 0) {
            // Literal present but not a single record-shaped match - treat as
            // a false positive so other primitives may claim the file.
            throw new WrongFormatError("ligo json literal present but no records found");
        }
        return parsed;
    },
};
