import { RX_THINKWARE } from "./_patterns.js";
import type { VendorFile } from "../types.js";
import type { FilenameTechnique } from "./types.js";

// Whether a file's channel opens and closes files on its own schedule rather
// than together with the other channels of its camera. Such a channel's start
// differs from its siblings' by real seconds of footage, so groupTrips aligns
// it by wall clock instead of absorbing the difference as clock-anchor jitter
// between files cut at one moment.

// Thinkware U3000 Pro interior (incabin_rec/EXT_..._I): on the observed card
// it starts 3-8 s after the REC pair, and when REC restarts after an event it
// keeps its own minute boundaries. The name and mvhd share the camera clock.
const thinkwareInteriorCut: FilenameTechnique<boolean> = {
    id: "thinkware-interior-cut",
    extract(file: VendorFile): boolean | null {
        const match = file.file.name.match(RX_THINKWARE);
        return match?.[1]?.toUpperCase() === "EXT" ? true : null;
    },
};

export const FILENAME_INDEPENDENT_CUT: readonly FilenameTechnique<boolean>[] = [thinkwareInteriorCut];
