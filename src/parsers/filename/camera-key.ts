// Cross-channel camera key techniques.
//
// Each technique returns a string that is IDENTICAL for every channel of one
// physical camera (front + rear + interior + side) and DIFFERENT for separate
// cameras of the same model. The dispatcher in trips.ts uses this key to isolate
// distinct cameras in groupTrips: two cameras dropped together with close
// timestamps will no longer collapse into one frame.
//
// Algorithm per technique:
//   1. Recognise the format (same regex as the time/channel techniques).
//   2. Strip the channel marker from the filename (e.g. the trailing F/B/I
//      letter, or the S/Q prefix) so a single masked-name is shared by channels.
//   3. Strip the channel folder from `parentDir` (e.g. Front/Back/Interior,
//      normal/a, /rear/) so the path prefix is also shared.
//   4. Compose: `${id}|${strippedDir}|${maskedName}`. The id prefix isolates
//      formats so an unfamiliar generic .mp4 cannot collide with a Navitel
//      one that happens to mask to the same string.
//
// Unrecognised filenames use cameraFingerprint's mask + parent path fallback,
// which shares the same spelled-out channel-folder recognition.

import type { VendorFile } from "../types.js";
import {
    RX_GRMN_SEQUENCE,
    RX_GRMN_MODE_PATH,
    RX_HMS_CHANNEL_MODE,
    MAI70_MODE_FOLDERS,
    REDTIGER_MODE_FOLDERS,
    matchEaceChannelFolder,
    RX_DATETIME_CHANNEL_TS,
    RX_70MAI,
    RX_70MAI_CHANNEL_STRIP,
    RX_BEFERICH,
    RX_BLACKVUE,
    RX_CARCAM,
    RX_DATE_SEQUENCE_CAM,
    RX_DATE_SEQUENCE_CAM_PATH,
    RX_DDPAI_EVENT,
    RX_DDPAI_NORMAL,
    RX_DDPAI_TIMELAPSE,
    RX_E_ACE,
    RX_ESCORT,
    RX_FITCAMX,
    RX_FITCAMX_MP4,
    RX_FORD,
    RX_HPIM,
    RX_IBOX,
    RX_JUSCAR,
    RX_LIGOGPS_TRAILER_TS,
    RX_MOV_SEQ_FRI,
    RX_MP4_SEQ_AC,
    RX_NAVITEL,
    RX_NEOLINE,
    RX_NEXTBASE,
    RX_NOVATEK_TS,
    RX_NOVATEK_VANTRUE,
    RX_NOVATEK_VIOFO,
    RX_REC_SINGLE,
    RX_REC_SINGLE_PATH_CHANNEL,
    RX_SEI_DOUBLE_GPS,
    RX_SEI_DOUBLE_GPS_PATH,
    RX_REDTIGER,
    RX_SSTAR_CHN,
    RX_TESLA_EVENT_FILENAME,
    RX_TESLA_PATH,
    RX_TESLA_RECENT,
    RX_THINKWARE,
    RX_VUEROID,
    VUEROID_MODE_FOLDERS,
    RX_WOLFBOX,
    matchNovatekNvtMovFilename,
    matchNovatekSingleFilename,
    stripNovatekLockedFolder,
} from "./_patterns.js";
import { matchDailyCsvChannelPath } from "../internal/daily-csv-path.js";
import type { FilenameCameraKeyTechnique } from "./types.js";
import { channelFromFolder, matchChannelFolder } from "./channel-folder.js";

/**
 * Removes channel and mode folders while retaining the enclosing camera path.
 * Channel folders apply only at the leaf. Family-specific mode folders above
 * them may also be removed, as in Normal/Front, but enclosing device names stay.
 */
function strippedParentDir(
    relativePath: string,
    familyFolders: readonly string[],
    leafChannelFolders: readonly string[] = [],
): string {
    const segs = relativePath.split("/").filter((s) => s.length > 0);
    if (segs.length < 2) return ""; // flat drop, no parent
    const dirSegs = segs.slice(0, -1); // drop the filename itself
    // A suffix-derived folder is only a channel at the leaf. The same letter
    // higher in the path can identify the card rather than one of its streams.
    if (
        matchChannelFolder(relativePath) ||
        leafChannelFolders.some((folder) => folder.toLowerCase() === dirSegs.at(-1)?.toLowerCase())
    ) {
        dirSegs.pop();
    }
    const lower = familyFolders.map((s) => s.toLowerCase());
    while (dirSegs.length > 0) {
        const last = dirSegs[dirSegs.length - 1]!.toLowerCase();
        // The channel was already removed at the leaf. Never consume another
        // spelled-out channel name belonging to the enclosing device.
        if (channelFromFolder(last) !== null) break;
        if (!lower.includes(last)) break;
        dirSegs.pop();
    }
    return dirSegs.join("/");
}

