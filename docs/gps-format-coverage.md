# GPS format coverage

## Find your camera

Search this page for a brand or model. Real-sample evidence, source-derived
implementations and unsupported formats are distinguished below. The evidence
applies to the tested recording, not every model or firmware from that brand.
A no-fix sample verifies rejection of missing GPS, not a route or measured speed.
Video playback and GPS extraction are separate capabilities.

For an unlisted camera, create a file-name report at
[add-my-camera](https://everydashcam.app/add-my-camera). Reliable support needs
recordings, and sometimes the companion logs and original card folders.

## Evidence and implementation

This document owns sample coverage, uncertain interpretations and non-support
decisions. Detailed layouts live in the linked format notes; implementation,
marker order and filenames live in the [primitive registry](../src/parsers/primitives/index.ts),
[filename techniques](../src/parsers/filename/) and
[source hints](../src/parsers/gps-source-hints.ts).
Only anonymized fixtures enter the public repository.

ExifTool Type numbers are diagnostic labels that change between versions.
Pin upstream file, revision/version and line when adding evidence; follow
implementation comments for the exact layout. Offsets relative to a `freeGPS `
literal exclude the preceding four-byte box size.

## Adding a format: sample first

Ship an extractor, real sample and tests together via
[onboard-format](../.claude/skills/onboard-format/SKILL.md).
A verified open-source implementation may substitute for a real sample only if:

1. The byte layout is checked against the source itself and cited by file,
   line and version, rather than memory or a search summary.
2. Strict markers and negative tests prove that existing formats do not claim
   each other's fixtures.
3. The code says “implemented from foreign source, not validated against a
   real sample”, and the format appears in the source-derived table below.
4. The first real sample is run through the parser and its evidence row updated;
   correct the parser or support claim when it disagrees.

The waiver does not authorize guessing. Record unresolved units/scales/signs
explicitly. If source uncertainty cannot support a defensible interpretation,
recognize and reject the layout with a code comment explaining why.

## Verified with a real recording

| Format | Real sample | Evidence and limits |
| --- | --- | --- |
| Novatek freeGPS Type-3 (float DDmm) | 2E-Drive 730 Magnet; SilverStone F1 A80-GPS Sky; VIOFO A119, A329, A329S, T130, A119M Pro, A119 Mini 2; Transcend DrivePro 550; Mikavi PQ6 3CH | PQ6 validates the alternate layout; DrivePro 550 does not validate the optional f64 upgrade. A119 Mini 2 needs cold-start clock correction. [Decoder](../src/parsers/internal/freegps.ts), [collected fixtures](../src/parsers/__fixtures__/supported-gps/real-anonymized.test.ts). |
| freeGPS Type 1 - Azdome/EEEkit XOR-0xAA ASCII (`variantAzdomeXor`) | Roadgid Tube; WonVon W4K; public Rove R2-4K-context recording | Validates the shared XOR decoder only in the freeGPS carrier. WonVon has no calibrated accel evidence; later Azdome M27/M550 Pro formats are not covered. [Fixtures](../src/parsers/__fixtures__/xor-ascii/real-anonymized.test.ts). |
| Vantrue NMEA-in-freeGPS | Vantrue N2X; S1 Pro Max front/rear | S1 Pro Max fixtures retain the Type-15 accel preamble; sensor calibration and older S1 horsontech remain unverified. [Fixtures](../src/parsers/__fixtures__/supported-gps/real-anonymized.test.ts). |
| 70mai embedded freeGPS (ddmm×1e5) | 70mai A510, A810, M500 | Coordinates cross-checked against OSD and ExifTool; speed is recorded, timing is relative. A510 rear files have no GPS. Omni/X200 remains unverified. [Fixtures](../src/parsers/__fixtures__/70mai-embedded/real-anonymized.test.ts). |
| 70mai Pro `GPS `-box (direct 36-byte records) | public sample | Real public GPS-box data cross-checks coordinates and speed, but the committed fixture is synthetic. Pro/Midrive D02/D03 family attribution; relative timestamps preserve receiver gaps. [Decoder](../src/parsers/primitives/gps-box-70mai.ts). |
| 70mai `$V02` CSV sidecar | 70mai X800, A810, Dash Cam Pro Plus A500S; unidentified model with extensionless references | Firmware clock correction and model-dependent accel axes are documented in the [format reference](format-70mai-x800-gps.md). A500S unnamed sessions bind by video time windows. [Fixtures](../src/parsers/__fixtures__/70mai/real-anonymized.test.ts). |
| 70mai dated CSV sidecar (`.GPS/GPSData*.txt`) | 70mai A800 (owner-reported; the same row shape is [publicly attributed to the A800](https://forum.mapillary.com/t/using-the-70mai-a810-dashcam-for-mapillary/9130/50)) | UTC rows bound by mode-less clip names to normal and event files. No course or accelerometer; course is inferred per clip. Valid fixes with an all-zero clip name are skipped. Rear-clip rows (`B` channel) are publicly shown but not in our sample. [Fixtures](../src/parsers/__fixtures__/70mai-dated/real-anonymized.test.ts). |
| GoPro GPMF (GPS5) | HERO5, HERO6, MAX (HERO mode); HERO7/HERO8 no-fix cases | HERO7/HERO8 verify no-fix handling only. HERO11 dual GPS5/GPS9 behavior remains unverified. [Evidence](../tests/testdata/gopro-gpmf/README.md). |
| Thinkware GPS-in-subtitle | F200 PRO (real-anonymized) | Front-file GPS and accel verified on F200 PRO; legacy F770/F750 dialects are implemented without that model evidence. [Fixture notes](../src/parsers/__fixtures__/thinkware/README.md). |
| BlackVue X `gps`-in-`free` | DR900X Plus (no-fix sample) | Verifies the container and no-fix handling, not a route or measured speed. Positive decoding has synthetic coverage. |
| BlackVue DR `.gps`/`.3gf` sidecar | DR550GW-2CH | Real bytes establish big-endian /128 g scaling and axis mapping, resolving the conflicting upstream /10 scale. [Evidence](../src/parsers/__fixtures__/blackvue/real-anonymized.test.ts). |
| `gps0`+IDIT tail atoms | NAVITEL R600 GPS; iBOX iCON WiFi Signature Dual; unbranded dual-camera ISO-BMFF files with .TS extension | Speed/course conventions differ by firmware and are calibrated from motion. DuDuBell M1, VSYS M6L and Lamax S9 attribution remains unverified. iBOX RoadScan 4K sample has no readable GPS; RoadScan 2K uses ssmd. [Decoder](../src/parsers/internal/navitel-gps0.ts). |
| RVMI (RegistratorViewer export) | DATAKAM G5P, "reg viewer old" (AMBA) | RegistratorViewer re-exports, not native camera-format evidence. [Decoder](../src/parsers/internal/rvmi-extract.ts). |
| LigoGPS in MP4 (`ssmd`) | CARCAM CC-365 (4CH, SigmaStar) | [Real-anonymized regression](../src/parsers/__fixtures__/carcam/real-anonymized.test.ts). |
| LigoGPS in MPEG-TS PES | Juscar; recordings supplied as Compartir (model unconfirmed) | Shared GPS bytes do not establish identical hardware or a rebrand. [Parser](../src/parsers/primitives/juscar-ts.ts). |
| Enciphered, fuzzed LigoGPS PES in MPEG-TS + same-name `.TXT` log | unidentified 4K HEVC camera (`YYYY_MM_DD_HHMMSS_00.TS`) | Fuzz scale verified against the TXT twin; accel units are self-calibrated. Claim only the verified header/stream-type combination. [Format](format-ligogps-ts-pes.md). |
| LigoGPS file trailer (plaintext table) | Beferich J18 | Only the plaintext twin is read; encrypted fuzzing remains unresolved. Camera-local clock; rear filename mapping is mnemonic, with front-only evidence. [Fixtures](../src/parsers/__fixtures__/ligogps-trailer/real-anonymized.test.ts). |
| LigoGPS trailer on MPEG-TS (plaintext table) | Aspiring Expert 9, Blackview X5S PRO, GKU 600 Pro, INNOVV K3; unidentified dual-camera sample | Includes empty Blackview tables, paired encrypted/plaintext K3 trailers and GKU `_GAP_` time-lapse clips. [Format](format-ligogps-trailer-ts.md). |
| SigmaStar 32/40/56-byte `ssmd` GPS track | iBOX RoadScan 2K WiFi GPS Dual; Neoline Spectrum; iZEEKER iD300 | Distinct 32/40/56-byte dialects with clock and signal-quality limitations. [Layouts and evidence](format-sstar-ssmd.md). |
| Vueroid `tvxt`/`mp4s` 72-byte track | Vueroid S1 4K Infinite | N/W and N/E verified; southern codes and absolute accel scale remain unverified. [Format](format-vueroid-txet.md). |
| Novatek GPS struct in MPEG-TS PES (bare) | VIOFO A119 V3; Avylet A1 with GPS receiver; COMTEC EG-1 front/rear | Bare PES dialect verified; B4K prefix positive decoding remains unverified. Speed units vary by firmware. [Format](format-novatek-ts.md). |
| YOUQINGGPS in Novatek `freeGPS` | REDTIGER F7NP-4K, F17 (front/interior/rear) | All six F17 clips decode; this does not validate F17 Elite/Plus or older encrypted F7N. [Format](format-youqing.md). |
| Viidure ASCII GPS in MPEG-TS PES | INNOVV N2 | Both cameras verified; their GPS can differ. Does not validate binary INNOVV formats. [Format](format-viidure-ts.md). |
| HEVC prefix-SEI track with double coordinates | XEGA XG-37-AU4G (supplied regional model label) | One positive and one no-fix sample. Speed is estimated, not measured; regional model equivalence is unconfirmed. Preserve date/camera folders. [Format](format-sei-double-gps.md). |
| DDPAI NMEA `.gpx` and TAR `.git` telemetry | Z60 Pro USB telemetry | Logs validate decoding and filename association; matching video is still needed for frame-level synchronization. [Acquisition and format](format-ddpai-gpx.md). |
| Daily DDmm CSV `.dat` telemetry | Kaiser Baas R50, author-attributed public demo logs | Daily logs and downscaled demos validate association, not the native container or frame synchronization. [Format](format-daily-csv-gps.md). |
| Nextbase binary subtitle fmt1 | 322GW-family; 422GW | Fmt1 and dispatcher precedence verified. Fmt2/622GW and the alternate carrier remain unverified. [Fixtures](../src/parsers/__fixtures__/supported-gps/real-anonymized.test.ts). |
| Garmin GPS uuid in `moov` | Dash Cam 57 | Verifies UUID carrier, clock, coordinates and speed; does not validate PNDM or every DriveAssist model. [Fixtures](../src/parsers/__fixtures__/supported-gps/real-anonymized.test.ts). |
| GKU-indirected Ligo JSON in top-level `udta` | Type S S403, manufacturer and independent-reviewer clips | Verifies GKU wrapper and GPS fields; direct LigoJSON, Yada attribution and Gsensor units remain unverified. [Fixtures](../src/parsers/__fixtures__/supported-gps/real-anonymized.test.ts). |
| Escort `.map` sidecar | Escort M2 | [Real sidecar fixture](../src/parsers/__fixtures__/escort/real-anonymized.map). |
| NMEA `.nmea` sidecar | samplefiles MOV_0581, Navman MiVue 150 Safety, Mio MiVue 955WD Pro | 955WD Pro sidecar belongs to the front clip; preserve sibling F/R folders for pairing. [Fixtures](../src/parsers/__fixtures__/mivue-955wd/real-anonymized.test.ts). |
| Recording-scoped `@Sonygps` NMEA log | Sony HDR-AS30V | One log section per recording; bind by section start, not first fix, which may arrive much later. [Fixtures](../src/parsers/__fixtures__/sectioned-nmea-log/real-anonymized.test.ts). |
| `360GPSINFO` whole-session JSONL log | Botslab G300H Pro (G300HPro firmware/OSD) | Session-wide log with relative timing; preserve the card tree. [Format](format-360gps-jsonl.md). |

### Video samples without readable GPS

These files exercise video import/playback or no-fix handling. An empty GPS
result describes the supplied clip; it does not mean the model lacks a GPS
receiver or that every export loses telemetry.

| Sample model or family | Evidence / limitation |
| --- | --- |
| 70mai A800; unidentified NO-series and app exports | A800 samples and most app exports yield no embedded GPS; A800 GPS comes from the dated `.GPS` log above. One clip in the app-export set retains `freegps-70mai` records: filenames alone cannot decide whether telemetry survived. |
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

### Model attribution

Use verified retail names: [VIOFO A119M Pro](https://www.viofo.com/products/viofo-a119m-pro-4k-hdr-voice-control-dash-camera-with-sony-starvis-2-sensor)
and A119 Mini 2, [iBOX RoadScan 2K](https://iboxstore.ru/catalog/khity-prodazh/videoregistrator-s-bazoy-kamer-ibox-roadscan-2k-wifi-gps-dual/),
and [REDTIGER F17](https://redtigercam.com/products/redtiger-f17-4k-3-channel-5g-wifi-dash-cam).
Do not generalize these to RoadScan 4K, F17 Elite/Plus or other firmware.
The supplied XEGA AU4G label is unconfirmed; the
[EU4G product page](https://de.xegatech.com/products/xega-2k-4g-lte-dashcam-auto-vorne-hinten-mit-sim-karte-dashcam-mit-parkuberwachung-app-zugriff-2-wege-talk-bewegungserkennung-nachtsicht-gps-privater-modus)
does not prove regional equivalence.

WonVon evidence comes from the reviewer's
[original recording](https://dashcamtalk.com/forum/threads/wonvon-w4k.43180/).
The separate iZEEKER [ASXT layout](format-freegps-asxt.md) must not be confused
with iD300 KTRX ssmd; its clock and sensor limitations apply independently.

## Implemented from foreign source (awaiting first real sample)

Unless stated otherwise, these paths lack real-device validation. A verified
payload in another carrier does not establish support for the listed camera.
The first real recording must resolve or retain the stated caveats.
Upstream details are recorded beside the named implementations under
[primitives](../src/parsers/primitives/) and [internal decoders](../src/parsers/internal/).

| Format | Source spec | Implementation | Evidence level | Remaining limits |
| --- | --- | --- | --- | --- |
| freeGPS Type 4 - E-ACE (base64 + RC4) | GPSType 4 | `variantEaceRc4` | foreign-source | Upstream ciphertext fixtures validate decryption; no real recording. Both coordinates must validate under one key. |
| freeGPS Type 6 - Akaso plaintext | GPSType 6 | `variantAkasoType6` | foreign-source | Verbatim upstream dumps are fixtures. Accel scale is unconfirmed upstream; firmware-specific course/accel handling is in code. |
| freeGPS Type 7 + 9 - subtract-16 RMC (incl. EACHPAI) | GPSType 7/9 | `variantSub16Rmc` | foreign-source | Upstream EACHPAI dump is a positive fixture. The ZXSBNXYS header has no established vendor. |
| freeGPS Type 8 - Akaso V1 / Redtiger F7N | GPSType 8 regex (QuickTimeStream.pl:1961) | `variantAkasoType8Encrypted` | guard only (recognize-and-bail) | Coordinates remain undecodable. The guard prevents false coordinates; it does not implement GPS support. |
| freeGPS Type 10 - horsontech (Vantrue S1 family) | GPSType 10 | `variantHorsontech` | foreign-source | No S1-family real sample; N2X fixtures exercise a different dialect. |
| freeGPS Type 12 - vendor-unidentified f64 layout | GPSType 12 (QuickTimeStream.pl:2164) | `variantNovatekDoubles` | foreign-source | Vendor unidentified; do not attribute this layout to DOD. |
| freeGPS Type 16 - IQS int32 | QuickTimeStream.pl:2298-2309 | `freegps`: IQS | foreign-source | ATC blocks share its signature. Preserve the ATC exclusion and registry order in code/tests. |
| freeGPS Type 18 - XGODY text | GPSType 18 | `variantXgodyText` | foreign-source | Speed token is knots despite the km/h label. Whether a real table/probe reaches blocks outside mdat is unverified. |
| freeGPS Type 20 - Nextbase 512G `$S` BE multi-record | GPSType 20 | `variantNextbase512gBE` | foreign-source | Upstream dumps verify byte order; real multi-record extraction remains unverified. |
| Kenwood DRV-A510W `MN`-shift freeGPS layout | QuickTimeStream.pl:1752 (`.{85}` regex branch) | `freegps`: Kenwood MN | foreign-source | Camera-local clock; mixed local/UTC files retain an ordering limitation. Accel placeholder guards are required. |
| Kenwood udta + trailer pack (`VIDEOUUU` / `CCCC...GPSDATA--`) | ExifTool ProcessKenwood (QuickTimeStream.pl:2874-2877) + ProcessKenwoodTrailer | `kenwood` | foreign-source | Trailer speed and udta accel scale are unconfirmed upstream. Camera-local time cannot calibrate UTC; local-as-UTC mvhd can still shift anchoring. |
| Rexing V1-4K affine (Type 17b) | QuickTimeStream.pl:2315-2330 | `freegps`: Rexing affine | foreign-source | Only the exact Kodak version gate is supported; ungated raw values can look like valid coordinates. |
| Viofo A129 Plus / A229 newer-firmware layout | EgorKin's Novatek-GPS notes - NO pinned file/line/version, weaker than the waiver bar; the firmware-discriminator dword expectations are transcribed in the `freegps.ts` header comment | `freegps`: LAYOUT_ALT | layout real-sample validated on Mikavi PQ6; Viofo model mapping unverified | PQ6 validates the byte layout, not these Viofo firmware attributions. The upstream citation lacks a pinned revision. |
| Garmin uuid atom (DriveAssist 51) | QuickTimeStream.pl:3514-3543 | `garmin-uuid` | real-sample validated on Dash Cam 57 | Dash Cam 57 validates the carrier/fields, not the DriveAssist 51 model claim. |
| Vantrue N2S FMAS gpmd track | QuickTimeStream.pl:3580-3611; cross-checked minusbrain/vantrue2gpx | `vantrue-fmas` | real no-fix carrier; positive fields foreign-source | Real N2S files verify no-fix handling only. Speed remains disputed: mph in ExifTool versus km/h in vantrue2gpx; positive fixes are needed. Bearing interpretation and sensor axes remain unverified. |
| Lamax S9 `gps0` XOR-0xAA ASCII (311-byte records) | ExifTool Process_gps0 (QuickTimeStream.pl:2724-2735) + the shared decrypt at :1175, v13.55 | `navitel-tail` (dialect branch) | foreign-source | Shared XOR payload is verified in freeGPS, but this gps0 carrier is not. |
| Rove Stealth 4K `gpmd` XOR-0xAA ASCII | ExifTool `gpmd_Rove` condition (QuickTimeStream.pl:189) routing to Process_text (:1175), v13.55 | `rove-gpmd` | foreign-source | Shared XOR payload is verified in freeGPS, but this gpmd carrier is not; distinct from RoveGPS ssmd. |
| Vantrue N4/N2X Type-15 accel preamble | ExifTool GPSType 15 (QuickTimeStream.pl:2240-2261), v13.55 | `freegps`: Type-15 preamble | real preamble retained on S1 Pro Max; scale/orientation from foreign source | S1 Pro Max retains a real preamble; scale/orientation still rely on upstream. Gravity baseline is removed. |
| Rove R2-4K `RoveGPS` ssmd track | QuickTimeStream.pl:330-403 | `rove-ssmd` | foreign-source | Signed DDmm hemispheres and UTC timestamps are assumptions; neither is real-sample validated. |
| Nextbase binary subtitle fmt1/fmt2 (322GW family; 622GW) | nb-dashcam-tools @ b51f244, gpssampleparser.cpp:195-261 | `nextbase-subtitle` | fmt1 real-sample validated (see verified table); fmt2 DOUBLY unverified | Fmt1 is verified on 322GW-family/422GW, not 522GW. Fmt2/622GW is also untested upstream. First-cue no-fix marker behavior and accel semantics need real evidence. |
| Mini 0806 `A,DDMMYY,...` subtitle CSV | QuickTimeStream.pl:1232-1248 | `nmea-subtitle` | foreign-source | Km/h speed is unconfirmed upstream. The first-cue marker may miss hardware with a pre-fix initial cue. |
| LigoJSON / GKU udta (Yada RoadCam Pro 4K BT58189) | ExifTool LigoGPS.pm:273-281 (ProcessGKU) + 322-398 (ProcessLigoJSON) | `ligo-json` | GKU carrier real-sample validated on Type S S403; direct form foreign-source | Type S S403 validates GKU only. Direct JSON and Yada model attribution remain unverified; Gsensor scale/orientation is unknown. |
| freeGPS Type 14 - XBHT XB702 | QuickTimeStream.pl:2216-2240, v13.55 | `variantXbht` in `freegps` | foreign-source | Km/h speed is inferred from upstream semantics. No heading field; bearing is derived. |
| DuDuBell/Navitel `gsen` accel | QuickTimeStream.pl:2769-2790, v13.55 | `navitel-tail` | foreign-source | No timestamps; the 5 Hz cadence is assumed. Only an empty real atom has been tested. |
| Roadhawk scrambled subtitle text | QuickTimeStream.pl:1250-1267, v13.55 | `nmea-subtitle` | foreign-source | Verbatim upstream sample validates the substitution table; real carrier behavior remains unverified. |
| E-PRANCE B47FS difference cipher | QuickTimeStream.pl:1485-1493, v13.55 | `nmea-subtitle` | foreign-source | Weak envelope must be followed by a valid decoded RMC; no real recording. |
| Auto-Vox RIFF trailer (AITG/AITS) | QuickTimeStream.pl:2903-2995 (ProcessRIFFTrailer), v13.55 | `autovox-riff` | foreign-source | Hemisphere codes and accel calibration are explicit upstream guesses; a plausible route alone cannot settle them. |
| freeGPS Type 11 - ATC self-keying XOR | QuickTimeStream.pl:2047-2157, v13.55 | `variantAtc` in `freegps` | foreign-source | Vendor unidentified. Repeated ring-buffer records are deduplicated by time/position; preserve ATC/IQS ordering guards. |
| freeGPS Type 13 - INNOVV (motorcycle cam) | QuickTimeStream.pl:2190-2214, v13.55 | `variantInnovv` in `freegps` | foreign-source | No clock: fixes are spread over the video window. Sensor scale/axes are unknown and omitted. |
| freeGPS Type 17c - Transcend Drive Body Camera 70 | QuickTimeStream.pl:2328-2338, v13.55 | `freegps`: Transcend DB70 | foreign-source | Degree-vs-DDmm discrimination can overlap for positions near the equator/prime meridian; no real sample. |
| Transcend DrivePro 230 f64 coordinates | QuickTimeStream.pl:2344-2352, v13.55 | `freegps`: DrivePro doubles | foreign-source | Optional precision upgrade remains unverified; the DrivePro 550 sample does not validate it. |
| Embedded BlackVue `3gf ` in the top-level free box | blackclue (emb_file_def + sentinel loop) + ExifTool Process_3gf; payload layout is real-sample validated via the DR550GW-2CH standalone sidecar | `free-gps-box` | container nesting foreign-source; payload layout real-sample validated | Payload scaling is established by the DR550GW-2CH standalone sidecar; embedded nesting is unverified. |
| Denver ACG-8050WMK2 bracketed GPS log (+ NMEA in the same carrier) | QuickTimeStream.pl:3106-3131 (ProcessGPSLog), v13.55 | `gpslog-atom` / `free-gps-box` | foreign-source | UTC is assumed from upstream. Sensor units are unknown; line-based NMEA parsing can miss an unbroken log. |
| Novatek-in-MPEG-TS, B4K prefix dialect (Blueskysea B4K / NT96670) | ExifTool M2TS.pm:353-375, v13.55 | `novatek-ts` | foreign-source (the BARE dialect of the same primitive is real-sample validated - see the verified table) | The real B4K fixture has an empty GPS region: no positive decoding evidence. [Format](format-novatek-ts.md). |
| INNOVV in MPEG-TS (motorcycle cams) | ExifTool M2TS.pm:376-401, v13.55 | `ts-pes-gps` | foreign-source | No clock and no calibrated sensor units, as with the MP4 Type-13 payload. |
| DOD LS600W in MPEG-TS | ExifTool M2TS.pm:511-537, v13.55 | `ts-pes-gps` | foreign-source | Signed coordinates deliberately differ from upstream unsigned reads. Sensor tail remains undecoded. |
| Nextbase `gdat` Base64-JSON (+ the `nbmt` text atom) | Process_gdat (QuickTimeStream.pl:2795-2830) and Process_nbmt (:2835-2856), registered on %QuickTime::Main at QuickTime.pm:945-957, v13.55 | `nextbase-gdat` / `gpslog-atom-nbmt` | foreign-source | Zone-less datetime is assumed UTC; accel units/axes are unknown. Likely software-exported data. nbmt payload is unspecified: only recognized NMEA/Denver text is claimed. |
| Wolfbox/Redtiger `gpmd` (block1/block2) | ExifTool ProcessWolfbox + trip-viewer shenshu.rs | `wolfbox-gpmd` | foreign-source | Synthetic only. Block1 has no date and its declared cadence disagrees with the in-sample clock. Parking logs can exceed video duration; validate trimming on the first real sample. |

## Parser entry points

Cross-format behavior belongs in code and its tests:

- [freegps.ts](../src/parsers/internal/freegps.ts): variant ordering, multi-record
  bounds, anchor fallback and local-clock quarantine. Preserve both ATC/IQS guards.
- [mp4-index.ts](../src/parsers/internal/mp4-index.ts): probe escalation and
  unknown-duration handling.
- [parser.ts](../src/parser.ts): teleport filtering before trip statistics.
- [trips.ts](../src/trips.ts): clock correction, relative-time anchoring and merging.

## Not supported

- **Nextbase 512GW dedicated freeGPS variant:** coordinates already decode through
  the NMEA path. Extra accel and camera-local datetime are not enabled; a real
  multi-record sample must settle gravity semantics before adding them.
  Reference: ExifTool QuickTimeStream.pl:1717-1750.
- **Azdome M27 / M550 Pro:** the post-XOR layout remains unresolved. This does
  not apply to XOR-compatible M10.
- **Encrypted Akaso V1 / Redtiger F7N Type 8:** recognized only to prevent a
  false decode; no local coordinate decoder is established.

Other recognized but undecodable layouts explain rejection at the call site;
search for `recognize-and-bail`. Do not turn a guard into a support claim.
