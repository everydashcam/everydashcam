# GPS format coverage

## Find your camera

Use your browser's Find command to search this page for the camera brand or
model. The section where it appears tells you how confidently its GPS data is
supported:

- **Verified with a real recording** means the format has been tested against
  files produced by the camera.
- **Implemented from an open-source reference** means support is available but
  still needs confirmation from the first real sample.
- **Not supported** explains known formats that everydashcam deliberately does not
  claim.

If your camera is not listed, create a file-name report at
[everydashcam.app/add-my-camera](https://everydashcam.app/add-my-camera). New formats
are added from real recordings, and the report is the easiest place to start.

Video playback and GPS extraction are separate capabilities.
A clip with no GPS can still play, and a camera that supports GPS may need a
receiver, a satellite fix, or companion files. The tables describe the tested
recordings, not every firmware or model from the same brand.

## What this document records

This is the evidence log for dashcam GPS formats. Ground truth comes from real
device recordings and verified open-source implementations such as ExifTool's
`QuickTimeStream.pl`. Real recordings are not committed; the repository only
contains anonymized fixtures under `tests/testdata/` and
`src/parsers/__fixtures__/`.

**Division of labor.** Which format is claimed by which primitive/variant,
probe order, filename techniques, and embedded-vs-sidecar source hints are
registered in code - `src/parsers/primitives/index.ts`,
`src/parsers/filename/<field>.ts`, `src/parsers/gps-source-hints.ts` - and
that code is the only place those facts need to live; this doc does not
re-list them. What this doc is the source of truth for: which formats have
been verified against a **real device sample**, and the per-format gotchas -
unit/scale quirks, sign conventions, firmware clock biases, unresolved
upstream conflicts, and the deliberate non-support decisions. Where a
byte-layout claim here disagrees with the code, the code wins - fix the doc.

## Adding a format: sample first

The gold standard is a byte parser that ships with a **real sample**
(`extractor + sample + tests`); when a sample exists, the `onboard-format`
skill is the path.

A byte parser MAY ship from a verified foreign open-source implementation
(ExifTool, vendor tools, OSS extractors) WITHOUT a real sample, provided ALL
of:

1. the byte layout is verified against the foreign source itself, cited by
   file + line + version (e.g. `QuickTimeStream.pl:2298, v13.59`) - not from
   memory, not from a search digest;
2. the marker is strict - a lookalike block from another format cannot claim
   it, and negative tests prove the existing fixture corpus stays unclaimed
   in both directions;
3. the code carries the flag "implemented from foreign source, not validated
   against a real sample", and the format is listed in the "Implemented from
   foreign source" table below;
4. when the first real sample arrives, it MUST be run through the parser
   (`onboard-format` skill) and the table row updated - moved to the verified
   table, corrected, or the parser fixed.

The waiver does not authorize guessing. Where the foreign source is itself
unverified, contradictory beyond a recordable caveat, or provably misclassifies
our real samples, the format is not implemented at all - and the reasoning
lives as a comment at the bail-out in code, not as a backlog entry here. Unresolved upstream conflicts (units, scales, hemisphere conventions) are
carried as explicit caveats in the tables - never silently picked and forgotten.

## Verified with a real recording

| Format | Real sample | Notes |
|---|---|---|
| Novatek freeGPS Type-3 (float DDmm) | 2E-Drive 730 Magnet, SilverStone F1 A80-GPS Sky, VIOFO A119, A329, A329S, T130 (seq-less `_PR`/`_PF` parking names), A119M Pro / A119 Mini 2 (14+6-digit names) | datetime@44 default layout. Newer VIOFO firmwares (A119M Pro/A119 Mini 2) use the 14-digit+counter naming, not the classic `YYYY_MMDD_...` shape. A119 Mini 2 stamps records with the camera zone baked in (local-as-UTC) while its pre-fix RTC blocks (status `' 00'`/`'V00'`, no valid signature) run UTC - the cold-start clock jump is measured and subtracted to restore true UTC (`coldStartClockJumpSec` in `internal/freegps.ts`, `applyLocalClockCorrections` in `trips.ts`) |
| freeGPS Type 1 - Azdome/EEEkit XOR-0xAA ASCII (`variantAzdomeXor`) | Roadgid Tube (14+7-digit names) | ONE record format, THREE carriers (this freeGPS block, the Lamax S9 `gps0` atom, the Rove Stealth `gpmd` track) sharing `internal/xor-ascii-gps.ts` - this row is the only one of the three with a real sample, so it is what keeps the shared decoder honest. Accel triple (/100 g) is gravity-INCLUDED in the raw block - the `freegps` primitive subtracts the per-file axis-mean baseline after the parse pass (zeroed at <2 accel records; no-accel records untouched); timestamps assumed UTC; EEEkit 3-digit speed fallback; the +/-4-digit altitude field never emitted (no GpsRecord field); post-XOR Azdome (M27/M550 Pro) will NOT match - expected, see "Not supported" |
| Vantrue NMEA-in-freeGPS | Vantrue N2X | RMC string inside the block (`variantVantrueNmea`) |
| 70mai embedded freeGPS (ddmm×1e5) | 70mai A510, A810, M500 | int32×1e5 NMEA ddmm.mmmm coords (NOT decimal degrees; ExifTool's A810 branch - QuickTimeStream.pl GPSType 19 - reads the same offsets as /1e5 + minutes conversion), heading@+35, speed@+39 is km/h and is the emitted speed source (verified against the trajectory on a real A810 clip: matches to tenths on normal ~1 Hz fixes, 0 at a standstill, stays live through position-freeze gaps - where a dt=1s trajectory reconstruction produced 2-4x spikes), **no per-record timestamp** (only a constant 8h-shifted file-start unix) -> records emitted `timeUnsynced` and re-anchored onto the video window. Coordinates verified against the on-video OSD stamp (digit-exact) and ExifTool's independent decode. Layout: `freegps-70mai.ts`. A510 confirmed (incl. its `LA`/`PA` parking-mode filename prefixes; rear `B` clips carry no GPS - front only). Likely also Omni/X200 |
| 70mai Pro `GPS `-box (direct 36-byte records) | public sample | THIRD 70mai GPS generation (2019-2021 Pro, Midrive D02/D03): top-level `GPS ` box (uppercase 4cc, distinct from the 4K models' lowercase `gps ` index) holding 36-byte records: `has_gps`, a per-record `seconds` offset, speed in metres/hour, DD MM.mmm-packed int32 coords. Real speed field (no trajectory guess); records `timeUnsynced` but the per-record `seconds` offset IS honored via `relStartSeconds` (accurate across a cold-start / mid-file GPS gap). Cross-checked vs freezer52000 `maigps.c` + mzdun `70mai.cc`; validated on a real public GPS box (Warsaw, 105 km/h, haversine/speed ratio 1.00). Committed fixture is synthetic. `Mp4Index.maiGpsBox` + `classifyEmbeddedGpsKind` gate the dispatch |
| 70mai `$V02` CSV sidecar | 70mai X800, A810 | `GPSData*.txt`; +8h firmware clock bias (UTC+8 China default), carried only in the CSV path |
| GoPro GPMF (GPS5) | HERO5, HERO6, MAX (HERO mode); HERO7/HERO8 no-fix cases | See the [fixture evidence](../tests/testdata/gopro-gpmf/README.md): HERO7/HERO8 samples exercise no-fix handling, not a confirmed route.  HERO11 also writes GPS9; when both streams are present GPS5 is discarded per file (GPS9 has per-sample time/fix/DOP) - not validated on a real HERO11 dual-stream MP4, flagged in `gpmf-extract.ts` |
| Thinkware GPS-in-subtitle | F200 PRO (real-anonymized) | gsensori/`GxRMC`(no `$`)/CAR cues; accel `g=count/<sens>`, baseline-removed; GPS in front file only. Legacy `$GxRMC`+`\0` dialect (F770/F750) also handled |
| BlackVue X `gps`-in-`free` | DR900X Plus (no-fix sample) | Real container and NMEA carrier verified, but every supplied RMC record has status `V`: this clip confirms no-fix handling, not a decoded route or measured speed. Positive-fix behavior has synthetic coverage. |
| BlackVue DR `.gps`/`.3gf` sidecar | DR550GW-2CH (previously labelled DR550DW) | `.gps` is NMEA. Real `.3gf` bytes confirm big-endian, /128 g scaling (not ExifTool's /10), file X=lateral and Z=longitudinal; `0xFFFFFFFF` ms ends the stream. `blackvue-3gf.ts` auto-detects endianness and defaults to BE if ambiguous. Evidence: `src/parsers/__fixtures__/blackvue/real-anonymized.test.ts`; upstream references: ExifTool Process_3gf and blackclue. |
| `gps0`+IDIT tail atoms | NAVITEL R600 GPS (original MOV sample), iBOX iCON WiFi Signature Dual, unbranded 2-ch motorcycle cam (ISO-BMFF under a `.TS` extension, `FILE...<F\|R>.TS` in `Normal/F\|R/` folders; real sample) | ExifTool Process_gps0 layout: speed u16 @20, altitude i32 @16, in-record year-2000/month @22-23, course u8 @28. **Speed unit and course encoding are firmware-dependent** - km/h + course/2 (R600 GPS, iBOX) vs KNOTS + low-byte-of-course mod 256 (the `.TS` motorcycle cam, verified against its burned-in OSD; ExifTool's course/2 is marked "NC" there) - no byte discriminator found, so both are calibrated per file against the trajectory with a km/h + course/2 default below the sample floor (`navitel-gps0.ts`). Firmware interleaves ~1/3 stale ring-buffer rows (older timestamps, already-driven positions) -> dropped in-parser. Shared parser: ExifTool also attributes this family to DuDuBell M1 / VSYS M6L / Lamax S9 (likely covered, unverified) - Auto-Vox reuses the `gps0`/`gsen` NAMES but in a RIFF trailer with different record layouts, and has its own primitive (and its OWN knots speed - unrelated to this calibration). iBOX is multi-SoC: the **iCON** sample uses `gps0` (this row); **RoadScan 2K** uses a different `ssmd` layout below. The tested **RoadScan 4K** clip has no readable GPS; this does not establish a hardware-wide limit |
| RVMI (RegistratorViewer export) | DATAKAM G5P, "reg viewer old" (AMBA) | re-exported clips carry an RVMI track |
| LigoGPS in MP4 (`ssmd`) | CARCAM CC-365 (4CH, SigmaStar) | |
| LigoGPS in MPEG-TS PES | Juscar; recordings supplied as Compartir (model unconfirmed) | Shared GPS byte format; this does not establish identical hardware or a rebrand |
| Enciphered, fuzzed LigoGPS PES in MPEG-TS + same-name `.TXT` log | unidentified 4K HEVC camera (`YYYY_MM_DD_HHMMSS_00.TS`) | GPS PID typed `0x82` in the PMT (masked on the AV path - mediabunny reads it as DTS and fails the file). Fuzz scale = ExifTool entry 3, settled against the camera's own unfuzzed `.TXT` twin; the TXT is read first, the PES only under the sample's exact stream type and chunk header. Speed km/h, course positional after `km/h`; accelerometer in an undocumented unit, self-calibrated to 1 g. [Format notes](format-ligogps-ts-pes.md) |
| LigoGPS file trailer (plaintext table) | Beferich J18 | zero-padded trailer past the last top-level box, TWO LIGOGPSINFO directories: encrypted twin (recognize-and-bail, fuzz state unsettled) + plaintext 0x84-slot table = ExifTool's "Redtiger F9 4K" branch, flags 0x03 (not fuzzed, speed km/h); `A:` course, `H:` altitude (dropped - no GpsRecord field), `M:` magnetic variation (dropped); timestamps camera-local, 1 Hz, duplicated/skipped seconds observed. Filename `YYYY-MM-DD_HH_MM_SS_f.mp4`; `_r` rear mapped by mnemonic (front-only corpus). Layout: `internal/ligogps.ts` (parseLigoGpsTrailer) |
| LigoGPS trailer on MPEG-TS (plaintext table) | Aspiring Expert 9, Blackview X5S PRO, INNOVV K3; unidentified dual-camera sample | Blackview parking/time-lapse samples include empty tables. INNOVV K3 uses paired enciphered/plaintext trailers; only the plaintext twin is read. See [format notes](format-ligogps-trailer-ts.md). Detection and AV clamp: `src/ts-trailer.ts`; telemetry: `parseLigoGpsTsTrailer` in `src/parsers/internal/ligogps.ts` |
| SigmaStar 32/40/56-byte `ssmd` GPS track | iBOX RoadScan 2K WiFi GPS Dual; Neoline Spectrum; iZEEKER iD300 | RoadScan 2K has 32-byte DDmm records with km/h speed and heading in 2-degree steps, distinct from Rove's 32-byte layout. These cameras use a dedicated ~1 Hz `ssmd` metadata track, not LigoGPS. Neoline 40-byte rows carry direct f64 degrees and a no-fix sentinel; iZEEKER 56-byte KTRX rows carry reversible encoded coordinates plus a scrubbed stable identifier. Shared fields: integer km/h speed, heading in 2-degree steps, day/hour/min/sec; year/month anchored to the filename date. Layout and validation: `docs/format-sstar-ssmd.md` |
| Vueroid `tvxt`/`mp4s` 72-byte track | Vueroid S1 4K Infinite | 20 Hz GPS+accel records: f32 DDmm coords UNSIGNED + packed hemisphere code (N/W and N/E validated; southern codes unverified), u32 wall-clock = camera-LOCAL stored as fake unix-UTC -> `timeUnsynced` + `relStartSeconds`, speed f32 km/h, u16 altitude; accel triple kept with per-file DC removal (absolute scale unconfirmed - static vector ~0.65, not ~1 g). Layout: `docs/format-vueroid-txet.md` |
| Novatek GPS struct in MPEG-TS PES (bare) | VIOFO A119 V3; Avylet A1 with the optional GPS receiver; COMTEC EG-1 (Taiwan-market helmet camera, front/rear); TS recording mode (`<14-digit>_<6-digit>.TS`) | classic freeGPS record struct (HH MM SS YY MM DD i32 + A/NS/EW + f32 DDmm + speed + course) at the start of a 1008-byte private_stream_2 PES, PID auto-detected (NOT in the PMT), 1 record/s. A119 V3 and Avylet store knots; EG-1 stores km/h, recognized by the converted speed step (0.01852) with knots as the fallback for ambiguous data. No-fix Avylet rows use `V00` with unset clock fields; struct clock is camera-LOCAL -> `timeUnsynced`. The B4K prefix dialect has its own row in the foreign-source table. [Layout, evidence and fixtures](format-novatek-ts.md) |
| YOUQINGGPS in Novatek `freeGPS` | REDTIGER F7NP-4K, F17 (front/interior/rear) | Plaintext GPS clock, coordinates, speed and course; all six F17 sample clips decode through `freegps`. This is not the older encrypted F7N Type-8 layout. See [format notes](format-youqing.md) and `src/parsers/__fixtures__/youqing/real-anonymized.test.ts`. |
| Viidure ASCII GPS in MPEG-TS PES | INNOVV N2 | Real front/rear recordings; GPS UTC, decimal degrees and explicit km/h speed. The camera pair can contain different fixes, so records are not cloned. This does not validate the binary INNOVV layouts in the foreign-source table. See [format notes](format-viidure-ts.md). |
| HEVC prefix-SEI track with double coordinates | XEGA XG-37-AU4G (supplied regional model label) | GPS positions and relative timing; speed is estimated from positions, not measured by the camera. One sample has fixes; the other only no-fix packets. Keep the `InternalView` / `ExteriorView` and date folders. See [format notes](format-sei-double-gps.md). |
| DDPAI NMEA `.gpx` and TAR `.git` telemetry | Z60 Pro USB telemetry | Real logs verify decoding and filename association; matching video bytes are still needed to verify frame-level synchronization. Original MOLA N3, Z50 and Z60 videos alone do not establish GPS support. See [storage and format notes](format-ddpai-gpx.md). |
| Nextbase binary subtitle fmt1 | 322GW-family (`_FH` high-bitrate clip, 1800 rec @10 Hz) | fmt2 (622GW) is still foreign-source-only - see that table |
| Escort `.map` sidecar | Escort M2 | |
| NMEA `.nmea` sidecar | samplefiles MOV_0581, Navman MiVue 150 Safety, Mio MiVue 955WD Pro | The 955WD Pro writes synchronized `FILE<YYMMDD>-<HHMMSS>F/R.mp4` clips into sibling F/R folders; the front clip owns the same-basename `.NMEA` sidecar. The shared iBox-shaped filename techniques provide time/channel metadata, while the camera key strips both folder letters so the pair stays one frame. |
| Recording-scoped `@Sonygps` NMEA log | Sony HDR-AS30V | One `.LOG` can contain a timestamped section per clip; the section start matches the MP4 `creation_time`, while RMC fixes provide UTC, coordinates, and speed in knots. A GPS cold start can delay the first fix by almost two minutes, so association uses the section header rather than the first fix or file order. |
| `360GPSINFO` whole-session JSONL log | Botslab G300H Pro (G300HPro firmware/OSD) | One preallocated 2-MiB `GPS.TXT` spans the `360CARDVR/REC` loop clips. Only the first row has a camera-local clock; later rows advance every 5 s. `a`/`o` are decimal-degree coordinates, `s` is knots, `d` is course, and `99`/`999` is the no-fix sentinel. Rows bind to video-name clock windows and emit `timeUnsynced` + `relStartSeconds`. Layout: `docs/format-360gps-jsonl.md` |

### Video samples without readable GPS

These files exercise video import/playback or no-fix handling. An empty GPS
result describes the supplied clip; it does not mean the model lacks a GPS
receiver or that every export loses telemetry.

| Sample model or family | Evidence / limitation |
| --- | --- |
| 70mai A800; unidentified NO-series and app exports | A800 samples and most app exports yield no embedded GPS. One clip in the app-export set retains `freegps-70mai` records: filenames alone cannot decide whether telemetry survived. |
| DDPAI MOLA N3, Z50, Z60 | The video-only sample sets have no readable GPS. NMEA companion logs are required where available; Z60 Pro USB telemetry is verified separately above. |
| JOOYFACT A1 | The original MOV plays; no GPS records found. The supplied A1 label does not establish an A1G/A1P variant. |
| Rexing SC4KS | The original MPEG-TS plays, including seeking; no GPS records found. This does not validate Rexing V1-family GPS formats. |
| FITCAMX | Tested TS streams contain HEVC/AAC without a GPS data PID. Exact model unidentified. |
| E-ACE; Fujida Karma Pro Max; GKU D900 | Tested re-encoded clips contain no readable GPS. |
| VIOFO A229 Plus; VUEROID S1 QHD; VUEROID/VIOFO comparison clips | Review/comparison re-encodes contain no readable GPS. Original VUEROID S1 4K Infinite recordings are verified above. |
| NAVITEL R600 GPS re-export; old AMBA MOV | The re-export and old MOV have no GPS track. Both R600 sets show R600 GPS in the picture overlay; `R600-1` / `R600-2` were sample-set labels, not distinct models. |
| BlackVue ELITE 9 | The tested front file has no embedded GPS. |
| Unidentified SigmaStar `REC…` clip; date-space-named MP4 | The particular SigmaStar clip has only a JPEG thumbnail track; the other file has an empty Novatek `gps ` index. Other cameras with similar filenames can contain working GPS. |
| HP f969x | Coordinates and speed reach the picture overlay, but the tested original TS has no machine-readable GPS. The declared private data streams are empty, no SEI/NMEA was found, and the JPEG GPS placeholder is zeroed. See `gps-source-hints.ts`. |

### Implemented with synthetic coverage only

Garmin PNDM decoding is implemented in
`src/parsers/internal/pndm-extract.ts`, with synthetic fixtures under
`src/parsers/__fixtures__/garmin/`. No real-device recording currently verifies
this path, so it is not evidence for a particular Garmin model. The format is
binary data in a text/subtitle track, not GPMF.

### Model names and sample labels

Use retail model names where they can be verified: [VIOFO A119M Pro](https://www.viofo.com/products/viofo-a119m-pro-4k-hdr-voice-control-dash-camera-with-sony-starvis-2-sensor)
and A119 Mini 2 are identified by their picture overlays, including in the
previously mixed “A119 Mini Pro” sample set.
[iBOX RoadScan 2K WiFi GPS Dual](https://iboxstore.ru/catalog/khity-prodazh/videoregistrator-s-bazoy-kamer-ibox-roadscan-2k-wifi-gps-dual/)
is distinct from RoadScan 4K.
[REDTIGER F17](https://redtigercam.com/products/redtiger-f17-4k-3-channel-5g-wifi-dash-cam)
does not imply F17 Elite or F17 Plus.
BlackVue sample headers identify **DR550GW-2CH**; the older DR550DW folder
and fixture comments were mislabelled.
The supplied XEGA AU4G suffix remains unconfirmed: the manufacturer's
[XG-37-EU4G page](https://de.xegatech.com/products/xega-2k-4g-lte-dashcam-auto-vorne-hinten-mit-sim-karte-dashcam-mit-parkuberwachung-app-zugriff-2-wege-talk-bewegungserkennung-nachtsicht-gps-privater-modus)
does not establish that the regional variants are identical. Model attribution
and successful decoding are separate evidence.

## Implemented from foreign source (awaiting first real sample)

Everything in this table shipped under the waiver above with strict markers,
negative tests, and the in-code flag. **Standing requirement for every row, no
exceptions: the first real sample MUST be run through the parser and this row
updated** - moved to the verified table, corrected, or the parser fixed.

Offset convention used throughout this doc: "literal N" = offset from the
start of the `freeGPS ` (or equivalent) magic literal. ExifTool's offsets
include the 4-byte box-size dword, so literal N = ExifTool offset N+4.

| Format | Source spec | Primitive / variant | Status flag | Caveats |
|---|---|---|---|---|
| freeGPS Type 4 - E-ACE (base64 + RC4) | GPSType 4 | `variantEaceRc4` | foreign-source | 20-key RC4 ring ("luckychip gps", "customer aa..ss gps"); BOTH coord fields must validate under the SAME key; speed knots; accel dropped; ordered before Type 3 (an E-ACE block is a byte-alias of LAYOUT_ALT); channel-suffixed names only; real ExifTool ciphertexts decode-verified in-test |
| freeGPS Type 6 - Akaso plaintext | GPSType 6 | `variantAkasoType6` | foreign-source | speed already km/h (no knots conversion); `x.xx`@12 firmware quirk -> course+180 normalization + accel zeroed; accel /1000 scale is NC upstream; both verbatim upstream dumps are fixtures |
| freeGPS Type 7 + 9 - subtract-16 RMC (incl. EACHPAI) | GPSType 7/9 | `variantSub16Rmc` | foreign-source | gate = the 7-byte shifted `$GPRMC,` literal (34 57 60 62 5d 53 3c) at literal 56, no ZXSBNXYS requirement; bytes >=16 shifted down -> parseNmeaText; the verbatim EACHPAI dump decodes as the positive fixture; vendor of the ZXSBNXYS header unknown |
| freeGPS Type 8 - Akaso V1 / Redtiger F7N | GPSType 8 regex (QuickTimeStream.pl:1961) | `variantAkasoType8Encrypted` | guard only (recognize-and-bail) | coordinate cipher unknown upstream; the vendor apps (AkasoCar/ANKEWAY) decode GPS via an internet service - server-side key, incompatible with the no-backend constraint even if cracked; the guard prevents the misparse this block otherwise produces (lat 0.0 / lon ~0.00077 with a valid 2019 timestamp) |
| freeGPS Type 10 - horsontech (Vantrue S1 family) | GPSType 10 | `variantHorsontech` | foreign-source | `horsontech`@44 gate; lon f32 BEFORE lat (88/92); speed knots; accel /1000; the real N2X sample is the Type-15 family, not this |
| freeGPS Type 12 - vendor-unidentified f64 layout | GPSType 12 (QuickTimeStream.pl:2164) | `variantNovatekDoubles` | foreign-source | attribution kept neutral - NOT DOD; header firmware string `20130815.01`; f64 DDmm coords, speed f64 knots |
| freeGPS Type 16 - IQS int32 | QuickTimeStream.pl:2298-2309 | IQS sub-variant inside `parseType3Block` (`freegps`) | foreign-source | `IQS` at literal 12; abs(int32 LE)/1e7 degrees, hemisphere sign after abs; speed int32/100 m/s (negative => layout mismatch); bearing 0 -> downstream forward-fill; MUST stay behind the ATC exclusion - see the ordering hazard below |
| freeGPS Type 18 - XGODY text | GPSType 18 | `variantXgodyText` | foreign-source | decimal-degree `N:/S:/E:/W:` text at literal 19; the speed token is KNOTS although the firmware labels it km/h; accel zeroed (sample shows gravity-included, y~0.99); OPEN: ExifTool says XGODY blocks are table-referenced but live OUTSIDE mdat - whether our table path / 16 MB probe reaches them on a real file is unverified |
| freeGPS Type 20 - Nextbase 512G `$S` BE multi-record | GPSType 20 | `variantNextbase512gBE` | foreign-source | u16 BE 0x2453 (`$S`)@44 + date plausibility; ALL reads big-endian (unaligned i32 lat/lon at rec+0x0f/+0x13 confirmed vs unpack 'N' + the dump oracle); 0x20 stride, per-record magic+date validation is the terminator (ExifTool's $pos precedence bug deliberately not transliterated); fractional seconds preserved; a multi-record block is re-read out to its atom bound once the first probe finds 2+ records (`parseBlockFromProbe` / `STRUCTURAL_READ_MAX` in `src/parsers/internal/freegps.ts`); unverified against a real multi-record sample |
| Kenwood DRV-A510W `MN`-shift freeGPS layout | QuickTimeStream.pl:1752 (`.{85}` regex branch) | `LAYOUT_KENWOOD_MN` in `freegps` | foreign-source | positional gate (A[NS][EW]@84-86 + zero bytes 81-83/87); `MN:` banner is diagnostic only, never required; accel i32×3 /256 at 104-115, optional, guarded against all-zero and counter placeholders; raw year >=2000 => camera-LOCAL clock -> timeUnsynced; mixed local/UTC files carry a documented ordering limitation only |
| Kenwood udta + trailer pack (`VIDEOUUU` / `CCCC...GPSDATA--`) | ExifTool ProcessKenwood (QuickTimeStream.pl:2874-2877) + ProcessKenwoodTrailer | `kenwood` | foreign-source | FIRST date per record used (ExifTool "ignore second date"); udta coords DDmm×1e4, trailer coords DECIMAL degrees (no ddmm); trailer speed NC-assumed km/h; udta accel /1000 NC; camera-local time -> timeUnsynced + relStartSeconds, excluded from deriveStartUtc/TZ estimation (absolute wall-clock may still be TZ-shifted when mvhd is local-as-UTC); trailer C-run tolerance (`KENWOOD_TRAILER_MIN_C_RUN`/`KENWOOD_TRAILER_MAX_C_RUN` in `src/parsers/internal/kenwood.ts`) covers an ExifTool dump-vs-code ambiguity |
| Rexing V1-4K affine (Type 17b) | QuickTimeStream.pl:2315-2330 | `rexingAffine` option of `freegps`, gated on Kodak `frea`/`ver ` == `3.01.054` (`Mp4Index.kodakVersion`) | foreign-source | exact version match only, no heuristic fallback - obfuscated raws overlap valid DDmm ranges, an ungated affine = silently wrong coords; scoped to LAYOUT_DEFAULT |
| Viofo A129 Plus / A229 newer-firmware layout | EgorKin's Novatek-GPS notes - NO pinned file/line/version, weaker than the waiver bar; the firmware-discriminator dword expectations are transcribed in the `freegps.ts` header comment | `LAYOUT_ALT` in `freegps` | foreign-source | signature-based, never seen on a real sample; EgorKin's offset base is the ATOM START (= literal-4), and mixing bases is what makes this layout easy to misread |
| Garmin uuid atom (DriveAssist 51) | QuickTimeStream.pl:3514-3543 | `garmin-uuid` | foreign-source | moov-child uuid with usertype 9b630f8d-6374-40ec-8204-bc5ff5091728; 20-byte BE records from payload 33 (epoch 1904, speed mph, lat/lon i32 × 180/2^31); both-sentinel (i32 min) rows dropped - ExifTool still emits their timestamps, we deliberately do not |
| Vantrue N2S FMAS gpmd track | QuickTimeStream.pl:3580-3611; cross-checked minusbrain/vantrue2gpx | `vantrue-fmas` | foreign-source | UNRESOLVED speed unit: mph per ExifTool vs km/h per vantrue2gpx - we follow ExifTool; a real sample settles the 1.609× risk; +62 decoded as bearing (vantrue2gpx reads elevation - rejected on n=1 plausibility); lon struct BEFORE lat; coordinate = deg + (min + centiArcsec/6000)/60; accel zeroed (raw is gravity-included, axis order a single-sample guess); per-second dedupe |
| Lamax S9 `gps0` XOR-0xAA ASCII (311-byte records) | ExifTool Process_gps0 (QuickTimeStream.pl:2724-2735) + the shared decrypt at :1175, v13.55 | `navitel-tail` (dialect branch) | foreign-source | same payload as the Azdome freeGPS blocks - see the shared decoder note below. 311-byte records in a top-level `gps0` atom, signature at record offset 2; the walk stops at the first record that loses it |
| Rove Stealth 4K `gpmd` XOR-0xAA ASCII | ExifTool `gpmd_Rove` condition (QuickTimeStream.pl:189) routing to Process_text (:1175), v13.55 | `rove-gpmd` | foreign-source | third carrier of the same record. Distinct from the implemented `rove-ssmd` (different track, different format). Runs last in the gpmd chain - gpmf / wolfbox / fmas own the other dialects and reject these bytes |
| Vantrue N4/N2X Type-15 accel preamble | ExifTool GPSType 15 (QuickTimeStream.pl:2240-2261), v13.55 | `variantVantrueNmea` in `freegps` | foreign-source (its GPS half is real-sample validated) | the RMC tail already carries the whole fix, so only the accel is read from the binary preamble: three int32 LE at literal 88, /1000, gated on the Type-15 geometry (status 'A' at 24, hemispheres at 36/52). Upstream calls the scale NC, but its own hexdump settles the magnitude - the triple reads -1.038/0.066/0.002, i.e. ~1 g on one axis, so gravity is INCLUDED and the per-file baseline is removed downstream. An all-zero triple is treated as a placeholder, not a car at rest |
| Rove R2-4K `RoveGPS` ssmd track | QuickTimeStream.pl:330-403 | `rove-ssmd` | foreign-source | meta + ssmd + constant 32-byte stsz gate; LE doubles DDmm, u16 knots, u8×6 date (+2000); hemisphere ASSUMED signed-DDmm (S/W negative) - unverified; timestamps ASSUMED UTC - unverified, affects deriveStartUtc; not the LigoGPS ssmd dialect; distinct from gpmd_Rove "Stealth 4K encrypted text", which is the `rove-gpmd` row above |
| Nextbase binary subtitle fmt1/fmt2 (322GW family; 622GW) | nb-dashcam-tools @ b51f244, gpssampleparser.cpp:195-261 | `nextbase-subtitle` | fmt1 real-sample validated (see verified table); fmt2 DOUBLY unverified | fmt1 prefix 0x0120 (author-tested 322GW; 422/522GW untested-maybe), fmt2 prefix 0x0416 (622GW - upstream itself marks it `// Untested`); RMC parsed, GGA dropped (no GpsRecord fields); accel gravity semantics unknown upstream -> per-file mean baseline removal, zeroed at <2 samples, Y negated per upstream; registered BEFORE `nmea-subtitle` - the Thinkware marker half-claims these files (coords parse, accel lost) and registration order is the only protection (pinned by test); marker miss mode: a first sample with an all-NUL RMC field is not claimed |
| Mini 0806 `A,DDMMYY,...` subtitle CSV | QuickTimeStream.pl:1232-1248 | third dialect of `nmea-subtitle` (`sbtl-nmea-extract`) | foreign-source | speed km/h is NC upstream - re-verify on the first real moving sample; accel raw m/s^2 gravity-INCLUDED -> /9.80665 + mean baseline removal (zeroed at <2 samples); hard `20`+YY century (not a 70-pivot); our marker probes only the FIRST track sample where ExifTool scans all - pre-fix cue content of real hardware unknown |
| LigoJSON / GKU udta (Yada RoadCam Pro 4K BT58189) | ExifTool LigoGPS.pm:273-281 (ProcessGKU) + 322-398 (ProcessLigoJSON) | `ligo-json` | foreign-source | plaintext JSON records in a top-level udta (`LIGOGPSINFO {` direct, or `__V35AX_QVDATA__` GKU indirection); status `A` only; decimal degrees; speed knots; Gsensor zeroed (scale/orientation undocumented upstream); 4 MB scan cap; absolute UTC; separate primitive - the encrypted-chunk `ligogps` untouched |
| freeGPS Type 14 - XBHT XB702 | QuickTimeStream.pl:2216-2240, v13.55 | `variantXbht` in `freegps` | foreign-source | 36-byte records from literal 12, found by resync (as INNOVV). Packed clock in bytes 1..7 (year+2000, then tenths, dropped - GpsRecord is whole seconds), `A`[NS][EW] at +8, u32 DDmm×1e4 coordinates at +16/+20, u16 speed at +28. Speed unit is km/h by upstream's default tag semantics, NOT confirmed. The format has NO heading field at all - `bearingDeg` stays 0 and forwardFillBearingsIfAllZero derives it from the trajectory |
| DuDuBell/Navitel `gsen` accel | QuickTimeStream.pl:2769-2790, v13.55 | `parseGsenAtom` in `navitel-gps0.ts` (`navitel-tail`) | foreign-source | 3-byte records, one int8 per axis over /16, in a top-level `gsen` atom next to `gps0`; delivered through `ParsedRecords.accelSamples`. **Timestamp-less** - upstream observed 5 Hz on one video and that cadence is assumed. Assumed in the safe direction: a fixed rate means a differently-paced clip runs long and its tail falls past the video window, where mergeAccelSamples drops it; pacing by duration/count would instead keep every sample and put it on the wrong second, inventing braking. Gravity stays in (mergeAccelSamples removes the per-axis mean). The local sample's atom is empty, so only the empty case is real-tested |
| Roadhawk scrambled subtitle text | QuickTimeStream.pl:1250-1267, v13.55 | `decodeRoadhawkCue` in `sbtl-nmea-extract.ts` (`nmea-subtitle`) | foreign-source | a pre-decode step on the text path, not a carrier: cue bytes are offset by 43 into a 40-char substitution table, yielding `X..Y..Z..G..$GPRMC,...`. Gate = a trailing `*XX~`; the decode then self-verifies against that decoded shape, so a lookalike cue is left untouched instead of mangled. The table reproduces upstream's verbatim sample byte-for-byte (pinned by test). Accel prefix is gravity-included and joins the existing per-file baseline removal |
| E-PRANCE B47FS difference cipher | QuickTimeStream.pl:1485-1493, v13.55 | `decodeEpranceCue` in `sbtl-nmea-extract.ts` (`nmea-subtitle`) | foreign-source | also a pre-decode step: every byte is shifted by a constant recovered from known plaintext - the 4th-from-last char is always the NMEA `*`. Gate is pure shape (leading NUL, trailing newline), which is weak on its own, so the result is kept ONLY when it contains an RMC sentence; runs before the tx3g length-prefix strip, which would otherwise eat the leading NUL |
| Auto-Vox RIFF trailer (AITG/AITS) | QuickTimeStream.pl:2903-2995 (ProcessRIFFTrailer), v13.55 | `autovox-riff` | foreign-source | RIFF-shaped chunks appended AFTER the last ISOBMFF box: `gps0` holds 0x28-byte `AITG` records (f64 DDDMM.MMMM coords, u16 KNOTS - the Ambarella `gps0` uses km/h - year-1900 date, direction/2), `gsen` holds 0x0c-byte `AITS` records (int8 triple, and unlike the Ambarella `gsen` they timestamp themselves, so no rate is assumed). Detection: the head of the trailing region is read during indexing (`Mp4Index.trailerHead`) so the synchronous kind gate can see it; the chunk name alone is not enough (`gps0`/`gsen` collide with the Ambarella atoms) and the `AITG`/`AITS` magic separates them. **UNRESOLVED, carried from upstream:** the hemisphere bytes are an explicit guess (1=N/E, 2=S/W) - on upstream's own sample that choice is the difference between Ireland and Bremen, both plausible; likewise the accel's 24-counts-per-g calibration |
| freeGPS Type 11 - ATC self-keying XOR | QuickTimeStream.pl:2047-2157, v13.55 | `variantAtc` in `freegps` | foreign-source | vendor-unidentified 2013-2015 hardware. 52-byte records from literal 44, each XOR-ed with two keys it carries itself (byte +0x14 keys 0x00-0x14 and 0x18-0x1b; byte +0x1c keys 0x1c and 0x20-0x32) - both key slots are plaintext zero, so encryption is what parks the key there. Plaintext anchors `ATC`@+0x15 / `001`@+0x1d lie outside both ranges and pre-filter candidates (they cannot confirm a decrypt, only rule one out). Stored hour is hour-minus-1; heading folds -180..180 up into 0..360; speed is already m/s; altitude@+0x28 dropped (no field). Registered BEFORE the Type-3 path - see the ATC/IQS ordering hazard. The device ring buffer is restated in EVERY block, and unlike upstream we keep no cross-block "most recent" state: these records carry a real wall clock, so `dedupRecords` collapses the repeats on time+position, at the cost of transient duplicates per clip |
| freeGPS Type 13 - INNOVV (motorcycle cam) | QuickTimeStream.pl:2190-2214, v13.55 | `variantInnovv` in `freegps` | foreign-source | multi-record: `A`[NS][EW]\0 at literal 12 gates the block, then fixes are found by resync (upstream globs the signature; a stride assumption desyncs on a mid-block start). Per record: lat/lon f32 DDmm at +4/+8, speed knots +12, track +16. **No clock of any kind** - not even a file-start one - so records ship `timeUnsynced` with `unixSeconds: 0` and reanchorUnsyncedTimes spreads them over the video window. The i32 triple at +20 is DROPPED: upstream emits it raw with neither scale nor axis mapping. Scan is bounded by the atom size (from the box-size dword), not the 32 KB payload window - the window spans about two 16 KB atoms, and re-parsed neighbours have no timestamp to dedup on |
| freeGPS Type 17c - Transcend Drive Body Camera 70 | QuickTimeStream.pl:2328-2338, v13.55 | LAYOUT_DEFAULT branch of `parseType3Block` (`freegps`) | foreign-source | gate = raw LE dword at literal -4 == 0x400000 (the big-endian box size 0x4000, i.e. an ORDINARY 16 KB atom, not a "4 MB" one) AND a plain-degree range check on the raw floats - the range check carries the real discrimination, the dword alone is weak; coords already decimal degrees (ddmm skipped), speed already km/h. The payload window starts AT the literal, so the dword is threaded in separately (`readBoxSizeDword`); a read that cannot reach back 4 bytes stays on the plain Type-3 decode. Residual overlap with a genuine DDmm block needs lat 0..1.5° and lon 0..3° - open water in the Gulf of Guinea; same exposure as upstream |
| Transcend DrivePro 230 f64 coordinates | QuickTimeStream.pl:2344-2352, v13.55 | `readDriveProDoubles` in `parseType3Block` (`freegps`) | foreign-source | precision upgrade only, no new marker: f64 lat/lon at literal 108/124 replace the f32 pair when each agrees within 0.001°, in whatever units the branch left behind (DDmm on a plain Type 3, degrees after a 17b/17c conversion). Upstream's `dirLen >= 0xb0` gate degenerates here (our window ≠ atom length) so the agreement test carries all discrimination; the altitude f64 at literal 156 is read-and-dropped (no GpsRecord field) |
| Embedded BlackVue `3gf ` in the top-level free box | blackclue (emb_file_def + sentinel loop) + ExifTool Process_3gf; payload layout is real-sample validated via the DR550GW-2CH standalone sidecar | `readEmbedded3gf` in `free-gps-box-extract.ts` (`free-gps-box`) | container nesting foreign-source; payload layout real-sample validated | a `3gf ` child next to the `gps ` child, same bytes as the paired `.3gf` file, so `parse3gfBuffer` is reused - the /10-vs-/128 conflict is settled at /128 by the DR550GW-2CH sample, not open. Reaches GpsRecord through `ParsedRecords.accelSamples` -> `DispatchedEmbeddedGpsResult.accelByFilename` -> `combineAccelSources` -> the same `mergeAccelSamples` the sidecars use; a sidecar wins a collision. Inert on a GPS-less file by construction (mergeAccelSamples attaches to existing records, and the extractor only runs when the `gps ` sibling produced some) |
| Denver ACG-8050WMK2 bracketed GPS log (+ NMEA in the same carrier) | QuickTimeStream.pl:3106-3131 (ProcessGPSLog), v13.55 | `denver-gpslog` decode step, reached from `gpslog-atom` (top-level `udat`) and from `free-gps-box` (the `gps ` child of `free`) | foreign-source | ASCII records `YYMMDDHHMMSS[1][NS][ddmmmmmm][EW][dddmmmmmm][alt][kph][dir][kCal]±NNN...`; coordinates are DD + minutes×1e4 (hence /600000), speed km/h (upstream's default GPSSpeed semantics), timestamp taken as UTC because upstream stamps it `Z` - the format carries no second clock to cross-check that. TWO carriers, both wired exactly as upstream: the top-level `udat` atom (which ALSO carries plain NMEA - ExifTool attributes that to Datakam Player exports - so the primitive tries NMEA first, Denver second) and the `gps ` child of a Pittasoft-style `free` box, where the BlackVue NMEA path runs first and this is the fall-through. Deliberate deviation: upstream's leading `\b` is DROPPED - the accel run ends in a digit, so back-to-back records (which the single dumped record cannot rule out) would stop the scan after the first one; discrimination is carried by the bracket skeleton, the fixed digit counts and the mandatory accel run, and a match starting mid-number dies on the datetime range check. Dropped fields: altitude and kilocalories (no GpsRecord field) and the trailing ±NNN run (upstream emits it as an opaque string with no scale or axis order, so accel stays zero). The `[1]` status literal is required, so a no-fix row never emits a position. Known limitation: the NMEA path is line-based where upstream scans the whole buffer - a log written as one unbroken line yields nothing, a silent miss rather than a misparse |
| Novatek-in-MPEG-TS, B4K prefix dialect (Blueskysea B4K / NT96670) | ExifTool M2TS.pm:353-375, v13.55 | second branch of `novatek-ts` | foreign-source (the BARE dialect of the same primitive is real-sample validated - see the verified table) | the record is byte-identical to the bare dialect, only preceded by a FIXED 164-byte prefix, so it is a marker+reassembly problem rather than a decode one. Upstream's `^(.{164})?(.{24})A[NS][EW]` says fixed offset, NOT the anchor-scan-and-rebase that nvtk_mp42gpx describes - a fixed offset cannot land on a false anchor inside video bytes, so the stricter reading was taken (and the nvtk "jump = frame[0]+1" adaptation-field question disappears with it). 164+44 overruns a PES-start packet, which is the only reason this extractor reassembles at all; reassembly is gated on a cheap pre-filter (the record's hour/min/sec u32 triple DOES fit in the first packet), so ordinary video PES never pay for it. Details: `docs/format-novatek-ts.md` |
| INNOVV in MPEG-TS (motorcycle cams) | ExifTool M2TS.pm:376-401, v13.55 | `ts-pes-gps` | foreign-source | carrier-only work: the 32-byte record is byte-identical to the MP4 freeGPS Type-13 one, so `parseInnovvRecord` is REUSED rather than rewritten. `V00\0` marks a fix-less slot and is skipped. Same as the MP4 path: no clock of any kind -> `timeUnsynced`, and the i32 triple at +20 is dropped (upstream emits it raw with neither scale nor axis mapping) |
| DOD LS600W in MPEG-TS | ExifTool M2TS.pm:511-537, v13.55 | `ts-pes-gps` | foreign-source | 32-byte BIG-endian records from PES-body offset 32, gated by `$S` per record; int32×1e-7 DECIMAL degrees (not DDmm), speed in metres per 100 s, full in-record UTC (so NOT timeUnsynced), seconds stored in tenths and truncated to whole. Course is scaled ×100 into a range that overflows a signed u16, so values ≥0x8000 fold back by 36000 - i.e. 350° is stored as 64536, not 35000. TWO deliberate deviations: (1) coordinates are read SIGNED where upstream unpacks `N` (unsigned), which would turn every southern/western fix into ~429°, and the format has no hemisphere flags to recover it otherwise; (2) upstream's hunt for the earliest record in the CYCLIC list is skipped - every record carries a full UTC stamp and the trip layer sorts globally, so the rotation undoes itself, and upstream's own walk checks `$S` at the wrong index. The 10 bytes after the last record that upstream guesses are a 3-axis reading are not decoded |
| Nextbase `gdat` Base64-JSON (+ the `nbmt` text atom) | Process_gdat (QuickTimeStream.pl:2795-2830) and Process_nbmt (:2835-2856), registered on %QuickTime::Main at QuickTime.pm:945-957, v13.55 | `nextbase-gdat`; `nbmt` rides the same text decoders via its own `gpslog-atom-nbmt` registration (ordering rationale at its entry in `primitives/index.ts`) | foreign-source | The WHOLE `gdat` atom is one Base64 blob decoding to ONE JSON object `{cameraModel?, gpsData: [{datetime, lat, lon, speed, bearing, xAcc/yAcc/zAcc, gpsStatus}]}` - key spellings verbatim from the Perl. Only `gpsStatus == "A"` rows are emitted (upstream's own gate); speed is MPH; values may be JSON numbers OR numeric strings, since Perl casts either way. `datetime` is ISO-shaped - upstream's `tr/-T/: /` is what gives that away - and carries NO zone, so UTC is an ASSUMPTION (defensible: the value comes off a GPS receiver and upstream files it under GPSDateTime, which is UTC by definition) while an explicit `Z`/offset IS honored; assembled through Date.UTC, never Date.parse, so a zone-less string cannot pick up the viewer's own timezone. Dropped: x/y/zAcc (upstream emits them as an opaque "x y z" string with no unit or axis order - and do NOT borrow the scale from the Nextbase SUBTITLE formats, same vendor but a different producer) and cameraModel (no GpsRecord field). ExifTool attributes the format to "Nextbase software", so the producer is likely the MyNextbase desktop app on export - hunt for a sample among software-exported clips, not just cameras. **`nbmt` is the most speculative row in this table:** upstream only routes it to its generic text parser and documents nothing about the payload, so it is wired to the same NMEA/Denver decoders and anything else stays unclaimed |
| Wolfbox/Redtiger `gpmd` (block1/block2) | ExifTool ProcessWolfbox + trip-viewer shenshu.rs | `wolfbox-gpmd` | foreign-source | `gpmd`-named meta track that is NOT GPMF - LE int64 value/scale pairs, two layouts. **block2** (Wolfbox G900, Redtiger F9 4K): full UTC date+time in-sample, lat@0xb0, lon@0xc0, spd@0x48 knots, dir@0x58. **block1/ShenShu** (2026-firmware 3-channel Wolfbox): no date, status@0, lat@0x28, lon@0x38, same spd/dir slots -> timeUnsynced + relStartSeconds. The ShenShu track header claims 5 Hz via stts but the data is 1 Hz - pace by the in-sample clock, never stts. Parking-mode clips can embed the whole parked interval (~90 min) into a ~3 min video: a real sample would need records trimmed to video duration before trip stitching. trip-viewer reads 0x58 as "altitude" (rejected; ExifTool: direction). Synthetic fixtures only; SD/filename shapes in `filename/_patterns.ts` (`RX_WOLFBOX*`) |

**Marker-ordering hazard (ATC vs IQS):** ATC Type-11 sample-1 blocks ALSO
carry `IQS20130306B` at literal 12 - the exact anchor of the Type-16 check.
ExifTool disambiguates only because `ATC` at literal 65 is tested first. Our
Type-16 decode therefore requires NOT-`ATC`@65-67 (kept even though the shared
datetime gate already rejects ATC blocks - documented in code and test), and
`variantAtc` is registered ahead of the Type-3 path that hosts the Type-16
sub-variant. Both guards stay: either alone would do, together they make the
ordering explicit at both ends.

## Parser behaviors worth knowing

Cross-cutting behaviors that affect many formats and are easy to trip over.
Format-specific quirks live in the tables; deep internals live in code
comments.

- **Teleport/spike filter.** `dropTeleportOutliers` (gates and the derivation
  behind them: `TeleportFilterOptions` / `DEFAULT_TELEPORT_FILTER` in
  `src/parser.ts`) runs at trip finalization, before distance/event
  computation. Fully timeUnsynced formats (70mai 4K, Wolfbox block1) are
  exempt by construction; navitel's in-primitive ring-buffer passes are
  separate.
- **Multi-record contract.** A single freeGPS block can carry many fixes
  (e.g. Nextbase 512G Type 20, ATC Type 11, INNOVV Type 13, XBHT Type 14), so
  the variant contract is array-valued - see `FreeGpsVariant.parse` in
  `src/parsers/internal/freegps.ts` for the exact return-type contract (empty
  array = void/invalid block). These variants additionally bound their record
  scan by the atom size rather than the read window (`BLOCK_PAYLOAD_SIZE` in
  the same file) - see `atomScanLimit`.
- **Backward anchor-scan fallback.** When no strict freeGPS variant matches a
  block, a backward scan for the `A[NS][EW]` anchor validates the full Type-3
  geometry and emits only after two consecutive blocks agree at the same
  anchor. Absolute-year (y>=2000) records from this path are quarantined as
  `timeUnsynced` - the only known absolute-year writer in this geometry is
  Kenwood's local clock, and honest-UTC emission would poison per-fingerprint
  TZ estimation.
- **Novatek probe escalation.** A file classified `none` but carrying a
  Novatek-family filename (or the `<14-digit>_<6-digit>.ts` novatek-ts shape)
  still gets a re-probe at `MAX_PROBE_BYTES` + reclassification (both window
  sizes live in `src/parsers/internal/mp4-index.ts`), so a clip whose first
  GPS payload sits past the default window - table-less old-firmware MP4, or
  a high-bitrate TS whose first GPS PES lands past it - is not silently
  dropped.
- **mvhd sentinel.** All-ones `duration` / `creation_time` read as null (ISO
  14496-12 "unknown" for duration; a garbage filter for creation_time).
  Duration-sentinel files land in `state.unindexed`, not the filename/mtime
  fallbacks.

## Not supported

- **Nextbase 512GW dedicated freeGPS variant** - coordinates already parse via
  the full-payload RMC scan (`variantVantrueNmea`). A dedicated variant would
  add only accel (i32×3 /256 at literal 64) and the camera datetime (ASCII at
  literal 48), and both are unwanted: the accel hexdump reads ~1.11g, so
  gravity-included raw through /256 would false-trigger an impact marker every
  ~3 s, and the datetime is the camera's LOCAL clock, which loses to satellite
  UTC by the project's time rule. If a real sample ever revives this: gate on
  literal bytes 12..47 all-zero (which also gives the Vantrue negative test its
  meaning - the committed N2X fixture keeps a nonzero discriminator at 12..15)
  and settle gravity from real multi-record data. (QuickTimeStream.pl:1717-1750.)
- **Azdome M27 / M550 Pro** - changed format again after the GS63H XOR
  generation, and what it changed to is unresolved upstream too. Type-1 not
  matching them is expected, not a bug. M10 is NOT in this list - it is the
  XOR-compatible generation and parses through Type-1.

Formats whose coordinates nobody can decode correctly are not listed here.
Where our code recognises one and bails, the reasoning is a comment at that
bail-out - grep for `recognize-and-bail`.

## Facts worth pinning (easily gotten wrong)

- `gps0` is NOT "Ambarella/Novatek" per ExifTool - that string appears nowhere
  in `QuickTimeStream.pl`; the parser is right, the vendor label is a local
  name.
- 70mai embedded coordinates are NMEA `ddmm.mmmm × 1e5` int32, NOT decimal
  degrees `× 1e7`. The trap: a decimal read of the same int32 still yields a
  continuous, in-region track at plausible speed - just compressed 0.6x and
  shifted up to 0.4° inside the degree cell - so a track-shape sanity check
  cannot catch the wrong scale; only an absolute reference (the on-video OSD
  stamp, ExifTool) can.
- 70mai's +8h clock bias is a UTC+8 (China) firmware default, not "PST"; it
  lives in the `$V02` CSV path - the embedded 70mai formats have no per-point
  clock at all.
- Garmin is PNDM binary, not GPMF (any `garmin-gopro-gpmf` note is wrong).
- EACHPAI decodes - via the subtract-16 Type-7 path (`variantSub16Rmc`; the
  verbatim EACHPAI dump is the positive test fixture), not "undecodable".
- Type 12 is NOT DOD; its header firmware string is `20130815.01`
  (QuickTimeStream.pl:2164, v13.59). The `20130318.01` string belongs to the
  ATC Type-11 sample 2 (:2057). ExifTool names no vendor - attribution stays
  neutral.
- ExifTool "GPSType N" numbers drift between releases - they are diagnostic
  labels in QuickTimeStream.pl, not a stable spec. Always pin version + line
  numbers (this doc mixes v13.59 and v13.55 - each citation states its own);
  a bare "Type 16" from an older
  note may point at a different layout in a newer ExifTool.