/**
 * Removes a single character at `idx` from `name`, then masks every digit
 * run with `#`. Used to strip a channel letter that sits at a known
 * regex-capture position.
 */
function maskNameWithCharRemoved(name: string, idx: number): string {
    const stripped = idx >= 0 ? name.slice(0, idx) + name.slice(idx + 1) : name;
    return stripped.replace(/\d+/g, "#");
}

/**
 * Strips a single trailing channel letter that sits immediately before the
 * extension (e.g. `..._F.mp4`), then digit-masks. Locates the letter via the
 * same `<letter>.` right-anchored search every trailing-letter family uses, so
 * all channels of one camera converge to one masked name. Not for the Nextbase
 * `_<channel><quality>.` layout, which anchors differently.
 */
function maskNameWithTrailingLetterStripped(name: string, channelChar: string): string {
    const idx = name.toLowerCase().lastIndexOf(`${channelChar.toLowerCase()}.`);
    return maskNameWithCharRemoved(name, idx);
}

/**
 * Plain digit-mask (no character stripped). Exported so cameraFingerprint's
 * fallback path (for filenames that no technique recognises) uses the same
 * masking rule as the technique outputs.
 */
export function maskName(name: string): string {
    return name.replace(/\d+/g, "#");
}

const mai70CameraKey: FilenameCameraKeyTechnique = {
    id: "70mai-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_70MAI);
        if (!m) return null;
        // Strip the channel letter from either position RX_70MAI accepts
        // (terminal, or before the app-export 14-digit stamp). The shared
        // right-anchored `<letter>.` helper only finds the terminal slot, so
        // the strip regex lives next to RX_70MAI in _patterns.ts (same tail
        // grammar, one owner) and is self-gating - no channel letter, no-op.
        const stripped = file.file.name.replace(RX_70MAI_CHANNEL_STRIP, "$1");
        let masked = maskName(stripped);
        // Canonicalize the EV/VL/LA/PA prefixes to NO (normal): the prefix is a
        // per-clip recording mode, not camera identity. The A810 lite
        // interleaves EV clips inside the normal loop (an event fires and it
        // writes the EV clip INSTEAD of the normal segment), and the A510 does
        // the same with LA/PA parking clips - so every mode-prefixed clip must
        // share the fingerprint of its NO twin to chain into one trip by time.
        // Masking only touches digits, so the leading prefix survives it; fold
        // it here, keeping the "NO#-#.MP#" shape so diagnostics stay
        // recognizable.
        masked = masked.replace(/^(?:EV|VL|LA|PA)/i, "NO");
        // Strip both "back" and "rear" (multi-channel drops rear in Back/, the
        // A810 lite in Rear/) plus the recording-mode folder above the channel
        // one, so Normal/Front, Normal/Rear, Event/Front, Event/Rear all yield
        // the same dir component.
        const dir = strippedParentDir(file.relativePath, MAI70_MODE_FOLDERS, [m[8] ?? m[9] ?? ""]);
        return `70mai|${dir}|${masked}`;
    },
};

const beferichCameraKey: FilenameCameraKeyTechnique = {
    id: "beferich-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_BEFERICH);
        if (!m) return null;
        // Channel letter at group [7], one char before `.mp4`. Strip it so
        // front + rear converge to one fingerprint and pair into one frame.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[7]!);
        // Single-folder corpus; defensive strip for hand-split channels.
        const dir = strippedParentDir(file.relativePath, [], [m[7]!]);
        return `beferich|${dir}|${masked}`;
    },
};

const blackvueCameraKey: FilenameCameraKeyTechnique = {
    id: "blackvue-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_BLACKVUE);
        if (!m) return null;
        // Channel char at group [4], one char before `.mp4`. The mode char [3]
        // sits right before it; we strip only the channel.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[4]!);
        // BlackVue typically writes everything to one folder, but defensive strip
        // for users who manually split channels into subfolders.
        const dir = strippedParentDir(file.relativePath, [], [m[4]!]);
        return `blackvue|${dir}|${masked}`;
    },
};

