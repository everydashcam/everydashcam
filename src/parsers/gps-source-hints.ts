// GPS source hints - declarative pre-flight for the embedded-GPS dispatcher.
//
// Each hint says "files matching this pattern keep their GPS here". The
// pipeline uses it to skip Mp4Index build (16 MB header IO per file) for
// formats that are not expected to have embedded GPS.
//
// One file = one flat registry. Adding a new known format = adding one entry.
// The hint is declarative metadata, not vendor-bundling: it carries a regex
// (or path check) and the source kind.
//
// "embedded" / "log-sidecar" / "basename-sidecar" / "none" - see GpsSource
// in types.ts. Unknown filenames fall through to "unknown" -> probe (safe
// default for generic .mp4 that might be GoPro/Novatek without a recognised
// pattern).

import type { VendorFile } from "./types.js";
import {
    RX_360_CARDVR_REC_PATH,
    RX_DATETIME_CHANNEL_TS,
    RX_70MAI,
    RX_BEFERICH,
    RX_BLACKVUE,
    RX_CARCAM,
    RX_DATE_SEQUENCE_CAM,
    RX_DDPAI_EVENT,
    RX_DDPAI_NORMAL,
    RX_DDPAI_TIMELAPSE,
    RX_DVR_FOUR_CHANNEL,
    RX_DVR_FOUR_CHANNEL_PATH,
    RX_E_ACE,
    RX_ESCORT,
    RX_FITCAMX,
    RX_FITCAMX_MP4,
    RX_FORD,
    RX_FORD_PATH,
    RX_HPIM,
    RX_IBOX,
    RX_JUSCAR,
    RX_LIGOGPS_TRAILER_TS,
    RX_MAH_SEQUENCE,
    RX_MAH_VIDEO_PATH,
    RX_MIVUE,
    RX_MIVUE_DUAL_PATH,
    RX_MOV_SEQ_FRI,
    RX_NAVITEL,
    RX_NEOLINE,
    RX_NEXTBASE,
    RX_NOVATEK_TS,
    RX_REDTIGER,
    RX_REC_SINGLE,
    RX_SEI_DOUBLE_GPS,
    RX_TESLA_PATH,
    RX_THINKWARE,
    RX_VUEROID,
    RX_WOLFBOX,
    isNovatekFamilyFilename,
} from "./filename/_patterns.js";

/**
 * Where a format keeps its GPS. Drives the embedded-extraction pre-filter.
 *
 * - "embedded": GPS lives inside the MP4/MOV/TS container. Always probe.
 * - "log-sidecar": GPS is in a text log that binds by filename or recording
 *   start. If the log was parsed, records exist by now; if not, embedded won't
 *   help.
 * - "basename-sidecar": GPS is in a same-basename file (GPX, .map, .gps).
 *   Sidecar handlers run in parallel; same logic - probing the container is
 *   pointless.
 * - "none": format is known to carry no embedded GPS in our current corpus
 *   (Tesla SEI not parsed, E-Ace XOR not decoded, FitCamX TS has no data
 *   stream). Switch entry to "embedded" when a working extractor lands.
 * - "unknown": no hint matched. The pipeline treats this as "may have
 *   embedded GPS, try anyway" - safe default for unfamiliar filenames.
 */
export type GpsSource = "embedded" | "log-sidecar" | "basename-sidecar" | "none" | "unknown";
export type DeclaredGpsSource = Exclude<GpsSource, "unknown">;

interface GpsSourceHint {
    /** Stable id, shown in diagnostics. */
    id: string;
    matches(file: VendorFile): boolean;
    source: DeclaredGpsSource;
    // Softens the hard skip for a basename-sidecar hint whose name shape is
    // generic (shared with cameras that DO embed GPS). When set, the skip is
    // only trusted once the paired sidecar has produced records; with no records
    // yet (sidecar absent/unparsed) the embedded probe is allowed, so a lookalike
    // file is not silently left unread. Precisely-shaped basename-sidecar hints
    // omit this and keep the unconditional skip - that IO saving is the point of
    // the registry.
    probeIfNoRecords?: boolean;
}

