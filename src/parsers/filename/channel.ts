// Filename channel techniques. One entry = one way to map filename/path to a
// ChannelMatch ({ channel, confident }). Format-shaped matches outrank
// unscoped folder heuristics.
//
// Many techniques look at a single capital letter just before the extension;
// the mapping (F=front, B=rear vs F=front, R=rear) differs per family, so
// they live as distinct entries.
//
// `confident` separates two kinds of letters (see ChannelMatch doc):
//   - mnemonic (F=front, R=rear, B=back, I=interior) under a vendor-specific
//     name pattern, or a spelled-out path/folder, or a single-channel model
//     -> confident (UI shows "Rear camera").
//   - index letters whose mapping is a pure vendor convention (CarCam A/B/C/D,
//     Vantrue A/B/C where B=cabin) -> not confident (UI shows "Channel N").

import type { Channel, VendorFile } from "../types.js";
import {
    RX_DATETIME_CHANNEL_TS,
    RX_70MAI,
    RX_70MAI_PATH_CHANNEL,
    RX_BEFERICH,
    RX_BLACKVUE,
    RX_CARCAM,
    RX_DVR_FOUR_CHANNEL,
    RX_CARCAM_PATH_FRONT,
    RX_CARCAM_PATH_INTERIOR,
    RX_CARCAM_PATH_REAR,
    RX_CARCAM_PATH_SIDE,
    RX_DATE_SEQUENCE_CAM,
    RX_DATE_SEQUENCE_CAM_PATH,
    RX_DDPAI_EVENT,
    RX_DDPAI_NORMAL,
    RX_DDPAI_TIMELAPSE,
    RX_E_ACE,
    RX_FITCAMX,
    RX_FITCAMX_MP4,
    RX_FITCAMX_PATH_FRONT,
    RX_FITCAMX_PATH_REAR,
    RX_FORD,
    RX_HPIM,
    RX_IBOX,
    RX_JUSCAR,
    RX_JUSCAR_PATH_FRONT,
    RX_JUSCAR_PATH_REAR,
    RX_LIGOGPS_TRAILER_TS,
    RX_MOV_SEQ_FRI,
    RX_NAVITEL,
    RX_NEOLINE,
    RX_NEXTBASE,
    RX_NOVATEK_VANTRUE,
    RX_NOVATEK_VIOFO,
    RX_REDTIGER,
    RX_REC_SINGLE,
    RX_REC_SINGLE_PATH_CHANNEL,
    RX_SEI_DOUBLE_GPS,
    RX_SEI_DOUBLE_GPS_PATH,
    RX_SSTAR_CHN,
    RX_TESLA_EVENT_FILENAME,
    RX_TESLA_PATH,
    RX_TESLA_RECENT,
    RX_THINKWARE,
    RX_VUEROID,
    RX_WOLFBOX,
    RX_WOLFBOX_PATH_FRONT,
    RX_WOLFBOX_PATH_INTERIOR,
    RX_WOLFBOX_PATH_REAR,
    matchNovatekSingleFilename,
} from "./_patterns.js";
import type { ChannelMatch, FilenameChannelTechnique } from "./types.js";

// Trustworthy mount: vendor-specific mnemonic letter, spelled-out path, or
// single-channel model. UI shows the semantic label.
const sure = (channel: Channel): ChannelMatch => ({ channel, confident: true });
// Best-effort mount from an index letter (A/B/C/D) - used for layout/grouping,
// but the UI shows a positional "Channel N" label instead of asserting a mount.
const guess = (channel: Channel): ChannelMatch => ({ channel, confident: false });

// A new suffix still identifies another stream; use the spare slot without
// claiming its physical mount until a sample establishes the letter's meaning.
function mnemonicChannel(letter: string): ChannelMatch {
    switch (letter.toUpperCase()) {
        case "F":
            return sure("front");
        case "R":
            return sure("rear");
        case "I":
            return sure("interior");
        case "B":
            return guess("rear");
        case "C":
            return guess("interior");
        default:
            return guess("side");
    }
}

