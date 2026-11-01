// Filename recording-mode techniques. One entry = one way to recognise the
// recording mode (normal / event / parking / manual) from filename or path.
// Format-shaped matches outrank unscoped folder heuristics.

import type { RecordingMode, VendorFile } from "../types.js";
import { matchDailyCsvChannelPath } from "../internal/daily-csv-path.js";
import {
    matchModeChannelFolder,
    RX_360_CARDVR_REC_PATH,
    RX_70MAI,
    RX_70MAI_PATH_MODE,
    RX_70MAI_PREFIX_MODE,
    RX_BLACKVUE,
    RX_CARCAM,
    RX_CARCAM_PATH_EVENT,
    RX_CARCAM_PATH_PARKING,
    RX_DATE_SEQUENCE_CAM,
    RX_DATE_SEQUENCE_CAM_PATH,
    RX_DATETIME_CHANNEL_TS,
    RX_DDPAI_EVENT,
    RX_DDPAI_NORMAL,
    RX_DDPAI_TIMELAPSE,
    RX_E_ACE,
    RX_ESCORT_PATH_EVENT,
    RX_ESCORT_PATH_MANUAL,
    RX_ESCORT_PATH_NORMAL,
    RX_FITCAMX,
    RX_FITCAMX_MP4,
    RX_FITCAMX_PATH_EVENT,
    RX_FITCAMX_PATH_NORMAL,
    RX_FORD,
    RX_HPIM,
    RX_GRMN_SEQUENCE,
    RX_GRMN_MODE_PATH,
    RX_IBOX,
    RX_IBOX_PATH_EVENT,
    RX_IBOX_PATH_PARKING,
    RX_JUSCAR,
    RX_JUSCAR_PATH_EVENT,
    RX_JUSCAR_PATH_VIDEO,
    RX_MIVUE,
    RX_MIVUE_PATH_MODE,
    RX_NOVATEK_PATH_RO,
    RX_NOVATEK_TS,
    RX_NOVATEK_VANTRUE,
    RX_NOVATEK_VIOFO,
    RX_REC_SINGLE,
    RX_REC_SINGLE_PATH_CHANNEL,
    RX_REDTIGER,
    RX_REDTIGER_PATH_MODE,
    RX_TESLA_PATH,
    RX_TESLA_PATH_RECENT,
    RX_TESLA_PATH_SAVED,
    RX_TESLA_PATH_SENTRY,
    RX_THINKWARE,
    RX_VUEROID,
    RX_VUEROID_PATH_MODE,
    RX_WOLFBOX,
    RX_WOLFBOX_PATH_EVENT,
    RX_WOLFBOX_PATH_NORMAL,
    matchNovatekSingleFilename,
} from "./_patterns.js";
import { channelFromFolder } from "./channel-folder.js";
import type { FilenameModeTechnique } from "./types.js";

const mai70Mode: FilenameModeTechnique = {
    id: "70mai-mode",
    evidence: (file) => (RX_70MAI.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): RecordingMode | null {
        // Path wins over the filename prefix: the folder layout carries manual,
        // which no filename prefix does. A foldered drop keeps that granularity,
        // and the two signals agree anyway (an event clip is both EV-prefixed
        // and stored under Event/).
        const pm = file.relativePath.match(RX_70MAI_PATH_MODE);
        if (pm) {
            switch (pm[1]!.toLowerCase()) {
                case "normal":
                    return "normal";
                case "event":
                    return "event";
                case "lapse":
                    return "parking";
                case "manual":
                    return "manual";
                // "parking" (A810: Parking/ holds PA g-sensor captures) falls
                // through to the prefix branch on purpose: the prefix is more
                // precise than the folder (PA = parked incident -> event,
                // mirroring the flat-drop mapping below).
            }
        }
        // Flat drop (user copied files out of their folders): recover the mode
        // from the filename prefix. Gate on RX_70MAI so only real 70mai names
        // are read - the prefix regex alone would claim "NOTES.mp4".
        if (!RX_70MAI.test(file.file.name)) return null;
        const prefix = file.file.name.match(RX_70MAI_PREFIX_MODE);
        if (!prefix) return null;
        switch (prefix[1]!.toUpperCase()) {
            case "EV":
            case "VL":
                return "event";
            case "LA":
                // A510 parking timelapse - the same slot the Lapse/ folder maps
                // to above, so foldered and flat drops agree.
                return "parking";
            case "PA":
                // A510 parking g-sensor/motion capture: an incident that fired
                // while parked. It mirrors EV -> event rather than "parking" -
                // the clip marks an incident, not the background parking loop
                // (that is LA's slot).
                return "event";
            default:
                return "normal"; // NO
        }
    },
};

