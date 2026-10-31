// Novatek freeGPS - registry of variants for different vendors on the same
// chipset. The primary foreign source is ExifTool QuickTimeStream.pl
// (https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTimeStream.pl);
// real-sample-derived additions cite their format note at the variant.
//
// Covers: VIOFO, Vantrue, Akaso, Azdome, Kenwood, Nextbase 512GW, and many
// no-name Chinese clones. ExifTool distinguishes 12+ variants by magic
// signatures in the payload.
//
// Plugin strategy:
//  1. Scan the file for the 8-byte literal `freeGPS ` (with a space). This
//     direct-search is reliable: on some firmwares the `moov->'gps '` atom
//     structure is broken or points to the wrong place, but direct-search
//     always works (used by EgorKin/nvtk_mp4_to_gpx and ExifTool as fallback).
//  2. Pass each found block through the variant registry. The first variant
//     whose magic pattern matches parses and returns the block's records
//     (an empty array for corrupt or void data).
//
// Implemented variants: Vantrue NMEA-embedded; Type-8 recognize-and-bail
// (Akaso V1 / Redtiger F7N - coordinates encrypted, unsolved upstream);
// VIOFO/Novatek Type 3 with four sub-layouts (default / legacy / alt /
// Kenwood MN-shift) plus the IQS Type-16 int32 sub-variant of the default
// layout; and a batch of ExifTool-derived variants (Azdome XOR Type 1,
// Vantrue S1 horsontech Type 10, sub-16 RMC cipher Type 7/9, XGODY ASCII
// Type 18, E-ACE RC4 Type 4, Akaso plain-float Type 6, YOUQINGGPS,
// Novatek doubles Type 12, Nextbase 512G '$S' Type 20) - see the foreign-source banner
// further down. Blocks no variant claims can additionally go through the
// backward anchor-scan fallback (createFreeGpsBlockParser) that discovers
// non-standard Type-3 base offsets dynamically. The registry architecture
// keeps additions purely additive - existing variants are not modified.

import { throwIfCancelled } from "../../abort-signals.js";
import { extendArray } from "../../array-extend.js";
import { concat } from "../../bytes.js";
import { type GpsRecord, KMH_TO_MS, KNOTS_TO_MS, type ParsedRecords, type SkippedLine } from "../types.js";
import { utcMillisecondsFromParts, utcSecondsFromYmdhms } from "./calendar.js";
import { matchesBytesAt, findByteSequence } from "./byte-search.js";
import { ddmmToDegrees, isCoordinateInRange } from "./ddmm.js";
import { hasAsxtFreeGpsSignature, parseAsxtFreeGps, readAsxtWallClock } from "./freegps-asxt.js";
import { decodeXorAsciiGpsText, decryptXorAscii } from "./xor-ascii-gps.js";
import type { Mp4Index } from "./mp4-index.js";
import { parseNmeaText } from "./nmea.js";

// Literal that starts every freeGPS block.
const FREE_GPS_MAGIC = "freeGPS ";
const FREE_GPS_MAGIC_BYTES = new TextEncoder().encode(FREE_GPS_MAGIC);

/** freeGPS payload window read per block. parseFreeGpsBlock reads only as many
 *  bytes as a layout needs; the rest is slack so a block never straddles two
 *  reads. Same value across the linear and jump scan paths. */
const BLOCK_PAYLOAD_SIZE = 0x8000; // 32 KB

interface FreeGpsVariant {
    /** Variant name for logs (e.g. "VIOFO Type 3"). */
    name: string;
    /** The parser scans beyond the structural path's 1 KiB probe. */
    needsWholeAtom?: boolean;
    /**
     * Returns true if this variant can parse the payload. Payload starts
     * with FREE_GPS_MAGIC (8 bytes).
     */
    matches(payload: DataView): boolean;
    /**
     * Parses payload into zero or more GpsRecords. An empty array means
     * corrupt or void data (magic matched but fields invalid / no fix) -
     * caller records a skipped entry and moves on. Most variants carry one
     * record per block; the array contract exists for multi-record blocks
     * (NMEA text with several sentences, ring-buffer formats).
     *
     * `options` carries the per-file flags from createFreeGpsBlockParser
     * (currently only the Rexing affine gate, consumed by the Type-3
     * variant). Variants that need no flags simply omit the parameter.
     *
     * `boxSizeDword` is the raw LE dword sitting at literal -4 (the MP4 box
     * size the payload window deliberately excludes) - undefined when the
     * read did not reach back that far. Only the Transcend DB70 gate needs
     * it; see isTranscendDb70Block.
     */
    parse(
        payload: DataView,
        mp4Filename: string,
        options?: CreateFreeGpsBlockParserOptions,
        boxSizeDword?: number,
    ): GpsRecord[];
}

/**
 * VIOFO/Novatek Type 3 - three sub-layouts with different base offsets.
 *
 * Byte-layout sources:
 *  - EgorKin/nvtk_mp42gpx_EgorKin_mod.py: dispatches on uint32 LE at pos 12
 *    of `data` (where `data = literal-4`): 0x58 → offset 0x30 (default A229);
 *    0x3F0/0x2C → offset 0x10 (A129 Plus / A229 newer FW).
 *    data+0x30 = literal+44 (default datetime); data+0x10 = literal+12 (alt).
 *  - ExifTool QuickTimeStream.pl ProcessFreeGPS (Type 3, regex
 *    `^(.{37}|.{85})\0\0\0A([NS])([EW])\0` - the regex runs on dataPt
 *    starting at the atom size dword, so literal = dataPt - 4): the
 *    37-prefix variant puts 'A' at dataPt 40 = literal 36, datetime
 *    (unpack 'x16V6') at literal 12, lat (GetFloat 0x2c) at literal 40 -
 *    that is LAYOUT_ALT, not LAYOUT_LEGACY.
 *  - Sergei.nz: "offsets 48 and 16 have been used in different firmware
 *    versions" - offsets in a buffer that also starts at the size dword,
 *    i.e. literal 44 and 12 = LAYOUT_DEFAULT and LAYOUT_ALT again.
 *  - 2E Drive 730 / SilverStone F1 A80 (real samples in private):
 *    confirmed datetime@44, active@68, lat@72 (= EgorKin default).
 *  - LAYOUT_LEGACY (datetime@16, anchor 40) has NO verifiable upstream
 *    attribution after re-deriving the sources above - it is the canonical
 *    record geometry at anchor 40, kept for backward compatibility with
 *    whatever firmware originally motivated it (signature-gated, so it
 *    costs nothing when absent).
 *
 * Layout selection is signature-based ('A'/'V' + N/S + E/W). Layouts are
 * tried most-common first; the first passing signature check wins.
 *
 *   LAYOUT_DEFAULT (EgorKin default, 2E Drive / SilverStone / VIOFO A229):
 *     [44..67]  datetime H,M,S,Y,mo,d (6 x uint32 LE)
 *     [68]      'A'/'V' active flag
 *     [69]      'N'/'S' lat hemisphere
 *     [70]      'E'/'W' lon hemisphere
 *     [71]      unknown2
 *     [72..75]  lat float32 LE (DDDmm.mmmm)
 *     [76..79]  lon float32 LE
 *     [80..83]  speed float32 LE (knots)
 *     [84..87]  course float32 LE
 *     accel not defined in this layout.
 *
 *   LAYOUT_LEGACY (no verified upstream attribution - see the source notes
 *   above; canonical anchor-40 geometry kept for backward compatibility):
 *     [16..39]  datetime H,M,S,Y,mo,d
 *     [40]      'A'/'V'
 *     [41]      'N'/'S'
 *     [42]      'E'/'W'
 *     [43]      unknown2
 *     [44..47]  lat float32 LE
 *     [48..51]  lon float32 LE
 *     [52..55]  speed float32 LE
 *     [56..59]  course float32 LE
 *     [60..71]  accel x,y,z (3 x int32 LE), divisor 256 (g)
 *
 *   LAYOUT_ALT (EgorKin alt, A129 Plus / A229 newer FW):
 *     [12..35]  datetime
 *     [36]      'A'/'V'
 *     [37..38]  NS, EW
 *     [40..43]  lat float32 LE
 *     [44..47]  lon
 *     [48..51]  speed
 *     [52..55]  course
 *
 *   LAYOUT_KENWOOD_MN (ExifTool Type-3 `.{85}` branch, Kenwood DRV-A510W -
 *   the standard record shifted +48 by a longer vendor header; implemented
 *   from foreign source (ExifTool QuickTimeStream.pl:1752-1764, v13.59), not
 *   validated against a real sample):
 *     [12..]    'MN:DRV-A510W@V1.x..::start@' vendor banner in the lone
 *               upstream hexdump. NOT part of the signature: ExifTool's own
 *               gate is purely positional and the '::start@' suffix suggests
 *               a stream-start banner that may not repeat in every block.
 *     [60..83]  datetime H,M,S,Y,mo,d (6 x uint32 LE)
 *     [81..83]  always 0 (day <= 31, so the day field's high bytes are the
 *               positional gate together with [87])
 *     [84]      'A'/'V'   [85] 'N'/'S'   [86] 'E'/'W'   [87] 0
 *     [88..91]  lat float32 LE (DDDmm.mmmm)
 *     [92..95]  lon float32 LE
 *     [96..99]  speed float32 LE (knots)
 *     [100..103] course float32 LE
 *     [104..115] accel x,y,z (3 x int32 LE, /256 g) - optional tail; the
 *               firmware writes all-zero or an int16 counter
 *               01 00 02 00 .. 06 00 as a "no G-sensor data" placeholder
 *               (ExifTool QuickTimeStream.pl:1804-1807).
 */

interface FieldLayout {
    name: string;
    datetime: number; // base offset from literal start (H field of datetime)
    active: number;
    ns: number;
    ew: number;
    lat: number;
    lon: number;
    speed: number;
    course: number;
    accelX: number | null; // null if accelerometer is not defined in this layout
    accelY: number | null;
    accelZ: number | null;
    minPayloadLength: number;
}

const LAYOUT_DEFAULT: FieldLayout = {
    name: "default",
    datetime: 44,
    active: 68,
    ns: 69,
    ew: 70,
    lat: 72,
    lon: 76,
    speed: 80,
    course: 84,
    accelX: null,
    accelY: null,
    accelZ: null,
    minPayloadLength: 88,
};

const LAYOUT_LEGACY: FieldLayout = {
    name: "legacy",
    datetime: 16,
    active: 40,
    ns: 41,
    ew: 42,
    lat: 44,
    lon: 48,
    speed: 52,
    course: 56,
    accelX: 60,
    accelY: 64,
    accelZ: 68,
    minPayloadLength: 72,
};

const LAYOUT_ALT: FieldLayout = {
    name: "alt",
    datetime: 12,
    active: 36,
    ns: 37,
    ew: 38,
    lat: 40,
    lon: 44,
    speed: 48,
    course: 52,
    accelX: null,
    accelY: null,
    accelZ: null,
    minPayloadLength: 56,
};

const LAYOUT_KENWOOD_MN: FieldLayout = {
    name: "kenwood-mn",
    datetime: 60,
    active: 84,
    ns: 85,
    ew: 86,
    lat: 88,
    lon: 92,
    speed: 96,
    course: 100,
    // Accel exists at [104..115] but is optional and placeholder-guarded -
    // handled by readKenwoodAccel in parseType3Block, not the generic path.
    accelX: null,
    accelY: null,
    accelZ: null,
    minPayloadLength: 104,
};

// Kenwood positional gate, from ExifTool's Type-3 regex
// /^(.{37}|.{85})\0\0\0A([NS])([EW])\0/ (QuickTimeStream.pl:1752, v13.59):
// three zero bytes right before the status triple plus the zero pad after it.
// hasValidSignature(LAYOUT_KENWOOD_MN) must pass first (it guarantees
// byteLength >= 104, so these reads are in bounds).
function hasKenwoodZeroGate(payload: DataView): boolean {
    return (
        payload.getUint8(81) === 0 &&
        payload.getUint8(82) === 0 &&
        payload.getUint8(83) === 0 &&
        payload.getUint8(87) === 0
    );
}

function hasValidSignature(payload: DataView, layout: FieldLayout): boolean {
    if (payload.byteLength < layout.minPayloadLength) return false;
    const fix = payload.getUint8(layout.active);
    if (fix !== 0x41 && fix !== 0x56) return false; // 'A' or 'V'
    const ns = payload.getUint8(layout.ns);
    if (ns !== 0x4e && ns !== 0x53) return false;
    const ew = payload.getUint8(layout.ew);
    if (ew !== 0x45 && ew !== 0x57) return false;
    return true;
}

// Fixed Type-3 sub-layouts in pickLayout's frequency order. Shared by the
// signature dispatch and the cold-start pre-fix datetime collection, which
// must probe the same geometries.
const TYPE3_LAYOUTS: readonly FieldLayout[] = [LAYOUT_DEFAULT, LAYOUT_LEGACY, LAYOUT_ALT, LAYOUT_KENWOOD_MN];

function pickLayout(payload: DataView): FieldLayout | null {
    // Try layouts in order of real-world frequency: default (datetime@44) is
    // most common (2E Drive, SilverStone, VIOFO A229), legacy (datetime@16)
    // for old VIOFO A119 / Sergei script files, alt (datetime@12) for rare
    // VIOFO A129 Plus / A229 newer FW, kenwood-mn (datetime@60) last. A
    // Kenwood block cannot alias the first three: at their signature offsets
    // it carries datetime bytes whose ranges (sec <= 59 etc.) never produce
    // 'A'/'V', and zero bytes from the header padding.
    if (hasValidSignature(payload, LAYOUT_DEFAULT)) return LAYOUT_DEFAULT;
    if (hasValidSignature(payload, LAYOUT_LEGACY)) return LAYOUT_LEGACY;
    if (hasValidSignature(payload, LAYOUT_ALT)) return LAYOUT_ALT;
    if (hasValidSignature(payload, LAYOUT_KENWOOD_MN) && hasKenwoodZeroGate(payload)) return LAYOUT_KENWOOD_MN;
    return null;
}

/**
 * Reads the 6 x u32 LE Type-3 datetime (H,M,S,Y,mo,d) at the layout's base
 * offset and validates it through the shared calendar gate. Returns null when
 * the window is too short or any field is out of range. `yearRaw` is the
 * stored year before the 2-digit expansion - the Kenwood local-clock
 * quarantine keys on it.
 */
function readType3Datetime(payload: DataView, layout: FieldLayout): { unixSeconds: number; yearRaw: number } | null {
    if (payload.byteLength < layout.datetime + 24) return null;
    const h = payload.getUint32(layout.datetime, true);
    const mi = payload.getUint32(layout.datetime + 4, true);
    const s = payload.getUint32(layout.datetime + 8, true);
    const y = payload.getUint32(layout.datetime + 12, true);
    const mo = payload.getUint32(layout.datetime + 16, true);
    const d = payload.getUint32(layout.datetime + 20, true);
    const unixSeconds = utcSecondsFromYmdhms(y, mo, d, h, mi, s);
    if (unixSeconds === null) return null;
    return { unixSeconds, yearRaw: y };
}

/** Returns true when `text` (ASCII) sits at `offset` of the payload. */
function hasAsciiAt(payload: DataView, offset: number, text: string): boolean {
    if (payload.byteLength < offset + text.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (payload.getUint8(offset + i) !== text.charCodeAt(i)) return false;
    }
    return true;
}

// 'IQS' header marker offset (literal 12 = atom 16, e.g. "IQS_A7_20150417").
// ExifTool QuickTimeStream.pl:2298 (v13.59) selects the int32 sub-variant by
// the same string check.
const IQS_MARKER_OFFSET = 12;
// 'ATC' marker offset (literal 65 = atom 0x45) - ExifTool Type-11 gate,
// QuickTimeStream.pl:2047 (v13.59).
const ATC_MARKER_OFFSET = 65;

/**
 * IQS int32 sub-variant of LAYOUT_DEFAULT - ExifTool GPSType 16
 * (QuickTimeStream.pl:2298-2309, v13.59). Same datetime/status offsets as the
 * default float layout, but the coordinate fields are integers:
 *   [72..75] lat int32 LE, decimal degrees * 1e7 (NOT DDDmm.mmmm)
 *   [76..79] lon int32 LE, decimal degrees * 1e7
 *   [80..83] speed int32 LE, m/s * 100 (NOT knots)
 *   [84..87] altitude float32 LE, m * 1000 - dropped, no GpsRecord field;
 *            note this is NOT a course in this sub-variant.
 * Without this branch the int32s reinterpreted as float32 are denormals ~0
 * that PASS the ddmm range checks, so a real IQS file used to emit a
 * systematic (0,0) track. Implemented from foreign source (ExifTool 13.59),
 * not validated against a real sample.
 */