const mai70Channel: FilenameChannelTechnique = {
    id: "70mai-channel",
    evidence: (file) => (RX_70MAI.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_70MAI);
        let unknownSuffix: string | null = null;
        if (m) {
            // The letter sits either before the trailing 14-digit stamp (m[8],
            // app-export shape) or at the very end (m[9]); one file carries at
            // most one of the two.
            const suffix = m[8] ?? m[9];
            if (suffix !== undefined) {
                const ch = suffix.toUpperCase();
                if (ch === "F") return sure("front");
                if (ch === "B" || ch === "R") return sure("rear");
                if (ch === "I" || ch === "C") return sure("interior");
                unknownSuffix = ch;
            }
        }
        // Multi-channel S500/A810/T800 use Normal/Front, Normal/Back, Normal/Interior.
        const pm = file.relativePath.match(RX_70MAI_PATH_CHANNEL);
        if (pm) {
            const folder = pm[1]!.toLowerCase();
            if (folder === "front") return sure("front");
            if (folder === "back") return sure("rear");
            if (folder === "interior") return sure("interior");
        }
        return unknownSuffix ? mnemonicChannel(unknownSuffix) : null;
    },
};

const beferichChannel: FilenameChannelTechnique = {
    id: "beferich-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_BEFERICH);
        if (!m) return null;
        // `f` = front is confirmed on real J18 samples. The rest of the map is
        // the ford-channel rationale verbatim: standard mnemonics for r/b/i
        // (the dual-channel firmware is expected to suffix the rear `r`), any
        // other letter goes to the FREE "side" slot as a guess so it still
        // pairs with front in one frame without colliding with a real rear.
        switch (m[7]!.toLowerCase()) {
            case "f":
                return sure("front");
            case "r":
            case "b":
                return sure("rear");
            case "i":
                return sure("interior");
            case "c":
                return guess("interior");
            default:
                return guess("side");
        }
    },
};

const blackvueChannel: FilenameChannelTechnique = {
    id: "blackvue-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_BLACKVUE);
        if (!m) return null;
        return mnemonicChannel(m[4]!);
    },
};

const dateSequenceCamChannel: FilenameChannelTechnique = {
    id: "date-sequence-cam-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const match = file.file.name.match(RX_DATE_SEQUENCE_CAM);
        if (!match) return null;
        const path = file.relativePath.match(RX_DATE_SEQUENCE_CAM_PATH);
        if (path) return sure(path[2]!.toLowerCase() === "front" ? "front" : "rear");
        if (match[3] === "1") return sure("front");
        if (match[3] === "2") return guess("rear");
        return null;
    },
};

const carcamChannel: FilenameChannelTechnique = {
    id: "carcam-channel",
    evidence: (file) => (RX_CARCAM.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_CARCAM);
        if (m) {
            // A/B/C/D are index letters: the mount mapping is CarCam's own
            // convention, not a mnemonic. Use it for layout, but don't assert it.
            switch (m[4]!.toUpperCase()) {
                case "A":
                    return guess("front");
                case "B":
                    return guess("rear");
                case "C":
                    return guess("interior");
                case "D":
                    return guess("side");
            }
        }
        // Path-based fallback: Normal/A/, Normal/B/, ... - the vendor laid the
        // files out in named folders, a deliberate signal we trust.
        const lower = file.relativePath.toLowerCase();
        if (RX_CARCAM_PATH_FRONT.test(lower)) return sure("front");
        if (RX_CARCAM_PATH_REAR.test(lower)) return sure("rear");
        if (RX_CARCAM_PATH_INTERIOR.test(lower)) return sure("interior");
        if (RX_CARCAM_PATH_SIDE.test(lower)) return sure("side");
        return m ? guess("side") : null;
    },
};

const dvrFourChannel: FilenameChannelTechnique = {
    id: "dvr-four-channel-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_DVR_FOUR_CHANNEL);
        if (!m) return null;
        switch (m[4]!.toLowerCase()) {
            case "front":
                return sure("front");
            case "back":
                return sure("rear");
            case "left":
                return sure("interior");
            case "right":
                return sure("side");
            default:
                return null;
        }
    },
};

const recSingleChannel: FilenameChannelTechnique = {
    id: "rec-single-channel",
    extract(file: VendorFile): ChannelMatch | null {
        if (!RX_REC_SINGLE.test(file.file.name)) return null;
        const channelPath = file.relativePath.match(RX_REC_SINGLE_PATH_CHANNEL);
        if (channelPath) {
            const letter = channelPath[2]!.toUpperCase();
            if (letter === "A") return guess("front");
            if (letter === "B") return guess("rear");
            return mnemonicChannel(letter);
        }
        // iZEEKER separates same-named channels into Normal/A and Normal/B.
        // The letters are positional indices, so keep the mount labels
        // unconfirmed while still assigning distinct channel slots.
        const lower = file.relativePath.toLowerCase();
        if (RX_CARCAM_PATH_FRONT.test(lower)) return guess("front");
        if (RX_CARCAM_PATH_REAR.test(lower)) return guess("rear");
        return null;
    },
};