const carcamCameraKey: FilenameCameraKeyTechnique = {
    id: "carcam-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_CARCAM);
        if (!m) return null;
        // Channel letter at group [4], in `-X.mp4` position.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[4]!);
        // CarCam path layout: `normal/a|b|c|d/...`. The channel folder name is
        // a single letter; strip it (and the `normal` parent stays as-is).
        const dir = strippedParentDir(file.relativePath, [], ["a", "b", "c", "d", m[4]!]);
        return `carcam|${dir}|${masked}`;
    },
};

const sstarChnCameraKey: FilenameCameraKeyTechnique = {
    id: "sstar-chn-camera-key",
    extract(file: VendorFile): string | null {
        if (!RX_SSTAR_CHN.test(file.file.name)) return null;
        // The channel index lives in the leading `CH<n>` token AND in a
        // per-channel `CH<n>` folder (Normal/CH1|CH2|CH3/). Digit-masking already
        // folds CH1/CH2/CH3 -> CH# in the name (the index is a digit), so only
        // the folder must be stripped for all channels to converge on one
        // fingerprint and pair into one multichannel frame. Mode folders
        // (Normal/Event) are NOT stripped - like CarCam, keep event clips as
        // their own trip until a real sample shows the firmware interleaves them.
        const dir = strippedParentDir(file.relativePath, ["ch1", "ch2", "ch3", "ch4"]);
        return `sstar-chn|${dir}|${maskName(file.file.name)}`;
    },
};

const recSingleCameraKey: FilenameCameraKeyTechnique = {
    id: "rec-single-camera-key",
    extract(file: VendorFile): string | null {
        if (!RX_REC_SINGLE.test(file.file.name)) return null;
        if (RX_REC_SINGLE_PATH_CHANNEL.test(file.relativePath)) {
            // Modes interleave in the same recording loop. Remove exactly the
            // card's two trailing folders so a camera root named F survives.
            const dir = file.relativePath
                .split("/")
                .filter((segment) => segment.length > 0)
                .slice(0, -3)
                .join("/");
            const masked = maskName(file.file.name.replace(/^(?:REC|SOS|PAR)/i, "REC"));
            return `rec-single|${dir}|${masked}`;
        }
        // Bare letter directories can identify separate physical cameras.
        const dir = strippedParentDir(file.relativePath, []);
        return `rec-single|${dir}|${maskName(file.file.name)}`;
    },
};

const seiDoubleGpsCameraKey: FilenameCameraKeyTechnique = {
    id: "sei-double-gps-camera-key",
    extract(file: VendorFile): string | null {
        if (!RX_SEI_DOUBLE_GPS.test(file.file.name) || !RX_SEI_DOUBLE_GPS_PATH.test(file.relativePath)) return null;
        // The trailing view and date folders belong to one camera. Preserve
        // its root, including roots whose names happen to look like channels.
        const dir = file.relativePath
            .split("/")
            .filter((segment) => segment.length > 0)
            .slice(0, -3)
            .join("/");
        // The opaque suffix varies between recordings, not physical cameras.
        const masked = maskName(file.file.name.replace(/_[a-z](\.mp4)$/i, "$1").toLowerCase());
        return `sei-double-gps|${dir}|${masked}`;
    },
};

const ddpaiCameraKey: FilenameCameraKeyTechnique = {
    id: "ddpai-camera-key",
    extract(file: VendorFile): string | null {
        const name = file.file.name;
        const daily = matchDailyCsvChannelPath(file.relativePath);
        if (daily) {
            // This layout overlaps DDPai. Retain its normal-folder key so an
            // optional _A rear sibling still pairs, and fold event clips into
            // the same camera. The digit mask also handles one-second clips.
            const path = file.relativePath.replaceAll("\\", "/").replace(/101(?=video\/[^/]+$)/i, "100");
            const dir = strippedParentDir(path, []);
            return `ddpai|${dir}|${maskName(name.replace(/_[a-z](?=\.mp4$)/i, "").toLowerCase())}`;
        }
        // Normalize the channel token and extension spelling together.
        const normal = name.match(RX_DDPAI_NORMAL);
        if (normal) {
            const dir = strippedParentDir(file.relativePath, [], [normal[3] ?? ""]);
            return `ddpai|${dir}|${maskName(`${normal[1]}_${normal[2]}.mp4`)}`;
        }
        // Timelapse: S_ (front) / Q_ (rear) prefix at group [1].
        const tl = name.match(RX_DDPAI_TIMELAPSE);
        if (tl) {
            const stripped = name.replace(/^[SsQq]_/, "");
            const dir = strippedParentDir(file.relativePath, []);
            return `ddpai|${dir}|tl:${maskName(stripped)}`;
        }
        // Event: G_ prefix is mode (not channel - events are front-only).
        // Keep name as-is so DDPai events do not collide with normal/timelapse.
        const ev = name.match(RX_DDPAI_EVENT);
        if (ev) {
            const dir = strippedParentDir(file.relativePath, []);
            return `ddpai|${dir}|ev:${maskName(name)}`;
        }
        return null;
    },
};

