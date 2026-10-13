// BlackVue X-series GPS box extractor. NMEA payload inside a non-standard
// `gps` box within the top-level `free` box. The real DR900X Plus sample
// verifies the carrier but has no satellite fixes; positive-fix coverage is
// synthetic (see docs/gps-format-coverage.md). Parsing lives in
// internal/free-gps-box-extract.ts.

import { type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Mp4Index } from "../internal/mp4-index.js";
import { tryExtractFreeGpsBox } from "../internal/free-gps-box-extract.js";
import type { Primitive } from "./types.js";

export const freeGpsBoxPrimitive: Primitive = {
    id: "free-gps-box",
    displayName: "BlackVue X-series (gps box in free)",
    kind: "video-embedded",

    async marker(_file: VendorFile, index?: Mp4Index): Promise<boolean> {
        if (!index) return false;
        return index.freeGpsBoxInsideFree !== null;
    },

    async parse(file: VendorFile, index?: Mp4Index): Promise<ParsedRecords> {
        if (!index) throw new WrongFormatError("free-gps-box requires Mp4Index");
        const result = await tryExtractFreeGpsBox(file, index);
        if (!result) throw new WrongFormatError("BlackVue free-gps-box parsed empty");
        return result;
    },
};