const seiDoubleGpsChannel: FilenameChannelTechnique = {
    id: "sei-double-gps-channel",
    extract(file: VendorFile): ChannelMatch | null {
        if (!RX_SEI_DOUBLE_GPS.test(file.file.name)) return null;
        const path = file.relativePath.match(RX_SEI_DOUBLE_GPS_PATH);
        if (!path) return null;
        return sure(path[1]!.toLowerCase() === "internalview" ? "interior" : "front");
    },
};

const sstarChnChannel: FilenameChannelTechnique = {
    id: "sstar-chn-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_SSTAR_CHN);
        if (!m) return null;
        // CH1/CH2/CH3(/CH4) are index markers (SigmaStar reference-design
        // naming), not mnemonics - the mount mapping is a best guess, so the UI
        // shows a positional "Channel N" label until confirmed. CH1 is the
        // high-bitrate main lens (front); the CH2/CH3 order (rear vs cabin) is
        // unverified. Same treatment as CarCam A/B/C/D.
        switch (m[1]) {
            case "1":
                return guess("front");
            case "2":
                return guess("rear");
            case "3":
                return guess("interior");
            case "4":
                return guess("side");
        }
        return null;
    },
};

const ddpaiChannel: FilenameChannelTechnique = {
    id: "ddpai-channel",
    evidence: (file) =>
        RX_DDPAI_NORMAL.test(file.file.name) ||
        RX_DDPAI_TIMELAPSE.test(file.file.name) ||
        RX_DDPAI_EVENT.test(file.file.name)
            ? "specific"
            : "heuristic",
    extract(file: VendorFile): ChannelMatch | null {
        // A=rear is a DDPai convention (not a mnemonic), and RX_DDPAI_NORMAL is
        // a generic timestamp pattern, so the mount is a guess. Same for the
        // S/Q timelapse letters and the event default-to-front.
        const normal = file.file.name.match(RX_DDPAI_NORMAL);
        if (normal) {
            const suffix = normal[3]?.toUpperCase();
            if (!suffix) return guess("front");
            if (suffix === "A") return guess("rear");
            if (suffix === "F") return guess("front");
            return mnemonicChannel(suffix);
        }
        const tl = file.file.name.match(RX_DDPAI_TIMELAPSE);
        if (tl) return tl[1]!.toUpperCase() === "Q" ? guess("rear") : guess("front");
        const ev = file.file.name.match(RX_DDPAI_EVENT);
        if (ev) return guess("front");
        // Path-based fallback for 3-channel models (Z90 Master 3CH) - spelled-out folders.
        const lower = file.relativePath.toLowerCase();
        if (lower.includes("/front/")) return sure("front");
        if (lower.includes("/rear/")) return sure("rear");
        if (lower.includes("/inside/")) return sure("interior");
        return null;
    },
};

const eaceChannel: FilenameChannelTechnique = {
    id: "e-ace-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_E_ACE);
        if (!m) return null;
        const ch = m[3];
        if (ch) return mnemonicChannel(ch);
        // No suffix - single-channel model; grouper assigns default 'front'.
        return null;
    },
};

const fitcamxChannel: FilenameChannelTechnique = {
    id: "fitcamx-channel",
    extract(file: VendorFile): ChannelMatch | null {
        // MP4 variant: channel is the middle letter of the 3-letter suffix.
        // A/B is an index convention (both channels share one folder), not a mnemonic
        // -> guess, so the pair still lands in one frame but the UI shows a
        // positional label instead of asserting a mount.
        const mp4 = file.file.name.match(RX_FITCAMX_MP4);
        if (mp4) {
            switch (mp4[3]!.toUpperCase()) {
                case "A":
                    return guess("front");
                case "B":
                    return guess("rear");
                case "C":
                    return guess("interior");
                default:
                    return guess("side");
            }
        }
        // .ts variant: channel comes from the Movie|EMR vs Movie_E|EMR_E folder
        // pair. The name gate is load-bearing: a bare path claim would mark ANY
        // file inside an EMR/ or Movie/ folder sure("front"), including other
        // formats' rear files, and break their channel pairing.
        if (!RX_FITCAMX.test(file.file.name)) return null;
        const path = file.relativePath;
        if (RX_FITCAMX_PATH_REAR.test(path)) return sure("rear");
        if (RX_FITCAMX_PATH_FRONT.test(path)) return sure("front");
        return null;
    },
};

