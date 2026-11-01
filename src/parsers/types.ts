// Domain types for parsers. Capability-first architecture - no vendor entity
// (VendorPlugin et al.); the GPS byte format is described by Primitive in
// primitives/types.ts, filename heuristics by filename/types.ts, sidecars by
// SidecarHandler / AccelSidecarHandler below.

// One decoded GPS record. Extractors convert native units (DDDmm.mmmm for
// Novatek, knots for NMEA) to decimal degrees and m/s. Firmware quirks
// (70mai 8h-bias, Y-up accel) are applied INSIDE the extractor; callers get
// honest UTC and gravity-removed accel.
export interface SpeedSample {
    /** m/s; zero is only a placeholder when speedSource is unavailable. */
    speedMs: number;
    /** Absent preserves the existing device-parser contract. */
    speedSource?: "measured" | "estimated" | "unavailable";
}

export interface GpsRecord extends SpeedSample {
    unixSeconds: number;
    // Receiver-reported fix status. Use isValidGpsFix for usable GPS position
    // and motion; firmware can mark missing-signal placeholders active.
    active: boolean;
    lat: number; // decimal degrees
    lon: number; // decimal degrees
    bearingDeg: number; // degrees [0..360)
    /** Continuity ID within a record collection: source-local when parsed,
     * remapped across files and channels when the trip is assembled. */
    trackSegment?: number;
    /** Log collection owning trackSegment's local counter. Adjacent daily
     * files can continue one video while restarting their segment numbering. */
    trackSegmentSource?: string;
    // Acceleration in g, gravity-removed (dynamic component). At rest = 0,0,0.
    // Formats without an accelerometer (GPX, GPMF, NMEA sidecar, BlackVue
    // legacy) leave zeros; magnitude 0 -> brake-detector ignores.
    accelXg: number;
    accelYg: number;
    accelZg: number;
    // Name of the MP4 this record belongs to. Set by the extractor from a log
    // field (70mai $V02 field[9]), matched MP4 for GPX sidecars, File.name when
    // GPS is embedded, or filled after recording-start association.
    mp4Filename: string;
    // Internal identity of the concrete video file this record belongs to.
    // Most parsers leave it absent; the ingest dispatcher resolves basenames.
    // Whole-card logs may retain an exact owner supplied in their parse context.
    videoKey?: string;
    // A named log can arrive before its video. Keep the original reference,
    // source scope and extractor until its concrete owner commits to the trip
    // list. A cancelled provisional binding can then return to the original
    // name; pending rows never use an unscoped basename lookup.
    filenameAssociation?: {
        mp4Filename: string;
        sourcePath: string;
        sourceKey?: string;
        extractorId: string;
    };
    // A recording-scoped log may know the exact UTC start of its owning clip
    // without storing that clip's filename. The ingest layer keeps this hint
    // until MP4 metadata is available, then replaces the placeholder owner
    // with mp4Filename/videoKey. Unmatched hints remain inert: basename lookups
    // never expose them to a different recording.
    recordingAssociation?: {
        startUtc: number;
        extractorId: string;
        sourceKey?: string;
    };
    // A directory log supplies UTC samples for recordings below its parent.
    // Without videoKey this is a pending source row; bound copies retain the
    // provenance so later metadata or overlapping sources can revise ownership.
    // These samples cannot calibrate the clock used to associate them.
    timeAssociation?: {
        sourcePath: string;
        sourceKey?: string;
        extractorId: string;
    };
    // The position fix is valid but the GPS *clock* was not yet synced when
    // this record was written (cold start after a power-up: the chip delivers
    // coordinates before it decodes satellite time, so the firmware stamps a
    // near-epoch placeholder). `unixSeconds` is therefore NOT a trustworthy
    // wall-clock: the time layer ignores such records when deriving a file's
    // start / camera TZ, and re-anchors their `unixSeconds` onto the owning
    // video's window so the track still renders. Absent/false = real GPS time.
    timeUnsynced?: boolean;
    // For a `timeUnsynced` record that nonetheless carries a trustworthy
    // per-record *relative* offset from the clip's recording start (seconds),
    // this holds that offset. Some formats have no wall-clock but DO timestamp
    // each fix relative to start (the older 70mai Pro `GPS ` box `seconds`
    // field). reanchorUnsyncedTimes places such records at startUtc+offset
    // instead of spreading them evenly by index - accurate on clips with a
    // cold-start or mid-file GPS gap. Absent = no offset (spread evenly).
    relStartSeconds?: number;
    // True for a track the user manually attached to a video from another
    // device (for example dashcam GPX + action-camera footage). Its timestamps
    // are valid for calibration/rendering, but must never anchor the video's
    // own recording clock or split otherwise-consecutive clips before the user
    // chooses an offset.
    externalTrack?: boolean;
    // Stable identity of the manually attached GPX source. GPS Sync preferences
    // include it so an offset tuned for one route cannot leak onto a different
    // GPX later attached to the same video trip.
    externalTrackKey?: string;
    // Bookkeeping for the local-as-UTC correction (see
    // applyLocalClockCorrections in trips.ts): how many seconds have already
    // been SUBTRACTED from this record's original `unixSeconds` to restore
    // true UTC. Lives on the record - not on the candidate - because record
    // objects are shared between candidates and the gpsLog buckets; a
    // per-record marker keeps the shift idempotent no matter how many owners
    // revisit it. Absent = 0 (never shifted). Parsers never set this.
    localClockOffsetAppliedSec?: number;
}