const GPS_SOURCE_HINTS: readonly GpsSourceHint[] = [
    { id: "datetime-channel-ts", matches: (f) => RX_DATETIME_CHANNEL_TS.test(f.file.name), source: "embedded" },
    // This card layout has video-only MP4s; avoid a 4 MB marker read for every
    // channel while leaving similarly named files from other layouts probed.
    {
        id: "dvr-four-channel",
        matches: (f) => RX_DVR_FOUR_CHANNEL.test(f.file.name) && RX_DVR_FOUR_CHANNEL_PATH.test(f.relativePath),
        source: "none",
    },
    {
        id: "sei-double-gps",
        matches: (f) => RX_SEI_DOUBLE_GPS.test(f.file.name),
        source: "embedded",
    },
    // 70mai: two storage paths depending on model.
    //  - Older / lower-tier (X800, ...): $V02 CSV log-sidecar (csv-70mai
    //    primitive) - GPSData*.txt next to the MP4, no embedded GPS.
    //  - Newer 4K (A810, M500, ...): NO CSV; GPS is embedded as a 70mai-specific
    //    freeGPS block (freegps-70mai primitive) plus a top-level `gps ` index.
    // Declaring "embedded" is safe for the CSV models too: when their
    // GPSData*.txt is present it is parsed first (log-sidecar pass), so
    // shouldTryEmbeddedGps short-circuits on hasExistingRecords and skips the
    // embedded probe. A CSV-model MP4 dropped WITHOUT its sidecar does reach the
    // probe, but carries no freeGPS marker and yields nothing - correct, only a
    // wasted index build on that edge case. The newer 4K models are the intended
    // embedded path. Confirmed on real A810 + M500 samples (ddmm.mmmm*1e5 int32).
    {
        id: "70mai",
        matches: (f) => RX_70MAI.test(f.file.name),
        source: "embedded",
    },
    // Beferich J18: plaintext LigoGPS table in the file trailer
    // (ligogps-trailer primitive).
    {
        id: "beferich",
        matches: (f) => RX_BEFERICH.test(f.file.name),
        source: "embedded",
    },
    // BlackVue: X-series writes GPS in a `gps` box inside top-level `free`
    // (free-gps-box primitive). Legacy DR-series uses .gps NMEA sidecar
    // handled in parallel by the basename-sidecar handler.
    {
        id: "blackvue",
        matches: (f) => RX_BLACKVUE.test(f.file.name),
        source: "embedded",
    },
    // CarCam 4CH: LigoGPS in ssmd meta-track (ligogps primitive).
    {
        id: "carcam",
        matches: (f) => RX_CARCAM.test(f.file.name),
        source: "embedded",
    },
    // SigmaStar REC/SOS/PAR family: iZEEKER iD300 carries KTRX records in an
    // ssmd meta track. GPS-less variants share the name shape, but probing
    // them is safe and preserves support for embedded variants.
    {
        id: "rec-single",
        matches: (f) => RX_REC_SINGLE.test(f.file.name),
        source: "embedded",
    },
    // DDPai timelapse (S_/Q_ prefix) and event (G_ prefix + _L/_X suffix)
    // recordings use basename-matched NMEA-in-.gpx sidecars. These distinctive
    // shapes can skip the embedded probe; normal clips cannot make that claim.
    {
        id: "ddpai",
        matches: (f) => RX_DDPAI_TIMELAPSE.test(f.file.name) || RX_DDPAI_EVENT.test(f.file.name),
        source: "basename-sidecar",
    },
    // DDPai "normal" recordings: `<14-digit timestamp>_<counter>.mp4`. That shape
    // is a common generic dashcam scheme (Novatek clones use it too), so it is
    // NOT trusted to hard-skip on its own - probe embedded GPS when no sidecar
    // records exist yet.
    {
        id: "ddpai-normal",
        matches: (f) => RX_DDPAI_NORMAL.test(f.file.name),
        source: "basename-sidecar",
        probeIfNoRecords: true,
    },
    // E-Ace: freeGPS Type 4 (RC4-over-base64 coordinate fields) now decodes
    // via variantEaceRc4 in internal/freegps.ts, so the file is worth probing.
    // The known local sample is a GPS-less FFmpeg re-encode - it will probe
    // empty, which is the correct degradation.
    //
    // Only the channel-suffixed form is claimed: the bare
    // `YYYYMMDD_HHMMSS.mp4` shape is one of the most common dashcam naming
    // schemes shared by Novatek clones; suffix-less E-Ace files take the same
    // "unknown" probe path anyway.
    {
        id: "e-ace",
        matches: (f) => {
            const m = f.file.name.match(RX_E_ACE);
            return m !== null && m[3] !== undefined;
        },
        source: "embedded",
    },
    // Escort M2: GPS in a .map sidecar with the same basename.
    {
        id: "escort",
        matches: (f) => RX_ESCORT.test(f.file.name),
        source: "basename-sidecar",
    },
    {
        id: "date-sequence-cam",
        matches: (f) => RX_DATE_SEQUENCE_CAM.test(f.file.name),
        source: "embedded",
    },
    // 360CARDVR: one preallocated 360GPSINFO JSONL log spans the loop-recording
    // MP4 files under REC/. The path gate keeps the shared MP4 name language
    // from suppressing an embedded probe for unrelated cameras.
    {
        id: "360gps-jsonl",
        matches: (f) => RX_FITCAMX_MP4.test(f.file.name) && RX_360_CARDVR_REC_PATH.test(f.relativePath),
        source: "log-sidecar",
    },
    // FitCamX TS: PMT carries only HEVC + AAC, no data/private streams.
    // Switch to "embedded" once a model with a data-stream surfaces.
    {
        id: "fitcamx",
        matches: (f) => RX_FITCAMX.test(f.file.name),
        source: "none",
    },
    // Ford built-in dashcam (.ts in a FordFootage/ folder): H.264 + AAC + a
    // single JPEG poster on a private stream (stream_type 0x89), no GPS/telemetry
    // track in the corpus. Verified by a full-file byte scan of a real sample:
    // no EXIF GPS IFD, no NMEA, no freeGPS. Switch to "embedded" if a
    // GPS-carrying model surfaces. The `YYYY-MM-DD_HH_MM_SS_x.ts` name is generic,
    // so the FordFootage/ folder is what actually identifies the format - gate on
    // it so a same-named .ts from another camera is not silently skipped.
    {
        id: "ford",
        matches: (f) => RX_FORD.test(f.file.name) && RX_FORD_PATH.test(f.relativePath),
        source: "none",
    },
    // HP f969x (SigmaStar CarDV TS): GPS reaches the firmware (the OSD burns
    // coordinates + speed into the picture) but is written NOWHERE machine-
    // readable - the PMT-declared private data streams stay empty, no SEI, no
    // NMEA, clean stuffing, the JPEG poster's APP15 GPS placeholder is zeroed,
    // and the mic-off AAC track is one canned silence frame on repeat.
    // Verified by a full-file scan of two real samples, one with an on-screen
    // confirmed fix. Switch to "embedded" if a firmware that fills the slots
    // surfaces.
    {
        id: "hpim",
        matches: (f) => RX_HPIM.test(f.file.name),
        source: "none",
    },
    // iBox (iCON WiFi Signature Dual, ...): Ambarella tail-atoms - byte-identical
    // to the Navitel R-series layout (IDIT + gps0 + gsea + gsen after moov),
    // parsed by the navitel-tail primitive. The filename shape is shared by
    // dual-channel MiVue; top-level F/R paths select its sidecar hint below.
    {
        id: "ibox",
        matches: (f) => RX_IBOX.test(f.file.name) && !RX_MIVUE_DUAL_PATH.test(f.relativePath),
        source: "embedded",
    },
    // Juscar MPEG-TS: LigoGPS plaintext in private-data PES (juscar-ts primitive).
    {
        id: "juscar",
        matches: (f) => RX_JUSCAR.test(f.file.name),
        source: "embedded",
    },
    // Mio / Navman MiVue (MiVue 150 Safety, ...): GPS in a same-basename `.NMEA`
    // sidecar (nmeaSidecar handler). The MP4 carries no embedded GPS. Disjoint
    // from the iBox/Navitel FILE-patterns (no channel letter, no sequence), so no
    // collision with their "embedded" hints - but `FILE<yymmdd>-<hhmmss>` is a
    // shape generic Ambarella firmwares also use, so it is not trusted to
    // hard-skip on its own: probe when no sidecar records exist yet.
    {
        id: "mivue",
        matches: (f) => RX_MIVUE.test(f.file.name),
        source: "basename-sidecar",
        probeIfNoRecords: true,
    },
    // Dual-channel MiVue: front and rear live in top-level F/R folders and the
    // front clip owns a same-basename `.NMEA` sidecar. The name itself is
    // indistinguishable from iBox, so keep the embedded probe enabled when the
    // sidecar is absent; an iBox card arranged the same way still degrades safely.
    {
        id: "mivue-dual",
        matches: (f) => RX_IBOX.test(f.file.name) && RX_MIVUE_DUAL_PATH.test(f.relativePath),
        source: "basename-sidecar",
        probeIfNoRecords: true,
    },
    // Recording-scoped NMEA log: each @Sonygps header carries the matching
    // clip's UTC start. The MP_ROOT/...ANV01 path keeps the generic MAH counter
    // from suppressing embedded probes on a renamed file from another camera.
    {
        id: "sectioned-nmea-log",
        matches: (f) => RX_MAH_SEQUENCE.test(f.file.name) && RX_MAH_VIDEO_PATH.test(f.relativePath),
        source: "log-sidecar",
    },
    // Unknown-vendor <14-digit>_<7-digit><letter> family, .ts shape only:
    // plaintext LigoGPS/LCAI trailer at EOF (ligogps-trailer-ts primitive).
    // The .mov trio of the same family stays unhinted - no GPS-carrying
    // sample (see RX_MOV_SEQ_FRI).
    {
        id: "seq-fri-ts",
        matches: (f) => RX_MOV_SEQ_FRI.test(f.file.name) && /\.ts$/i.test(f.file.name),
        source: "embedded",
    },
    // LigoGPS plaintext table after the last whole TS packet. The two-digit
    // token before the underscored channel is opaque and is not a sequence.
    {
        id: "ligogps-trailer-ts-suffix",
        matches: (f) => RX_LIGOGPS_TRAILER_TS.test(f.file.name),
        source: "embedded",
    },
    // Navitel R-series: GPS in tail atoms after moov (`gps0` + `IDIT`).
    {
        id: "navitel",
        matches: (f) => RX_NAVITEL.test(f.file.name),
        source: "embedded",
    },
    // Neoline Spectrum (SigmaStar platform): GPS in a dedicated ssmd meta
    // track of constant 40-byte samples (sstar-ssmd primitive). The ^INF
    // anchor keeps it disjoint from the Vueroid `_INF_` infix shape.
    {
        id: "neoline",
        matches: (f) => RX_NEOLINE.test(f.file.name),
        source: "embedded",
    },
    // Nextbase: GPS is embedded across the lineup - 322GW (and the
    // 422/522/622GW family) writes NMEA into an MP4 subtitle track
    // (nb-dashcam-tools doc/camera-file-format.md + gpsexportwidget.cpp
    // demuxing stream 0:s), 512GW embeds a freeGPS NMEA block (ExifTool
    // QuickTimeStream.pl GPSType 2). Actual extraction is a separate
    // primitive concern; this entry documents the family - behaviorally
    // identical to the "unknown" fallthrough today (both probe).
    {
        id: "nextbase",
        matches: (f) => RX_NEXTBASE.test(f.file.name),
        source: "embedded",
    },
    // Novatek family (VIOFO, Vantrue, single-channel OEMs): freeGPS in MP4.
    // The NVT-IM MOV sample has status-only blocks, but the related hardware family
    // includes an optional-GPS variant, so it must keep the probe enabled.
    {
        id: "novatek",
        matches: (f) => isNovatekFamilyFilename(f.file.name),
        source: "embedded",
    },
    // Novatek GPS struct in a private PES inside MPEG-TS (novatek-ts
    // primitive). Deliberately its own entry: RX_NOVATEK_TS is excluded from
    // isNovatekFamilyFilename because that gate also feeds the MP4-only
    // freeGPS probe escalation in registry.ts (TS has its own escalation
    // disjunct there).
    {
        id: "novatek-ts",
        matches: (f) => RX_NOVATEK_TS.test(f.file.name),
        source: "embedded",
    },
    // RedTiger F7NP-4K: plaintext YOUQINGGPS blocks referenced by the
    // container's Novatek `gps ` table (freegps primitive).
    {
        id: "redtiger",
        matches: (f) => RX_REDTIGER.test(f.file.name),
        source: "embedded",
    },
    // Tesla SEI-based telemetry (firmware 2025.44.25+) is not yet parsed.
    {
        id: "tesla",
        matches: (f) => RX_TESLA_PATH.test(f.relativePath),
        source: "none",
    },
    // Thinkware F-series: NMEA in the sbtl track (nmea-subtitle primitive).
    {
        id: "thinkware",
        matches: (f) => RX_THINKWARE.test(f.file.name),
        source: "embedded",
    },
    // Vueroid (S1 4K Infinite, ...): binary GPS+accel records in a tvxt/mp4s
    // track (vueroid-txet primitive).
    {
        id: "vueroid",
        matches: (f) => RX_VUEROID.test(f.file.name),
        source: "embedded",
    },
    // Wolfbox/Redtiger: binary struct in a `gpmd` meta-track (wolfbox-gpmd
    // primitive). Two struct layouts in the wild, both embedded.
    {
        id: "wolfbox",
        matches: (f) => RX_WOLFBOX.test(f.file.name),
        source: "embedded",
    },
];