const eaceCameraKey: FilenameCameraKeyTechnique = {
    id: "e-ace-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_E_ACE);
        if (!m) return null;
        // Channel separators and extension case do not identify a camera.
        const extension = file.file.name.slice(file.file.name.lastIndexOf(".")).toLowerCase();
        const masked = maskName(`${m[1]}_${m[2]}${extension}`);
        const ch = m[3];
        // A `<Mode>_<channel word>` leaf keeps only its mode stem: channels
        // converge, while Event clips keep their own key. Unlike
        // redtiger-camera-key, no corpus shows whether an event replaces its
        // loop segment or duplicates it; a shared key would turn a duplicate
        // into a dup frame inside the drive.
        const stem = matchEaceChannelFolder(file.relativePath)?.[1] ?? null;
        const path = stem === null ? file.relativePath : file.relativePath.replace(/[^/]+(?=\/[^/]+$)/, stem);
        const dir = strippedParentDir(path, [], [ch ?? ""]);
        return `e-ace|${dir}|${masked}`;
    },
};

const escortCameraKey: FilenameCameraKeyTechnique = {
    id: "escort-camera-key",
    extract(file: VendorFile): string | null {
        if (!RX_ESCORT.test(file.file.name)) return null;
        // M2 is single-channel; no channel marker to strip. Mode lives in path
        // (Normal/Event/Favorites) - those should NOT be stripped, otherwise
        // Normal and Event clips of the same camera collapse into a single trip
        // boundary, which is not what we want for the channel-key concept.
        const dir = strippedParentDir(file.relativePath, []);
        return `escort|${dir}|${maskName(file.file.name)}`;
    },
};

const dateSequenceCamCameraKey: FilenameCameraKeyTechnique = {
    id: "date-sequence-cam-camera-key",
    extract(file: VendorFile): string | null {
        const match = file.file.name.match(RX_DATE_SEQUENCE_CAM);
        if (!match) return null;
        const channelIndex = match[3]!;
        // Unknown mounts share the fallback front slot. Preserve their index
        // so simultaneous streams cannot become one interleaved trip.
        const channelFolder = file.relativePath.match(RX_DATE_SEQUENCE_CAM_PATH);
        const hasMount = channelFolder !== null || channelIndex === "1" || channelIndex === "2";
        const dir = strippedParentDir(
            file.relativePath,
            [],
            channelFolder ? [`${channelFolder[1]}_${channelFolder[2]}`] : [],
        );
        const channelKey = hasMount ? "" : `|cam${channelIndex}`;
        return `date-sequence-cam|${dir}|${maskName(file.file.name)}${channelKey}`;
    },
};

const FITCAMX_STRIP_FOLDERS = ["movie", "movie_e", "emr", "emr_e"];

const fitcamxCameraKey: FilenameCameraKeyTechnique = {
    id: "fitcamx-camera-key",
    extract(file: VendorFile): string | null {
        const name = file.file.name;
        // MP4 variant: the 3-letter suffix ends in <channel><mode letter>.
        // Both are per-clip attributes, not camera identity - the corpus shows
        // EMR clips running the uninterrupted minute cadence of a normal loop
        // (event written INSTEAD of the normal segment, the redtiger
        // rationale), and the .ts branch below already strips the mode FOLDER
        // for the same reason. Drop both letters so the A/B pair and the
        // normal/event siblings all converge on one key.
        if (RX_FITCAMX_MP4.test(name)) {
            const suffixStart = name.length - ".mp4".length - 2;
            const stripped = name.slice(0, suffixStart) + name.slice(suffixStart + 2);
            const masked = maskName(stripped);
            const dir = strippedParentDir(file.relativePath, FITCAMX_STRIP_FOLDERS);
            return `fitcamx|${dir}|${masked}`;
        }
        if (!RX_FITCAMX.test(name)) return null;
        // .ts variant: channel comes purely from parent folder (Movie/Movie_E/
        // EMR/EMR_E). Strip the channel/mode folder; nothing to remove from
        // the name itself.
        const dir = strippedParentDir(file.relativePath, FITCAMX_STRIP_FOLDERS);
        return `fitcamx|${dir}|${maskName(name)}`;
    },
};