function parseIqsFields(
    payload: DataView,
    ns: number,
    ew: number,
    unixSeconds: number,
    mp4Filename: string,
): GpsRecord | null {
    // ATC exclusion is mandatory: Type-11 ATC ring-buffer blocks
    // (QuickTimeStream.pl:2047) carry the same 'IQS...' header string
    // ("IQS20130306B", :2052) but an entirely different record format we do
    // not decode - bail instead of emitting garbage.
    if (hasAsciiAt(payload, ATC_MARKER_OFFSET, "ATC")) return null;

    // Math.abs before the hemisphere sign (ExifTool uses `abs Get32s`): some
    // firmware stores the int32 already signed - applying the N/S/E/W sign on
    // top of a signed value would double-negate the hemisphere.
    const lat = (Math.abs(payload.getInt32(72, true)) / 1e7) * ns;
    const lon = (Math.abs(payload.getInt32(76, true)) / 1e7) * ew;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;
    const speedMs = payload.getInt32(80, true) / 100;
    // A negative "speed" means these bytes are not the IQS layout after all.
    if (speedMs < 0) return null;

    return {
        unixSeconds,
        active: true,
        lat,
        lon,
        // Literal 84 is altitude here, not course. Bearing 0 is forward-filled
        // downstream (forwardFillBearingsIfAllZero) - same convention as
        // ligogps / pndm / gps-box-70mai.
        bearingDeg: 0,
        speedMs,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

// Kenwood accel triple at literal [104..115] (3 x int32 LE, /256 g) -
// ExifTool reads it at offset 60 of the 48-shifted dataPt
// (QuickTimeStream.pl:1804-1807, v13.59) and ignores two "no G-sensor data"
// placeholder patterns: all zeros and the int16 counter 01 00 02 00 .. 06 00.
const KENWOOD_ACCEL_OFFSET = 104;
const KENWOOD_ACCEL_END = KENWOOD_ACCEL_OFFSET + 12;
const KENWOOD_ACCEL_COUNTER = [0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00];

function readKenwoodAccel(payload: DataView): [number, number, number] {
    if (payload.byteLength < KENWOOD_ACCEL_END) return [0, 0, 0];
    let allZero = true;
    let isCounter = true;
    for (let i = 0; i < 12; i++) {
        const b = payload.getUint8(KENWOOD_ACCEL_OFFSET + i);
        if (b !== 0) allZero = false;
        if (b !== KENWOOD_ACCEL_COUNTER[i]) isCounter = false;
    }
    if (allZero || isCounter) return [0, 0, 0];
    return [
        payload.getInt32(KENWOOD_ACCEL_OFFSET, true) / 256,
        payload.getInt32(KENWOOD_ACCEL_OFFSET + 4, true) / 256,
        payload.getInt32(KENWOOD_ACCEL_OFFSET + 8, true) / 256,
    ];
}

// ===== Rexing V1-4K affine deobfuscation (ExifTool GPSType 17b) =====
//
// Rexing V1-4K / JMSPlayer firmware writes LAYOUT_DEFAULT blocks whose float
// coordinates are obfuscated by an affine transform; the inverse is
//   lat = (latRaw - 187.982162849635) / 3
//   lon = (lonRaw - 2199.19873715495) / 2
// and the results are ALREADY decimal degrees - ddmmToDegrees must be
// skipped; the hemisphere sign still applies afterwards. Constants and the
// KodakVersion gate: ExifTool QuickTimeStream.pl:2315-2330 (v13.59);
// independently confirmed by sergei.nz's JMSPlayer-DLL decompilation
// (0x40677f6defc7a398 = float64 187.98217... = the same lat bias).
//
// The gate is EXACT-MATCH ONLY, no heuristic fallback: obfuscated raw values
// overlap the valid DDmm range (raw 250 is both a valid 2deg50min and an
// obfuscated 20.67deg), so shape-based auto-detection would corrupt genuine
// Type-3 files. This mirrors ExifTool, which keys solely on the version
// string. Firmware other than 3.01.054 keeps the plain DDmm decode (and
// produces the same silent garbage ExifTool would - a known, documented gap
// until a sample proves another version string).
//
// Implemented from foreign source (ExifTool 13.59 QuickTimeStream.pl:
// 2315-2330), not validated against a real sample.
const REXING_LAT_BIAS = 187.982162849635;
const REXING_LON_BIAS = 2199.19873715495;
/** KodakVersion string (Mp4Index.kodakVersion, from the top-level frea/'ver '
 *  atom) that identifies the obfuscating Rexing firmware. */
export const REXING_KODAK_VERSION = "3.01.054";

// ===== Transcend Drive Body Camera 70 (ExifTool GPSType 17c) =====
//
// Byte-identical to LAYOUT_DEFAULT except the two unit conventions: the
// coordinate floats are ALREADY decimal degrees (ddmmToDegrees must be
// skipped) and the speed float is ALREADY km/h, not knots. Decoded as a plain
// Type 3 the block yields a plausible-looking track near (0.5, 0.5) - a real
// 29.7deg latitude read as DDmm is 29.7 minutes - which is why this needs a
// positive gate rather than a range sanity check.
//
// The gate is the box-size dword, i.e. the four bytes the payload window
// starts AFTER: `00 00 40 00`, which is the big-endian box size 0x4000 read
// little-endian - NOT a "4 MB atom". That is an ordinary 16 KB freeGPS atom,
// so the dword is weak on its own (70mai A810 carries the identical prefix
// and stays safe only by routing through its own primitive first). The
// discrimination is really carried by the companion range check: a genuine
// Type-3 stores DDmm, where anything outside the equator band reads well
// above 90. Residual overlap - a real DDmm pair that also passes as degrees -
// needs latitude 0..1.5deg AND longitude 0..3deg, i.e. open water in the Gulf
// of Guinea. Upstream has the same exposure; accepted rather than widened.
// Without the dword (a read that could not reach back 4 bytes) the block
// stays on the plain Type-3 path.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2328-2338),
// not validated against a real sample.
const TRANSCEND_DB70_BOX_SIZE_DWORD = 0x400000;

function isTranscendDb70Block(
    layout: FieldLayout,
    boxSizeDword: number | undefined,
    latRaw: number,
    lonRaw: number,
): boolean {
    if (layout !== LAYOUT_DEFAULT) return false;
    if (boxSizeDword !== TRANSCEND_DB70_BOX_SIZE_DWORD) return false;
    return Math.abs(latRaw) <= 90 && Math.abs(lonRaw) <= 180;
}

// ===== Transcend DrivePro 230 f64 coordinate upgrade =====
//
// The same Type-3 block optionally repeats lat/lon as float64 at literal
// 108/124, in the SAME units as the float32 pair it duplicates (DDmm on a
// plain Type 3, decimal degrees once a 17b/17c branch has converted) - so the
// upgrade is applied before the ddmm conversion, exactly where ExifTool
// applies it.
//
// Upstream gates on the atom length (dirLen >= 0xb0); our payload window is a
// fixed 32 KB slice, not the atom, so that gate degenerates to "the window is
// long enough" and the agreement test carries ALL the discrimination: a
// double is accepted only when it lands within 0.001 deg of the float32 the
// block already parsed. Random bytes at those offsets essentially never do.
// The altitude double at literal 156 is read by ExifTool but has no
// GpsRecord field here, so it is deliberately dropped.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2344-2352),
// not validated against a real sample.
const DRIVEPRO_LAT_DOUBLE_OFFSET = 108;
const DRIVEPRO_LON_DOUBLE_OFFSET = 124;
const DRIVEPRO_DOUBLES_MIN_PAYLOAD = DRIVEPRO_LON_DOUBLE_OFFSET + 8;
const DRIVEPRO_AGREEMENT_DEG = 0.001;

/**
 * Returns the float64 lat/lon pair when it agrees with the already-parsed
 * float32 pair within DRIVEPRO_AGREEMENT_DEG, otherwise null (block carries
 * no doubles, or the bytes at those offsets are something else).
 */
function readDriveProDoubles(payload: DataView, lat: number, lon: number): [number, number] | null {
    if (payload.byteLength < DRIVEPRO_DOUBLES_MIN_PAYLOAD) return null;
    const lat2 = payload.getFloat64(DRIVEPRO_LAT_DOUBLE_OFFSET, true);
    const lon2 = payload.getFloat64(DRIVEPRO_LON_DOUBLE_OFFSET, true);
    if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) return null;
    if (Math.abs(lat2 - lat) >= DRIVEPRO_AGREEMENT_DEG) return null;
    if (Math.abs(lon2 - lon) >= DRIVEPRO_AGREEMENT_DEG) return null;
    return [lat2, lon2];
}

/** Per-block decode flags for parseType3Block. */
interface Type3BlockOptions {
    /**
     * Rexing V1-4K affine deobfuscation (ExifTool GPSType 17b). Set by the
     * freegps primitive when Mp4Index.kodakVersion === REXING_KODAK_VERSION.
     */
    rexingAffine?: boolean;
    /**
     * Quarantine absolute-year (y >= 2000) records as timeUnsynced. Set on
     * the anchor-scan path, where the layout was discovered rather than
     * recognized - see the note at the timeUnsynced assignment below.
     */
    absoluteYearIsLocalClock?: boolean;
    /** Raw LE dword at literal -4; see isTranscendDb70Block. */
    boxSizeDword?: number;
}

function parseType3Block(
    payload: DataView,
    layout: FieldLayout,
    mp4Filename: string,
    blockOptions: Type3BlockOptions = {},
): GpsRecord | null {
    const { rexingAffine = false, absoluteYearIsLocalClock = false, boxSizeDword } = blockOptions;
    // Bounds armor: the registry variants reach here through
    // hasValidSignature (which enforces minPayloadLength), but the
    // anchor-scan PINNED path does not - a truncated tail block (power-loss
    // recording) or a short structural-table entry would otherwise throw
    // RangeError past byteLength and lose the whole file's records
    // (registry.ts discards on a non-WrongFormatError).
    if (payload.byteLength < layout.minPayloadLength) return null;
    const fix = payload.getUint8(layout.active);
    if (fix !== 0x41) return null; // 'V' = void/no fix, skip

    const ns = payload.getUint8(layout.ns) === 0x4e ? 1 : -1;
    const ew = payload.getUint8(layout.ew) === 0x45 ? 1 : -1;

    // VIOFO writes 2-digit year (21 = 2021); the shared helper expands it.
    const datetime = readType3Datetime(payload, layout);
    if (datetime === null) return null;
    const { unixSeconds, yearRaw: y } = datetime;

    // IQS int32 sub-variant - gated on LAYOUT_DEFAULT identity: in other
    // layouts literal 12 is data (e.g. the LAYOUT_ALT datetime hour field),
    // so the string check would be meaningless there.
    if (layout === LAYOUT_DEFAULT && hasAsciiAt(payload, IQS_MARKER_OFFSET, "IQS")) {
        return parseIqsFields(payload, ns, ew, unixSeconds, mp4Filename);
    }

    const latRaw = payload.getFloat32(layout.lat, true);
    const lonRaw = payload.getFloat32(layout.lon, true);
    // Knots on every layout except the Transcend DB70 branch below, which
    // writes km/h into the same field - hence the unit-neutral name.
    const speedRaw = payload.getFloat32(layout.speed, true);
    const heading = payload.getFloat32(layout.course, true);
    if (![latRaw, lonRaw, speedRaw, heading].every(Number.isFinite)) return null;

    // Both deobfuscating branches are scoped to LAYOUT_DEFAULT - ExifTool's
    // are nested inside the x48-unpack (= datetime@44) decode only. Each
    // yields decimal degrees, so ddmmToDegrees is skipped for them; the
    // hemisphere sign applies after either way.
    let latValue = latRaw;
    let lonValue = lonRaw;
    let alreadyDegrees = false;
    let speedIsKmh = false;
    if (rexingAffine && layout === LAYOUT_DEFAULT) {
        latValue = (latRaw - REXING_LAT_BIAS) / 3;
        lonValue = (lonRaw - REXING_LON_BIAS) / 2;
        alreadyDegrees = true;
    } else if (isTranscendDb70Block(layout, boxSizeDword, latRaw, lonRaw)) {
        alreadyDegrees = true;
        speedIsKmh = true;
    }

    // Precision upgrade against the values as they stand now (still DDmm on a
    // plain Type 3), mirroring where upstream applies it.
    const doubles = readDriveProDoubles(payload, latValue, lonValue);
    if (doubles) [latValue, lonValue] = doubles;

    const lat = (alreadyDegrees ? latValue : ddmmToDegrees(latValue)) * ns;
    const lon = (alreadyDegrees ? lonValue : ddmmToDegrees(lonValue)) * ew;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;

    let accelXg = 0;
    let accelYg = 0;
    let accelZg = 0;
    if (layout === LAYOUT_KENWOOD_MN) {
        [accelXg, accelYg, accelZg] = readKenwoodAccel(payload);
    } else if (layout.accelX !== null && layout.accelY !== null && layout.accelZ !== null) {
        accelXg = payload.getInt32(layout.accelX, true) / 256;
        accelYg = payload.getInt32(layout.accelY, true) / 256;
        accelZg = payload.getInt32(layout.accelZ, true) / 256;
    }

    const record: GpsRecord = {
        unixSeconds,
        active: true,
        lat,
        lon,
        bearingDeg: heading,
        speedMs: speedRaw * (speedIsKmh ? KMH_TO_MS : KNOTS_TO_MS),
        accelXg,
        accelYg,
        accelZg,
        mp4Filename,
    };
    // Kenwood firmware sometimes writes an absolute year with LOCAL wall-clock
    // time, sometimes year-since-2000 with UTC - in the same video (ExifTool
    // QuickTimeStream.pl:1788-1791, v13.59). We cannot know the camera's zone,
    // so absolute-year records are flagged timeUnsynced: the time layer skips
    // them for TZ/start inference and re-anchors them onto the video window
    // instead of poisoning per-fingerprint TZ math with local-as-UTC stamps.
    // Documented limitation (n=1 sample upstream): on a mixed local/UTC file
    // the re-anchor spreads the local-clock records evenly, losing their
    // per-record absolute time. Scoped to LAYOUT_KENWOOD_MN plus anchor-scan
    // layouts (absoluteYearIsLocalClock, set by parseAtAnchor): a
    // Kenwood-shaped block that misses a fixed-layout byte gate (firmware
    // drift) re-enters via the anchor scan at the same geometry and must get
    // the same quarantine, or its local-as-UTC stamps poison
    // estimateTzByFingerprint. ExifTool applies the yr >= 2000 local-time
    // conversion to its ENTIRE Type-3 branch (QuickTimeStream.pl:1788-1791),
    // so no absolute-year-UTC writer is known in this geometry. The trusted
    // fixed layouts (default/legacy/alt) keep absolute years as genuine UTC.
    if ((layout === LAYOUT_KENWOOD_MN || absoluteYearIsLocalClock) && y >= 2000) {
        record.timeUnsynced = true;
    }
    return record;
}

const variantViofoType3: FreeGpsVariant = {
    name: "VIOFO Type 3",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        return pickLayout(payload) !== null;
    },
    parse(payload, mp4Filename, options, boxSizeDword) {
        const layout = pickLayout(payload);
        if (!layout) return [];
        const record = parseType3Block(payload, layout, mp4Filename, {
            rexingAffine: options?.rexingAffine === true,
            boxSizeDword,
        });
        return record ? [record] : [];
    },
};

/**
 * YOUQINGGPS plaintext layout. Its datetime/status geometry is a byte-exact
 * Type-8/Type-3 alias, so the 10-byte banner is the ownership gate and this
 * variant must stay before both of those registry entries.
 *
 * The receiver clock at [44..67] is UTC. A second clock near the block tail
 * mirrors the camera-local OSD time; using it here would bake the camera's
 * timezone into the track. Coordinates are DDmm.mmmm floats, speed is knots.
 * Full evidence and layout notes: docs/format-youqing.md.
 */
const variantYouqing: FreeGpsVariant = {
    name: "YOUQINGGPS",
    matches(payload) {
        return matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES) && hasAsciiAt(payload, 12, "YOUQINGGPS");
    },
    parse(payload, mp4Filename) {
        if (payload.byteLength < 100) return [];

        const fix = payload.getUint8(68);
        if (fix !== 0x41) return []; // 'V' = void/no fix
        const nsByte = payload.getUint8(69);
        const ewByte = payload.getUint8(70);
        if ((nsByte !== 0x4e && nsByte !== 0x53) || (ewByte !== 0x45 && ewByte !== 0x57)) return [];

        const datetime = readType3Datetime(payload, LAYOUT_DEFAULT);
        if (datetime === null) return [];

        const latRaw = payload.getFloat32(36, true);
        const lonRaw = payload.getFloat32(40, true);
        const speedKnots = payload.getFloat32(92, true);
        const heading = payload.getFloat32(96, true);
        if (![latRaw, lonRaw, speedKnots, heading].every(Number.isFinite)) return [];
        if (latRaw < 0 || lonRaw < 0 || speedKnots < 0 || heading < 0 || heading > 360) return [];

        const lat = ddmmToDegrees(latRaw) * (nsByte === 0x4e ? 1 : -1);
        const lon = ddmmToDegrees(lonRaw) * (ewByte === 0x45 ? 1 : -1);
        if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return [];

        return [
            {
                unixSeconds: datetime.unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg: heading,
                speedMs: speedKnots * KNOTS_TO_MS,
                accelXg: 0,
                accelYg: 0,
                accelZg: 0,
                mp4Filename,
            },
        ];
    },
};

/**
 * Akaso V1 / Redtiger F7N "encrypted" blocks - ExifTool GPSType 8
 * (QuickTimeStream.pl:1961-1989, v13.59). The shape is a byte-exact alias of
 * LAYOUT_DEFAULT: a fully valid datetime at literal 44-67 and 'A'[NS][EW] at
 * 68-70. But the real coordinates live in two ENCRYPTED float64s at literal
 * 76-91 (encryption unsolved upstream - ExifTool warns the values are wrong).
 * Decoded as LAYOUT_DEFAULT floats, literal 72-75 (the \0{5} run) reads as
 * bit-exact 0.0 latitude while 76-79 reads half of the encrypted double:
 * ~55% of such garbage lon floats survive the |ddmm| <= 180 gate, so a real
 * Type-8 file used to emit a visible bogus (0, garbage) track with valid
 * timestamps. Recognize-and-bail (Miltona gps0 precedent): matches() claims
 * the block, parse() returns [] so it lands in skipped[]. A whole-file miss
 * surfaces as the "no variant matched" WrongFormatError on the streaming
 * path, or as an empty-records result with skipped entries on the
 * structural path - the dispatcher treats both the same
 * (dispatchParseVideoEmbeddedGps continues to the next primitive on empty
 * records).
 *
 * Do not try to crack the cipher: the vendor apps (AkasoCar, ANKEWAY) decode
 * GPS through an internet service, so the key lives on a vendor server. Even a
 * solved cipher would need a backend, which this project does not have.
 *
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantAkasoType8Encrypted: FreeGpsVariant = {
    name: "Akaso/Redtiger Type 8 (encrypted, recognize-and-bail)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        return isType8EncryptedShape(payload);
    },
    parse() {
        return []; // coordinates undecodable upstream - never emit records
    },
};

// ExifTool's Type-8 regex /^.{64}[\x01-\x0c]\0{3}[\x01-\x1f]\0{3}A[NS][EW]\0{5}/
// (QuickTimeStream.pl:1961) translated to literal offsets (the regex runs on
// the atom including its 4-byte size prefix, so literal = atom - 4):
// month u32 LE in 1..12 at 60, day u32 LE in 1..31 at 64, 'A' at 68 (the
// regex has no 'V' form), [NS] at 69, [EW] at 70, then FIVE zero bytes at
// 71..75. The zero run is the discriminator against a genuine LAYOUT_DEFAULT
// fix, where bytes 72-75 hold a nonzero DDDmm.mmmm latitude float.
function isType8EncryptedShape(payload: DataView): boolean {
    if (payload.byteLength < 76) return false;
    const month = payload.getUint32(60, true);
    if (month < 1 || month > 12) return false;
    const day = payload.getUint32(64, true);
    if (day < 1 || day > 31) return false;
    if (payload.getUint8(68) !== 0x41) return false; // 'A'
    const ns = payload.getUint8(69);
    if (ns !== 0x4e && ns !== 0x53) return false; // 'N'/'S'
    const ew = payload.getUint8(70);
    if (ew !== 0x45 && ew !== 0x57) return false; // 'E'/'W'
    for (let i = 71; i < 76; i++) {
        if (payload.getUint8(i) !== 0) return false;
    }
    return true;
}

/** Registry name of the Vantrue embedded-NMEA variant. Its Type-15 accel is
 *  gravity-included, so the primitive keys the per-file baseline removal on
 *  it (see GRAVITY_INCLUDED_VARIANT_NAMES). */
