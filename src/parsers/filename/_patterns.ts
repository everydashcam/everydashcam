// Shared regex constants for filename techniques.
//
// One source of truth per filename family - if a vendor's firmware changes
// the naming, this is the single place to update. Per-field technique files
// (time.ts / channel.ts / mode.ts / sequence.ts) import the constants they
// need; the regex never gets out of sync across fields.
// A channel-letter slot accepts any single letter. Map known letters in
// channel.ts; keep mode, quality, and GPS-carrier discriminator codes specific.

// 70mai: NO (normal) / EV (event) / LA / PA (A510 parking timelapse /
// parking event) prefix + 8-digit date + - + 6-digit time + optional
// -counter + optional trailing 14-digit wall-clock timestamp (M500 and app
// exports) + optional channel letter (F/B/R/I/C are known). The letter sits either
// BEFORE the trailing timestamp (app-export shape `...-000195R-<14d>.mp4`,
// group m[8]) or at the very end (group m[9]); a file carries at most one of
// the two, so consumers read `m[8] ?? m[9]`. B/R are rear aliases and I/C
// are interior aliases. The prefix is a NON-capturing group so the m[1..9]
// group indices stay stable
// for every consumer (time / channel / sequence / camera-key all key off
// this one regex): m[1..6] datetime, m[7] counter, m[8]/m[9] channel.
export const RX_70MAI =
    /^(?:NO|EV|VL|LA|PA)(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?(?:([A-Z])(?:-\d{14})?|(?:-\d{14})?([A-Z])?)\.mp4$/i;
// Recording-mode folders on a 70mai card. Single source for both the path-mode
// regex and camera-key's parent-dir strip list - a mode folder added here
// reaches both, so a new name cannot silently re-fragment trips.
export const MAI70_MODE_FOLDERS = ["normal", "event", "lapse", "manual", "parking"] as const;
export const RX_70MAI_PATH_MODE = new RegExp(`(?:^|/)(${MAI70_MODE_FOLDERS.join("|")})/`, "i");
// 70mai filename prefix carries the recording mode when the folder layout is
// absent (flat drop): NO = normal loop, EV/VL = protected event, LA = parking
// timelapse, PA = parking g-sensor/motion event.
// Read only after RX_70MAI has matched, so the two-letter prefix cannot claim
// a foreign name (e.g. "NOTES.mp4").
export const RX_70MAI_PREFIX_MODE = /^(NO|EV|VL|LA|PA)/i;
// Invariant core of a 70mai clip name: datetime + optional counter + optional
// channel letter, WITHOUT the 2-letter mode prefix and WITHOUT anything after
// ".MP4". The GPSData CSV log references clips by name, but the firmware's
// name and the name on disk can disagree in exactly those two spots: a locked
// clip is renamed across mode prefixes (recorded as normal, locked to
// EV/VL...), and X800 firmware appends garbage after ".MP4" in the log row
// ("VL...F.MP4G4"). The core survives both, and it is unique per card
// (timestamp + sequence + channel), so it is the join key for rebinding log
// records to loaded videos (rebindOrphanLogRecords in parser.ts).
// The dated log (csv-70mai-dated) writes the core alone, without any prefix.
// A bare core must carry both the counter and the channel letter: a bare
// "YYYYMMDD-HHMMSS.MP4" is a generic camera name and must not join 70mai clips.
const RX_70MAI_NAME_CORE = /^(?:[A-Z]{2}(\d{8}-\d{6}(?:-\d+)?[A-Z]?)|(\d{8}-\d{6}-\d+[A-Z]))\.MP4/i;

/** Returns the invariant 70mai name core (uppercased), or null for a name
 *  that does not have the 70mai shape. A prefixed name and the bare core the
 *  dated log writes for the same clip return the same value. */
export function mai70NameCore(name: string): string | null {
    const m = name.match(RX_70MAI_NAME_CORE);
    return m ? (m[1] ?? m[2])!.toUpperCase() : null;
}

// Channel-letter strip for camera fingerprinting: removes the suffix letter
// from BOTH positions RX_70MAI accepts (terminal, or before the app-export
// 14-digit stamp). Must stay in lockstep with RX_70MAI's tail grammar - it is
// self-gating on names RX_70MAI matched (the char in that slot is otherwise a
// digit), so callers apply it unconditionally after a match.
export const RX_70MAI_CHANNEL_STRIP = /[A-Z]((?:-\d{14})?\.mp4)$/i;

// BlackVue DR-series: YYYYMMDD_HHMMSS_<Mode><Channel>.mp4.
// Mode in N/E/P/M; F/R/I are known channel letters.
// Beferich (J18, ...): `2026-08-03_11_34_53_f.mp4`. Same datetime core as
// RX_FORD but `.mp4` and no FordFootage/ gate - the trailing channel letter
// keeps the two disjoint via the extension. Front-only corpus: `f` is
// confirmed, other letters map by mnemonic (see beferich-channel).
export const RX_BEFERICH = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})_([a-z])\.mp4$/i;