const blackvueMode: FilenameModeTechnique = {
    id: "blackvue-mode",
    extract(file: VendorFile): RecordingMode | null {
        const m = file.file.name.match(RX_BLACKVUE);
        if (!m) return null;
        switch (m[3]!.toUpperCase()) {
            case "N":
                return "normal";
            case "E":
                return "event";
            case "P":
                return "parking";
            case "M":
                return "manual";
            default:
                return null;
        }
    },
};

const carcamMode: FilenameModeTechnique = {
    id: "carcam-mode",
    evidence: (file) => (RX_CARCAM.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): RecordingMode | null {
        const lower = file.relativePath.toLowerCase();
        if (RX_CARCAM_PATH_EVENT.test(lower)) return "event";
        if (RX_CARCAM_PATH_PARKING.test(lower)) return "parking";
        if (RX_CARCAM.test(file.file.name)) return "normal";
        return null;
    },
};

const recSingleMode: FilenameModeTechnique = {
    id: "rec-single-mode",
    extract(file: VendorFile): RecordingMode | null {
        if (!RX_REC_SINGLE.test(file.file.name)) return null;
        const prefix = file.file.name.slice(0, 3).toUpperCase();
        if (prefix === "SOS") return "event";
        if (prefix === "PAR") return "parking";
        // REC is shared by unrelated firmwares; only the card layout provides
        // a mode when the name has no explicit event or parking prefix.
        const path = file.relativePath.match(RX_REC_SINGLE_PATH_CHANNEL);
        switch (path?.[1]?.toLowerCase()) {
            case "normal":
                return "normal";
            case "event":
                return "event";
            case "parking":
                return "parking";
            default:
                return null;
        }
    },
};

function timestampFolderMode(file: VendorFile): RecordingMode | null {
    const segments = file.relativePath.split("/").filter((segment) => segment.length > 0);
    const parent = segments.at(-2);
    // Only a channel leaf can separate the mode folder from its recording.
    const folder = (channelFromFolder(parent) === null ? parent : segments.at(-3))?.toLowerCase();
    switch (folder) {
        case "normal":
        case "video":
            return "normal";
        case "event":
            return "event";
        case "parking":
            return "parking";
        case "manual":
        case "favorites":
            return "manual";
        default:
            return null;
    }
}

const ddpaiMode: FilenameModeTechnique = {
    id: "ddpai-mode",
    extract(file: VendorFile): RecordingMode | null {
        const daily = matchDailyCsvChannelPath(file.relativePath);
        if (daily) return daily.mode;
        if (RX_DDPAI_TIMELAPSE.test(file.file.name)) return "parking";
        const ev = file.file.name.match(RX_DDPAI_EVENT);
        if (ev) return ev[3]!.toUpperCase() === "X" ? "parking" : "event";
        if (RX_DDPAI_NORMAL.test(file.file.name)) {
            return timestampFolderMode(file) ?? "normal";
        }
        return null;
    },
};

const eaceMode: FilenameModeTechnique = {
    id: "e-ace-mode",
    extract(file: VendorFile): RecordingMode | null {
        if (!RX_E_ACE.test(file.file.name)) return null;
        const folder = matchModeChannelFolder(file.relativePath);
        if (folder) return folder[1]!.toLowerCase() === "event" ? "event" : "normal";
        return timestampFolderMode(file) ?? "normal";
    },
};