export const VANTRUE_NMEA_VARIANT_NAME = "Vantrue NMEA-embedded";

/**
 * Vantrue N2X embedded-NMEA variant. On a real Vantrue N2X sample
 * (private/incoming/Vantrue N2X) freeGPS blocks carry an embedded
 * NMEA RMC sentence at a fixed offset ~100 from the literal start rather than
 * the canonical Type 3/Type 10 binary layout. Using the shared parseNmeaText
 * avoids duplicating the decode logic.
 *
 * This does NOT match the ExifTool Type 10 spec - that one is the Vantrue S1
 * (covered separately by variantHorsontech below). The N2X block shape is the
 * ExifTool Type-15 family (lat/lon doubles + datetime at literal 16..99 with
 * the redundant RMC tail we parse). The fix itself comes from the
 * sample-validated NMEA path; of the binary preamble only the accel triple is
 * decoded (readVantrueType15Accel below), from the upstream spec rather than
 * from the sample, whose binary half is not anonymization-consistent with its
 * RMC.
 */
const variantVantrueNmea: FreeGpsVariant = {
    name: VANTRUE_NMEA_VARIANT_NAME,
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        return findNmeaRmcStart(payload) !== null;
    },
    parse(payload, mp4Filename) {
        const start = findNmeaRmcStart(payload);
        if (start === null) return [];
        const text = readAsciiUntilTerminator(payload, start);
        // Return every record the text yields, not just the first - the
        // multi-record contract keeps the tail if a block ever carries more
        // than one decodable sentence.
        const records = parseNmeaText(text, mp4Filename).records;
        const accel = readVantrueType15Accel(payload);
        if (accel) {
            for (const record of records) {
                record.accelXg = accel[0];
                record.accelYg = accel[1];
                record.accelZg = accel[2];
            }
        }
        return records;
    },
};

// Vantrue N4/N2X binary preamble (ExifTool GPSType 15, QuickTimeStream.pl:
// 2240-2261, v13.55). The RMC tail above already carries the whole fix, so the
// preamble is read for ONE thing the sentence has not got: the accelerometer.
//
// Geometry gate, transliterated from upstream's `^.{28}A.{11}([NS]).{15}([EW])`
// with our literal = ExifTool offset - 4 convention.
const VANTRUE15_STATUS_AT = 24;
const VANTRUE15_NS_AT = 36;
const VANTRUE15_EW_AT = 52;
// Three int32 LE at ExifTool 92.
const VANTRUE15_ACCEL_AT = 88;
// Scale is "NC" upstream, but its own hexdump settles the magnitude: the triple
// reads -1.038 / 0.066 / 0.002, i.e. ~1 g on one axis - gravity INCLUDED. The
// block emits it raw; the per-file baseline removal that turns it into the
// dynamic component GpsRecord wants runs in the freegps primitive, keyed on
// GRAVITY_INCLUDED_VARIANT_NAMES.
const VANTRUE15_ACCEL_SCALE = 1000;

/**
 * Reads the Type-15 accel triple, or null when the block is not that geometry
 * (a Vantrue block whose RMC we parsed but whose preamble is a different
 * layout - the gate is what keeps us from reading noise as gravity).
 */
function readVantrueType15Accel(payload: DataView): [number, number, number] | null {
    if (payload.byteLength < VANTRUE15_ACCEL_AT + 12) return null;
    if (payload.getUint8(VANTRUE15_STATUS_AT) !== 0x41) return null; // 'A'
    const ns = payload.getUint8(VANTRUE15_NS_AT);
    if (ns !== 0x4e && ns !== 0x53) return null;
    const ew = payload.getUint8(VANTRUE15_EW_AT);
    if (ew !== 0x45 && ew !== 0x57) return null;

    const triple: [number, number, number] = [
        payload.getInt32(VANTRUE15_ACCEL_AT, true) / VANTRUE15_ACCEL_SCALE,
        payload.getInt32(VANTRUE15_ACCEL_AT + 4, true) / VANTRUE15_ACCEL_SCALE,
        payload.getInt32(VANTRUE15_ACCEL_AT + 8, true) / VANTRUE15_ACCEL_SCALE,
    ];
    // An all-zero triple is a placeholder, not a reading at rest: with gravity
    // included, a real sample always has ~1 g somewhere.
    if (triple.every((v) => v === 0)) return null;
    return triple;
}

// The RMC sentence sits at a fixed offset ~100 bytes into a Vantrue N2X block
// (see variantVantrueNmea above); real samples all fall well inside 512. Capping
// the scan here keeps this variant O(1)-ish on the hot streaming path (it runs
// before Novatek Type-3 on every 32 KB block) and shrinks the stray-match window
// over trailing video slack.
const NMEA_RMC_SCAN_LIMIT = 512;

function findNmeaRmcStart(payload: DataView): number | null {
    // Scan for "$G" + [A-Z] + "RMC" (any talker ID: $GPRMC, $GNRMC, etc.).
    // The [A-Z] check on the talker byte prevents a random byte from matching
    // and feeding garbage into readAsciiUntilTerminator.
    const max = Math.min(payload.byteLength, NMEA_RMC_SCAN_LIMIT) - 6;
    for (let i = 0; i < max; i++) {
        if (payload.getUint8(i) !== 0x24) continue; // '$'
        if (payload.getUint8(i + 1) !== 0x47) continue; // 'G'
        const talker = payload.getUint8(i + 2);
        if (talker < 0x41 || talker > 0x5a) continue; // [A-Z]
        if (payload.getUint8(i + 3) !== 0x52) continue; // 'R'
        if (payload.getUint8(i + 4) !== 0x4d) continue; // 'M'
        if (payload.getUint8(i + 5) !== 0x43) continue; // 'C'
        return i;
    }
    return null;
}

function readAsciiUntilTerminator(payload: DataView, start: number): string {
    // Linear scan to the first terminator. Using String.fromCharCode(...spread)
    // on large payloads (8-32 KB) hits the Function.apply argument limit
    // (RangeError on Safari, silent truncation on some engines). TextDecoder
    // over a subarray is O(N) without that limit.
    let end = start;
    while (end < payload.byteLength) {
        const b = payload.getUint8(end);
        // \r, \n, \0 terminate the sentence; non-ASCII (>127) means we have
        // left the text section and entered the next binary block.
        if (b === 0x0d || b === 0x0a || b === 0x00 || b > 0x7f) break;
        end++;
    }
    if (end === start) return "";
    const bytes = new Uint8Array(payload.buffer, payload.byteOffset + start, end - start);
    return new TextDecoder("latin1").decode(bytes);
}

// ===== ExifTool-derived variants (foreign source) =====
//
// Every variant below is implemented from foreign source (ExifTool 13.59
// QuickTimeStream.pl, per-variant line refs at each entry) under the
// foreign-source waiver: strict signature gates, negative tests proving
// existing formats are never claimed, and a per-variant validation flag in
// code. The Azdome XOR
// variant has since been validated against real Roadgid Tube samples (waiver
// revalidation - see its banner); the rest still await a first real sample.
// Offset convention: ExifTool's $dataPt starts at the atom size dword, our
// DataView starts at the `freeGPS ` literal, so literal = atom offset - 4.

/** Decodes payload bytes [start, start+length) as a latin1 string (byte ==
 *  char code, no UTF-8 reinterpretation - required for regex byte matching). */
function readLatin1(payload: DataView, start: number, length: number): string {
    const bytes = new Uint8Array(payload.buffer, payload.byteOffset + start, length);
    return new TextDecoder("latin1").decode(bytes);
}

// Type-1 signature at literal 14 (atom 18): the first 8 bytes of the
// XOR-0xAA-encrypted "\0\0XKZD\xfe\xfe" preamble that opens every Azdome
// GS63H / EEEkit block. 8 exact bytes - the strictest gate in the registry.
const AZDOME_SIGNATURE = [0xaa, 0xaa, 0xf2, 0xe1, 0xf0, 0xee, 0x54, 0x54] as const;
const AZDOME_XOR_START = 14;
// ExifTool decrypts at most 0x101 bytes (QuickTimeStream.pl:1690); beyond
// that the block is video padding, not text.
const AZDOME_XOR_WINDOW = 0x101;

/** Registry name of the Azdome XOR variant. Exported so the freegps
 *  primitive can key its per-file accel baseline removal on the variant
 *  that claimed the file's records (the raw block output is
 *  gravity-included - see the accel note inside parse below). */
export const AZDOME_XOR_VARIANT_NAME = "Azdome/EEEkit XOR (Type 1)";

/**
 * Variants whose accel triple reaches GpsRecord gravity-INCLUDED. GpsRecord
 * wants the dynamic component (at rest = 0,0,0), and gravity can only be
 * estimated over a whole file, so the freegps primitive strips the per-axis
 * mean after the parse pass for exactly these. A variant listed here that
 * loses the removal ships a permanent ~1 g floor into impact detection; one
 * listed here by mistake loses its true DC component.
 */
export const GRAVITY_INCLUDED_VARIANT_NAMES: ReadonlySet<string> = new Set([
    AZDOME_XOR_VARIANT_NAME,
    VANTRUE_NMEA_VARIANT_NAME,
]);

/**
 * Azdome GS63H / EEEkit XOR-0xAA ASCII variant - ExifTool GPSType 1
 * (QuickTimeStream.pl:1651-1715, v13.59). The payload from literal 14 is
 * ASCII XOR-ed with 0xAA: datetime YYYYMMDDHHMMSS at decrypted offset 8,
 * [NS] + 8-digit lat and [EW] + 9-digit lon (both DDmm * 1e4) after a
 * 15-byte user label, optional speed, signed 3-digit accel triple. The two
 * firmware tag bytes at literal 8 (0x05 Azdome / 0xF0 EEEkit) are
 * deliberately NOT used for dispatch - the gist record shows them churning
 * between models; the decode regexes are their own validators.
 * Implemented from foreign source (ExifTool 13.59); validated against real
 * Roadgid Tube samples (foreign-source waiver revalidation). The samples
 * settled the accel gravity question - see the accel note inside parse.
 */
const variantAzdomeXor: FreeGpsVariant = {
    name: AZDOME_XOR_VARIANT_NAME,
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < AZDOME_XOR_START + AZDOME_SIGNATURE.length) return false;
        for (let i = 0; i < AZDOME_SIGNATURE.length; i++) {
            if (payload.getUint8(AZDOME_XOR_START + i) !== AZDOME_SIGNATURE[i]) return false;
        }
        return true;
    },
    parse(payload, mp4Filename) {
        const raw = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        const text = decryptXorAscii(raw, AZDOME_XOR_START, AZDOME_XOR_WINDOW);
        // Shared with the Lamax S9 gps0 and Rove Stealth gpmd carriers - same
        // bytes, different wrapper (see internal/xor-ascii-gps.ts). The accel
        // triple comes back RAW; the primitive removes the per-file baseline
        // after the parse pass, keyed on AZDOME_XOR_VARIANT_NAME.
        const record = decodeXorAsciiGpsText(text, mp4Filename);
        return record ? [record] : [];
    },
};

// 'horsontech' vendor literal at literal 44 (atom 0x30).
const HORSONTECH_MARKER_OFFSET = 44;
// Accel triple ends at literal 120 - everything the variant reads fits below.
const HORSONTECH_MIN_PAYLOAD = 120;

/**
 * Vantrue S1 'horsontech' binary variant - ExifTool GPSType 10
 * (QuickTimeStream.pl:2021-2045, v13.59). Two traps, both fixture-pinned:
 * the datetime is y/m/d/h/m/s ORDER (not the Type-3 h-m-s-y-m-d), and
 * LONGITUDE at literal 88 comes BEFORE latitude at 92. The 10-byte vendor
 * literal is stricter than ExifTool's own dispatch (which keys only on
 * A[NS][EW]\0 at literal 60) - a firmware that varies the vendor string is
 * skipped, which fails safe into skipped[].
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantHorsontech: FreeGpsVariant = {
    name: "Vantrue S1 horsontech (Type 10)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < HORSONTECH_MIN_PAYLOAD) return false;
        if (!hasAsciiAt(payload, HORSONTECH_MARKER_OFFSET, "horsontech")) return false;
        if (payload.getUint8(60) !== 0x41) return false; // 'A' (upstream regex has no 'V' form)
        const ns = payload.getUint8(61);
        if (ns !== 0x4e && ns !== 0x53) return false;
        const ew = payload.getUint8(62);
        if (ew !== 0x45 && ew !== 0x57) return false;
        return payload.getUint8(63) === 0;
    },
    parse(payload, mp4Filename) {
        const ns = payload.getUint8(61) === 0x4e ? 1 : -1;
        const ew = payload.getUint8(62) === 0x45 ? 1 : -1;
        // unpack('x68V6...') = literal 64: year, month, day, hour, min, sec.
        const y = payload.getUint32(64, true);
        const mo = payload.getUint32(68, true);
        const d = payload.getUint32(72, true);
        const h = payload.getUint32(76, true);
        const mi = payload.getUint32(80, true);
        const s = payload.getUint32(84, true);
        // ExifTool gates this branch on month/day ranges only; the shared
        // helper is a superset of that check.
        const unixSeconds = utcSecondsFromYmdhms(y, mo, d, h, mi, s);
        if (unixSeconds === null) return [];
        const lonRaw = payload.getFloat32(88, true); // GetFloat 0x5c - longitude FIRST
        const latRaw = payload.getFloat32(92, true);
        const speedKnots = payload.getFloat32(96, true);
        const heading = payload.getFloat32(100, true);
        if (![lonRaw, latRaw, speedKnots, heading].every(Number.isFinite)) return [];
        const lat = ddmmToDegrees(latRaw) * ns;
        const lon = ddmmToDegrees(lonRaw) * ew;
        if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return [];
        // Literal 104 is altitude - no GpsRecord field, dropped. Accel triple
        // at literal 108/112/116 (unpack x68V6x20V3 = atom 112, NOT "after
        // the V6"); /1000 scale is marked "(NC)" upstream - unconfirmed.
        return [
            {
                unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg: heading,
                speedMs: speedKnots * KNOTS_TO_MS,
                accelXg: payload.getInt32(108, true) / 1000,
                accelYg: payload.getInt32(112, true) / 1000,
                accelZg: payload.getInt32(116, true) / 1000,
                mp4Filename,
            },
        ];
    },
};

// "$GPRMC," enciphered by +16 per byte: 34 57 60 62 5d 53 3c at literal 56
// (atom 60). Shared by Type 7 and the EACHPAI Type 9 family.
const SUB16_SIGNATURE = [0x34, 0x57, 0x60, 0x62, 0x5d, 0x53, 0x3c] as const;
const SUB16_TEXT_OFFSET = 56;
const SUB16_TEXT_MAX = 80; // ExifTool unpack('x60C80')
const SUB16_MIN_PAYLOAD = 136; // ExifTool: length >= 140 atom-relative

/**
 * Subtract-16 cipher over an embedded RMC sentence - ExifTool GPSType 7
 * (QuickTimeStream.pl:1940-1959, v13.59). Deliberately does NOT require the
 * 'ZXSBNXYS' header some Type-7 files carry: the EACHPAI family (upstream
 * "unsolved" Type 9, QuickTimeStream.pl:1998-2019) shares the cipher and its
 * canonical hexdump deciphers to a complete valid $GPRMC - the dual gate
 * would wrongly drop it. A non-RMC decipher self-rejects via parseNmeaText.
 * Known deviation: ExifTool's RMC regex tolerates an empty status field
 * (",A?,"); parseRmc rejects it ("bad status") - the record lands in skipped
 * instead of decoding without a fix flag, which is acceptable.
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantSub16Rmc: FreeGpsVariant = {
    name: "sub-16 RMC cipher (Type 7/9)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < SUB16_MIN_PAYLOAD) return false;
        for (let i = 0; i < SUB16_SIGNATURE.length; i++) {
            if (payload.getUint8(SUB16_TEXT_OFFSET + i) !== SUB16_SIGNATURE[i]) return false;
        }
        return true;
    },
    parse(payload, mp4Filename) {
        const end = Math.min(SUB16_TEXT_OFFSET + SUB16_TEXT_MAX, payload.byteLength);
        let text = "";
        for (let i = SUB16_TEXT_OFFSET; i < end; i++) {
            const b = payload.getUint8(i);
            // b < 0x30 deciphers to a control char (or is not enciphered text
            // at all for b < 16) - the sentence terminator class, same role as
            // readAsciiUntilTerminator's \0/\r/\n stop.
            if (b < 0x30) break;
            text += String.fromCharCode(b - 16);
        }
        return parseNmeaText(text, mp4Filename).records;
    },
};

// Slash-date "YYYY/MM/DD HH:MM:SS " + hemisphere at literal 19 (atom 23).
const XGODY_DATE_OFFSET = 19;
const XGODY_DATE_SHAPE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} [NS]$/;
const XGODY_TEXT_OFFSET = 12; // mode prefix start (atom 16)

/**
 * XGODY 12" 4K ASCII text variant - ExifTool GPSType 18
 * (QuickTimeStream.pl:2354-2384, v13.59). One plaintext line: mode prefix,
 * slash datetime, labeled tokens (N:/S: lat, E:/W: lon in DECIMAL DEGREES -
 * no ddmm), a bare speed value, x:/y:/z: accel, A: bearing, H: unknown.
 * The matcher keys on the date shape only - hard-requiring 'normal:' would
 * silently drop other-mode blocks (parking/event) that ExifTool parses.
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantXgodyText: FreeGpsVariant = {
    name: "XGODY ASCII text (Type 18)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < XGODY_DATE_OFFSET + 21) return false;
        return XGODY_DATE_SHAPE.test(readLatin1(payload, XGODY_DATE_OFFSET, 21));
    },
    parse(payload, mp4Filename) {
        const text = readAsciiUntilTerminator(payload, XGODY_TEXT_OFFSET);
        // Mode prefixes other than "normal:" exist upstream but are
        // unconfirmed; any 7-char "<mode>:" prefix parses the same way
        // (deliberately not logged - this is the per-block hot path).
        const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) /.exec(text.slice(7));
        if (!m) return [];
        const unixSeconds = utcSecondsFromYmdhms(
            Number(m[1]),
            Number(m[2]),
            Number(m[3]),
            Number(m[4]),
            Number(m[5]),
            Number(m[6]),
        );
        if (unixSeconds === null) return [];
        // Tokens start right after the datetime (literal 39 = text offset 27):
        // "N:42.382470 W:83.389570 53.6 km/h x:-0.02 y:0.99 z:0.10 A:269.2 H:245.5"
        let lat: number | null = null;
        let latSign = 1;
        let lon: number | null = null;
        let lonSign = 1;
        let speedKnots: number | null = null;
        let bearing = 0;
        for (const token of text.slice(27).split(/\s+/)) {
            const labeled = /^([A-Za-z]):([-+]?\d+(?:\.\d+)?)$/.exec(token);
            if (labeled) {
                const label = labeled[1]!;
                const value = Number(labeled[2]!);
                if (label === "N" || label === "S") {
                    lat = Math.abs(value);
                    latSign = label === "S" ? -1 : 1;
                } else if (label === "E" || label === "W") {
                    lon = Math.abs(value);
                    lonSign = label === "W" ? -1 : 1;
                } else if (label === "A") {
                    bearing = value; // 'A' is the track (verified upstream)
                }
                // x:/y:/z: are gravity-INCLUDED in the only known sample
                // (y:0.99 at rest = the gravity axis); GpsRecord wants
                // gravity-removed values, so they are deliberately dropped.
                // 'H:' is explicitly not altitude upstream - ignored.
                continue;
            }
            // The first bare FRACTIONAL number after the longitude is the
            // speed - the decimal point is mandatory, matching ExifTool's
            // /^\d+\.\d+$/ (QuickTimeStream.pl:2374): a stray unlabeled
            // integer field in unknown firmware must be skipped, not consumed
            // as speed. The "km/h" label that follows it lies: ExifTool
            // determined the value is stored in knots (n=1, hedged upstream -
            // sanity-check against plausible speeds when a real sample lands).
            if (lon !== null && speedKnots === null && /^\d+\.\d+$/.test(token)) speedKnots = Number(token);
        }
        if (lat === null || lon === null) return [];
        const latDeg = lat * latSign;
        const lonDeg = lon * lonSign;
        if (Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) return [];
        return [
            {
                unixSeconds,
                active: true,
                lat: latDeg,
                lon: lonDeg,
                bearingDeg: bearing,
                speedMs: (speedKnots ?? 0) * KNOTS_TO_MS,
                accelXg: 0,
                accelYg: 0,
                accelZg: 0,
                mp4Filename,
            },
        ];
    },
};

// E-ACE Type-4 field geometry (all literal): 20-byte lat string at 40
// (atom 0x2c), 20-byte lon string at 60 (atom 0x40), speed float at 80,
// track at 84.
const EACE_LAT_FIELD_OFFSET = 40;
const EACE_LON_FIELD_OFFSET = 60;
const EACE_FIELD_LENGTH = 20;
const EACE_MIN_PAYLOAD = 88; // track float ends at literal 88
// Field-shape gates, verbatim from ExifTool's notEnc/notStr checks.
const EACE_BASE64_FIELD = /^[A-Za-z0-9+/]{8,20}={0,2}\0*$/;
const EACE_PLAIN_FIELD = /^\d{1,5}\.\d+\0*$/;
// Decrypted-output validators (no \0 tail - NULs are stripped pre-decrypt).
const EACE_DECRYPTED_LAT = /^\d{1,4}\.\d+$/;
const EACE_DECRYPTED_LON = /^\d{1,5}\.\d+$/;

// 20 keys: 'luckychip gps', then 'customer aa gps'..'customer ss gps' - the
// template's both #'s take the SAME letter (ExifTool s/#/$ch/g over
// 'customer ## gps', QuickTimeStream.pl:1611+1832-1834). NOT single-letter.
const EACE_RC4_KEYS: readonly string[] = (() => {
    const keys = ["luckychip gps"];
    for (let i = 0; i < 19; i++) {
        const ch = String.fromCharCode(0x61 + i); // 'a'..'s'
        keys.push(`customer ${ch}${ch} gps`);
    }
    return keys;
})();

/** Textbook RC4 (KSA + PRGA; ExifTool DecryptLucky is RC4 with renamed loop
 *  vars, QuickTimeStream.pl:1612-1630). Returns a new decrypted buffer. */