const fordCameraKey: FilenameCameraKeyTechnique = {
    id: "ford-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_FORD);
        if (!m) return null;
        // Channel letter at group [7], one char before `.ts`. Strip it (anchored
        // to the same RX_FORD match, not a second pattern that could drift from
        // it) so every channel of one camera converges to a single fingerprint -
        // front + rear (+ any other) then pair into one multichannel frame in
        // groupTrips. Same lastIndexOf+mask approach as the other trailing-letter
        // families (juscar/ibox/...).
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[7]!);
        // Ford writes all channels into one folder, but strip spelled-out channel
        // folders too in case a user splits them by hand.
        const dir = strippedParentDir(file.relativePath, []);
        return `ford|${dir}|${masked}`;
    },
};

// HP card layout is `<Mode>/<channel letter>/<file>` (Normal/F/...). Both
// levels are per-clip attributes, not camera identity: strippedParentDir's
// bottom-up walk pops the single-letter channel folder first, then the mode
// folder above it (the mai70 rationale - an event clip written mid-loop must
// chain into the same trip as its normal siblings). Event/Parking/Manual are
// the standard CarDV set; an unknown mode folder simply stays in the key and
// degrades to a per-folder trip split, same as before this technique.
const HPIM_STRIP_FOLDERS = ["f", "r", "b", "i", "normal", "event", "parking", "manual"];

const hpimCameraKey: FilenameCameraKeyTechnique = {
    id: "hpim-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_HPIM);
        if (!m) return null;
        // Channel letter at group [3], one char before `.TS`. Strip it so all
        // channels of one camera converge on one fingerprint.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[3]!);
        const dir = strippedParentDir(file.relativePath, HPIM_STRIP_FOLDERS);
        return `hpim|${dir}|${masked}`;
    },
};

const iboxCameraKey: FilenameCameraKeyTechnique = {
    id: "ibox-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_IBOX);
        if (!m) return null;
        // Channel letter at group [5], immediately before `.mp4|.mov`.
        // The same filename language is also used by dual-channel MiVue. Its
        // SD layout puts the pair in sibling F/ and R/ folders, so strip both
        // the single-letter and spelled-out folder dialects.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[5]!);
        const dir = strippedParentDir(file.relativePath, [], ["f", "r", "i", m[5]!]);
        return `ibox|${dir}|${masked}`;
    },
};

const juscarCameraKey: FilenameCameraKeyTechnique = {
    id: "juscar-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_JUSCAR);
        if (!m) return null;
        // Strip the channel and mode suffix so one camera keeps one key.
        const masked = maskName(`${m[1]}_${m[2]}.ts`);
        const dir = file.relativePath
            .split("/")
            .filter((segment) => segment.length > 0)
            .slice(0, -1);
        // Only the final channel and mode folders describe the clip. An
        // enclosing camera root may itself be named F, R, video or event.
        if (
            matchChannelFolder(file.relativePath) ||
            /^(?:f|r)$/i.test(dir.at(-1) ?? "") ||
            dir.at(-1)?.toLowerCase() === m[3]!.toLowerCase()
        ) {
            dir.pop();
        }
        if (/^(?:video|event|park)$/i.test(dir.at(-1) ?? "")) dir.pop();
        return `juscar|${dir.join("/")}|${masked}`;
    },
};

const movSeqFriCameraKey: FilenameCameraKeyTechnique = {
    id: "mov-seq-fri-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_MOV_SEQ_FRI);
        if (!m) return null;
        // Channel letter at group [3], immediately before the extension.
        // Strip it so all channels of one capture converge on one fingerprint
        // and pair into one multichannel frame (the interior clip starts a
        // couple seconds behind front/rear; the groupTrips snap absorbs that).
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[3]!);
        // The .ts card splits channels into single-letter F/ R/ folders - a
        // per-clip attribute, not camera identity; long names cover
        // hand-split channels.
        const dir = strippedParentDir(file.relativePath, [], ["f", "r", "i", m[3]!]);
        return `mov-seq-fri|${dir}|${masked}`;
    },
};