export const RX_BLACKVUE = /^(\d{8})_(\d{6})_([NEPM])([A-Z])\.mp4$/i;

/**
 * Channel-independent recording key for a BlackVue clip: `date_time_mode`
 * (lowercased), dropping the channel letter. The front, rear and interior
 * clips of one recording share it, so it pairs a shared `_N.gps`/`_N.3gf`
 * sidecar with every channel (matchBlackvueSidecarBasename) and clones that GPS
 * across the channels so they anchor identically (cloneRecordsAcrossChannels).
 * null for names that are not BlackVue-shaped.
 */
export function blackvueChannelGroupKey(name: string): string | null {
    const m = name.match(RX_BLACKVUE);
    return m ? `${m[1]}_${m[2]}_${m[3]}`.toLowerCase() : null;
}

// CarCam 4CH 360-WiFi: REC + date - time - sequence - channel letter.
// A/B/C/D are the known port indices; the slot stays open for firmware variants.
export const RX_CARCAM = /^REC(\d{8})-(\d{6})-(\d+)-([A-Z])\.mp4$/i;
// SigmaStar REC family: mode prefix + date - time - sequence, no channel suffix.
// iZEEKER splits channels into Normal/A and Normal/B; iBox RoadScan uses
// Normal|Event|Parking/F|R with REC|SOS|PAR prefixes. A bare REC name carries
// no reliable channel or mode. The missing suffix keeps this off RX_CARCAM.
export const RX_REC_SINGLE = /^(?:REC|SOS|PAR)(\d{8})-(\d{6})-(\d+)\.mp4$/i;
export const RX_REC_SINGLE_PATH_CHANNEL = /(?:^|\/)(Normal|Event|Parking)\/([A-Z])\/[^/]+$/i;
export const RX_CARCAM_PATH_FRONT = /(?:^|\/)normal\/a\//i;
export const RX_CARCAM_PATH_REAR = /(?:^|\/)normal\/b\//i;
export const RX_CARCAM_PATH_INTERIOR = /(?:^|\/)normal\/c\//i;
export const RX_CARCAM_PATH_SIDE = /(?:^|\/)normal\/d\//i;
export const RX_CARCAM_PATH_EVENT = /(?:^|\/)event\//i;
export const RX_CARCAM_PATH_PARKING = /(?:^|\/)parking\//i;

// Unbranded SigmaStar 3-4CH cam (card carries `.sstar.format` markers): a
// leading CH<n> channel index + - + 8-digit date - 6-digit time + .ts, one clip
// per channel dropped into a per-channel `CH<n>` folder under Normal/. CH<n> is
// an index, not a mnemonic (like CarCam A/B/C/D), so the mount mapping is a best
// guess. The mandatory `CH` prefix + `.ts` keeps it disjoint from every other
// .ts family (novatek-ts / fitcamx / juscar / ford all start with a digit).
// No embedded GPS in the corpus (the paired same-basename .TXT sidecars are
// 0-byte); name classification only.
export const RX_SSTAR_CHN = /^CH([1-4])-\d{8}-\d{6}\.ts$/i;