function rc4Decrypt(data: Uint8Array, key: string): Uint8Array {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i]! + key.charCodeAt(i % key.length)) & 0xff;
        const t = s[i]!;
        s[i] = s[j]!;
        s[j] = t;
    }
    const out = new Uint8Array(data.length);
    let a = 0;
    let b = 0;
    for (let i = 0; i < data.length; i++) {
        a = (a + 1) & 0xff;
        b = (b + s[a]!) & 0xff;
        const t = s[a]!;
        s[a] = s[b]!;
        s[b] = t;
        out[i] = data[i]! ^ s[(s[a]! + s[b]!) & 0xff]!;
    }
    return out;
}

/** Strips the trailing NUL padding of a fixed-width ASCII field. */
function stripTrailingNuls(field: string): string {
    return field.replace(/\0+$/, "");
}

/**
 * E-ACE B44 'luckychip' RC4 variant - ExifTool GPSType 4
 * (QuickTimeStream.pl:1806-1841 + DecryptLucky:1611-1630, v13.59). The block
 * is a byte-exact alias of LAYOUT_ALT's A/NS/EW signature at literal 36-38;
 * what separates it is the coordinate fields: 20-byte ASCII strings that are
 * either base64-wrapped RC4 ciphertext or plaintext DDmm floats - binary
 * LAYOUT_ALT float bytes can't sustain either shape, and BOTH fields must
 * match the SAME shape (ExifTool's notEnc/notStr foreach). MUST be
 * registered before variantViofoType3, or Type 3 claims the block and nulls
 * its float decode. Only the short-prefix form is implemented - the .{81}
 * long-prefix alternative has no upstream evidence for Type 4.
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantEaceRc4: FreeGpsVariant = {
    name: "E-ACE luckychip RC4 (Type 4)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < EACE_MIN_PAYLOAD) return false;
        const fix = payload.getUint8(36);
        if (fix !== 0x41 && fix !== 0x56) return false; // 'A'/'V'
        const ns = payload.getUint8(37);
        if (ns !== 0x4e && ns !== 0x53) return false;
        const ew = payload.getUint8(38);
        if (ew !== 0x45 && ew !== 0x57) return false;
        const latField = readLatin1(payload, EACE_LAT_FIELD_OFFSET, EACE_FIELD_LENGTH);
        const lonField = readLatin1(payload, EACE_LON_FIELD_OFFSET, EACE_FIELD_LENGTH);
        return (
            (EACE_BASE64_FIELD.test(latField) && EACE_BASE64_FIELD.test(lonField)) ||
            (EACE_PLAIN_FIELD.test(latField) && EACE_PLAIN_FIELD.test(lonField))
        );
    },
    parse(payload, mp4Filename) {
        if (payload.getUint8(36) !== 0x41) return []; // 'V' = void/no fix, skip
        const ns = payload.getUint8(37) === 0x4e ? 1 : -1;
        const ew = payload.getUint8(38) === 0x45 ? 1 : -1;
        // Datetime u32 x6 LE at literal 12, H,M,S,Y,mo,d - the same unpack
        // ('x16V6') as the shared Type-3/4 dispatch upstream.
        const h = payload.getUint32(12, true);
        const mi = payload.getUint32(16, true);
        const s = payload.getUint32(20, true);
        const y = payload.getUint32(24, true);
        const mo = payload.getUint32(28, true);
        const d = payload.getUint32(32, true);
        const unixSeconds = utcSecondsFromYmdhms(y, mo, d, h, mi, s);
        if (unixSeconds === null) return [];
        const latField = readLatin1(payload, EACE_LAT_FIELD_OFFSET, EACE_FIELD_LENGTH);
        const lonField = readLatin1(payload, EACE_LON_FIELD_OFFSET, EACE_FIELD_LENGTH);
        let latStr: string | null = null;
        let lonStr: string | null = null;
        if (EACE_PLAIN_FIELD.test(latField) && EACE_PLAIN_FIELD.test(lonField)) {
            latStr = stripTrailingNuls(latField);
            lonStr = stripTrailingNuls(lonField);
        } else {
            // base64 + RC4 path (the matcher guaranteed both fields look
            // base64). atob rejects NULs - strip the padding first.
            let latCipher: Uint8Array;
            let lonCipher: Uint8Array;
            try {
                latCipher = Uint8Array.from(atob(stripTrailingNuls(latField)), (c) => c.charCodeAt(0));
                lonCipher = Uint8Array.from(atob(stripTrailingNuls(lonField)), (c) => c.charCodeAt(0));
            } catch {
                return [];
            }
            const decoder = new TextDecoder("latin1");
            for (const key of EACE_RC4_KEYS) {
                // BOTH fields must validate under the SAME key - ExifTool
                // moves to the next key when either one fails.
                const lt = decoder.decode(rc4Decrypt(latCipher, key));
                if (!EACE_DECRYPTED_LAT.test(lt)) continue;
                const ln = decoder.decode(rc4Decrypt(lonCipher, key));
                if (!EACE_DECRYPTED_LON.test(ln)) continue;
                latStr = lt;
                lonStr = ln;
                break;
            }
            // No key matched: unknown firmware key - degrade to skipped, same
            // outcome as before this variant existed.
            if (latStr === null || lonStr === null) return [];
        }
        const lat = ddmmToDegrees(Number(latStr)) * ns;
        const lon = ddmmToDegrees(Number(lonStr)) * ew;
        if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return [];
        const speedKnots = payload.getFloat32(80, true);
        const heading = payload.getFloat32(84, true);
        if (![speedKnots, heading].every(Number.isFinite)) return [];
        // Accel exists as raw int32s at literal 88, but the scale "varies per
        // axis" upstream (~250-300/g) - bogus G-events are worse than none.
        return [
            {
                unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg: heading,
                speedMs: speedKnots * KNOTS_TO_MS,
                accelXg: 0,
                accelYg: 0,
                accelZg: 0,
                mp4Filename,
            },
        ];
    },
};

// Akaso Type-6 signature offsets (literal): 'A' at 56, [NS] at 64, [EW] at
// 72, each int32-boxed (3 zero bytes after the char).
const AKASO6_MIN_PAYLOAD = 108; // accel triple ends at literal 108

/**
 * Akaso plain-float variant - ExifTool GPSType 6
 * (QuickTimeStream.pl:1906-1938, v13.59). Same canonical h-m-s clock at
 * literal 44 as Type 3, but the status/hemisphere chars are int32-boxed and
 * speed is ALREADY km/h - the one freeGPS branch upstream with no knots
 * conversion. Quirk owned here per project convention: blocks whose firmware
 * version slot (literal 12) holds the placeholder 'x.xx' store the track off
 * by 180 and garbage accel words (QuickTimeStream.pl:1932-1937).
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantAkasoType6: FreeGpsVariant = {
    name: "Akaso plain-float (Type 6)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < AKASO6_MIN_PAYLOAD) return false;
        if (payload.getUint8(56) !== 0x41) return false; // 'A' (no 'V' form upstream)
        const ns = payload.getUint8(64);
        if (ns !== 0x4e && ns !== 0x53) return false;
        const ew = payload.getUint8(72);
        if (ew !== 0x45 && ew !== 0x57) return false;
        // The three \0{3} runs of the int32 boxes - the structural gate that
        // keeps float-coordinate layouts (whose bytes there are exponent /
        // mantissa data) out.
        for (const boxPad of [57, 65, 73]) {
            for (let i = 0; i < 3; i++) {
                if (payload.getUint8(boxPad + i) !== 0) return false;
            }
        }
        return true;
    },
    parse(payload, mp4Filename) {
        const ns = payload.getUint8(64) === 0x4e ? 1 : -1;
        const ew = payload.getUint8(72) === 0x45 ? 1 : -1;
        const h = payload.getUint32(44, true);
        const mi = payload.getUint32(48, true);
        const s = payload.getUint32(52, true);
        // Year may be full (2020 in the canonical dump) or 2-digit (the
        // "Anticlock" dump stores 20) - the shared helper expands both;
        // unconditional +2000 would reject every canonical-form record.
        const y = payload.getUint32(84, true);
        const mo = payload.getUint32(88, true);
        const d = payload.getUint32(92, true);
        const unixSeconds = utcSecondsFromYmdhms(y, mo, d, h, mi, s);
        if (unixSeconds === null) return [];
        const latRaw = payload.getFloat32(60, true);
        const lonRaw = payload.getFloat32(68, true);
        const speedKmh = payload.getFloat32(76, true); // already km/h - NO knots conversion
        let heading = payload.getFloat32(80, true);
        if (![latRaw, lonRaw, speedKmh, heading].every(Number.isFinite)) return [];
        const lat = ddmmToDegrees(latRaw) * ns;
        const lon = ddmmToDegrees(lonRaw) * ew;
        if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return [];
        // /1000 scale is "(NC)" upstream and the only known sample shows
        // near-zero values - benign, but unverified.
        let accelXg = payload.getInt32(96, true) / 1000;
        let accelYg = payload.getInt32(100, true) / 1000;
        let accelZg = payload.getInt32(104, true) / 1000;
        if (hasAsciiAt(payload, 12, "x.xx")) {
            // Placeholder firmware version: track is off by 180 ("why is this
            // off by 180?" - unexplained upstream too) and the accel words are
            // garbage. Positive modulo: JS % keeps the sign of the dividend.
            heading = (((heading + 180) % 360) + 360) % 360;
            accelXg = 0;
            accelYg = 0;
            accelZg = 0;
        }
        return [
            {
                unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg: heading,
                speedMs: speedKmh / 3.6,
                accelXg,
                accelYg,
                accelZg,
                mp4Filename,
            },
        ];
    },
};

const NOVATEK_DOUBLES_MIN_PAYLOAD = 132; // ExifTool dirLen >= 0x88 atom-relative

/**
 * Novatek all-doubles layout - ExifTool GPSType 12 (QuickTimeStream.pl:
 * 2159-2189, v13.59; upstream sample firmware string "20130815.01",
 * otherwise unattributed - earlier "DOD LS460W" / "Kenwood doubles"
 * attributions are unsupported). The float64 coordinate width plus the
 * int32-boxed status/hemisphere chars at literal 56/68/84 are the
 * discriminators. Requiring the full zero box at 56 is deliberately stricter
 * than upstream's single-\0 check. Registered AFTER variantViofoType3:
 * neither can claim the other (Type-12's [NS] at literal 68 fails Type-3's
 * A/V check there), and sitting after avoids any new shadowing question for
 * the sample-validated Type-3 path. ExifTool's only Type-12 evidence dumps
 * zero record bytes, so the fixture is spec-derived - the weakest of this
 * batch. Implemented from foreign source (ExifTool 13.59), not validated
 * against a real sample.
 */
const variantNovatekDoubles: FreeGpsVariant = {
    name: "Novatek doubles (Type 12)",
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < NOVATEK_DOUBLES_MIN_PAYLOAD) return false;
        if (payload.getUint32(56, true) !== 0x41) return false; // 'A' int32-boxed (no 'V' form upstream)
        const ns = payload.getUint8(68);
        if (ns !== 0x4e && ns !== 0x53) return false;
        const ew = payload.getUint8(84);
        if (ew !== 0x45 && ew !== 0x57) return false;
        for (let i = 1; i < 4; i++) {
            if (payload.getUint8(68 + i) !== 0) return false;
            if (payload.getUint8(84 + i) !== 0) return false;
        }
        return true;
    },
    parse(payload, mp4Filename) {
        const ns = payload.getUint8(68) === 0x4e ? 1 : -1;
        const ew = payload.getUint8(84) === 0x45 ? 1 : -1;
        const h = payload.getUint32(44, true);
        const mi = payload.getUint32(48, true);
        const s = payload.getUint32(52, true);
        // Year is stored as year-2000 upstream; the shared helper expands it.
        const y = payload.getUint32(108, true);
        const mo = payload.getUint32(112, true);
        const d = payload.getUint32(116, true);
        const unixSeconds = utcSecondsFromYmdhms(y, mo, d, h, mi, s);
        if (unixSeconds === null) return [];
        const latRaw = payload.getFloat64(60, true); // DDmm.mmmmmm
        const lonRaw = payload.getFloat64(76, true);
        const speedKnots = payload.getFloat64(92, true);
        const heading = payload.getFloat64(100, true);
        if (![latRaw, lonRaw, speedKnots, heading].every(Number.isFinite)) return [];
        const lat = ddmmToDegrees(latRaw) * ns;
        const lon = ddmmToDegrees(lonRaw) * ew;
        if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return [];
        return [
            {
                unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg: heading,
                speedMs: speedKnots * KNOTS_TO_MS,
                // /1000 scale is upstream's; unconfirmed like the rest.
                accelXg: payload.getInt32(120, true) / 1000,
                accelYg: payload.getInt32(124, true) / 1000,
                accelZg: payload.getInt32(128, true) / 1000,
                mp4Filename,
            },
        ];
    },
};

