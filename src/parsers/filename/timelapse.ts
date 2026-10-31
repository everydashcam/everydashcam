// Filename technique: is this a TIME-LAPSE recording? A time-lapse clip captures
// frames far slower than it plays back, so it is time-compressed - its duration
// and the burnt-in clock do NOT track real elapsed wall time (a 2-minute park
// becomes a ~9-second clip). The viewer surfaces this as a badge and marks the
// on-screen clock, because otherwise the displayed time crawls at playback rate
// and misleads.
//
// This is ORTHOGONAL to RecordingMode: a 70mai A510 "LA" clip is BOTH parking
// (mode) AND time-lapse, so it gets its own boolean field rather than a mode
// value. Format-gated on purpose - a GPS-density heuristic
// (fixes-per-video-second) looks tempting but false-positives on genuine
// high-rate GPS (GoPro GPMF logs 10-18 Hz). An explicit marker is authoritative;
// an ambiguous filename family still needs independent container-clock evidence.

import {
    RX_70MAI,
    RX_70MAI_PATH_MODE,
    RX_70MAI_PREFIX_MODE,
    RX_DDPAI_TIMELAPSE,
    RX_GRMN_SEQUENCE,
    RX_GRMN_MODE_PATH,
    matchNovatekNvtMovFilename,
} from "./_patterns.js";
import type { VendorFile } from "../types.js";
import type { FilenameTechnique } from "./types.js";

// 70mai A510 parking time-lapse. Mirrors mai70Mode's LA branch (which folds LA
// into the "parking" mode slot): the "Lapse/" folder on a foldered drop, or the
// LA filename prefix on a flat drop (gated on RX_70MAI so the two-letter prefix
// cannot claim a foreign "LA...mp4").
const mai70Timelapse: FilenameTechnique<boolean> = {
    id: "70mai-timelapse",
    extract(file: VendorFile): boolean | null {
        const pm = file.relativePath.match(RX_70MAI_PATH_MODE);
        // Time-lapse has no exact foreign technique that can override a weak
        // folder guess, so require the distinctive clip shape here.
        if (pm && pm[1]!.toLowerCase() === "lapse" && RX_70MAI.test(file.file.name)) return true;
        if (!RX_70MAI.test(file.file.name)) return null;
        const prefix = file.file.name.match(RX_70MAI_PREFIX_MODE);
        return prefix && prefix[1]!.toUpperCase() === "LA" ? true : null;
    },
};

// DDPai time-lapse parking clips (S_/Q_ name variant, RX_DDPAI_TIMELAPSE).
const ddpaiTimelapse: FilenameTechnique<boolean> = {
    id: "ddpai-timelapse",
    extract(file: VendorFile): boolean | null {
        return RX_DDPAI_TIMELAPSE.test(file.file.name) ? true : null;
    },
};

export const FILENAME_TIMELAPSE: readonly FilenameTechnique<boolean>[] = [
    mai70Timelapse,
    ddpaiTimelapse,
    {
        id: "grmn-timelapse",
        extract(file) {
            if (!RX_GRMN_SEQUENCE.test(file.file.name)) return null;
            return file.relativePath.match(RX_GRMN_MODE_PATH)?.[2]?.toLowerCase() === "tlpse" ? true : null;
        },
    },
];

// A missing mode marker alone is ambiguous on NVT-IM MOV cameras: legacy
// realtime firmware writes the same no-suffix name. This technique therefore
// declares only that the container clocks MAY prove time compression. The
// ingest timing pass makes the actual decision from mvhd-name versus media
// duration and leaves legacy realtime clips unchanged.
const novatekNvtMovClockTimelapse: FilenameTechnique<boolean> = {
    id: "novatek-nvt-mov-clock-timelapse",
    extract(file: VendorFile): boolean | null {
        const match = matchNovatekNvtMovFilename(file.file.name);
        return match && match[5] === "" ? true : null;
    },
};

export const FILENAME_CLOCK_TIMELAPSE: readonly FilenameTechnique<boolean>[] = [novatekNvtMovClockTimelapse];