const mp4SeqAcCameraKey: FilenameCameraKeyTechnique = {
    id: "mp4-seq-ac-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_MP4_SEQ_AC);
        if (!m) return null;
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[3]!);
        const dir = strippedParentDir(file.relativePath, []);
        return `mp4-seq-ac|${dir}|${masked}`;
    },
};

const ligoGpsTrailerTsCameraKey: FilenameCameraKeyTechnique = {
    id: "ligogps-trailer-ts-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_LIGOGPS_TRAILER_TS);
        if (!m) return null;
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[3]!);
        const dir = strippedParentDir(
            file.relativePath,
            [],
            ["video_f", "video_r", "video_i", `video_${m[3]}`, "f", "r", "i", m[3]!],
        );
        return `ligogps-trailer-ts|${dir}|${masked}`;
    },
};

const NAVITEL_STRIP_FOLDERS = ["f", "r", "normal", "event", "parking", "manual"];

const navitelCameraKey: FilenameCameraKeyTechnique = {
    id: "navitel-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_NAVITEL);
        if (!m) return null;
        // Optional channel letter at group [8], one char before extension.
        let masked: string;
        const ch = m[8];
        if (ch) {
            masked = maskNameWithTrailingLetterStripped(file.file.name, ch);
        } else {
            masked = maskName(file.file.name);
        }
        // The .ts variant lays the card out as `<Mode>/<channel letter>/`
        // (Normal/F/, Normal/R/) - the hpim layout, same strip rationale:
        // both levels are per-clip attributes, not camera identity, and an
        // event clip written mid-loop must chain into the same trip as its
        // normal siblings. Spelled-out names cover hand-split channels.
        const dir = strippedParentDir(file.relativePath, NAVITEL_STRIP_FOLDERS);
        return `navitel|${dir}|${masked}`;
    },
};

const novatekViofoCameraKey: FilenameCameraKeyTechnique = {
    id: "novatek-viofo-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_NOVATEK_VIOFO);
        if (!m) return null;
        // Channel letter at group [6], one char before `.mp4`. The
        // mode letter [5] (P = parking, E = impact event) stays in the mask
        // (cameraKey is not mode-aware - mode handling lives separately).
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[6]!);
        // Locked clips move into RO with unchanged names. Remove that leaf
        // first so a letter channel folder above it still matches normally.
        const channelPath = stripNovatekLockedFolder(file.relativePath);
        const dir = strippedParentDir(channelPath, [], [m[6]!]);
        return `novatek-viofo|${dir}|${masked}`;
    },
};

const novatekVantrueCameraKey: FilenameCameraKeyTechnique = {
    id: "novatek-vantrue-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_NOVATEK_VANTRUE);
        if (!m) return null;
        // Channel letter at group [5], one char before `.mp4`.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[5]!);
        const dir = strippedParentDir(file.relativePath, [], [m[5]!]);
        return `novatek-vantrue|${dir}|${masked}`;
    },
};

const novatekSingleCameraKey: FilenameCameraKeyTechnique = {
    id: "novatek-single-camera-key",
    extract(file: VendorFile): string | null {
        if (!matchNovatekSingleFilename(file.file.name)) return null;
        // Single-channel: no channel marker to strip. The optional NVT-IM A is
        // a recording-mode marker, so normalize it too: driving and parking
        // clips must share the camera's TZ bucket and grouping partition.
        const nvtMov = matchNovatekNvtMovFilename(file.file.name);
        const name = nvtMov?.[5] ? file.file.name.replace(/A(?=\.mov$)/i, "") : file.file.name;
        // Remove the locked-clip leaf before normalizing channel folders so
        // protected and normal clips share the same camera identity.
        const channelPath = stripNovatekLockedFolder(file.relativePath);
        const dir = strippedParentDir(channelPath, []);
        return `novatek-single|${dir}|${maskName(name)}`;
    },
};

const novatekTsCameraKey: FilenameCameraKeyTechnique = {
    id: "novatek-ts-camera-key",
    extract(file: VendorFile): string | null {
        if (!RX_NOVATEK_TS.test(file.file.name)) return null;
        // The counter is per file, not per channel. Folder channels use the
        // same normalization as other filename families.
        const dir = strippedParentDir(file.relativePath, []);
        return `novatek-ts|${dir}|${maskName(file.file.name)}`;
    },
};