// Nextbase '$S' record geometry: 32-byte records from literal 44 (atom 0x30).
const NEXTBASE_RECORD_START = 44;
const NEXTBASE_RECORD_STRIDE = 0x20;
const NEXTBASE_RECORD_MAGIC = 0x2453; // "$S" read big-endian
// Bytes a record read actually touches: magic at +0 .. lon int32 end at +23.
const NEXTBASE_RECORD_MIN_BYTES = 23;

/** ExifTool's Type-20 record-terminator bounds (QuickTimeStream.pl:2424-2428)
 *  with the hour gate tightened from upstream's sloppy `hr > 59` to a real
 *  0..23 range. `secX10` is the raw stored value (seconds * 10). */
function isPlausibleNextbaseDate(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    secX10: number,
): boolean {
    return (
        year >= 2000 &&
        year <= 2200 &&
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= 31 &&
        hour <= 23 &&
        minute <= 59 &&
        secX10 <= 600
    );
}

/**
 * Nextbase 512G '$S' multi-record variant - ExifTool GPSType 20
 * (QuickTimeStream.pl:2403-2451, v13.59). The ONLY big-endian freeGPS
 * variant; every read in this branch is BE and must stay branch-local.
 * Records stride 0x20; coordinates are UNALIGNED int32 BE decimal degrees
 * * 1e7 at rec+0x0f/+0x13 (no ddmm). Upstream this is the unguarded
 * fallback branch, so our gate adds first-record date plausibility on top of
 * the 2-byte magic ('x.xx' at literal 12 appears in the lone dump but is a
 * firmware version slot, not a stable signature - not required). The date
 * validation IS the record-loop terminator: ExifTool's own loop bound has a
 * precedence bug (`$pos += 0x20 > length(...)` adds the comparison result),
 * so upstream extracts only ONE record per block and nobody has verified
 * multi-record output against a real file - never trust counts. Deliberate
 * deviation: the loop ALSO terminates on a per-record '$S' magic mismatch,
 * which upstream never re-checks (it documents rec+0 as "int16u unknown
 * (seen: 0x24 0x53)" and terminates on date implausibility alone). If the
 * field turns out to be a per-record status word rather than a constant
 * magic, records after the first deviation are dropped silently - a
 * strictness call on n=1 dump evidence, revisit on a real multi-record file.
 * Implemented from foreign source (ExifTool 13.59), not validated against a
 * real sample.
 */
const variantNextbase512gBE: FreeGpsVariant = {
    name: "Nextbase 512G $S (Type 20)",
    needsWholeAtom: true,
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        if (payload.byteLength < NEXTBASE_RECORD_START + NEXTBASE_RECORD_MIN_BYTES) return false;
        if (payload.getUint16(NEXTBASE_RECORD_START, false) !== NEXTBASE_RECORD_MAGIC) return false;
        // A 2-byte magic alone is too weak ('$S' occurs in random bytes once
        // per ~64 KB); the first record's date plausibility completes the gate.
        return isPlausibleNextbaseDate(
            payload.getUint16(NEXTBASE_RECORD_START + 6, false),
            payload.getUint8(NEXTBASE_RECORD_START + 8),
            payload.getUint8(NEXTBASE_RECORD_START + 9),
            payload.getUint8(NEXTBASE_RECORD_START + 10),
            payload.getUint8(NEXTBASE_RECORD_START + 11),
            payload.getUint16(NEXTBASE_RECORD_START + 12, false),
        );
    },
    parse(payload, mp4Filename) {
        const records: GpsRecord[] = [];
        // The u32 LE at literal 8 is the block's used-data length, atom-
        // relative (0x178 in the lone upstream dump = header + exactly the
        // 10-record area). Semantics inferred from n=1, so it is used only as
        // an extra upper bound on top of the payload window - never as a
        // record count - and ignored when implausibly small.
        let end = payload.byteLength;
        const declaredEnd = payload.getUint32(8, true) - 4; // atom -> literal
        if (declaredEnd >= NEXTBASE_RECORD_START + NEXTBASE_RECORD_MIN_BYTES && declaredEnd < end) end = declaredEnd;
        for (let rec = NEXTBASE_RECORD_START; rec + NEXTBASE_RECORD_MIN_BYTES <= end; rec += NEXTBASE_RECORD_STRIDE) {
            if (payload.getUint16(rec, false) !== NEXTBASE_RECORD_MAGIC) break;
            const year = payload.getUint16(rec + 6, false);
            const mon = payload.getUint8(rec + 8);
            const day = payload.getUint8(rec + 9);
            const hr = payload.getUint8(rec + 10);
            const min = payload.getUint8(rec + 11);
            const secX10 = payload.getUint16(rec + 12, false);
            if (!isPlausibleNextbaseDate(year, mon, day, hr, min, secX10)) break; // validation IS the terminator
            const lat = payload.getInt32(rec + 15, false) / 1e7;
            const lon = payload.getInt32(rec + 19, false) / 1e7;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) break;
            let heading = payload.getInt16(rec + 4, false) / 100;
            if (heading < 0) heading += 360;
            // Seconds are stored * 10 - carry the 0.1 s fraction into
            // unixSeconds (Date.UTC alone would truncate it).
            const timestampMs = utcMillisecondsFromParts(year, mon, day, hr, min, Math.floor(secX10 / 10));
            if (timestampMs === null) break;
            const unixSeconds = timestampMs / 1000 + (secX10 % 10) / 10;
            records.push({
                unixSeconds,
                active: true,
                lat,
                lon,
                bearingDeg: heading,
                speedMs: payload.getUint16(rec + 2, false) / 100, // m/s * 100
                accelXg: 0,
                accelYg: 0,
                accelZg: 0,
                mp4Filename,
            });
        }
        return records;
    },
};

/**
 * Registered variant list. Order matters - first match wins.
 *
 * Rationale: strict-literal / structural gates go first - each of the six
 * leading variants requires a multi-byte literal at a fixed offset (the
 * Azdome XOR signature, 'horsontech', the sub-16 cipher bytes, the XGODY
 * slash-date) or a structural shape no other format satisfies (the E-ACE
 * base64/plaintext coordinate fields, the Akaso int32-boxed status triple),
 * so none of them can fire on the formats below. Two of them MUST precede
 * variantViofoType3: an E-ACE block is a byte-exact alias of LAYOUT_ALT's
 * signature (ordering is the only thing keeping Type 3 from nulling its
 * float decode), and Akaso-before-Type-3 removes even the theoretical
 * collision direction (Type-3 DEFAULT's status triple lands inside the Akaso
 * lon float). The Type-8 recognizer stays BEFORE Type 3 (byte-exact alias of
 * LAYOUT_DEFAULT - must be claimed-and-skipped before the float decode emits
 * garbage), and the NMEA variant before Type 3 because Vantrue blocks also
 * carry a binary payload that could accidentally pass the Type-3 signature.
 * The doubles and '$S' variants go AFTER Type 3: a Type-3 layout can never
 * claim them (their bytes at the Type-3 status offsets are hemisphere chars
 * or zeros), and sitting last avoids any new shadowing question for the
 * sample-validated Type-3 path.
 */
// ===== INNOVV multi-record blocks (ExifTool GPSType 13) =====
//
// Motorcycle cam. The block is a bare run of 32-byte fixes with NO clock of
// any kind - not even a file-start one - so every record ships `timeUnsynced`
// and reanchorUnsyncedTimes spreads them across the video window, the same
// path the 70mai 4K blocks take.
//
// Record: `A`[NS][EW]\0 then lat/lon f32 DDmm at +4/+8, speed knots at +12,
// track at +16, and an i32 triple at +20. Upstream emits that triple raw with
// no scale or axis attribution, so it is dropped rather than guessed - a
// wrong g scale would feed the impact detector.
//
// Records are found by resync rather than by stride: upstream globs the
// signature across the whole atom, and a run that starts mid-block would
// otherwise desync every following record.
//
// Scan bound: the atom, NOT our 32 KB payload window. The window is twice a
// typical 16 KB freeGPS atom, so scanning it whole would re-parse the NEXT
// block's records - and with no timestamps there is nothing to dedup them on
// beyond position. The bound comes from the box size preceding the literal;
// when that is unavailable the scan falls back to the window and the overlap
// is left to the position-keyed dedup downstream.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2190-2214),
// not validated against a real sample.
const INNOVV_MARKER_OFFSET = 12;
const INNOVV_RECORD_SIZE = 32;
/** Bytes between the atom start and the literal: the 4-byte box size that
 *  `free`'s 4cc shares with the `freeGPS ` literal we anchor on. */
const ATOM_HEADER_BEFORE_LITERAL = 4;

/**
 * Upper bound, in payload coordinates, for the record scan of a multi-record
 * variant: the end of THIS atom rather than the end of the 32 KB read window,
 * which typically spans the next block too. Falls back to the window when the
 * box size is unavailable or implausible - the records that leak in then are
 * left to the downstream dedup.
 */
function atomScanLimit(payload: DataView, boxSizeDword: number | undefined): number {
    if (boxSizeDword === undefined) return payload.byteLength;
    // The dword is stored big-endian; we hold the little-endian read of it.
    const atomSize = byteSwap32(boxSizeDword);
    const usable = atomSize - ATOM_HEADER_BEFORE_LITERAL;
    if (usable < INNOVV_MARKER_OFFSET + INNOVV_RECORD_SIZE) return payload.byteLength;
    return Math.min(payload.byteLength, usable);
}

function byteSwap32(value: number): number {
    return (
        (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | ((value >>> 24) & 0xff)) >>> 0
    );
}

/** True when `A`[NS][EW]\0 sits at `at`. */
export function hasInnovvRecordSignature(payload: DataView, at: number): boolean {
    if (at + INNOVV_RECORD_SIZE > payload.byteLength) return false;
    if (payload.getUint8(at) !== 0x41) return false; // 'A'
    const ns = payload.getUint8(at + 1);
    if (ns !== 0x4e && ns !== 0x53) return false; // N / S
    const ew = payload.getUint8(at + 2);
    if (ew !== 0x45 && ew !== 0x57) return false; // E / W
    return payload.getUint8(at + 3) === 0x00;
}

export function parseInnovvRecord(payload: DataView, at: number, mp4Filename: string): GpsRecord | null {
    const ns = payload.getUint8(at + 1) === 0x53 ? -1 : 1; // 'S' negative
    const ew = payload.getUint8(at + 2) === 0x57 ? -1 : 1; // 'W' negative
    const latRaw = Math.abs(payload.getFloat32(at + 4, true));
    const lonRaw = Math.abs(payload.getFloat32(at + 8, true));
    const speedKnots = payload.getFloat32(at + 12, true);
    const heading = payload.getFloat32(at + 16, true);
    if (![latRaw, lonRaw, speedKnots, heading].every(Number.isFinite)) return null;

    const lat = ddmmToDegrees(latRaw) * ns;
    const lon = ddmmToDegrees(lonRaw) * ew;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;
    if (speedKnots < 0 || heading < 0 || heading >= 360) return null;

    return {
        unixSeconds: 0, // placeholder, reanchored onto the video window
        active: true,
        lat,
        lon,
        bearingDeg: heading,
        speedMs: speedKnots * KNOTS_TO_MS,
        // Upstream reports the i32 triple verbatim, with neither a scale nor an
        // axis mapping - nothing to convert to gravity-removed g honestly.
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
        timeUnsynced: true,
    };
}

const variantInnovv: FreeGpsVariant = {
    name: "INNOVV Type 13",
    needsWholeAtom: true,
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        return hasInnovvRecordSignature(payload, INNOVV_MARKER_OFFSET);
    },
    parse(payload, mp4Filename, _options, boxSizeDword) {
        const limit = atomScanLimit(payload, boxSizeDword);
        const records: GpsRecord[] = [];
        let at = INNOVV_MARKER_OFFSET;
        while (at + INNOVV_RECORD_SIZE <= limit) {
            if (!hasInnovvRecordSignature(payload, at)) {
                at++;
                continue;
            }
            const record = parseInnovvRecord(payload, at, mp4Filename);
            // Advance a whole record either way: a signature that fails field
            // validation is a corrupt record, not a false anchor to rescan
            // from one byte on.
            if (record) records.push(record);
            at += INNOVV_RECORD_SIZE;
        }
        return records;
    },
};

// ===== ATC self-keying XOR records (ExifTool GPSType 11) =====
//
// Vendor-unidentified 2013-2015 hardware. 52-byte records from literal 44,
// each encrypted with two keys the record carries itself: the byte at +0x14
// keys the 0x00-0x14 and 0x18-0x1b ranges, the byte at +0x1c keys 0x1c and
// 0x20-0x32. Both key slots are plaintext-zero, so XOR-ing them with
// themselves clears them - which is also why the keys must be read before the
// passes run.
//
// `ATC` at +0x15 and `001` at +0x1d sit OUTSIDE both ranges. They are the
// per-record correctness check: a record whose keys were misread still shows
// them intact, so they cannot confirm the decrypt on their own, but their
// absence rules a candidate out before any decryption work.
//
// Ring buffer, not a stream: the device's whole ~30-entry buffer is rewritten
// into EVERY block, so consecutive blocks repeat almost all their records.
// Upstream carries cross-block state (a "most recent record" timestamp plus
// its position) to emit only what is new. We do not: these records carry a
// real wall clock, so dedupRecords keys them on time+position and collapses
// the repeats globally, which costs a few thousand transient records per clip
// and keeps the variant contract stateless.
//
// Ordering: this must be tried BEFORE the Type-3 path. Sample-1 ATC blocks
// also carry `IQS...` at literal 12, the exact anchor of the Type-16
// sub-variant - upstream disambiguates only by testing `ATC` first.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2047-2157),
// not validated against a real sample.
const ATC_RECORD_START = 44;
const ATC_RECORD_SIZE = 52;
const ATC_ANCHOR_ATC = 0x15;
const ATC_ANCHOR_001 = 0x1d;
const ATC_KEY1_AT = 0x14;
const ATC_KEY2_AT = 0x1c;

/** Decrypts a copy of the 52-byte record at `at`. */
function decryptAtcRecord(payload: DataView, at: number): DataView {
    const bytes = new Uint8Array(ATC_RECORD_SIZE);
    for (let i = 0; i < ATC_RECORD_SIZE; i++) bytes[i] = payload.getUint8(at + i);

    const key1 = bytes[ATC_KEY1_AT]!;
    const key2 = bytes[ATC_KEY2_AT]!;
    for (let i = 0x00; i <= 0x14; i++) bytes[i] = bytes[i]! ^ key1;
    for (let i = 0x18; i <= 0x1b; i++) bytes[i] = bytes[i]! ^ key1;
    bytes[ATC_KEY2_AT] = bytes[ATC_KEY2_AT]! ^ key2;
    for (let i = 0x20; i <= 0x32; i++) bytes[i] = bytes[i]! ^ key2;

    return new DataView(bytes.buffer);
}

/** True when the plaintext `ATC` / `001` anchors are both present at `at`. */
function hasAtcRecordAnchors(payload: DataView, at: number): boolean {
    if (at + ATC_RECORD_SIZE > payload.byteLength) return false;
    return hasAsciiAt(payload, at + ATC_ANCHOR_ATC, "ATC") && hasAsciiAt(payload, at + ATC_ANCHOR_001, "001");
}