// DDPai - three name variants for normal / timelapse-parking / event.
// The "normal" shape `<14-digit>_<counter>` is NOT DDPai-exclusive: Novatek-
// family cameras (VIOFO A119 Mini Pro / Mini 2, Roadgid Tube, Fujida Karma)
// name their clips the same way with 6-7 digit counters and keep freeGPS
// INSIDE the MP4. The
// ddpai-normal source hint sets probeIfNoRecords for exactly that reason -
// widening the counter here must never turn into a hard embedded-probe skip.
export const RX_DDPAI_GPS_DIR = /(?:^|\/)(?:103|203)gps\//i;
export const RX_DDPAI_NORMAL = /^(\d{14})_(\d{2,7})(?:_([A-Z]))?\.mp4$/i;
export const RX_DDPAI_TIMELAPSE = /^([SQ])_(\d{14})_(\d{3,5})_(\d{2,4})\.mp4$/i;
export const RX_DDPAI_EVENT = /^G_(\d{14})_(\d{2,5})_([LX])\.mp4$/i;
export const RX_DDPAI_TIMESTAMP_TOKEN = /(\d{14})/;

// A separator belongs to the channel token; a bare trailing separator is invalid.
// The MOV spelling is used by Type S, with the same timestamp/channel language.
export const RX_E_ACE = /^(\d{8})_(\d{6})(?:[_-]?([A-Z]))?\.(?:mp4|mov)$/i;

// Counter-only Garmin clips carry their wall clock in the container/GPS.
export const RX_GRMN_SEQUENCE = /^GRMN(\d+)\.mp4$/i;
// Folder numbering varies by model (for example 101SAVED vs 102SAVED).
// Consumers also require a GRMN filename before using the mode suffix.
export const RX_GRMN_MODE_PATH = /(?:^|\/)DCIM\/(\d{3}(EVENT|SAVED|PARKM|TLPSE|UNSVD))\/[^/]+$/i;

// FineVu documents this clock and FO/OR/FR stream tokens in its file browser:
// https://finevu.co.uk/wp-content/uploads/2023/10/How-to-download-video-footage.pdf
// FO = front, OR = rear, FR = combined. Other tokens keep their clock without
// asserting a mount or interpreting the final letter as a recording mode.
export const RX_HMS_CHANNEL_MODE = /^(\d{8})[-_](\d{2})h(\d{2})m(\d{2})s_([A-Z]{1,4})_([A-Z])\.mp4$/i;
// Leaf folder of a card that splits streams into `<Mode>_<channel word>/`
// siblings: RedTiger F17 (Video_Front/, Video_Inside/, Video_Rear/, with
// Event_* next to them) and GKU 600 Pro (Video_front/, Video_rear/).
// Groups: mode stem, channel word.
const RX_MODE_CHANNEL_FOLDER = /^(video|event)_(front|rear|inside)$/i;

/** Mode and channel of a `<Mode>_<channel>` leaf folder, preserving the card's spelling. */
export function matchModeChannelFolder(relativePath: string): RegExpMatchArray | null {
    const segs = relativePath.split("/");
    if (segs.length < 2) return null;
    return segs[segs.length - 2]!.match(RX_MODE_CHANNEL_FOLDER);
}

// Escort M2: digits_digits_CAM.mp4. Time has no seconds field.
export const RX_ESCORT = /^(\d{8})_(\d{4})_CAM\.mp4$/i;
export const RX_ESCORT_PATH_EVENT = /(?:^|\/)event\//i;
export const RX_ESCORT_PATH_MANUAL = /(?:^|\/)favorites\//i;
export const RX_ESCORT_PATH_NORMAL = /(?:^|\/)normal\//i;

// Numbered CAM clips use a sequence, not HHMM. Keep separate from RX_ESCORT.
export const RX_DATE_SEQUENCE_CAM = /^(\d{8})_(\d{4})_CAM([0-9])\.mp4$/i;
export const RX_DATE_SEQUENCE_CAM_PATH = /(?:^|\/)(normal|event|favorites)_(front|rear)\/(?=[^/]+$)/i;