const neolineCameraKey: FilenameCameraKeyTechnique = {
    id: "neoline-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_NEOLINE);
        if (!m) return null;
        // Channel letter at group [4], immediately before `.mp4`.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[4]!);
        const dir = strippedParentDir(file.relativePath, [], [m[4]!]);
        return `neoline|${dir}|${masked}`;
    },
};

const vueroidCameraKey: FilenameCameraKeyTechnique = {
    id: "vueroid-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_VUEROID);
        if (!m) return null;
        // Mode and channel are per-clip attributes, not camera identity.
        const stripped = file.file.name.replace(/_[A-Z]_[NEP](\.mp4)$/i, "_N$1");
        const dir = strippedParentDir(file.relativePath, VUEROID_MODE_FOLDERS, [m[3]!]);
        return `vueroid|${dir}|${maskName(stripped)}`;
    },
};

const nextbaseCameraKey: FilenameCameraKeyTechnique = {
    id: "nextbase-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_NEXTBASE);
        if (!m) return null;
        // Strip ONLY the channel letter [4]; KEEP the H/L quality letter [5].
        // Nextbase records parallel high/low-bitrate streams of the same lens
        // with identical timestamps - collapsing H+L into one fingerprint
        // would put the L stream on an already-occupied channel slot and
        // spawn |dupN frames. A user dropping both H and L streams therefore
        // sees two parallel trips - deliberate, the safe degradation.
        const lower = file.file.name.toLowerCase();
        // `_<channel><quality>.` anchors the channel letter position; +1
        // skips the underscore so only the channel letter is removed.
        const idx = lower.lastIndexOf(`_${m[4]!.toLowerCase()}${m[5]!.toLowerCase()}.`) + 1;
        const masked = maskNameWithCharRemoved(file.file.name, idx);
        const dir = strippedParentDir(file.relativePath, []);
        return `nextbase|${dir}|${masked}`;
    },
};

// RedTiger splits channels into sibling `<mode>_<channel letter>` folders
// (Movie_F/, Movie_R/, Event_F/, ...). Both the folder and the trailing letter
// are per-clip attributes, not camera identity: the corpus shows an event pair
// slotted exactly into the 3-minute loop cadence between its Movie neighbours
// (the firmware writes the event clip INSTEAD of the normal segment), so an
// Event clip must chain into the same trip as its Movie siblings - the
// mai70/hpim rationale.
const redtigerCameraKey: FilenameCameraKeyTechnique = {
    id: "redtiger-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_REDTIGER);
        if (!m) return null;
        // Channel letter at group [3], one char before `.MP4`.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[3]!);
        const dir = strippedParentDir(
            file.relativePath,
            [],
            REDTIGER_MODE_FOLDERS.flatMap((mode) => ["f", "r", m[3]!].map((letter) => `${mode}_${letter}`)),
        );
        return `redtiger|${dir}|${masked}`;
    },
};

const teslaCameraKey: FilenameCameraKeyTechnique = {
    id: "tesla-camera-key",
    extract(file: VendorFile): string | null {
        const lower = file.relativePath.toLowerCase();
        if (!RX_TESLA_PATH.test(lower)) return null;
        // RecentClips: timestamp is in the filename; SavedClips/SentryClips:
        // timestamp is in the parent folder (already cross-channel - all
        // cameras of one event share the same timestamp folder).
        const recent = file.file.name.match(RX_TESLA_RECENT);
        const evt = file.file.name.match(RX_TESLA_EVENT_FILENAME);
        if (!recent && !evt) return null;
        const segs = file.relativePath.split("/").filter((s) => s.length > 0);
        // Walk up past the file (1 level) and past the timestamp folder
        // (1 level for event clips; recent layout is `RecentClips/<name>` so
        // the parent is `RecentClips` itself).
        const top = segs.length >= 2 ? segs.slice(0, -1).join("/") : "";
        if (recent) {
            // `<x>/<y>-front.mp4` -> camera key for the whole RecentClips folder.
            // Stripping the cam suffix from the filename. recent[7] is the cam.
            const cam = recent[7]!;
            const stripped = file.file.name.replace(new RegExp(`-${cam}\\.mp4$`, "i"), ".mp4");
            return `tesla|${top}|${maskName(stripped)}`;
        }
        // Event: filename IS the camera name; strip it entirely so all
        // cameras of one event share the same key.
        return `tesla|${top}|event`;
    },
};

