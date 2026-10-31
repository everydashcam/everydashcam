// Primitive - one byte-parsing format for GPS. Replaces the per-vendor hooks
// `parseLogs` / `parseVideoEmbeddedGps`: after the full refactor there is no
// vendor entity, formats register individually.
//
// Contract:
//   - kind="video-embedded": format lives inside an MP4/MOV/MPEG-TS container.
//     marker() checks cheap markers in Mp4Index (or async-probes the first
//     sample of a suitable track). For MPEG-TS Mp4Index is empty, the marker
//     reads the first bytes of the file itself.
//   - kind="log-sidecar": format lives in a separate file (CSV, sectioned
//     NMEA, ...) and knows how to identify its own video - the row carries a
//     filename or the header carries an exact recording start. marker() reads
//     a short prefix and checks the signature.
//     Sidecars driven by "filename A is paired with filename B" stay in
//     src/parsers/sidecars/ via SidecarHandler - those need knownVideos for
//     matching. Whole-card primitives receive the selected videos in context.
//
// Firmware quirks (70mai 8h-bias, Y-up accel) live INSIDE the extractor -
// one format, one spec plus quirks, no separate registries.

import type { Mp4Index } from "../internal/mp4-index.js";
import type { ParsedRecords, VendorFile } from "../types.js";

export interface PrimitiveVideoRef {
    name: string;
    relativePath: string;
    sourceKey?: string;
    // Opaque canonical owner supplied by ingest. Preserve it when a parser
    // resolves a card/path so later basename association cannot choose again.
    videoKey?: string;
}

export interface PrimitiveParseContext {
    // Whole-card logs need source/path identity as well as basenames: one
    // ingest may contain several cards with overlapping filename clocks.
    knownVideos?: readonly PrimitiveVideoRef[];
}

export interface Primitive {
    // Stable id, shown in diagnostics. Latin + dashes:
    // "csv-70mai", "gpmf", "freegps".
    id: string;
    // Human-readable name for diagnostics. UI does not use it.
    displayName: string;
    kind: "video-embedded" | "log-sidecar";

    // Cheap "is this file ours at all?" check. Must run without a full parse:
    // an Mp4Index marker (`index.maiGpsBox !== null`), an async probe of
    // a short track's first sample, or reading the first ~256 bytes.
    // For video-embedded the orchestrator builds Mp4Index once and passes it
    // in. For log-sidecar the index is not passed (undefined).
    marker(file: VendorFile, index?: Mp4Index): Promise<boolean>;

    // Full parse. Throws WrongFormatError when the marker turned out to be a
    // false positive (e.g. marker spotted `freeGPS ` magic in the first 16 MB
    // but the streaming scan found no valid blocks). Returns empty records
    // when the file matches the format but carries no GPS blocks.
    //
    // signal (optional): cancellation. Primitives with natural iteration
    // boundaries (row loops, sample iteration, block-by-block scans) should
    // check signal.aborted between iterations and throw a DOMException with
    // name="AbortError" when fired. Primitives that ignore signal degrade
    // gracefully to the previous behavior (main-side promise rejects on
    // abort, worker keeps reading until done). Adding the check is preferred
    // for any extractor that takes >10ms on a typical file.
    parse(
        file: VendorFile,
        index?: Mp4Index,
        signal?: AbortSignal,
        context?: PrimitiveParseContext,
    ): Promise<ParsedRecords>;

    // Optional: when the GPS stream is byte-identical across several files of
    // one "shot" (Juscar writes the same private-PES into both front and rear
    // .ts), the extractor declares a group key. The orchestrator parses the
    // first file of the group and clones records onto the rest with
    // mp4Filename rewritten - saves 2x IO on slow SD cards.
    //
    // null - file is not grouped, parsed standalone.
    cloneAcrossGroup?(file: VendorFile): string | null;
}