/**
 * Knots -> m/s. Several primitives store speed in knots (NMEA RMC, freeGPS,
 * LigoGPS); they convert to GpsRecord.speedMs through this single constant so
 * the factor cannot drift between formats.
 */
export const KNOTS_TO_MS = 0.514444;

/**
 * Miles-per-hour -> m/s. US-market formats store speed in mph (Garmin PNDM,
 * Garmin uuid records, Vantrue FMAS); same single-constant rule as above.
 */
export const MPH_TO_MS = 0.44704;

/** Km/h -> m/s; same single-constant rule as above. */
export const KMH_TO_MS = 1 / 3.6;

// A skipped line with its reason, for diagnostics.
export interface SkippedLine {
    line: number;
    raw: string;
    reason: string;
}

// Aggregated GPS result for one ingest session.
export interface ParsedLog {
    /** Primitive ids that contributed records to this ParsedLog. */
    appliedExtractors: string[];
    records: GpsRecord[];
    // Records grouped by mp4Filename and sorted by unixSeconds.
    // Primary index used by the player to look up records for the current file.
    byFilename: Map<string, GpsRecord[]>;
    // Records with an unambiguous ingest-time owner, grouped by vendorFileKey.
    // byFilename remains the raw-format index and includes these records too.
    byVideoKey: Map<string, GpsRecord[]>;
    // Filename buckets containing unbound recording-start or directory-time hints.
    pendingByFilename: Map<string, GpsRecord[]>;
    skipped: SkippedLine[];
}

// Interpolated position between adjacent GPS points. Acceleration is excluded
// because interpolating it at 1 Hz sampling is meaningless.
export interface InterpolatedPosition extends SpeedSample {
    lat: number;
    lon: number;
    bearingDeg: number;
}

// File with path relative to the selected folder root. Path matters: some
// formats encode channel / mode in the directory tree (Movie/Front/,
// TeslaCam/SentryClips/) instead of in the filename.
export interface VendorFile {
    file: File;
    // Empty when a file was selected without directory structure.
    relativePath: string;
    // Opaque per-source session scope assigned at the ingest entry point.
    // Optional because parser fixtures and standalone parser callers do not
    // participate in a UI ingest session.
    sourceKey?: string;
}

/** Session aliases matched by duplicate-file metadata and bounded content
 * samples. Their names retain GPS ownership and recording-mode evidence. */
export interface VideoWithRecordingCopies extends VendorFile {
    recordingCopies?: readonly VendorFile[];
}

// Camera channel for multi-camera recorders.
//
// "side" - 4th camera on 4-channel models (CARCAM 4CH 360-WiFi, etc.,
// typically truck/fleet). Specific mount (side-mirror / rear-side / cargo)
// varies by model; shown as generic "Side" in the UI for now.
export type Channel = "front" | "rear" | "interior" | "side";

// Recording mode - meaningful for some formats (BlackVue encodes it in the
// filename as N/E/P/M). Stored in VideoCandidate; not displayed in UI yet.
export type RecordingMode = "normal" | "event" | "parking" | "manual";