const SOURCE_PRIORITY: Record<DeclaredGpsSource, number> = {
    embedded: 3,
    "basename-sidecar": 1,
    "log-sidecar": 1,
    none: 0,
};

/**
 * Resolves a tie-breaking decision when several hints match the same file.
 * The most permissive source wins (embedded > sidecar > none) so we never
 * skip an embedded probe for a file that might legitimately have it.
 *
 * Exported for tests; production code uses {@link classifyGpsSource} which
 * walks the hint registry and feeds matched sources into this resolver.
 *
 * @param matched - declared sources of every hint that matched.
 * @returns "unknown" when matched is empty, otherwise the highest-priority source.
 */
export function resolveSourceCollision(matched: readonly DeclaredGpsSource[]): GpsSource {
    if (matched.length === 0) return "unknown";
    let best = matched[0]!;
    for (let i = 1; i < matched.length; i++) {
        if (SOURCE_PRIORITY[matched[i]!] > SOURCE_PRIORITY[best]) best = matched[i]!;
    }
    return best;
}

/**
 * Returns the GPS-source hint for a file by walking the registry. When several
 * hints match (rare - patterns are mostly disjoint), the most permissive
 * source wins (embedded > sidecar > none) so we never skip a probe for a
 * file that might genuinely have embedded GPS.
 *
 * "unknown" - no hint matched. Treat as "try embedded" downstream.
 */