function parseAtcRecord(payload: DataView, at: number, mp4Filename: string): GpsRecord | null {
    if (!hasAtcRecordAnchors(payload, at)) return null;
    const rec = decryptAtcRecord(payload, at);

    // Stored hour is hour-minus-1, wrapping through a byte.
    const hour = (rec.getUint8(0x0d) + 1) & 0xff;
    const minute = rec.getUint8(0x0e);
    const second = rec.getUint8(0x0f);
    const year = rec.getUint16(0x2c, true);
    const month = rec.getUint8(0x2e);
    const day = rec.getUint8(0x2f);
    // Upstream allows hour up to 24; tightened to a real hour here, matching
    // how the other variants gate their clocks. A genuine midnight record
    // stores 0xff and wraps to 0, so 24 is not a value real firmware needs.
    const unixSeconds = utcSecondsFromYmdhms(year, month, day, hour, minute, second);
    if (unixSeconds === null) return null;

    const lat = rec.getInt32(0x10, true) / 1e7;
    const lon = rec.getInt32(0x18, true) / 1e7;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;

    // Speed is already m/s (upstream converts for display only).
    const speedMs = rec.getInt32(0x20, true) / 100;
    if (speedMs < 0) return null;
    // Heading is stored -180..180; upstream folds the negative half up.
    let bearingDeg = rec.getInt16(0x24, true) / 100;
    if (bearingDeg < 0) bearingDeg += 360;
    if (bearingDeg < 0 || bearingDeg >= 360) return null;

    return {
        unixSeconds,
        active: true,
        lat,
        lon,
        bearingDeg,
        speedMs,
        // No accelerometer in this record layout at all (the altitude at 0x28
        // has no GpsRecord field either).
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

const variantAtc: FreeGpsVariant = {
    name: "ATC Type 11",
    needsWholeAtom: true,
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        return hasAsciiAt(payload, ATC_MARKER_OFFSET, "ATC");
    },
    parse(payload, mp4Filename, _options, boxSizeDword) {
        // Same atom-vs-window bound as INNOVV: the ring buffer already repeats
        // itself, no need to also read the neighbouring block's copy of it.
        const limit = atomScanLimit(payload, boxSizeDword);
        const records: GpsRecord[] = [];
        for (let at = ATC_RECORD_START; at + ATC_RECORD_SIZE <= limit; at += ATC_RECORD_SIZE) {
            const record = parseAtcRecord(payload, at, mp4Filename);
            if (record) records.push(record);
        }
        return records;
    },
};

// ===== XBHT XB702 multi-record blocks (ExifTool GPSType 14) =====
//
// Motorcycle dashcam. 36-byte records whose first bytes are a packed BCD-less
// date, then `A`[NS][EW], then u32 coordinates as DDmm*1e4 and a u16 speed.
// Found by resync like INNOVV: upstream globs the record shape rather than
// striding, and the signature (a plausible clock followed by the fix triple)
// is strong enough to anchor on.
//
// The format carries NO heading field at all - bearingDeg stays 0 and the
// dispatcher's forwardFillBearingsIfAllZero derives it from the trajectory.
// Speed is emitted by upstream without conversion, which by its own tag
// definition means km/h; unconfirmed, like every other unit upstream leaves
// bare. Sub-second precision (the tenths byte) is dropped - GpsRecord is
// whole seconds.
//
// Implemented from foreign source (ExifTool 13.55 QuickTimeStream.pl:2216-2240),
// not validated against a real sample.
const XBHT_RECORD_SIZE = 36;
/** Offset of the clock+fix signature inside a record. */
const XBHT_SIGNATURE_AT = 4;

/** True when a plausible clock + `A`[NS][EW] sits at record offset 4. */
function hasXbhtRecordSignature(payload: DataView, at: number): boolean {
    if (at + XBHT_RECORD_SIZE > payload.byteLength) return false;
    const sig = at + XBHT_SIGNATURE_AT;
    if (payload.getUint8(sig) > 24) return false; // hour
    if (payload.getUint8(sig + 1) > 59) return false; // minute
    if (payload.getUint8(sig + 2) > 59) return false; // second
    if (payload.getUint8(sig + 3) > 9) return false; // tenths
    if (payload.getUint8(sig + 4) !== 0x41) return false; // 'A'
    const ns = payload.getUint8(sig + 5);
    if (ns !== 0x4e && ns !== 0x53) return false;
    const ew = payload.getUint8(sig + 6);
    return ew === 0x45 || ew === 0x57;
}

function parseXbhtRecord(payload: DataView, at: number, mp4Filename: string): GpsRecord | null {
    const year = payload.getUint8(at + 1) + 2000;
    const month = payload.getUint8(at + 2);
    const day = payload.getUint8(at + 3);
    const hour = payload.getUint8(at + 4);
    const minute = payload.getUint8(at + 5);
    const second = payload.getUint8(at + 6);
    const unixSeconds = utcSecondsFromYmdhms(year, month, day, hour, minute, second);
    if (unixSeconds === null) return null;

    const ns = payload.getUint8(at + 9) === 0x53 ? -1 : 1;
    const ew = payload.getUint8(at + 10) === 0x57 ? -1 : 1;
    const lat = ddmmToDegrees(payload.getUint32(at + 16, true) / 1e4) * ns;
    const lon = ddmmToDegrees(payload.getUint32(at + 20, true) / 1e4) * ew;
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;

    return {
        unixSeconds,
        active: true,
        lat,
        lon,
        bearingDeg: 0, // absent from the format; forward-filled downstream
        speedMs: payload.getUint16(at + 28, true) * KMH_TO_MS,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename,
    };
}

const variantXbht: FreeGpsVariant = {
    name: "XBHT XB702 Type 14",
    needsWholeAtom: true,
    matches(payload) {
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return false;
        // Upstream anchors the block on the FIRST record sitting at literal 12.
        return hasXbhtRecordSignature(payload, 12);
    },
    parse(payload, mp4Filename, _options, boxSizeDword) {
        const limit = atomScanLimit(payload, boxSizeDword);
        const records: GpsRecord[] = [];
        let at = 12;
        while (at + XBHT_RECORD_SIZE <= limit) {
            if (!hasXbhtRecordSignature(payload, at)) {
                at++;
                continue;
            }
            const record = parseXbhtRecord(payload, at, mp4Filename);
            if (record) records.push(record);
            at += XBHT_RECORD_SIZE;
        }
        return records;
    },
};

// The status/receiver-clock geometry overlaps Type 3, but ASXT coordinates
// are encoded doubles. Own the header even when the record has no valid fix.
const variantAsxt: FreeGpsVariant = {
    name: "ASXT freeGPS",
    matches: hasAsxtFreeGpsSignature,
    parse: parseAsxtFreeGps,
};

const FREE_GPS_VARIANTS: readonly FreeGpsVariant[] = [
    variantAsxt,
    variantAtc,
    variantInnovv,
    variantXbht,
    variantAzdomeXor,
    variantHorsontech,
    variantSub16Rmc,
    variantXgodyText,
    variantEaceRc4,
    variantAkasoType6,
    variantYouqing,
    variantAkasoType8Encrypted,
    variantVantrueNmea,
    variantViofoType3,
    variantNovatekDoubles,
    variantNextbase512gBE,
];

/**
 * Parses one freeGPS block through the strict variant registry. Returns the
 * first matching variant's records, or an empty array if no variant
 * recognized the format (encrypted, non-Novatek, or unknown firmware). This
 * is the stateless registry-only parser; createFreeGpsBlockParser wraps it
 * with the stateful anchor-scan fallback for unknown layouts.
 */
function parseRegisteredFreeGpsBlock(payload: DataView, mp4Filename: string, boxSizeDword?: number): GpsRecord[] {
    for (const variant of FREE_GPS_VARIANTS) {
        if (variant.matches(payload)) {
            return variant.parse(payload, mp4Filename, undefined, boxSizeDword);
        }
    }
    return [];
}

function registeredVariantNeedsWholeAtom(payload: DataView): boolean {
    for (const variant of FREE_GPS_VARIANTS) {
        if (variant.matches(payload)) return variant.needsWholeAtom === true;
    }
    return false;
}

export const parseFreeGpsBlock: ParseFreeGpsBlock = Object.assign(parseRegisteredFreeGpsBlock, {
    needsWholeAtom: registeredVariantNeedsWholeAtom,
});

// ===== Backward anchor-scan fallback (dynamic Type-3 offsets) =====
//
// All known Type-3 sub-layouts share one relative geometry: 6 x u32 LE
// datetime ending 24 bytes before the 'A'[NS][EW] status triple, then a pad
// byte and lat/lon/speed/course float32 LE right after it. Firmware churn
// only moves the base offset (44/16/12/60 in the fixed layouts above). The
// fallback discovers the offset dynamically: scan the payload BACKWARDS for
// the status triple and validate the canonical record around it. This
// backward anchor-scan absorbs Novatek firmware offset churn without code
// changes (references: sergei.nz nvtk_mp42gpx.py get_gps_offset; viofosync
// _gpx.py A329S scan).
//
// False-positive control (a 3-byte triple does occur in random bytes):
//  1. full field validation at every candidate anchor (datetime ranges,
//     finite floats, coordinate ranges - parseType3Block);
//  2. near-(0,0) reject: known non-float dialects at the SAME geometry
//     (Type 3b/IQS int32 deg*1e7, Transcend, Rexing scaled) decode through
//     float32 as denormals ~0 that PASS the range checks - a near-null-island
//     pair is a systematic misdecode, not a fix (mirrors
//     is70maiFreeGpsBlock's 0,0 reject);
//  3. per-file consistency lock (closure state in createFreeGpsBlockParser):
//     records are emitted only once two CONSECUTIVE blocks validate at the
//     same anchor; the anchor is then pinned for the rest of the file.
//
// Absolute-year records (y >= 2000) from anchor-discovered layouts are
// flagged timeUnsynced (parseAtAnchor -> parseType3Block with
// absoluteYearIsLocalClock): the only known absolute-year writer in this
// geometry is the Kenwood local-clock mode, and ExifTool treats the whole
// Type-3 branch that way - emitting them as honest UTC would poison the
// per-fingerprint TZ estimate exactly like an ungated LAYOUT_KENWOOD_MN.
//
// Implemented from foreign source (sergei.nz / viofosync algorithm, geometry
// cross-checked against ExifTool QuickTimeStream.pl Type 3), not validated
// against a real sample with non-standard offsets.

/** Anchor scan upper bound: caps CPU on 32 KB payloads; every known real
 *  layout sits far below 512 bytes into the block. */
const ANCHOR_SCAN_MAX_WINDOW = 512;
/** Anchors below 32 would put the datetime hour field inside the 8-byte
 *  "freeGPS " magic, which always fails the h <= 23 check - dead range. */
const ANCHOR_SCAN_MIN = 32;
/** Bytes the record occupies from the anchor: status triple + pad + 4 x
 *  float32 (lat/lon/speed/course). */
const ANCHOR_RECORD_TAIL = 20;
/** Near-(0,0) rejection radius, degrees (~0.1 m). Genuine fixes at the
 *  equator/prime-meridian intersection do not occur in practice; denormal
 *  misdecodes are many orders of magnitude smaller than this. */
const ANCHOR_NULL_ISLAND_EPS = 1e-6;

/** Canonical Type-3 field geometry around a dynamically discovered anchor
 *  (= offset of the 'A' status byte). */
function buildAnchorLayout(anchor: number): FieldLayout {
    return {
        name: `anchor@${anchor}`,
        datetime: anchor - 24,
        active: anchor,
        ns: anchor + 1,
        ew: anchor + 2,
        lat: anchor + 4,
        lon: anchor + 8,
        speed: anchor + 12,
        course: anchor + 16,
        accelX: null,
        accelY: null,
        accelZ: null,
        minPayloadLength: anchor + ANCHOR_RECORD_TAIL,
    };
}

function parseAtAnchor(payload: DataView, anchor: number, mp4Filename: string): GpsRecord | null {
    // absoluteYearIsLocalClock: anchor layouts are dynamically built, so the
    // LAYOUT_KENWOOD_MN identity check inside parseType3Block can never fire
    // for them - the flag carries the same absolute-year quarantine here.
    const record = parseType3Block(payload, buildAnchorLayout(anchor), mp4Filename, {
        absoluteYearIsLocalClock: true,
    });
    if (!record) return null;
    if (Math.abs(record.lat) < ANCHOR_NULL_ISLAND_EPS && Math.abs(record.lon) < ANCHOR_NULL_ISLAND_EPS) return null;
    return record;
}

/**
 * Backward scan for the first anchor whose record fully validates. Backward
 * (high offsets first) follows the reference implementations: vendor headers
 * and banners live at the front of the block, the record at the back.
 */
function scanForAnchor(payload: DataView, mp4Filename: string): { anchor: number; record: GpsRecord } | null {
    const top = Math.min(payload.byteLength, ANCHOR_SCAN_MAX_WINDOW) - ANCHOR_RECORD_TAIL;
    for (let anchor = top; anchor >= ANCHOR_SCAN_MIN; anchor--) {
        if (payload.getUint8(anchor) !== 0x41) continue; // 'A' (a 'V' block has no decodable fix anyway)
        const ns = payload.getUint8(anchor + 1);
        if (ns !== 0x4e && ns !== 0x53) continue;
        const ew = payload.getUint8(anchor + 2);
        if (ew !== 0x45 && ew !== 0x57) continue;
        const record = parseAtAnchor(payload, anchor, mp4Filename);
        if (record) return { anchor, record };
    }
    return null;
}

/**
 * Per-file flags for createFreeGpsBlockParser - firmware facts that live
 * outside the block bytes (read once per file from Mp4Index) and change how
 * a variant decodes.
 */
export interface CreateFreeGpsBlockParserOptions {
    /**
     * Rexing V1-4K affine deobfuscation (ExifTool GPSType 17b). Set by the
     * freegps primitive when Mp4Index.kodakVersion === REXING_KODAK_VERSION;
     * consumed by the LAYOUT_DEFAULT path of parseType3Block. Default off.
     */
    rexingAffine?: boolean;
}

/**
 * The per-file block parser returned by createFreeGpsBlockParser: the plain
 * block-parsing closure plus per-file introspection of which variant the
 * file's records came from.
 */
export interface FreeGpsFileBlockParser extends ParseFreeGpsBlock {
    /**
     * Name of the single registry variant that emitted this file's records
     * so far. Null when nothing was emitted yet, when the records came from
     * the anchor-scan fallback, or when more than one variant emitted
     * (firmware writes one block format per file, so a mixed file has never
     * been seen - null keeps variant-conditional post-processing such as the
     * Azdome accel baseline safely OFF in that case).
     */
    claimedVariantName(): string | null;
    /**
     * Cold-start clock jump between the last pre-fix RTC block and the first
     * emitted record, snapped to the 15-min zone grid - or null when the file
     * did not start unsynced, no pre-fix block carried a readable datetime at
     * the emitting layout's geometry, or the jump does not look like a zone
     * (below one grid step, past the widest real UTC offset, or too far off
     * the grid). A non-null value alone does NOT prove local-as-UTC records -
     * the caller must pair it with the filename-clock gate (see
     * primitives/freegps.ts).
     */
    coldStartClockJumpSec(): number | null;
}

/** Zone grid for the cold-start jump: quarter-hour zones are real (Nepal
 *  +5:45, Chatham +12:45), same reasoning as the TZ estimate grid in trips. */
const CLOCK_JUMP_SNAP_SEC = 900;
/** |snapped| below one grid step is RTC drift, not a zone. */
const CLOCK_JUMP_MIN_ABS_SEC = 900;
/** Widest real UTC offset (+14:00, Kiritimati). A jump past it is not a zone
 *  but a stale RTC: a supercapacitor camera left unplugged comes back with a
 *  frozen or restored clock, and the gap to the first satellite fix can be
 *  hours or days. One in five such gaps lands close enough to the grid to
 *  pass the residual check below, and the fleet-wide correction downstream
 *  would then move the whole record axis by that garbage. */
const CLOCK_JUMP_MAX_ABS_SEC = 14 * 3600;
/** Max |raw - snapped|: covers the 1-2 s block cadence step plus modest RTC
 *  drift. Only sub-grid drift is separable this way - an RTC off by a whole
 *  number of quarter-hours snaps clean and reads as part of the zone. */
const CLOCK_JUMP_RESIDUAL_MAX_SEC = 90;

/**
 * Creates a per-file block parser: the strict variant registry first, then
 * the backward anchor-scan fallback for blocks no variant claims. The
 * consistency-lock state (pending/pinned anchor) lives in the closure -
 * construct ONE parser per file and thread it through both the structural
 * and streaming paths so the lock observes every block. The same closure
 * intentionally survives a jump-scan bail into the linear rerun: a pinned
 * anchor stays valid there, and the discarded jump-scan records are simply
 * re-parsed.
 *
 * Lock semantics: the first block validating at a new anchor emits nothing
 * (no retroactive emission - losing ~1 s of GPS is the accepted cost); the
 * second consecutive block at the same anchor pins it and emits from then
 * on. A block that validates nowhere (void fix, corrupt) breaks the
 * "consecutive" chain and resets the pending anchor.
 */
export function createFreeGpsBlockParser(options: CreateFreeGpsBlockParserOptions = {}): FreeGpsFileBlockParser {
    let pendingAnchor: number | null = null;
    let pinnedAnchor: number | null = null;
    // The first timed ASXT block can precede satellite lock. Preserve its
    // offset to later fixes, including gaps and stationary positions, before
    // downstream deduplication. This wall clock does not establish UTC or
    // prove that the first block is exactly at video time zero.
    let asxtStartWallClock: number | null = null;
    let asxtLastEmittedWallClock: number | null = null;
    // Claim tracking for claimedVariantName. A variant "claims" the file only
    // when it EMITS records: a match that decodes to nothing (void fix,
    // no-GPS block) says nothing about which format owns the file's records.
    let claimedName: string | null = null;
    let mixedClaims = false;
    let fallbackEmitted = false;
    // Cold-start clock-jump measurement. Pre-fix blocks on local-as-UTC
    // firmware (A119 Mini 2: status bytes ' 00'/'V00') fail every variant
    // signature but carry a valid RTC datetime at the fixed Type-3 offsets;
    // the first satellite-synced record then jumps by exactly the camera's
    // zone when the RTC runs UTC and the GPS stamps run local. Track the
    // LAST pre-fix datetime per layout (per layout, not global: a wrong
    // geometry can read a calendar-plausible garbage value, and the capture
    // below pairs strictly with the emitting block's own layout). Collection
    // stops at the first emission: post-fix signal-loss blocks carry the
    // already-synced clock and would poison a re-measure. The state survives
    // a jump-scan bail into the linear rerun by design (same closure).
    const lastPreFixUnixByLayout = new Map<FieldLayout, number>();
    let rawClockJumpSec: number | null = null;
    let sawEmit = false;

    const captureClockJump = (payload: DataView, first: GpsRecord): void => {
        // timeUnsynced first record = placeholder clock, no jump to measure.
        if (first.timeUnsynced === true) return;
        const layout = pickLayout(payload);
        if (layout === null) return; // non-Type-3 variant (NMEA text, doubles)
        const preFixUnix = lastPreFixUnixByLayout.get(layout);
        if (preFixUnix === undefined) return;
        rawClockJumpSec = first.unixSeconds - preFixUnix;
    };

    const parseOneBlock = (payload: DataView, mp4Filename: string, boxSizeDword?: number): GpsRecord[] => {
        for (const variant of FREE_GPS_VARIANTS) {
            if (variant.matches(payload)) {
                const records = variant.parse(payload, mp4Filename, options, boxSizeDword);
                if (variant === variantAsxt) {
                    const wallClock = readAsxtWallClock(payload);
                    if (wallClock !== null) {
                        asxtStartWallClock ??= wallClock;
                        // A regressing clock cannot establish a new origin
                        // without independent timing. Only emitted fixes
                        // advance the guard, so a corrupt no-fix timestamp
                        // cannot suppress later valid positions.
                        if (
                            wallClock < asxtStartWallClock ||
                            (asxtLastEmittedWallClock !== null && wallClock < asxtLastEmittedWallClock)
                        ) {
                            return [];
                        }
                        for (const record of records) record.relStartSeconds = wallClock - asxtStartWallClock;
                        if (records.length > 0) asxtLastEmittedWallClock = wallClock;
                    }
                }
                if (records.length > 0) {
                    if (claimedName === null) claimedName = variant.name;
                    else if (claimedName !== variant.name) mixedClaims = true;
                    if (!sawEmit) {
                        sawEmit = true;
                        captureClockJump(payload, records[0]!);
                    }
                }
                return records;
            }
        }
        // Fallback runs ONLY for blocks every strict variant rejected, so
        // supported formats can never regress through it.
        if (!matchesBytesAt(payload, 0, FREE_GPS_MAGIC_BYTES)) return [];

        // Unclaimed block: while the file is still in its cold-start window,
        // remember its datetime candidates for the jump measurement.
        if (!sawEmit) {
            for (const layout of TYPE3_LAYOUTS) {
                const datetime = readType3Datetime(payload, layout);
                if (datetime !== null) lastPreFixUnixByLayout.set(layout, datetime.unixSeconds);
            }
        }

        if (pinnedAnchor !== null) {
            const record = parseAtAnchor(payload, pinnedAnchor, mp4Filename);
            if (!record) return [];
            fallbackEmitted = true;
            sawEmit = true; // no capture - the anchor geometry has no pre-fix bucket
            return [record];
        }

        const found = scanForAnchor(payload, mp4Filename);
        if (!found) {
            pendingAnchor = null;
            return [];
        }
        if (found.anchor === pendingAnchor) {
            pinnedAnchor = found.anchor;
            fallbackEmitted = true;
            sawEmit = true;
            return [found.record];
        }
        pendingAnchor = found.anchor;
        return []; // withheld until a second consecutive block confirms the anchor
    };

    return Object.assign(parseOneBlock, {
        needsWholeAtom: registeredVariantNeedsWholeAtom,
        claimedVariantName: (): string | null => (mixedClaims || fallbackEmitted ? null : claimedName),
        coldStartClockJumpSec: (): number | null => {
            if (rawClockJumpSec === null) return null;
            const snapped = Math.round(rawClockJumpSec / CLOCK_JUMP_SNAP_SEC) * CLOCK_JUMP_SNAP_SEC;
            if (Math.abs(snapped) < CLOCK_JUMP_MIN_ABS_SEC) return null;
            if (Math.abs(snapped) > CLOCK_JUMP_MAX_ABS_SEC) return null;
            if (Math.abs(rawClockJumpSec - snapped) > CLOCK_JUMP_RESIDUAL_MAX_SEC) return null;
            return snapped;
        },
    });
}

/** Exported for tests (byte-builder fixtures + the variant cross-matrix). */
export const _internal = { FREE_GPS_MAGIC, FREE_GPS_MAGIC_BYTES, FREE_GPS_VARIANTS };

// ===== Streaming chunked scan =====
//
// Read the file in chunks via File.slice instead of one large .arrayBuffer().
// Benefits:
//   - never accumulates gigabytes in RAM (one chunk at a time);
//   - can bail early if no magic found (most generic files have no freeGPS
//     blocks - no point reading past a few MB);
//   - can bail early after the last block (dense stream at 1/sec; a gap of
//     8 MB reliably means the array is finished);
//   - AbortSignal is checked between chunks.
//
// Reference: EgorKin/nvtk_mp4_to_gpx (4096-byte buffers). Our chunks are
// larger because File.slice overhead in the browser is higher than Python
// file.read().

/** Chunk size for streaming scan. */
const SCAN_CHUNK_SIZE = 4 << 20;

/**
 * Probe limit: if no `freeGPS ` magic is found in the first 16 MB, bail out.
 * Novatek blocks are evenly distributed (~1/sec); the first block is almost
 * always in the opening megabytes. 16 MB with no hit → file has no telemetry.
 */
const SCAN_PROBE_LIMIT = 16 << 20;

/**
 * After the last found magic, scan at least this much more before stopping.
 * Equal to the probe limit on purpose: a stream the marker probe can see at
 * all has its first block within that distance of the file start, so its
 * blocks sit no wider apart than that - at 1 Hz the floor covers 128 Mbps,
 * beyond any dashcam. The allowance has to bridge one gap while only a single
 * block is known: a 4K clip at 63 Mbps (VIOFO A329) spaces blocks 8.2 MB
 * apart, and with an 8 MB floor a scan resuming right after its one seed ended
 * before the chunk holding the next block. A linear pass from the file start
 * only ever survived that spacing by chunk-grid luck.
 */
const SCAN_TAIL_AFTER_LAST_HIT = SCAN_PROBE_LIMIT;

/**
 * Once the spacing is known, the tail bail waits for this many consecutive
 * missing blocks when that is longer than the fixed floor, so a clip whose
 * spacing approaches the floor is not cut off by a single late block.
 */
const TAIL_BAIL_MISSING_BLOCKS = 3;

/**
 * Hard limit for corrupt-format / infinite-scan safety. 4 GB = max FAT32 file
 * size (common on dashcam SD cards). The tail-bail above stops scans
 * earlier when GPS blocks genuinely end before the file boundary.
 */
// 4 * 1024 ** 3 = 4 GB. `4 << 30` does NOT work - JS bitwise shift uses
// 32-bit signed arithmetic, so 4<<30 = 0 (overflow), silently zeroing the scan.
const SCAN_HARD_LIMIT = 4 * 1024 ** 3;

/**
 * Streaming scan for freeGPS blocks + parse into GpsRecords. One pass in file
 * order that switches between two reading modes as the block spacing allows:
 *
 *  - LINEAR: 4 MB chunks with a 32 KB overlap - the mode that sees every
 *    block. It runs from the start when no seeds are known and resumes after
 *    every missed prediction, so an irregular stretch (a parking-mode splice,
 *    a burst of giant I-frames, GPS resuming after a tunnel) is read
 *    exhaustively instead of ending the scan. Probe-bail (16 MB without any
 *    block) and tail-bail (16 MB or three spacings past the last block) end it.
 *  - JUMP: Novatek interleaves blocks at ~1 Hz, so on a steady bitrate the
 *    next block sits about one median spacing past the last one. Once two
 *    consecutive blocks are known - from the marker probe's seeds or from the
 *    linear pass - the scan reads a 256 KB window around each prediction
 *    (1 MB on a first miss) instead of the whole gap: 5-25x less IO than
 *    linear on a 4K clip. A miss hands the cursor back to LINEAR, and two
 *    fresh consecutive hits there bootstrap the next jump run; nothing is
 *    ever re-scanned from the start.
 *
 * Jumping only pays when the spacing clearly exceeds the window: dense
 * per-frame blocks (the 70mai dialect) stay linear, which reads each byte
 * once instead of overlapping windows.
 *
 * Blocks are parsed strictly in file order on both paths because the injected
 * block parser may be stateful (anchor-scan lock, cold-start clock jump).
 *
 * @param seedOffsets Absolute offsets of `freeGPS ` literals the marker probe
 *                    found (Mp4Index.freeGpsSeedOffsets). They must be the
 *                    first blocks of the file in order, which the probe
 *                    guarantees: the scan resumes right after the last seed.
 * @param signal      Checked between reads; throws DOMException("AbortError").
 */
export async function streamScanFreeGps(
    file: File,
    signal?: AbortSignal,
    seedOffsets?: readonly number[],
    parseBlock: ParseFreeGpsBlock = parseFreeGpsBlock,
): Promise<ParsedRecords> {
    const fileSize = file.size;
    const limit = Math.min(fileSize, SCAN_HARD_LIMIT);
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    // Absolute offsets of every parsed block in file order. Its tail drives
    // the jump prediction; its last entry is the resume point of a linear run.
    const hits: number[] = [];
    let blockIndex = 0;

    const checkAbort = (): void => {
        throwIfCancelled(signal, "freegps scan aborted");
    };
    const lastHit = (): number => (hits.length > 0 ? hits[hits.length - 1]! : -1);
    // A linear run resumes right past the last literal, not past its payload
    // window: the mode that sees every block must not skip one that a dense
    // dialect writes closer than a payload window after the previous one. The
    // dedupe below keeps the literal itself from being parsed twice.
    const linearResumePos = (): number => lastHit() + FREE_GPS_MAGIC_BYTES.length;
    const recentDelta = (): number => medianDeltas(hits.slice(-(JUMP_MEDIAN_WINDOW + 1)));
    /** Bytes past the last block after which the array is taken as finished. */
    const tailBailBytes = (): number =>
        hits.length >= 2
            ? Math.max(SCAN_TAIL_AFTER_LAST_HIT, TAIL_BAIL_MISSING_BLOCKS * recentDelta())
            : SCAN_TAIL_AFTER_LAST_HIT;

    /** Parses the block whose literal sits at buf[localOff]; absOff is its file offset. */
    const parseHit = (buf: Uint8Array, localOff: number, absOff: number): void => {
        const payloadEnd = Math.min(localOff + BLOCK_PAYLOAD_SIZE, buf.length);
        const view = new DataView(buf.buffer, buf.byteOffset + localOff, payloadEnd - localOff);
        blockIndex++;
        const blockRecords = parseBlock(view, file.name, readBoxSizeDword(buf, localOff));
        if (blockRecords.length > 0) {
            extendArray(records, blockRecords);
        } else {
            skipped.push({
                line: blockIndex,
                raw: `<freeGPS block @${absOff}, ${payloadEnd - localOff} bytes>`,
                reason: "no matching variant or void/invalid record",
            });
        }
        hits.push(absOff);
    };

    // Seeds are parsed first, in order, so they anchor the prediction without
    // a linear pass over the probe window. Each read starts 4 bytes early so
    // the box-size dword preceding the literal is covered.
    const seeds = [...new Set(seedOffsets ?? [])]
        .sort((a, b) => a - b)
        .filter((off) => off >= 0 && off + 8 <= fileSize);
    for (const absOff of seeds) {
        checkAbort();
        const readStart = Math.max(0, absOff - 4);
        const readEnd = Math.min(absOff + BLOCK_PAYLOAD_SIZE, fileSize);
        const buf = new Uint8Array(await file.slice(readStart, readEnd).arrayBuffer());
        parseHit(buf, absOff - readStart, absOff);
    }

    /**
     * Linear run from `startPos`. Returns "jump-ready" once two blocks found
     * in this run are spaced widely enough to predict the next one, "done"
     * when a bail rule or the file end stops the scan.
     */
    const linearRun = async (startPos: number): Promise<{ pos: number; outcome: "done" | "jump-ready" }> => {
        let pos = startPos;
        // The last 32 KB of the previous chunk, so a block straddling the
        // chunk boundary is always scanned in full.
        let tail = new Uint8Array(0);
        // A literal whose payload runs past the chunk: found but deferred to
        // the next iteration, where it re-appears through the overlap. The
        // bail rules count it as a hit so they cannot fire before it is parsed.
        let pendingHitPos = -1;
        let freshHits = 0;
        while (pos < limit) {
            checkAbort();
            if (hits.length === 0 && pendingHitPos === -1 && pos >= SCAN_PROBE_LIMIT) return { pos, outcome: "done" };
            const anchor = Math.max(lastHit(), pendingHitPos);
            if (anchor !== -1 && pos > anchor + tailBailBytes()) return { pos, outcome: "done" };

            const chunkEnd = Math.min(pos + SCAN_CHUNK_SIZE, fileSize);
            const chunk = new Uint8Array(await file.slice(pos, chunkEnd).arrayBuffer());
            const workspace = tail.length === 0 ? chunk : concat([tail, chunk]);
            const workspaceStartAbs = pos - tail.length;
            for (const localOff of findFreeGpsOffsetsInRange(workspace, 0, workspace.length)) {
                const absOff = workspaceStartAbs + localOff;
                // Seen through the overlap tail or by the jump run that handed over.
                if (absOff <= lastHit()) continue;
                if (localOff + BLOCK_PAYLOAD_SIZE > workspace.length && chunkEnd < fileSize) {
                    pendingHitPos = absOff;
                    break;
                }
                parseHit(workspace, localOff, absOff);
                freshHits++;
            }
            // An explicit copy releases the chunk so the GC can reclaim it.
            const tailLen = Math.min(BLOCK_PAYLOAD_SIZE, workspace.length);
            const tailCopy = new Uint8Array(tailLen);
            tailCopy.set(workspace.subarray(workspace.length - tailLen));
            tail = tailCopy;
            pos = chunkEnd;

            // Two consecutive blocks seen by this run re-establish the spacing.
            // A deferred straddling block is parsed before the jump starts, so
            // the prediction never runs ahead of an unparsed hit.
            if (freshHits >= 2 && pendingHitPos <= lastHit() && recentDelta() > JUMP_MIN_DELTA) {
                return { pos, outcome: "jump-ready" };
            }
        }
        return { pos, outcome: "done" };
    };

    const readWindow = async (
        last: number,
        predicted: number,
        radius: number,
    ): Promise<{ start: number; bytes: Uint8Array }> => {
        // Never re-read the previous block's payload.
        const start = Math.max(last + BLOCK_PAYLOAD_SIZE, predicted - radius);
        const end = Math.min(predicted + radius + BLOCK_PAYLOAD_SIZE, fileSize);
        return { start, bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()) };
    };

    /**
     * Jump run from the current last hit. Returns "miss" to hand over to a
     * linear run - also at the file end, where the final block may sit short
     * of the prediction: the linear run reads the remainder once.
     */
    const jumpRun = async (): Promise<"eof" | "miss"> => {
        let delta = recentDelta();
        while (true) {
            checkAbort();
            const last = lastHit();
            const predicted = last + delta;
            if (predicted >= limit) return linearResumePos() < limit ? "miss" : "eof";
            let window = await readWindow(last, predicted, JUMP_WINDOW_BYTES >> 1);
            let offsets = findFreeGpsOffsetsInRange(window.bytes, 0, window.bytes.length);
            if (offsets.length === 0) {
                window = await readWindow(last, predicted, JUMP_WINDOW_WIDE_BYTES >> 1);
                offsets = findFreeGpsOffsetsInRange(window.bytes, 0, window.bytes.length);
            }
            let parsed = 0;
            for (const localOff of offsets) {
                const absOff = window.start + localOff;
                if (absOff <= last) continue;
                if (
                    window.bytes.length - localOff < BLOCK_PAYLOAD_SIZE &&
                    window.start + window.bytes.length < fileSize
                ) {
                    // The window edge cut the payload (a block drifting late).
                    // Re-read the block whole rather than parsing it truncated,
                    // which could drop the tail records of a multi-record
                    // layout, or handing over to a 4 MB linear chunk.
                    const readStart = Math.max(0, absOff - 4);
                    const whole = new Uint8Array(
                        await file.slice(readStart, Math.min(absOff + BLOCK_PAYLOAD_SIZE, fileSize)).arrayBuffer(),
                    );
                    parseHit(whole, absOff - readStart, absOff);
                } else {
                    parseHit(window.bytes, localOff, absOff);
                }
                parsed++;
            }
            if (parsed === 0) return "miss";
            // Drift-correct on every hit: action scenes shift the spacing. A
            // spacing that collapsed below the window is cheaper read linearly.
            delta = recentDelta();
            if (delta <= JUMP_MIN_DELTA) return "miss";
        }
    };

    let pos = 0;
    let mode: "linear" | "jump" = "linear";
    if (hits.length >= 2 && recentDelta() > JUMP_MIN_DELTA) mode = "jump";
    else if (hits.length > 0) pos = linearResumePos();
    while (true) {
        if (mode === "jump") {
            if ((await jumpRun()) === "eof") break;
            mode = "linear";
            pos = linearResumePos();
            continue;
        }
        const linear = await linearRun(pos);
        if (linear.outcome === "done") break;
        mode = "jump";
    }
    return { records, skipped };
}

