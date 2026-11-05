// Filename-based container detection. Deliberately PURE - no mediabunny import.
//
// Kept separate from video-formats.ts (which module-evals
// `VIDEO_INPUT_FORMATS = [MP4, QTFF, MPEG_TS]` and therefore drags the ~240KB
// mediabunny lib in at import time). The main-thread ingest path needs only this
// filename check, so importing it from here - instead of video-formats.ts -
// keeps mediabunny off the landing critical path (T9). Worker bundles import
// VIDEO_INPUT_FORMATS directly and carry their own mediabunny copy regardless.

// True for MPEG-TS sticks (.ts/.m2ts) that write no moov box - playback routes
// through MSE remux regardless of browser (see per-file-mse.ts).
export function isTransportStreamName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith(".ts") || lower.endsWith(".m2ts");
}

// True for Matroska (.mkv). Browsers do not play Matroska through <video>.src
// (only WebM), so - like MPEG-TS - every .mkv routes through MSE remux: mediabunny
// demuxes it and the worker remuxes to fragmented MP4 (see per-file-mse.ts).
export function isMatroskaName(name: string): boolean {
    return name.toLowerCase().endsWith(".mkv");
}

// True for a raw HEVC elementary stream (.hevc): Annex-B bytes with no
// container. Neither <video> nor mediabunny reads it directly; demuxView
// (blob-source.ts) presents it as an MP4, so playback always goes through MSE.
// Deliberately not part of isNonIsobmffContainerName: indexing it must read
// only the head (raw-hevc-view.ts probeRawHevcHead), not demux the stream.
export function isRawHevcName(name: string): boolean {
    return name.toLowerCase().endsWith(".hevc");
}

// Read rate a healthy but slow source (an SD card behind a USB 2 reader, a
// phone's shared storage) sustains at the least.
const SLOW_SOURCE_BYTES_PER_SEC = 2 * 1024 * 1024;

// Extra time opening a file for demux may take before its first packet. A raw
// HEVC stream's MP4 view is built from one full read of the file
// (raw-hevc-view.ts); callers that bound how long an open may take add this to
// their budget, so a slow source is not mistaken for a wedged worker. Zero for
// every other file.
export function demuxPreparationBudgetMs(file: File): number {
    return isRawHevcName(file.name) ? Math.ceil((file.size / SLOW_SOURCE_BYTES_PER_SEC) * 1000) : 0;
}

// True for any container that is not natively decodable via <video>.src and must
// go through the mediabunny-backed index/playback path instead of the ISOBMFF
// moov walk. Single source of truth for the "non-ISOBMFF, remux to play" family.
export function isNonIsobmffContainerName(name: string): boolean {
    return isTransportStreamName(name) || isMatroskaName(name);
}