const ligoGpsTrailerTsChannel: FilenameChannelTechnique = {
    id: "ligogps-trailer-ts-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_LIGOGPS_TRAILER_TS);
        if (!m) return null;
        return mnemonicChannel(m[3]!);
    },
};

const fordChannel: FilenameChannelTechnique = {
    id: "ford-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_FORD);
        if (!m) return null;
        // `f` = front is confirmed on a real sample. The other channels are
        // unconfirmed (front-only corpus): map the standard mnemonics, and treat
        // any other letter as a distinct non-front channel so it pairs with front
        // in one frame (same fingerprint, see ford-camera-key) instead of
        // defaulting to "front". An unknown letter goes to the FREE "side" slot,
        // NOT "rear": the confident mnemonics already own front/rear/interior, so
        // "rear" would collide with a real `_r`/`_b` in the same frame and spawn a
        // |dupN split (and demote the confirmed rear's label - finalizeTrip in
        // trips.ts treats a guessed channel as not-confident). Same reasoning as
        // novatek-viofo (T -> side) and nextbase (B -> interior). Guessed mount
        // -> positional UI label regardless of the slot.
        switch (m[7]!.toLowerCase()) {
            case "f":
                return sure("front");
            case "r":
            case "b":
                return sure("rear");
            case "i":
                return sure("interior");
            case "c":
                return guess("interior");
            default:
                return guess("side");
        }
    },
};

const hpimChannel: FilenameChannelTechnique = {
    id: "hpim-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_HPIM);
        if (!m) return null;
        // `f` = front is corpus-confirmed. The other letters follow the ford
        // rationale: standard mnemonics for r/b/i, any other letter goes to
        // the FREE "side" slot as a guess so it still pairs with front in one
        // frame without colliding with a real rear.
        switch (m[3]!.toLowerCase()) {
            case "f":
                return sure("front");
            case "r":
            case "b":
                return sure("rear");
            case "i":
                return sure("interior");
            case "c":
                return guess("interior");
            default:
                return guess("side");
        }
    },
};

const iboxChannel: FilenameChannelTechnique = {
    id: "ibox-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_IBOX);
        if (!m) return null;
        return mnemonicChannel(m[5]!);
    },
};

const juscarChannel: FilenameChannelTechnique = {
    id: "juscar-channel",
    evidence: (file) => (RX_JUSCAR.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_JUSCAR);
        const known = m ? mnemonicChannel(m[3]!) : null;
        if (known?.confident) return known;
        const path = file.relativePath;
        if (RX_JUSCAR_PATH_REAR.test(path)) return sure("rear");
        if (RX_JUSCAR_PATH_FRONT.test(path)) return sure("front");
        return known;
    },
};

const neolineChannel: FilenameChannelTechnique = {
    id: "neoline-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_NEOLINE);
        if (!m) return null;
        return mnemonicChannel(m[4]!);
    },
};

const vueroidChannel: FilenameChannelTechnique = {
    id: "vueroid-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_VUEROID);
        if (!m) return null;
        return mnemonicChannel(m[3]!);
    },
};

const navitelChannel: FilenameChannelTechnique = {
    id: "navitel-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_NAVITEL);
        if (!m) return null;
        const suffix = m[8];
        if (!suffix) return null;
        return mnemonicChannel(suffix);
    },
};

const redtigerChannel: FilenameChannelTechnique = {
    id: "redtiger-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_REDTIGER);
        if (!m) return null;
        return mnemonicChannel(m[3]!);
    },
};

const movSeqFriChannel: FilenameChannelTechnique = {
    id: "mov-seq-fri-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_MOV_SEQ_FRI);
        if (!m) return null;
        return mnemonicChannel(m[3]!);
    },
};

const novatekViofoChannel: FilenameChannelTechnique = {
    id: "novatek-viofo-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_NOVATEK_VIOFO);
        if (!m) return null;
        const ch = m[6]!.toUpperCase();
        // T = telephoto, a third front-facing lens (viofosync
        // web/services/naming.py:99-107: "3-channel models pair F+R with
        // either T or I"). Map it to the free "side" slot so it cannot
        // collide with the F file of the same capture on one channel slot
        // (which would spawn |dupN frames); guess() because "side" is a
        // positional compromise, not the actual mount. Implemented from
        // foreign source (viofosync), no real T sample in the corpus.
        return mnemonicChannel(ch);
    },
};

const novatekSingleChannel: FilenameChannelTechnique = {
    id: "novatek-single-channel",
    extract(file: VendorFile): ChannelMatch | null {
        // Single-channel model - only one camera, nothing to confuse.
        return matchNovatekSingleFilename(file.file.name) ? sure("front") : null;
    },
};