// FitCamX: 14-digit timestamp + _ + 6-digit token + letter + .ts.
// Channel/mode come from parent folder (Movie / Movie_E / EMR / EMR_E).
export const RX_FITCAMX = /^(\d{14})_(\d{6})([A-Z])\.ts$/i;
// FitCamX MP4 variant (2-channel HEVC corpus): same stamp+counter language,
// but a 3-letter suffix and BOTH channels dropped into one mode folder (EMR/).
// Decoded from a diagnostic-report corpus: the middle letter A/B is the known channel
// index (a pair shares one to-the-second timestamp and interleaves one shared
// counter; A runs the higher bitrate of the two), the leading A is constant -
// kept literal until a sample shows another value. The corpus (EMR-only, all
// clips locked/emergency) ends every name in E, which lines up with the folder
// - so the trailing letter is read as a mode marker and left [A-Z]: normal
// clips of the same camera will carry some other letter, and pinning E would
// un-pair them. The FOLDER stays the mode source either way (the letter->mode
// table is unknown). Filename-only knowledge; embedded GPS unknown, so no
// source hint.
export const RX_FITCAMX_MP4 = /^(\d{14})_(\d{6})A([A-Z])([A-Z])\.mp4$/i;
export const RX_FITCAMX_PATH_REAR = /(?:^|\/)(movie_e|emr_e)\//i;
export const RX_FITCAMX_PATH_FRONT = /(?:^|\/)(movie|emr)\//i;
export const RX_FITCAMX_PATH_EVENT = /(?:^|\/)(emr|emr_e)\//i;
export const RX_FITCAMX_PATH_NORMAL = /(?:^|\/)(movie|movie_e)\//i;
// 360CARDVR firmware uses the same MP4 stamp/counter/suffix language, but
// keeps normal loops in REC/ and one whole-session JSONL GPS log in GPS/.
export const RX_360_CARDVR_REC_PATH = /(?:^|\/)360CARDVR\/REC\//i;

// Ford built-in dashcam (records to a USB stick, footage lands in a
// FordFootage/ folder): YYYY-MM-DD_HH_MM_SS_<channel>.ts. Per a real sample:
// H.264 2560x1440 + AAC + a single JPEG poster frame on a private stream
// (stream_type 0x89), and NO embedded GPS/telemetry. Channel letter: `f` is
// front (confirmed). Any other letter is a different channel - the corpus is
// front-only so far, so the rear/other letters are an assumption (mnemonic
// r/b = rear, i = interior), to be revalidated on the first real sample.
// Brand is inferred from the folder name + naming scheme, not from container
// metadata (the JPEG's EXIF Make/Model are blank).
export const RX_FORD = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})_([a-z])\.ts$/i;
// The FordFootage/ folder is what actually identifies the format - the
// `YYYY-MM-DD_HH_MM_SS_x.ts` name shape is generic. The source-hint gates on
// this path so a same-named .ts from another camera is not silently skipped.
export const RX_FORD_PATH = /(?:^|\/)FordFootage\//i;

// HP (f969x; SigmaStar CarDV firmware per the TS service descriptor): HPIM +
// 8-digit date - 6-digit time + channel letter + .TS, card layout
// `<Mode>/<channel letter>/` (Normal/F/ in the corpus). `f` = front is the
// only letter observed; other letters map by mnemonic (see hpim-channel).
// The container is HEVC + a low-res H264 preview + AAC + a JPEG poster on a
// private PES. GPS burns into the picture (OSD coordinates + speed) but is
// written nowhere machine-readable - the PMT-declared private data slots stay
// empty even with an on-screen confirmed fix, so the format carries a "none"
// gps-source hint (rationale at the hint entry).
export const RX_HPIM = /^HPIM(\d{8})-(\d{6})([A-Z])\.ts$/i;

// FILE + 2-digit-year YY MM DD - HHMMSS + channel letter + extension.
// Shared by iBox iCON and dual-channel Mio MiVue firmware. The name alone
// cannot distinguish their GPS carriers; the MiVue 955WD card adds top-level
// F/ and R/ folders and a same-basename front `.NMEA` sidecar.
export const RX_IBOX = /^FILE(\d{2})(\d{2})(\d{2})-(\d{6})([A-Z])\.(mp4|mov)$/i;
export const RX_IBOX_PATH_EVENT = /(?:^|\/)event\//i;
export const RX_IBOX_PATH_PARKING = /(?:^|\/)parking\//i;
// F/R here identifies the observed MiVue sidecar card layout. It is a GPS
// carrier hint, not the channel parser; other folders retain the embedded probe.
export const RX_MIVUE_DUAL_PATH = /(?:^|\/)[FR]\//i;