// GKU `_GAP_` time-lapse runs for hours between drives on the real card, so it
// is the parking loop. The other clips must read as normal, not unknown: an
// unknown mode defines no trip class, and the drive next to a parking session
// would then glue into it.
const datetimeChannelTsMode: FilenameModeTechnique = {
    id: "datetime-channel-ts-mode",
    extract(file: VendorFile): RecordingMode | null {
        const m = file.file.name.match(RX_DATETIME_CHANNEL_TS);
        if (!m) return null;
        if (m[3]) return "parking";
        return matchModeChannelFolder(file.relativePath)?.[1]?.toLowerCase() === "event" ? "event" : "normal";
    },
};

const escortMode: FilenameModeTechnique = {
    id: "escort-mode",
    evidence: () => "heuristic",
    extract(file: VendorFile): RecordingMode | null {
        const path = file.relativePath;
        if (RX_ESCORT_PATH_EVENT.test(path)) return "event";
        if (RX_ESCORT_PATH_MANUAL.test(path)) return "manual";
        if (RX_ESCORT_PATH_NORMAL.test(path)) return "normal";
        return null;
    },
};

const dateSequenceCamMode: FilenameModeTechnique = {
    id: "date-sequence-cam-mode",
    extract(file: VendorFile): RecordingMode | null {
        if (!RX_DATE_SEQUENCE_CAM.test(file.file.name)) return null;
        const mode = file.relativePath.match(RX_DATE_SEQUENCE_CAM_PATH)?.[1]?.toLowerCase();
        if (mode === "normal") return "normal";
        if (mode === "event") return "event";
        if (mode === "favorites") return "manual";
        return null;
    },
};

const fitcamxMode: FilenameModeTechnique = {
    id: "fitcamx-mode",
    extract(file: VendorFile): RecordingMode | null {
        // Name gate: a bare Movie|EMR path claim would label other formats'
        // files that happen to sit in same-named folders (see fitcamx-channel).
        if (!RX_FITCAMX.test(file.file.name) && !RX_FITCAMX_MP4.test(file.file.name)) return null;
        const path = file.relativePath;
        if (RX_360_CARDVR_REC_PATH.test(path)) return "normal";
        if (RX_FITCAMX_PATH_EVENT.test(path)) return "event";
        if (RX_FITCAMX_PATH_NORMAL.test(path)) return "normal";
        return null;
    },
};

const fordMode: FilenameModeTechnique = {
    id: "ford-mode",
    extract(file: VendorFile): RecordingMode | null {
        // Single-mode in the corpus - normal recording only (no event/parking
        // marker in the name). Assert "normal" on a name match, like the other
        // single-mode name-only families (e-ace, carcam, ibox), so Ford clips
        // carry a mode instead of null. Event/parking modes are unknown; revisit
        // if a sample with one surfaces.
        return RX_FORD.test(file.file.name) ? "normal" : null;
    },
};

const iboxMode: FilenameModeTechnique = {
    id: "ibox-mode",
    evidence: (file) => (RX_IBOX.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): RecordingMode | null {
        const lower = file.relativePath.toLowerCase();
        if (RX_IBOX_PATH_EVENT.test(lower)) return "event";
        if (RX_IBOX_PATH_PARKING.test(lower)) return "parking";
        return RX_IBOX.test(file.file.name) ? "normal" : null;
    },
};

const juscarMode: FilenameModeTechnique = {
    id: "juscar-mode",
    evidence: (file) => (RX_JUSCAR.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): RecordingMode | null {
        const match = file.file.name.match(RX_JUSCAR);
        if (match?.[4]?.toUpperCase() === "SOS") return "event";
        if (match?.[4]?.toUpperCase() === "PARK") return "parking";
        const path = file.relativePath;
        if (RX_JUSCAR_PATH_EVENT.test(path)) return "event";
        if (RX_JUSCAR_PATH_VIDEO.test(path) || match) return "normal";
        return null;
    },
};

const mivueMode: FilenameModeTechnique = {
    id: "mivue-mode",
    extract(file: VendorFile): RecordingMode | null {
        // Name gate first: the Normal/Event/Parking folder names are generic and
        // must not claim foreign files on the path alone.
        if (!RX_MIVUE.test(file.file.name)) return null;
        const m = file.relativePath.match(RX_MIVUE_PATH_MODE);
        if (m) {
            switch (m[1]!.toLowerCase()) {
                case "event":
                    return "event";
                case "parking":
                    return "parking";
                case "normal":
                    return "normal";
            }
        }
        // MiVue name but no mode folder (flat drop) - loop recordings are the
        // bulk, so default to normal like the other single-mode FILE-named
        // families (ibox, ford).
        return "normal";
    },
};