const novatekVantrueChannel: FilenameChannelTechnique = {
    id: "novatek-vantrue-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_NOVATEK_VANTRUE);
        if (!m) return null;
        // A/B/C are index letters (B=cabin is not a mnemonic) - guess the mount.
        const ch = m[5]!.toUpperCase();
        if (ch === "A") return guess("front");
        if (ch === "B") return guess("interior"); // Vantrue B = cabin
        if (ch === "C") return guess("rear");
        return guess("side");
    },
};

const nextbaseChannel: FilenameChannelTechnique = {
    id: "nextbase-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_NEXTBASE);
        if (!m) return null;
        const ch = m[4]!.toUpperCase();
        if (ch === "F") return sure("front");
        if (ch === "R") return sure("rear");
        // B is a module letter whose mount nb-dashcam-tools never states (it
        // treats it as an opaque token; could be the Cabin View module or a
        // rear-window one). Guess "interior" so it cannot collide with R on
        // one channel slot; guess() keeps the UI positional instead of
        // asserting a mount we are only guessing.
        if (ch === "B") return guess("interior");
        return mnemonicChannel(ch);
    },
};

const teslaChannel: FilenameChannelTechnique = {
    id: "tesla-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const lower = file.relativePath.toLowerCase();
        if (!RX_TESLA_PATH.test(lower)) return null;
        const recent = file.file.name.match(RX_TESLA_RECENT);
        const evt = file.file.name.match(RX_TESLA_EVENT_FILENAME);
        const camera = recent ? recent[7]!.toLowerCase() : evt ? evt[1]!.toLowerCase() : null;
        if (!camera) return null;
        // Tesla spells the camera out in the name/path - trustworthy.
        switch (camera) {
            case "front":
                return sure("front");
            case "back":
                return sure("rear");
            case "cabin":
                return sure("interior");
            case "left_repeater":
            case "right_repeater":
            case "left_pillar":
            case "right_pillar":
                return sure("side");
        }
        return null;
    },
};

const thinkwareChannel: FilenameChannelTechnique = {
    id: "thinkware-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_THINKWARE);
        if (!m) return null;
        return mnemonicChannel(m[2]!);
    },
};

const wolfboxChannel: FilenameChannelTechnique = {
    id: "wolfbox-channel",
    evidence: (file) => (RX_WOLFBOX.test(file.file.name) ? "specific" : "heuristic"),
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_WOLFBOX);
        const known = m ? mnemonicChannel(m[6]!) : null;
        if (known?.confident) return known;
        // SD-card folders spell the channel out (front_norm/rear_emer/...);
        // `extra` is the interior camera on the 3-channel models.
        const path = file.relativePath;
        if (RX_WOLFBOX_PATH_FRONT.test(path)) return sure("front");
        if (RX_WOLFBOX_PATH_REAR.test(path)) return sure("rear");
        if (RX_WOLFBOX_PATH_INTERIOR.test(path)) return sure("interior");
        return known;
    },
};

const datetimeChannelTsChannel: FilenameChannelTechnique = {
    id: "datetime-channel-ts-channel",
    extract(file: VendorFile): ChannelMatch | null {
        const m = file.file.name.match(RX_DATETIME_CHANNEL_TS);
        return m ? sure(m[3]!.toUpperCase() === "F" ? "front" : "rear") : null;
    },
};

export const FILENAME_CHANNEL: readonly FilenameChannelTechnique[] = [
    datetimeChannelTsChannel,
    // Exact name-gated families stay first for stable diagnostics. The
    // unscoped path fallbacks are marked heuristic, so a user-created folder
    // cannot override a later camera-specific channel suffix.
    neolineChannel,
    vueroidChannel,
    mai70Channel,
    beferichChannel,
    blackvueChannel,
    dateSequenceCamChannel,
    recSingleChannel,
    seiDoubleGpsChannel,
    carcamChannel,
    dvrFourChannel,
    sstarChnChannel,
    ddpaiChannel,
    novatekViofoChannel,
    novatekVantrueChannel,
    novatekSingleChannel,
    eaceChannel,
    fitcamxChannel,
    ligoGpsTrailerTsChannel,
    fordChannel,
    hpimChannel,
    iboxChannel,
    juscarChannel,
    movSeqFriChannel,
    navitelChannel,
    nextbaseChannel,
    redtigerChannel,
    teslaChannel,
    thinkwareChannel,
    wolfboxChannel,
];