export function classifyGpsSource(file: VendorFile): GpsSource {
    // Collect the declared source of every matching hint (>1 is rare - the
    // patterns are mostly disjoint) and let the shared resolver pick the most
    // permissive one, so the priority rule lives in exactly one place.
    const matched: DeclaredGpsSource[] = [];
    for (const hint of GPS_SOURCE_HINTS) {
        if (hint.matches(file)) matched.push(hint.source);
    }
    return resolveSourceCollision(matched);
}

/**
 * Whether to run embedded-GPS extraction for a file. Combines two signals:
 * records already produced from log/sidecar parsing, and the source-hint
 * declaration for this filename family.
 *
 * Rules:
 *  - records already exist -> skip (already parsed, embedded would duplicate).
 *  - source = "embedded" or "unknown" -> try (an embedded format, or a
 *    generic name that might be GoPro/Novatek under the hood).
 *  - source = "log-sidecar" / "basename-sidecar" / "none" -> skip (no
 *    embedded data expected), UNLESS a matched hint sets `probeIfNoRecords`:
 *    its name shape is generic, so with no records yet we probe rather than
 *    silently leave a lookalike file unread.
 */
export function shouldTryEmbeddedGps(file: VendorFile, hasExistingRecords: boolean): boolean {
    if (hasExistingRecords) return false;
    // One walk collects both the resolved source and whether any matched hint
    // opts into a probe-when-empty (generic-shaped sidecar formats).
    const matched: DeclaredGpsSource[] = [];
    let probeIfNoRecords = false;
    for (const hint of GPS_SOURCE_HINTS) {
        if (hint.matches(file)) {
            matched.push(hint.source);
            if (hint.probeIfNoRecords) probeIfNoRecords = true;
        }
    }
    const source = resolveSourceCollision(matched);
    return source === "embedded" || source === "unknown" || probeIfNoRecords;
}
