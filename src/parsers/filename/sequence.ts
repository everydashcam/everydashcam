// Filename sequence techniques. A sequence number from the filename
// (camera-side counter) is used as a tiebreaker in groupTrips when several
// frames share a snapped startUtc.

import type { VendorFile } from "../types.js";
import {
    RX_70MAI,
    RX_CARCAM,
    RX_DVR_FOUR_CHANNEL,
    RX_DATE_SEQUENCE_CAM,
    RX_DDPAI_EVENT,
    RX_DDPAI_NORMAL,
    RX_DDPAI_TIMELAPSE,
    RX_FITCAMX_MP4,
    RX_MAH_SEQUENCE,
    RX_MOV_SEQ_FRI,
    RX_NAVITEL,
    RX_NEOLINE,
    RX_NEXTBASE,
    RX_NOVATEK_TS,
    RX_NOVATEK_VANTRUE,
    RX_NOVATEK_VIOFO,
    RX_REC_SINGLE,
    RX_REDTIGER,
    RX_TESLA_EVENT_FILENAME,
    RX_TESLA_PATH,
    RX_TESLA_RECENT,
    matchNovatekSingleFilename,
} from "./_patterns.js";
import type { FilenameSequenceTechnique } from "./types.js";

// Tesla cameras have a deterministic id used as the tiebreaker when several
// channels share a timestamp. The mapping mirrors Tesla event.json camera ids.
const TESLA_CAMERA_SEQUENCE: Record<string, number> = {
    front: 0,
    back: 7,
    left_repeater: 3,
    right_repeater: 4,
    left_pillar: 5,
    right_pillar: 6,
    cabin: 8,
};

const mai70Sequence: FilenameSequenceTechnique = {
    id: "70mai-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_70MAI);
        if (!m) return null;
        const counter = m[7];
        // The greedy counter group also swallows the M500 trailing 14-digit
        // wall-clock stamp when no separate counter precedes it (e.g.
        // NO20260429-182640-20260429182640F.mp4 -> "20260429182640"). That is a
        // timestamp, not a camera-side counter - reject it so the tiebreaker
        // never sees a wall-clock value.
        if (counter === undefined || counter.length >= 14) return null;
        const n = Number(counter);
        return Number.isFinite(n) ? n : null;
    },
};

const carcamSequence: FilenameSequenceTechnique = {
    id: "carcam-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_CARCAM);
        return m ? Number(m[3]) : null;
    },
};

const dvrFourChannelSequence: FilenameSequenceTechnique = {
    id: "dvr-four-channel-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_DVR_FOUR_CHANNEL);
        return m ? Number(m[3]) : null;
    },
};

const ddpaiSequence: FilenameSequenceTechnique = {
    id: "ddpai-sequence",
    extract(file: VendorFile): number | null {
        const normal = file.file.name.match(RX_DDPAI_NORMAL);
        if (normal) return Number(normal[2]);
        const tl = file.file.name.match(RX_DDPAI_TIMELAPSE);
        if (tl) return Number(tl[3]);
        const ev = file.file.name.match(RX_DDPAI_EVENT);
        if (ev) return Number(ev[2]);
        return null;
    },
};

const dateSequenceCamSequence: FilenameSequenceTechnique = {
    id: "date-sequence-cam-sequence",
    extract(file: VendorFile): number | null {
        const match = file.file.name.match(RX_DATE_SEQUENCE_CAM);
        return match ? Number(match[2]) : null;
    },
};

const fitcamxSequence: FilenameSequenceTechnique = {
    id: "fitcamx-sequence",
    extract(file: VendorFile): number | null {
        const match = file.file.name.match(RX_FITCAMX_MP4);
        return match ? Number(match[2]) : null;
    },
};

const movSeqFriSequence: FilenameSequenceTechnique = {
    id: "mov-seq-fri-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_MOV_SEQ_FRI);
        return m ? Number(m[2]) : null;
    },
};

const sectionedNmeaSequence: FilenameSequenceTechnique = {
    id: "sectioned-nmea-sequence",
    extract(file: VendorFile): number | null {
        const match = file.file.name.match(RX_MAH_SEQUENCE);
        return match ? Number(match[1]) : null;
    },
};

const navitelSequence: FilenameSequenceTechnique = {
    id: "navitel-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_NAVITEL);
        if (!m) return null;
        const n = Number(m[7]);
        return Number.isFinite(n) ? n : null;
    },
};

const nextbaseSequence: FilenameSequenceTechnique = {
    id: "nextbase-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_NEXTBASE);
        if (!m) return null;
        // 3-digit camera-side counter. Tiebreaker only - it is not part of
        // the frame key in groupTrips, so independent counters across
        // channels are harmless.
        return Number(m[3]);
    },
};

const novatekSequence: FilenameSequenceTechnique = {
    id: "novatek-sequence",
    extract(file: VendorFile): number | null {
        const viofo = file.file.name.match(RX_NOVATEK_VIOFO);
        if (viofo) {
            // The counter group is optional (T130 parking clips and some OEM
            // firmwares drop it) - a missing counter must yield null, not NaN.
            return viofo[4] !== undefined ? Number(viofo[4]) : null;
        }
        const single = matchNovatekSingleFilename(file.file.name);
        if (single) return Number(single[4]);
        const vantrue = file.file.name.match(RX_NOVATEK_VANTRUE);
        if (vantrue) return Number(vantrue[3]);
        return null;
    },
};

const novatekTsSequence: FilenameSequenceTechnique = {
    id: "novatek-ts-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_NOVATEK_TS);
        return m ? Number(m[2]) : null;
    },
};

const neolineSequence: FilenameSequenceTechnique = {
    id: "neoline-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_NEOLINE);
        return m ? Number(m[3]) : null;
    },
};

const recSingleSequence: FilenameSequenceTechnique = {
    id: "rec-single-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_REC_SINGLE);
        return m ? Number(m[3]) : null;
    },
};

const redtigerSequence: FilenameSequenceTechnique = {
    id: "redtiger-sequence",
    extract(file: VendorFile): number | null {
        const m = file.file.name.match(RX_REDTIGER);
        return m ? Number(m[2]) : null;
    },
};

const teslaSequence: FilenameSequenceTechnique = {
    id: "tesla-sequence",
    extract(file: VendorFile): number | null {
        if (!RX_TESLA_PATH.test(file.relativePath.toLowerCase())) return null;
        const recent = file.file.name.match(RX_TESLA_RECENT);
        const evt = file.file.name.match(RX_TESLA_EVENT_FILENAME);
        const camera = recent ? recent[7]!.toLowerCase() : evt ? evt[1]!.toLowerCase() : null;
        if (!camera) return null;
        return TESLA_CAMERA_SEQUENCE[camera] ?? null;
    },
};

export const FILENAME_SEQUENCE: readonly FilenameSequenceTechnique[] = [
    mai70Sequence,
    carcamSequence,
    dvrFourChannelSequence,
    recSingleSequence,
    ddpaiSequence,
    dateSequenceCamSequence,
    fitcamxSequence,
    sectionedNmeaSequence,
    movSeqFriSequence,
    navitelSequence,
    neolineSequence,
    nextbaseSequence,
    novatekSequence,
    novatekTsSequence,
    redtigerSequence,
    teslaSequence,
];