const hpimMode: FilenameModeTechnique = {
    id: "hpim-mode",
    extract(file: VendorFile): RecordingMode | null {
        // Name gate first - the mode folder names are generic (see mivue-mode).
        if (!RX_HPIM.test(file.file.name)) return null;
        // Same Normal/Event/Parking folder language as MiVue; Normal/ is
        // corpus-confirmed, the other two are the standard CarDV set.
        const m = file.relativePath.match(RX_MIVUE_PATH_MODE);
        if (m) {
            switch (m[1]!.toLowerCase()) {
                case "event":
                    return "event";
                case "parking":
                    return "parking";
                case "normal":
                    return "normal";
            }
        }
        // Flat drop: loop recordings are the bulk (the mivue rationale).
        return "normal";
    },
};

const novatekMode: FilenameModeTechnique = {
    id: "novatek-mode",
    extract(file: VendorFile): RecordingMode | null {
        // Locked clips (g-sensor or manual lock) are MOVED by firmware into
        // DCIM/Movie/RO/ with unchanged filenames - the lock is not inferable
        // from the name (viofosync web/services/scanner.py:57-63; a119_join.py
        // ingests the same RO subdir on single-channel A119). "event" is the
        // closest RecordingMode for "protected", matching the iBox/Juscar/
        // CarCam protected-folder convention; a manual lock lands there too -
        // indistinguishable. The Novatek name gate keeps the short "ro"
        // segment from claiming foreign files.
        const viofo = file.file.name.match(RX_NOVATEK_VIOFO);
        if (viofo) {
            if (RX_NOVATEK_PATH_RO.test(file.relativePath)) return "event";
            // Mode letter: P = parking, E = impact event, "" (the optional
            // group captures an empty string, never undefined) = normal
            // driving (viofosync web/services/scanner.py:48-66).
            switch (viofo[5]!.toUpperCase()) {
                case "P":
                    return "parking";
                case "E":
                    return "event";
                default:
                    return "normal";
            }
        }
        if (matchNovatekSingleFilename(file.file.name)) {
            return RX_NOVATEK_PATH_RO.test(file.relativePath) ? "event" : "normal";
        }
        if (RX_NOVATEK_TS.test(file.file.name)) {
            return RX_NOVATEK_PATH_RO.test(file.relativePath) ? "event" : "normal";
        }
        const vantrue = file.file.name.match(RX_NOVATEK_VANTRUE);
        if (vantrue) {
            switch (vantrue[4]!.toUpperCase()) {
                case "N":
                    return "normal";
                case "E":
                    return "event";
                case "P":
                    return "parking";
                default:
                    return null;
            }
        }
        return null;
    },
};

const redtigerMode: FilenameModeTechnique = {
    id: "redtiger-mode",
    extract(file: VendorFile): RecordingMode | null {
        // Name gate first - a `<mode>_f/` folder alone must not claim foreign
        // files (the mivue-mode rationale).
        if (!RX_REDTIGER.test(file.file.name)) return null;
        const m = file.relativePath.match(RX_REDTIGER_PATH_MODE);
        if (m) {
            switch (m[1]!.toLowerCase()) {
                case "movie":
                    return "normal";
                case "event":
                    return "event";
                case "parking":
                    // Movie/Event are corpus-confirmed; Parking is the
                    // conventional CarDV third (the hpim precedent).
                    return "parking";
            }
        }
        // Flat drop: loop recordings are the bulk (the mivue rationale).
        return "normal";
    },
};