const thinkwareCameraKey: FilenameCameraKeyTechnique = {
    id: "thinkware-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_THINKWARE);
        if (!m) return null;
        // Channel letter at group [2], one char before `.mp4`.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[2]!);
        const dir = strippedParentDir(file.relativePath, [], [m[2]!]);
        return `thinkware|${dir}|${masked}`;
    },
};

// Wolfbox SD layout splits channels into sibling `<channel>_<mode>` folders,
// so both the trailing letter AND the folder must be stripped for the
// cross-channel key to converge.
const WOLFBOX_CHANNEL_FOLDERS = ["front", "rear", "extra"].flatMap((ch) =>
    ["norm", "emer", "photo"].map((mode) => `${ch}_${mode}`),
);

const wolfboxCameraKey: FilenameCameraKeyTechnique = {
    id: "wolfbox-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_WOLFBOX);
        if (!m) return null;
        // Channel letter F/I/R at group [6], one char before `.mp4`.
        const masked = maskNameWithTrailingLetterStripped(file.file.name, m[6]!);
        const dir = strippedParentDir(file.relativePath, WOLFBOX_CHANNEL_FOLDERS);
        return `wolfbox|${dir}|${masked}`;
    },
};

const datetimeChannelTsCameraKey: FilenameCameraKeyTechnique = {
    id: "datetime-channel-ts-camera-key",
    extract(file: VendorFile): string | null {
        const m = file.file.name.match(RX_DATETIME_CHANNEL_TS);
        if (!m) return null;
        // Only the leaf is a channel; an enclosing root may itself be named front/back.
        const dir = strippedParentDir(file.relativePath, [], ["f", "r", m[3]!]);
        return `datetime-channel-ts|${dir}|${maskName(`${m[1]}_${m[2]}.ts`)}`;
    },
};

/**
 * Camera-key techniques in walk order. Each returns a cross-channel string
 * or null when the format does not match.
 *
 * `cameraFingerprint` (in camera-fingerprint.ts) walks this list and falls
 * back to a plain mask+parentDir when nothing matches. Order is by specificity
 * - the wide `e-ace` regex (any `\d{8}_\d{6}[A-Z]?\.mp4`) comes after the
 * narrower neighbours to keep diagnostics stable.
 */
export const FILENAME_CAMERA_KEY: readonly FilenameCameraKeyTechnique[] = [
    {
        id: "grmn-camera-key",
        extract(file) {
            if (!RX_GRMN_SEQUENCE.test(file.file.name)) return null;
            const modePath = file.relativePath.match(RX_GRMN_MODE_PATH);
            const dir = strippedParentDir(file.relativePath, modePath ? [modePath[1]!] : []);
            return `grmn|${dir}|counter`;
        },
    },
    {
        id: "hms-channel-mode-camera-key",
        extract(file) {
            const m = file.file.name.match(RX_HMS_CHANNEL_MODE);
            if (!m) return null;
            const dir = strippedParentDir(file.relativePath, []);
            // Combined-track names retain their token: they are not another
            // single-lens channel to merge with independently exported clips.
            const stream = m[5]!.toUpperCase();
            const token = stream === "FO" || stream === "OR" ? "single" : stream.toLowerCase();
            return `hms-channel-mode|${dir}|${token}`;
        },
    },
    datetimeChannelTsCameraKey,
    mai70CameraKey,
    beferichCameraKey,
    blackvueCameraKey,
    carcamCameraKey,
    sstarChnCameraKey,
    recSingleCameraKey,
    seiDoubleGpsCameraKey,
    ddpaiCameraKey,
    novatekViofoCameraKey,
    novatekVantrueCameraKey,
    novatekSingleCameraKey,
    novatekTsCameraKey,
    eaceCameraKey,
    escortCameraKey,
    dateSequenceCamCameraKey,
    fitcamxCameraKey,
    fordCameraKey,
    hpimCameraKey,
    iboxCameraKey,
    juscarCameraKey,
    ligoGpsTrailerTsCameraKey,
    movSeqFriCameraKey,
    mp4SeqAcCameraKey,
    navitelCameraKey,
    neolineCameraKey,
    nextbaseCameraKey,
    redtigerCameraKey,
    teslaCameraKey,
    thinkwareCameraKey,
    vueroidCameraKey,
    wolfboxCameraKey,
];