// Thrown by extractor.parse() and SidecarHandler.parse() when the marker
// matched but the content does not. Dispatcher catches it and tries the
// next extractor; one broken file does not abort the whole ingest.
export class WrongFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WrongFormatError";
    }
}

// Result of parsing one GPS source (a log file or an MP4 with embedded data).
export interface ParsedRecords {
    records: GpsRecord[];
    skipped: SkippedLine[];
    // Optional: absolute UTC of video frame 0 as known from the GPS source
    // itself (e.g. RVMI tReV OLE-date baseline, which RegistratorViewer writes
    // at media-time 0 of the metadata track). Authoritative for files where
    // mvhd.creation_time is wrong (fragments cut from a longer original keep
    // the parent's mvhd, so deriveStartUtc otherwise falls back to first GPS
    // fix and chart leads video by GPS-fix delay). Only primitives that can
    // tie a wall-clock to media-time 0 should set this; absent for GPS sources
    // that only know per-sample timestamps.
    // Second contract: `records: []` PLUS a defined hint is a positive claim
    // on the file - the registry stops the extractor walk and keeps the hint
    // and skip diagnostics (a quality-gated parse that condemned every fix,
    // e.g. the sstar-ssmd phantom-track gate). Empty records WITHOUT a hint
    // stays "matched the shape, carries no GPS" and lets siblings walk.
    videoStartUtcHint?: number;
    // Optional: evidence that this file's record clocks are the camera's
    // LOCAL wall time (zone baked in by the firmware) rather than UTC.
    // Positive = the records run ahead of true UTC by this many seconds,
    // always a multiple of the 15-min zone grid. Measured from the cold-start
    // clock jump between pre-fix RTC blocks and the first satellite-synced
    // record (freegps), gated on the filename clock matching the synced
    // records - see the hint derivation in primitives/freegps.ts. Consumers
    // aggregate per camera fingerprint and subtract from the record axis
    // (applyLocalClockCorrections in trips.ts); a file without a cold start
    // inherits its siblings' measurement there.
    localClockOffsetHintSec?: number;
    // Optional: accelerometer samples the primitive found in the container
    // itself (an embedded `3gf ` child, a `gsen` atom, a binary preamble next
    // to the GPS record). Kept as AccelSample - the same type an accel-only
    // sidecar produces - rather than folded into GpsRecord.accel*g, because
    // these streams run at their own rate (5-20 Hz against 1 Hz GPS) and must
    // go through mergeAccelSamples to land on the nearest record. The
    // dispatcher collects them per file; source (sidecar vs container) makes
    // no difference past that point.
    accelSamples?: AccelSample[];
}

// Vendor-neutral sidecar handlers for basename-binding formats (GPX,
// NMEA `.gps`, Escort `.map`). Separate contract from Primitive: classification
// runs via matches(file, knownVideos) which needs the list of known MP4s.
export interface SidecarHandler {
    id: string;
    // Returns the MP4 name if this file is a sidecar of one of knownVideos; null otherwise.
    matches(file: VendorFile, knownVideos: Set<string>): string | null;
    // Parses the sidecar and binds records to the given mp4Filename.
    // signal (optional): cancellation; same contract as Primitive.parse -
    // honored on iteration boundaries when present, ignored otherwise.
    parse(file: VendorFile, mp4Filename: string, signal?: AbortSignal): Promise<GpsRecord[]>;
}

// One accelerometer sample with relative time from video start. Used for
// accel-only sidecars (BlackVue `.3gf`); absolute time is resolved after
// ingest via VideoCandidate.startUtc.
export interface AccelSample {
    msSinceStart: number;
    accelXg: number;
    accelYg: number;
    accelZg: number;
}

// Handler for accel-only sidecars (no GPS). After ingest, app.ts merges
// samples into GpsRecords via msSinceStart + startUtc -> nearest GPS record.
export interface AccelSidecarHandler {
    id: string;
    matches(file: VendorFile, knownVideos: Set<string>): string | null;
    // signal (optional): cancellation; same contract as SidecarHandler.parse.
    parseAccel(file: VendorFile, signal?: AbortSignal): Promise<AccelSample[]>;
}