// Mio / Navman MiVue single-channel line (MiVue 150 Safety, ...): FILE +
// 2-digit-year YY MM DD - HHMMSS + extension, with no channel letter or
// sequence counter. YYMMDD (not DDMMYY) is confirmed against the GPS clock on
// a real sample: name 260625 == GPRMC date 2026-06-25. GPS lives in a
// same-basename `.NMEA` sidecar; the MP4 itself carries no embedded GPS.
export const RX_MIVUE = /^FILE(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(?:mp4|mov)$/i;
// MiVue SD layout splits recording mode into top-level folders (Normal/, Event/,
// Parking/; Photo/ holds JPEG snapshots, not videos). Generic names, so the mode
// technique gates on RX_MIVUE first before trusting the folder. Shared with
// hpim-mode - the HP card speaks the same Normal/Event/Parking folder language
// (Normal/ is corpus-confirmed, the other two are the standard CarDV set).
export const RX_MIVUE_PATH_MODE = /(?:^|\/)(Normal|Event|Parking)\//i;

// Action-camera clips paired to a recording-scoped @Sonygps NMEA log. The
// numeric MAH token is a monotonic clip counter; MP_ROOT/<nnn>ANV01 is the
// identifying card layout used by this log family.
export const RX_MAH_SEQUENCE = /^MAH(\d{5})\.mp4$/i;
export const RX_MAH_VIDEO_PATH = /(?:^|[\\/])MP_ROOT[\\/]\d{3}ANV01[\\/]/i;

// Juscar: 8-digit date _ 6-digit time + channel letter + .ts.
export const RX_JUSCAR = /^(\d{8})_(\d{6})([A-Z])(?:_(SOS|PARK))?\.ts$/i;
export const RX_JUSCAR_PATH_REAR = /(?:^|\/)rear\/[^/]*$/i;
export const RX_JUSCAR_PATH_FRONT = /(?:^|\/)front\/[^/]*$/i;
export const RX_JUSCAR_PATH_EVENT = /(?:^|\/)event\//i;
export const RX_JUSCAR_PATH_VIDEO = /(?:^|\/)video\//i;

// Navitel: FILE + 2-digit-year YY MM DD - HH MM SS - 6-digit sequence + optional letter.
// The .ts spelling is a 2-channel motorcycle-cam firmware that writes a plain
// ISO-BMFF file (ftyp/moov/mdat + the same IDIT/gps0 tail) under a .TS
// extension, channels split into single-letter F/ R/ folders. Extension-wise
// it cannot collide with the real MPEG-TS families: none of them start with
// "FILE".
export const RX_NAVITEL = /^FILE(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{6})([A-Z])?\.(?:mov|mp4|ts)$/i;

// Unknown-vendor camera family: 14-digit datetime + _ + 7-digit sequence +
// channel letter. Two corpora share the shape: a 3-channel `.mov` trio
// (filename-only diagnostic report; F/R/I mnemonics content-unvalidated) and
// a 2-channel `.ts` card (real files: LigoGPS/LCAI trailer at EOF, channels
// in single-letter F/ R/ folders, `_ths.jpg` thumbnails). The FitCamX
// stamp+counter language, but the 7-digit counter keeps it disjoint (FitCamX
// is a 6-digit token; both widths are anchored, neither regex backtracks
// into the other's shape), and the mandatory trailing letter keeps it off
// RX_DDPAI_NORMAL twins. The `.ts` shape carries an "embedded" gps-source
// hint (trailer); `.mov` stays unhinted on purpose - where its GPS lives is
// unknown, the default embedded probe stays on.
export const RX_MOV_SEQ_FRI = /^(\d{14})_(\d{7})([A-Z])\.(?:mov|ts)$/i;

// MP4 variant with A/C channel indices (WonVon W4K): the published sample
// pair identifies A as front and C as rear, with different seven-digit
// counters at the same timestamp. No recording-mode marker is established.
// Keep separate from MOV/TS mnemonic channels and six-digit RedTiger names.
// Other letters still identify this shape; channel confidence is separate.
export const RX_MP4_SEQ_AC = /^(\d{14})_(\d{7})([A-Z])\.mp4$/i;

// LigoGPS-trailer MPEG-TS family: 14-digit local timestamp, an opaque
// two-digit token, then an underscored channel letter. The front
// spelling and VIDEO_F folder are real-sample validated; R/I keep the
// standard mnemonic language for sibling firmwares without assigning meaning
// to the opaque token.
export const RX_LIGOGPS_TRAILER_TS = /^(\d{14})(\d{2})_([A-Z])\.ts$/i;

// Nextbase (322GW family): yyMMdd_HHmmss_NNN_<channel><quality>.MP4.
// Known channels B/F/R; quality H/L = parallel high/low-bitrate streams of the same
// lens recorded simultaneously. Upstream accepts the identical language as a
// 3-group regex ^(\d{6}_\d{6})_(\d{3})_([BFR][HL])\.MP4$ (nb-dashcam-tools
// src/clipmergewidget.cpp:194-196); ours splits the captures per field.
// Implemented from foreign source (nb-dashcam-tools); the FH (front,
// high-bitrate) shape is validated against a real 322GW-family clip - the
// other channel/quality letters remain foreign-source-only (listed
// untested-maybe for the 422/522/622GW in nb-dashcam-tools' compat table;
// unconfirmed for 512GW filenames).
export const RX_NEXTBASE = /^(\d{6})_(\d{6})_(\d{3})_([A-Z])([HL])\.mp4$/i;

// Neoline (Spectrum family, SigmaStar chipset): INF + 8-digit date - 6-digit
// time - UNPADDED sequence - channel letter. The corpus is front-only, so
// R = rear is an assumption from the mnemonic, to be revalidated on the
// first real rear sample. "INF" is likely the infinity-loop tag (unverified),
// not a mode marker - the name carries no recording mode. GPS is embedded
// (SigmaStar ssmd track; extraction is a separate primitive concern).
export const RX_NEOLINE = /^INF(\d{8})-(\d{6})-(\d+)-([A-Z])\.mp4$/i;

// RedTiger (F7NP-4K, 2-channel corpus): 14-digit datetime + _ + 6-digit card-global
// counter + channel letter + .MP4, card layout
// `CARDV/<Mode>_<channel letter>/` (Movie_F/, Movie_R/, Event_F/, Event_R/
// corpus-confirmed; Parking_* is the conventional CarDV third). The .mp4
// extension keeps it off RX_FITCAMX (the same stamp+counter+letter language
// in .ts), and the mandatory trailing letter keeps it off RX_DDPAI_NORMAL
// twins. GPS lives in plaintext YOUQINGGPS/freeGPS blocks on the F7NP-4K.
export const RX_REDTIGER = /^(\d{14})_(\d{6})([A-Z])\.mp4$/i;
// Recording-mode folder stems on a RedTiger card (the folder name is
// `<stem>_<channel letter>`). Single source for the path-mode regex and
// camera-key's parent-dir strip list (the MAI70_MODE_FOLDERS pattern).
export const REDTIGER_MODE_FOLDERS = ["movie", "event", "parking"] as const;
export const RX_REDTIGER_PATH_MODE = new RegExp(`(?:^|/)(${REDTIGER_MODE_FOLDERS.join("|")})_[a-z]/`, "i");

// Wolfbox (G900/i07 family, 1-3 channels): YYYY_MM_DD_HHMMSS_EE_C.MP4 where
// EE is a 2-digit event code (00 = normal, 02 = g-sensor event) and
// C is the channel letter (F/I/R known). SD layout: <channel>_<mode> folders
// (front_norm, front_emer, rear_norm, extra_emer, ...; extra = interior).
export const RX_WOLFBOX = /^(\d{4})_(\d{2})_(\d{2})_(\d{6})_(\d{2})_([A-Z])\.mp4$/i;
export const RX_WOLFBOX_PATH_FRONT = /(?:^|\/)front_(?:norm|emer|photo)\//i;
export const RX_WOLFBOX_PATH_REAR = /(?:^|\/)rear_(?:norm|emer|photo)\//i;
export const RX_WOLFBOX_PATH_INTERIOR = /(?:^|\/)extra_(?:norm|emer|photo)\//i;
export const RX_WOLFBOX_PATH_EVENT = /(?:^|\/)(?:front|rear|extra)_emer\//i;
export const RX_WOLFBOX_PATH_NORMAL = /(?:^|\/)(?:front|rear|extra)_norm\//i;

// Novatek family - three filename variants on the same chipset.
// VIOFO multi-channel: YYYY_MMDD_HHMMSS[_NNN]<P|E?><channel>.mp4. Mode letter:
// P = parking, E = impact event, absent = normal driving. Channel letter:
// F/R/I = front/rear/interior, T = telephoto (3-channel models pair F+R with
// either T or I). The sequence counter is OPTIONAL: T130 parking clips and
// some OEM firmwares write `..._PR.mp4` / `..._F.mp4` with no counter at all
// (real-sample-validated, freeGPS parses) - consumers must treat an undefined
// m[4] as "no sequence" (null), never NaN/0. The E and T letters are
// implemented from foreign source (viofosync web/services/scanner.py:48-66,
// web/services/naming.py:99-107), not validated against a real sample.
export const RX_NOVATEK_VIOFO = /^(\d{4})_(\d{4})_(\d{6})_(\d+)?([PE]?)([A-Z])\.mp4$/i;
// Viofo/Novatek locked-clip folder: firmware MOVES g-sensor-locked and
// manually-locked clips into DCIM/Movie/RO/ with UNCHANGED filenames, so the
// lock is not inferable from the name (viofosync web/services/scanner.py:57-63;
// a119_join.py:86-96 shows the same layout on single-channel A119). The "ro"
// segment is too short to claim files on its own - consumers must gate on a
// Novatek name regex first.
export const RX_NOVATEK_PATH_RO = /(?:^|\/)ro\//i;

/** Removes only the locked-clip leaf; callers gate on a Novatek filename. */
export function stripNovatekLockedFolder(relativePath: string): string {
    return relativePath.replace(/(^|\/)ro\/(?=[^/]+$)/i, "$1");
}

// Single-channel Novatek OEM (2E Drive, SilverStone F1, ...).
export const RX_NOVATEK_SINGLE = /^(\d{4})_(\d{4})_(\d{6})_(\d+)\.(mp4|mov)$/i;
// Novatek NVT-IM single-camera MOV variant: same split datetime + 3-digit
// counter grammar, with an optional trailing A recording-mode marker. On the
// mode-switching firmware, A is realtime driving and no suffix is parking
// time-lapse. Older no-suffix NVT-IM firmware also exists, so the missing A is
// only a CANDIDATE signal: container clock evidence must prove time compression
// before the mode changes to parking (see filename/timelapse.ts and trips.ts).
// A real sample carries only power-state `freeGPS` blocks, while related GPS
// hardware exists. Keep the spelling inside the Novatek-family probe so those
// variants can still surface records. m[5] is "A" or the empty string.
export const RX_NOVATEK_NVT_MOV = /^(\d{4})_(\d{4})_(\d{6})_(\d{3})(A?)\.mov$/i;

/** Matches the NVT-IM MOV spelling and exposes its optional mode marker. */
export function matchNovatekNvtMovFilename(name: string): RegExpMatchArray | null {
    return name.match(RX_NOVATEK_NVT_MOV);
}

/** Matches either single-camera Novatek filename spelling. */
export function matchNovatekSingleFilename(name: string): RegExpMatchArray | null {
    return matchNovatekNvtMovFilename(name) ?? name.match(RX_NOVATEK_SINGLE);
}
// Vantrue: YYYYMMDD_HHMMSS_NNNN_<N|E|P>_<A|B|C>.mp4.
export const RX_NOVATEK_VANTRUE = /^(\d{8})_(\d{6})_(\d+)_([NEP])_([A-Z])\.mp4$/i;
// Novatek MPEG-TS OEMs: 14-digit timestamp _ 6-digit counter + .ts - the
// RX_DDPAI_NORMAL name scheme in a TS container (GPS rides a private PES
// stream; extraction is a separate primitive concern). Disjoint from
// RX_FITCAMX, whose `\d{14}_\d{6}<letter>.ts` requires a trailing letter.
// Deliberately NOT part of isNovatekFamilyFilename: that predicate also feeds
// MP4-only consumers (the `novatek` hint's freeGPS semantics); TS files join
// the shared probe escalation via needsGpsProbeEscalation below instead.
export const RX_NOVATEK_TS = /^(\d{14})_(\d{6})\.ts$/i;

/**
 * Whether a filename belongs to the Novatek family (VIOFO multi-channel,
 * single-channel OEM including the NVT-IM MOV spelling, Vantrue) - the chipsets
 * that ship freeGPS blocks or share that optional-GPS firmware family.
 * Shared by the `novatek` gps-source hint and the dispatcher's marker-probe
 * escalation (registry.ts tryParseOne) so the two gates can never disagree
 * on what counts as a Novatek-family name.
 */
export function isNovatekFamilyFilename(name: string): boolean {
    return (
        RX_NOVATEK_VIOFO.test(name) ||
        RX_NOVATEK_SINGLE.test(name) ||
        RX_NOVATEK_NVT_MOV.test(name) ||
        RX_NOVATEK_VANTRUE.test(name)
    );
}

/**
 * Whether a "none"-classified file deserves the 16 MB marker re-probe before
 * giving up on embedded GPS. Owns the format list for the dispatcher's probe
 * escalation (registry.ts classifyAndWalk) so a new name shape is added HERE,
 * next to its regex, not inline in the shared gate. Members: Novatek-family
 * MP4 names (first freeGPS block can sit past the 4 MB window on high-bitrate
 * clips) and the novatek-ts TS shape (first GPS PES observed at ~3-4 MB,
 * already brushing the default window).
 */
export function needsGpsProbeEscalation(name: string): boolean {
    return isNovatekFamilyFilename(name) || RX_NOVATEK_TS.test(name);
}

// Tesla RecentClips: YYYY-MM-DD_HH-MM-SS-<camera>.mp4.
export const RX_TESLA_RECENT = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-([a-z_]+)\.mp4$/i;
// Tesla SavedClips/SentryClips: short filename (camera only); time is in the parent folder.
export const RX_TESLA_EVENT_FILENAME = /^([a-z_]+)\.mp4$/i;
export const RX_TESLA_EVENT_FOLDER = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
export const RX_TESLA_PATH = /(?:^|\/)teslacam\//i;
export const RX_TESLA_PATH_RECENT = /(?:^|\/)teslacam\/recentclips\//i;
export const RX_TESLA_PATH_SAVED = /(?:^|\/)teslacam\/savedclips\//i;
export const RX_TESLA_PATH_SENTRY = /(?:^|\/)teslacam\/sentryclips\//i;

// Thinkware: <REC|EVT|PARK|MAN>_<anything>_<channel>.mp4. No time in name.
export const RX_THINKWARE = /^(REC|EVT|PARK|MAN)_.+_([A-Z])\.mp4$/i;

// Vueroid (S1 4K Infinite): 8-digit date _ 6-digit time _ INF _ channel letter _
// N/E/P mode. Keep the observed INF infix literal until other filename
// variants are sampled; it separates this shape from other underscore names.
// N = normal is the real-sample-validated shape; E = event and P = parking
// are assumed from the mnemonic, as is the R rear channel (front-only
// corpus). No sequence counter in the name.
export const RX_VUEROID = /^(\d{8})_(\d{6})_INF_([A-Z])_([NEP])\.mp4$/i;

export const VUEROID_MODE_FOLDERS = ["inf", "event", "pevent", "park", "user"] as const;
// Match only the card folder adjoining the file, not an enclosing archive name.
export const RX_VUEROID_PATH_MODE = new RegExp(`(?:^|/)(${VUEROID_MODE_FOLDERS.join("|")})/[^/]+$`, "i");

// Generic-datetime fallback: matches any YYYYMMDDhhmmss embedded in a filename
// under any separator. Registered last in FILENAME_TIME.
export const RX_GENERIC_DATETIME = /(\d{4})[-_T]?(\d{2})[-_T]?(\d{2})[-_T ]?(\d{2})[-_:]?(\d{2})[-_:]?(\d{2})/;

// Local HHMMSS + two numeric fields + one opaque letter. The calendar date
// is available only in the channel-specific SD-card folder layout.
export const RX_SEI_DOUBLE_GPS = /^\d{6}_\d{3}_\d{3}_[A-Z]\.mp4$/i;
export const RX_SEI_DOUBLE_GPS_PATH = /(?:^|\/)(InternalView|ExteriorView)\/(\d{6})\/[^/]+$/i;

// INNOVV N2, GKU 600 Pro: date, clock and mnemonic camera suffix in separate
// tokens. GKU inserts `_GAP` before the suffix on its time-lapse clips.
// Groups: date, clock, GAP token (or undefined), channel letter.
export const RX_DATETIME_CHANNEL_TS = /^(20\d{6})_(\d{6})(?:_(GAP))?_([A-Z])\.ts$/i;