/**
 * Per-block parser injected into the streaming scan. Default is the Novatek
 * variant registry (parseFreeGpsBlock); the freegps primitive passes a
 * createFreeGpsBlockParser closure, and the 70mai-embedded primitive passes
 * its own parser (parse70maiFreeGpsBlock) - both reuse the
 * chunk/overlap/abort/jump-scan machinery without forking it. Contract:
 * receives a DataView starting at the `freeGPS ` magic, returns the records
 * decoded from the block (empty array = void/invalid/unclaimed block, the
 * caller records a skipped entry).
 */
export interface ParseFreeGpsBlock {
    (payload: DataView, mp4Filename: string, boxSizeDword?: number): GpsRecord[];
    /** True when a structural probe identifies a layout whose records may continue past it. */
    needsWholeAtom?(payload: DataView, boxSizeDword?: number): boolean;
}

/**
 * Reads the MP4 box-size dword that sits immediately before the `freeGPS `
 * literal. The payload window starts AT the literal (so every layout offset
 * stays literal-relative), which leaves those four bytes outside it - the
 * Transcend DB70 gate is the one decode that needs them. Returns undefined
 * when the read does not reach back that far, in which case the block simply
 * stays on the plain Type-3 path.
 */
function readBoxSizeDword(buf: Uint8Array, literalOffset: number): number | undefined {
    if (literalOffset < 4) return undefined;
    return new DataView(buf.buffer, buf.byteOffset + literalOffset - 4, 4).getUint32(0, true);
}

// ===== Predicted-offset jump run =====
//
// Novatek freeGPS blocks are interleaved with video frames at ~1 Hz. On a
// constant-bitrate clip the spacing between adjacent blocks is constant; on a
// variable-bitrate clip it fluctuates with I-frame size but stays within a
// small fraction of the median. The scan exploits this: with two or more
// consecutive blocks known it computes the median delta, predicts each
// subsequent block's offset and reads just a small window around it.
// Misses hand the cursor to the linear run (see streamScanFreeGps).

/** Window size around the predicted offset. 256 KB tolerates ~±128 KB
 *  drift per block. On a 4K HEVC clip with 1 Hz GPS, ~256 KB is enough
 *  for normal bitrate variation; action scenes with very large I-frames
 *  may drift more - the median-Δ adapts on every hit. */
const JUMP_WINDOW_BYTES = 0x40000; // 256 KB

/** Widened window after a miss before handing over to the linear run. */
const JUMP_WINDOW_WIDE_BYTES = 0x100000; // 1 MB

/** How many of the most-recent deltas to median over. Fewer = faster drift
 *  adaptation; more = more stable estimate. 8 is a balance: covers ~8 sec
 *  of GPS at 1 Hz, smoothing transient bitrate spikes without lagging on
 *  sustained scene changes. */
const JUMP_MEDIAN_WINDOW = 8;

/** Smallest block spacing worth predicting. A window read costs this many
 *  bytes, so below it the linear 4 MB chunks read every byte once with far
 *  fewer calls - the dense per-frame 70mai dialect lands here. */
const JUMP_MIN_DELTA = JUMP_WINDOW_BYTES + BLOCK_PAYLOAD_SIZE;