const vueroidMode: FilenameModeTechnique = {
    id: "vueroid-mode",
    extract(file: VendorFile): RecordingMode | null {
        const m = file.file.name.match(RX_VUEROID);
        if (!m) return null;
        // The documented card folder distinguishes manual and parked-impact
        // recordings; the unverified E/P suffix meanings are only a fallback.
        const folder = file.relativePath.match(RX_VUEROID_PATH_MODE)?.[1]?.toLowerCase();
        switch (folder) {
            case "inf":
                return "normal";
            case "event":
            case "pevent":
                return "event";
            case "park":
                return "parking";
            case "user":
                return "manual";
        }
        // N = normal is real-sample-validated; E = event and P = parking are
        // assumed from the mnemonic (no E/P sample in the corpus yet).
        switch (m[4]!.toUpperCase()) {
            case "N":
                return "normal";
            case "E":
                return "event";
            case "P":
                return "parking";
            default:
                return null;
        }
    },
};

const teslaMode: FilenameModeTechnique = {
    id: "tesla-mode",
    extract(file: VendorFile): RecordingMode | null {
        const lower = file.relativePath.toLowerCase();
        if (!RX_TESLA_PATH.test(lower)) return null;
        if (RX_TESLA_PATH_RECENT.test(lower)) return "normal";
        if (RX_TESLA_PATH_SAVED.test(lower)) return "manual";
        if (RX_TESLA_PATH_SENTRY.test(lower)) return "event";
        return null;
    },
};

const thinkwareMode: FilenameModeTechnique = {
    id: "thinkware-mode",
    extract(file: VendorFile): RecordingMode | null {
        const m = file.file.name.match(RX_THINKWARE);
        if (!m) return null;
        switch (m[1]!.toUpperCase()) {
            case "REC":
                return "normal";
            case "EVT":
                return "event";
            case "PARK":
                return "parking";
            case "MAN":
                return "manual";
            default:
                return null;
        }
    },
};

const wolfboxMode: FilenameModeTechnique = {
    id: "wolfbox-mode",
    evidence(file) {
        const m = file.file.name.match(RX_WOLFBOX);
        return m && (m[5] === "00" || m[5] === "02") ? "specific" : "heuristic";
    },
    extract(file: VendorFile): RecordingMode | null {
        const m = file.file.name.match(RX_WOLFBOX);
        if (m) {
            // EE event code: 00 = normal loop, 02 = g-sensor event. Other
            // values exist in the wild but their meaning is unconfirmed -
            // fall through to the folder signal instead of guessing.
            const ee = m[5]!;
            if (ee === "00") return "normal";
            if (ee === "02") return "event";
        }
        const path = file.relativePath;
        if (RX_WOLFBOX_PATH_EVENT.test(path)) return "event";
        if (RX_WOLFBOX_PATH_NORMAL.test(path)) return "normal";
        return null;
    },
};

export const FILENAME_MODE: readonly FilenameModeTechnique[] = [
    {
        id: "grmn-mode",
        extract(file) {
            if (!RX_GRMN_SEQUENCE.test(file.file.name)) return null;
            switch (file.relativePath.match(RX_GRMN_MODE_PATH)?.[2]?.toLowerCase()) {
                case "event":
                    return "event";
                case "saved":
                    return "manual";
                case "parkm":
                    return "parking";
                case "tlpse":
                case "unsvd":
                    return "normal";
                default:
                    return null;
            }
        },
    },
    // Keep exact filename families first for stable diagnostics. The unscoped
    // path branches below are marked heuristic, so they remain useful for
    // renamed files without shadowing a later exact filename.
    mivueMode,
    vueroidMode,
    hpimMode,
    mai70Mode,
    blackvueMode,
    carcamMode,
    recSingleMode,
    ddpaiMode,
    eaceMode,
    datetimeChannelTsMode,
    escortMode,
    dateSequenceCamMode,
    // novatek-mode precedes fitcamx-mode so the mnemonic P/E letter and the
    // Movie/RO/ lock folder stay authoritative regardless of walk changes;
    // fitcamx's Movie|EMR path claim is additionally name-gated, so it cannot
    // reach Viofo clips under DCIM/Movie/ at all. Mirrors FILENAME_CHANNEL,
    // where the novatek* techniques already precede fitcamx. Safe: novatek
    // regexes are name-gated and cannot match FitCamX names.
    novatekMode,
    fitcamxMode,
    fordMode,
    iboxMode,
    juscarMode,
    redtigerMode,
    teslaMode,
    thinkwareMode,
    wolfboxMode,
];
