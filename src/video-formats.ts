// Shared list of container formats accepted on the mediabunny Input side.
//
// Centralised so adding a new container takes effect across indexer, MSE
// backend, export, transcode pipeline and preview workers in one place - the
// previous per-file `ISOBMFF_FORMATS = [MP4, QTFF]` const was duplicated in
// 9 modules.
//
// MP4/QTFF cover the vast majority of dashcams (ISOBMFF family). MPEG_TS
// covers 4K HEVC sticks that write `.ts/.m2ts` without a moov box. MATROSKA
// covers `.mkv` (dashcam viewers/tools re-export clips as Matroska). Both
// MPEG_TS and MATROSKA playback go through MSE remux (see per-file-mse.ts)
// regardless of browser - neither container is natively decodable via
// <video>.src in Chromium/Firefox/Safari.
//
// This module pulls in mediabunny (the format objects are its values). The pure
// filename checks `isTransportStreamName` / `isMatroskaName` deliberately live in
// video-format-names.ts so the main-thread ingest path can detect these
// containers WITHOUT importing mediabunny - keeping the ~240KB lib off the
// landing critical path (T9). Worker bundles import VIDEO_INPUT_FORMATS directly.
import { MATROSKA, MP4, MPEG_TS, QTFF } from "./mediabunny.js";

export const VIDEO_INPUT_FORMATS = [MP4, QTFF, MPEG_TS, MATROSKA];