/** Median of adjacent deltas in a sorted offsets array. Stable estimator
 *  against single-block outliers (one giant I-frame is one outlier delta,
 *  median ignores it). */
function medianDeltas(offsets: number[]): number {
    if (offsets.length < 2) return 0;
    const deltas: number[] = [];
    for (let i = 1; i < offsets.length; i++) {
        const d = offsets[i]! - offsets[i - 1]!;
        if (d > 0) deltas.push(d);
    }
    if (deltas.length === 0) return 0;
    deltas.sort((a, b) => a - b);
    const mid = deltas.length >> 1;
    // `Math.floor((a + b) / 2)` not `(a + b) >> 1`: bitwise ops sign-extend to
    // 32-bit, so on multi-GB file deltas the right-shift returns garbage. The
    // shift overflow that bit us in SCAN_HARD_LIMIT (4 << 30 = 0) lurks here
    // the same way - guard preventively even though realistic Novatek deltas
    // are under 2 MB.
    return deltas.length % 2 === 0 ? Math.floor((deltas[mid - 1]! + deltas[mid]!) / 2) : deltas[mid]!;
}

/**
 * Scans [from, to) in a Uint8Array for all occurrences of "freeGPS " magic.
 * Returns start offsets. Used by streamScanFreeGps on the workspace buffer and
 * by hasFreeGpsMarker for quick sniffing.
 */
function findFreeGpsOffsetsInRange(buf: Uint8Array, from: number, to: number, limit = Infinity): number[] {
    const offsets: number[] = [];
    while (offsets.length < limit) {
        const offset = findByteSequence(buf, FREE_GPS_MAGIC_BYTES, from, to);
        if (offset < 0) break;
        offsets.push(offset);
        from = offset + FREE_GPS_MAGIC_BYTES.length;
    }
    return offsets;
}

/**
 * Quick sniff: checks whether `freeGPS ` magic appears in the first N bytes.
 * Used in classifyByContent for a fast pass without a full scan. Default
 * scanLimit matches SCAN_PROBE_LIMIT. On already-loaded moov bytes this is
 * essentially free.
 */
export function hasFreeGpsMarker(buf: Uint8Array, scanLimit = SCAN_PROBE_LIMIT): boolean {
    return findByteSequence(buf, FREE_GPS_MAGIC_BYTES, 0, scanLimit) >= 0;
}

/**
 * Scans [from, to) of buf for `freeGPS ` magic, stops after `limit` hits.
 * Public wrapper around findFreeGpsOffsetsInRange used by the index builder
 * to collect jump-scan seed offsets.
 */
export function findFreeGpsOffsets(buf: Uint8Array, from: number, to: number, limit: number): number[] {
    return findFreeGpsOffsetsInRange(buf, from, to, limit);
}

// ===== Structural `gps ` atom table path =====
//
// The sibling of the streaming scan above: instead of walking mdat, read the
// moov -> `gps ` atom's (offset, size) table and fetch each freeGPS block
// directly. Cheap (tens of KB per recording minute vs up to 4 GB). Shared by
// every Novatek-family primitive that reaches a `gps ` atom - the generic
// VIOFO/Vantrue `freegps` primitive and the 70mai-embedded one - each injecting
// its own ParseFreeGpsBlock so the table-reading machinery is not forked.

interface GpsAtomEntry {
    offset: number;
    size: number;
}

/**
 * Structural path: moov -> `gps ` atom (3 letters + space) with a chunk
 * descriptor of (offset, size) pairs, each pointing at a freeGPS block. Returns
 * the parsed records, or null when there is no usable atom / no candidate table
 * yields a valid first block (caller falls back to the streaming scan).
 */
/**
 * Whether the moov `gps ` atom carries at least one entry the structural path
 * could read. Some firmware writes the atom as a placeholder (70mai rear
 * channels: count 0, no entries) or fills it with junk (VIOFO A329: the count
 * matches the block count while every entry is zero or out of range). Both
 * used to pass as a light structural signal and sent the file into the
 * streaming scan without seeds; this gate keeps them out of the structural
 * path and, through the dispatcher, out of the "light" cost class.
 */
export function hasUsableNovatekGpsTable(index: Mp4Index): boolean {
    const atom = index.novatekGpsAtom;
    if (!atom || !index.moovView) return false;
    return readGpsAtomEntryCandidates(index.moovView, atom.payloadStart, atom.end, index.fileSize).length > 0;
}

/**
 * Whether the `gps ` atom announces blocks even though its entries are
 * unusable: the canonical count field is non-zero. A firmware that counted
 * its freeGPS blocks did write them into mdat, so the dispatcher escalates
 * the marker probe for such a file the way it does for Novatek-named files
 * instead of giving up at the default window. A zero count is a placeholder
 * atom and promises nothing.
 */
export function novatekGpsTableDeclaresEntries(index: Mp4Index): boolean {
    const atom = index.novatekGpsAtom;
    if (!atom || !index.moovView) return false;
    if (atom.end - atom.payloadStart < 8) return false;
    return index.moovView.getUint32(atom.payloadStart + 4, false) > 0;
}

export async function tryStructuralPath(
    file: File,
    index: Mp4Index,
    parseBlock: ParseFreeGpsBlock,
    signal?: AbortSignal,
): Promise<ParsedRecords | null> {
    const gpsAtom = index.novatekGpsAtom;
    if (!gpsAtom) return null;
    if (!index.moovView) return null;

    for (const entries of readGpsAtomEntryCandidates(index.moovView, gpsAtom.payloadStart, gpsAtom.end, file.size)) {
        const parsed = await parseEntries(file, entries, parseBlock, signal);
        if (parsed) return parsed;
    }
    return null;
}

// `gps ` atom payload candidates, tried in order. A wrong candidate is
// rejected by parseEntries' bounded preflight before any bulk IO, so each
// extra candidate costs at most eight ~1 KB reads.
//
//  1. CANONICAL (ExifTool QuickTimeStream.pl:2546-2553 (v13.59) Get32u
//     count@4 / entries@8 under big-endian QuickTime byte order; same layout
//     in sergei.nz nvtk_mp42gpx.py parse_moov, viofosync _gpx.py, and the
//     piofo real-file hexdump `00 00 01 01 | 00 00 00 07 | entries`):
//       [0..3]  version/flags word (e.g. 0x00000101)
//       [4..7]  count u32 BE
//       then count x [offset u32 BE, size u32 BE] from +8.
//     Entries point at the BLOCK ATOM START - [4-byte size]['free']['GPS '] -
//     so the literal sits at byte 4 of the pointed-to data (ExifTool matches
//     /^....freeGPS /s, QuickTimeStream.pl:1553). The count is clamped to the
//     entries that fit (ExifTool's clamp, :2547), so a truncated recording
//     with an overshooting count still yields the table prefix instead of
//     being rejected outright.
//
//  2./3. LEGACY GUESSES - count u32 at payload offset 0 (LE, then BE),
//     entries from +4, pointing directly at the "freeGPS " literal. This is
//     the layout this code originally assumed (misattributed to ExifTool; no
//     committed sample proves a firmware that writes it). Kept as fallbacks
//     so any such firmware, if it exists, is not regressed - arbitration via
//     the magic check is cheap.
function readGpsAtomEntryCandidates(dv: DataView, start: number, end: number, fileSize: number): GpsAtomEntry[][] {
    const payloadLen = end - start;
    const candidates: GpsAtomEntry[][] = [];

    const collectEntries = (entriesStart: number, count: number, littleEndian: boolean): GpsAtomEntry[] => {
        const entries: GpsAtomEntry[] = [];
        for (let i = 0; i < count; i++) {
            const e = entriesStart + i * 8;
            const offset = dv.getUint32(e, littleEndian);
            const size = dv.getUint32(e + 4, littleEndian);
            if (offset === 0 || size === 0) continue;
            if (offset >= fileSize) continue;
            // Per-entry size cap - guard against a corrupted header with
            // gigabyte-scale numbers.
            if (size > 1 << 20) continue;
            entries.push({ offset, size });
        }
        return entries;
    };

    // Canonical: version(4) + count(4) + at least one 8-byte entry.
    if (payloadLen >= 16) {
        const declared = dv.getUint32(start + 4, false);
        const capacity = Math.floor((payloadLen - 8) / 8);
        const count = Math.min(declared, capacity);
        if (count > 0) {
            const entries = collectEntries(start + 8, count, false);
            if (entries.length > 0) candidates.push(entries);
        }
    }

    // Legacy guesses: count at 0 (LE then BE), entries from +4, no clamp -
    // an overrunning count means the reading is wrong, not truncated.
    if (payloadLen >= 12) {
        for (const littleEndian of [true, false]) {
            const count = dv.getUint32(start, littleEndian);
            if (count === 0 || count > 100000) continue;
            const expected = 4 + count * 8;
            if (expected > payloadLen) continue;
            const entries = collectEntries(start + 4, count, littleEndian);
            if (entries.length === 0) continue;
            candidates.push(entries);
        }
    }
    return candidates;
}

// First read per block. Block table entries from Novatek firmware commonly
// carry size=0x8000 = 32 KB even though a single-fix record fits in 88 bytes
// (LAYOUT_DEFAULT) - the rest is reserved/padding, so reading the declared
// entry size would allocate 3600 x 32 KB = 115 MB on a 60 min clip instead of
// ~3.5 MB. That matters for mobile worker memory pressure (V8 GC on small-RAM
// Android), and costs nothing in IO: the OS reads a 4-16 KB page at a random
// offset either way. Every one-fix-per-block layout (DEFAULT 88, LEGACY 72,
// ALT 56, 70mai <=39, Vantrue NMEA ~180) is decoded from this probe alone.
const STRUCTURAL_PROBE_READ = 1024;

// Ceiling for the second read a MULTI-record block gets (ATC ring buffers,
// INNOVV/XBHT resync scans): those run to the atom bound, so a probe-sized
// view silently drops their tail records. The streaming path hands every block
// a BLOCK_PAYLOAD_SIZE window - matching it here is what keeps the two paths
// yielding the same records for the same file.
const STRUCTURAL_READ_MAX = BLOCK_PAYLOAD_SIZE;

// Pipeline depth for parallel `file.slice().arrayBuffer()` calls. Random-IO
// on mobile SD/UFS is seek-dominated (3-10 ms per access), and SD controllers
// can pipeline several outstanding requests internally. depth=8 gives ~6-8x
// wall-clock improvement on 3600-block tables without trashing IO. Browsers
// cap concurrent file reads anyway (~6-12); going higher rarely helps.
const STRUCTURAL_PARALLEL_DEPTH = 8;

// A corrupt first descriptor is common after an interrupted recording. Probe
// one IO batch so a valid later entry can still establish the table without
// risking thousands of reads for a wholly bogus candidate.
const STRUCTURAL_PREFLIGHT_ENTRIES = STRUCTURAL_PARALLEL_DEPTH;

async function parseEntries(
    file: File,
    entries: GpsAtomEntry[],
    parseBlock: ParseFreeGpsBlock,
    signal?: AbortSignal,
): Promise<ParsedRecords | null> {
    if (entries.length === 0) return null;

    const preflightCount = Math.min(STRUCTURAL_PREFLIGHT_ENTRIES, entries.length);
    const preflightBuffers = await Promise.all(
        entries
            .slice(0, preflightCount)
            .map((entry) => readEntryBytes(file, entry, STRUCTURAL_PROBE_READ).catch(() => null)),
    );
    if (!preflightBuffers.some((buf) => buf !== null && findFreeGpsLiteralOffset(buf) !== null)) return null;

    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    let magicBlocks = 0;

    const processEntry = async (i: number, buf: Uint8Array | null): Promise<void> => {
        const entry = entries[i]!;
        const literalOffset = buf ? findFreeGpsLiteralOffset(buf) : null;
        if (!buf || literalOffset === null) {
            skipped.push({
                line: i + 1,
                raw: `<entry @${entry.offset}, ${entry.size} bytes>`,
                reason: !buf ? "read failed" : "no freeGPS magic",
            });
            return;
        }
        magicBlocks++;
        const blockRecords = await parseBlockFromProbe(file, entry, buf, literalOffset, parseBlock);
        if (blockRecords.length > 0) {
            extendArray(records, blockRecords);
        } else {
            skipped.push({
                line: i + 1,
                raw: `<entry @${entry.offset}, ${entry.size} bytes>`,
                reason: "no matching variant or void/invalid record",
            });
        }
    };

    for (let i = 0; i < preflightBuffers.length; i++) await processEntry(i, preflightBuffers[i] ?? null);

    // Process the rest in pipelined batches. Within a batch we issue reads
    // in parallel via Promise.all - this is where the wall-clock win comes
    // from (8 outstanding random seeks on SD instead of one-at-a-time).
    // Between batches we sequentially parse and push results to keep
    // skipped[].line in deterministic order.
    for (let batchStart = preflightCount; batchStart < entries.length; batchStart += STRUCTURAL_PARALLEL_DEPTH) {
        throwIfCancelled(signal, "freegps structural scan aborted");
        const batchEnd = Math.min(batchStart + STRUCTURAL_PARALLEL_DEPTH, entries.length);
        const batchBuffers = await Promise.all(
            entries
                .slice(batchStart, batchEnd)
                .map((entry) => readEntryBytes(file, entry, STRUCTURAL_PROBE_READ).catch(() => null)),
        );
        for (let j = 0; j < batchBuffers.length; j++) {
            const i = batchStart + j;
            const buf = batchBuffers[j];
            await processEntry(i, buf ?? null);
        }
    }

    if (magicBlocks === 0) return null;
    return { records, skipped };
}

async function readEntryBytes(file: File, entry: GpsAtomEntry, length: number): Promise<Uint8Array | null> {
    const readLen = Math.min(entry.size, length);
    // 12-byte floor: an atom-start-pointing entry is [u32 size]["freeGPS "] -
    // a shorter read could never expose the literal at offset 4.
    if (readLen < 12) return null;
    const ab = await file.slice(entry.offset, entry.offset + readLen).arrayBuffer();
    if (ab.byteLength < 12) return null;
    return new Uint8Array(ab);
}

/**
 * Parses one block out of its probe read, re-reading it before parsing when
 * the registry identifies a layout whose records can extend beyond the probe.
 *
 * Layout metadata avoids a lossy record-count heuristic: a valid first record
 * followed by corrupt slots may be the only record visible in the first KB,
 * while later valid ring-buffer records still need the atom-sized read.
 *
 * Custom injected parsers without metadata retain the old 2+-record fallback.
 */
async function parseBlockFromProbe(
    file: File,
    entry: GpsAtomEntry,
    probe: Uint8Array,
    literalOffset: 0 | 4,
    parseBlock: ParseFreeGpsBlock,
): Promise<GpsRecord[]> {
    const probeView = toDataViewAtLiteral(probe, literalOffset);
    const boxSizeDword = readBoxSizeDword(probe, literalOffset);
    if (parseBlock.needsWholeAtom?.(probeView, boxSizeDword)) {
        const whole = await readWholeAtom(file, entry, probe, literalOffset);
        if (whole) {
            return parseBlock(
                toDataViewAtLiteral(whole, literalOffset),
                file.name,
                readBoxSizeDword(whole, literalOffset),
            );
        }
    }

    const probeRecords = parseBlock(probeView, file.name, boxSizeDword);
    if (probeRecords.length < 2) return probeRecords;

    const whole = await readWholeAtom(file, entry, probe, literalOffset);
    if (!whole) return probeRecords;
    return parseBlock(toDataViewAtLiteral(whole, literalOffset), file.name, readBoxSizeDword(whole, literalOffset));
}

/**
 * Re-reads the block up to the end of its atom, or null when the probe already
 * covers it.
 *
 * A legacy table points at the literal itself, which leaves the box-size dword
 * outside the read: the atom bound is then unknowable and the fallback is the
 * window the streaming path would have given this block. Any spill into the
 * next block is absorbed by the position-keyed dedup, exactly as it is there.
 */
async function readWholeAtom(
    file: File,
    entry: GpsAtomEntry,
    probe: Uint8Array,
    literalOffset: 0 | 4,
): Promise<Uint8Array | null> {
    const boxSizeDword = readBoxSizeDword(probe, literalOffset);
    // The dword is stored big-endian; readBoxSizeDword hands back the LE read.
    const atomEnd =
        boxSizeDword === undefined
            ? STRUCTURAL_READ_MAX
            : literalOffset - ATOM_HEADER_BEFORE_LITERAL + byteSwap32(boxSizeDword);
    const want = Math.min(entry.size, atomEnd, STRUCTURAL_READ_MAX);
    if (want <= probe.length) return null;
    const whole = await readEntryBytes(file, entry, want).catch(() => null);
    return whole && whole.length > probe.length ? whole : null;
}

/**
 * Locates the "freeGPS " literal in an entry read. Canonical tables point at
 * the block ATOM start ([u32 size]['free']['GPS '] - literal at byte 4,
 * ExifTool QuickTimeStream.pl:1553, v13.59); the legacy guess points directly
 * at the literal (byte 0). Returns the literal offset, or null when neither
 * position carries it (broken table / wrong candidate).
 */
function findFreeGpsLiteralOffset(buf: Uint8Array): 0 | 4 | null {
    if (hasFreeGpsLiteralAt(buf, 0)) return 0;
    if (hasFreeGpsLiteralAt(buf, 4)) return 4;
    return null;
}

function hasFreeGpsLiteralAt(buf: Uint8Array, at: number): boolean {
    return (
        buf.length >= at + 8 &&
        buf[at] === 0x66 &&
        buf[at + 1] === 0x72 &&
        buf[at + 2] === 0x65 &&
        buf[at + 3] === 0x65 &&
        buf[at + 4] === 0x47 &&
        buf[at + 5] === 0x50 &&
        buf[at + 6] === 0x53 &&
        buf[at + 7] === 0x20
    );
}

/** DataView over the read, starting at the literal - the offset every
 *  ParseFreeGpsBlock implementation expects. */
function toDataViewAtLiteral(buf: Uint8Array, literalOffset: number): DataView {
    return new DataView(buf.buffer, buf.byteOffset + literalOffset, buf.byteLength - literalOffset);
}
