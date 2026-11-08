// Per-session channel drift correction for cameras whose muxer cuts files by
// frame count and names them by nominal schedule (70mai): when one sensor
// delivers slightly fewer frames per wall second than the stamped rate, its
// files stay perfectly-shaped (exactly N frames, uniform PTS, nominal name)
// while their CONTENT slides ahead of the name - about a second per hour,
// several seconds of front/rear desync by the end of a long drive.
//
// The lead is measurable without decoding: all channels stop at the same wall
// instant when recording ends, so the leading channel's tail file is shorter
// than the front's by exactly the lead accumulated over the session. That
// delta is distributed linearly across the session (the sensor-rate deficit is
// constant) and stored per candidate as `driftLeadSec`; consumers shift the
// file that much later on the content axis when fetching this channel's
// content. The correction never rewrites startUtc - frame grouping, the trip
// timeline, GPS and overlays all stay on the nominal (front-honest) axis.
//
// Every guard falls back to "no correction" (null lead), so a camera without
// the defect - or a session too damaged to measure - behaves exactly as before.

import type { Channel } from "./parsers/types.js";
import type { TripFrame, VideoCandidate } from "./trips.js";

// Only 70mai is known to cut by frame count with nominal names. Other brands
// keep their own channel-anchor quirks (see docs/gps-format-coverage.md) and
// are corrected per-format when a measured sample proves the same mechanism.
const FINGERPRINT_PREFIX = "70mai|";

// A frame starting within this tolerance of the previous frame's end continues
// the recording session; filename seconds jitter +-1s around the true cut and
// SD-card file-open overhead adds a little more. Beyond it the recording
// stopped, and a stop may be a power cycle - which resets the drift - so the
// chain must not span it.
const CHAIN_JOIN_TOLERANCE_SEC = 5;

// Below this tail delta the pair is within measurement noise (audio-track
// quantization, duration rounding) - a healthy camera lands here.
const MIN_LEAD_SEC = 0.5;
// Above this the delta is not sensor drift but a broken/mispaired tail.
const MAX_LEAD_SEC = 15;
// Real sensor-rate deficits are on the order of seconds per hour. A higher
// apparent rate means the tail delta does not describe this session (damaged
// tail, session mostly ring-erased) - skip rather than misalign.
const MAX_LEAD_RATE_SEC_PER_HOUR = 30;
// A session shorter than this cannot both accumulate a measurable lead and
// stay under the rate cap, and a short tail-only chain is exactly the
// ring-erased case the rate cap guards against.
const MIN_SESSION_SEC = 600;

/**
 * Measures per-session channel drift and writes `driftLeadSec` onto every
 * non-front candidate of `frames`. Expects the complete frame list of ONE
 * camera fingerprint, sorted by startUtc (the per-fingerprint group inside
 * groupTrips - sessions may span trip splits, e.g. driving<->parking).
 * Always resets previously written leads first, so a regroup with changed
 * data never keeps a stale correction.
 */
export function applyChannelDriftLead(frames: readonly TripFrame[]): void {
    for (const frame of frames) {
        for (const candidate of nonFrontCandidates(frame)) candidate.driftLeadSec = null;
    }
    if (frames.length === 0) return;
    const fingerprint = anyCandidate(frames[0]!)?.fingerprint ?? "";
    if (!fingerprint.startsWith(FINGERPRINT_PREFIX)) return;

    for (const chain of buildSessionChains(frames)) correctChain(chain);
}

/**
 * Splits the sorted frame list into recording sessions: maximal chains where
 * each next frame starts at the previous end (within tolerance). A frame that
 * starts INSIDE the covered span (a protected event/parking copy overlapping
 * the normal loop) joins the chain without advancing its end.
 */
function buildSessionChains(frames: readonly TripFrame[]): TripFrame[][] {
    const chains: TripFrame[][] = [];
    let current: TripFrame[] = [];
    let chainEndUtc = Number.NEGATIVE_INFINITY;
    for (const frame of frames) {
        const joins = current.length > 0 && frame.startUtc - chainEndUtc <= CHAIN_JOIN_TOLERANCE_SEC;
        if (!joins) {
            if (current.length > 0) chains.push(current);
            current = [];
            chainEndUtc = Number.NEGATIVE_INFINITY;
        }
        current.push(frame);
        // Wall span, not footage: a parking time-lapse clip covers minutes of
        // wall time with seconds of video, and the next file joins at the WALL end.
        const end = frame.startUtc + frame.wallDurationSec;
        if (end > chainEndUtc) chainEndUtc = end;
    }
    if (current.length > 0) chains.push(current);
    return chains;
}

/** Measures the tail-pair lead of one session chain and writes the linear ramp. */
function correctChain(chain: TripFrame[]): void {
    // The tail is the frame that reached the session's end - the one cut by the
    // recording stop. With overlapping copies in the chain that is not
    // necessarily the last-sorted frame.
    let tail = chain[0]!;
    for (const frame of chain) {
        if (frame.startUtc + frame.wallDurationSec >= tail.startUtc + tail.wallDurationSec) tail = frame;
    }
    const sessionSec = tail.startUtc - chain[0]!.startUtc;
    if (sessionSec < MIN_SESSION_SEC) return;

    const front = tail.channels.front;
    if (!front || front.durationSec <= 1 || !hasMeasuredDuration(front)) return;
    // A time-lapse tail has no wall-true durations to compare.
    // TODO: 70mai time-lapse channels can drift by tens of minutes, not
    // seconds: in darkness the A810 Lite front sensor drops to 0.75 fps while
    // files are still cut at a fixed frame count under the shared schedule
    // names. A linear content-axis lead cannot express that - the lead grows
    // inside a file and can exceed a whole file. The candidate fix is
    // per-channel wall placement from each channel's chain of file close
    // times (File.lastModified); deferred until a second report shows demand.
    if (front.wallDurationSec !== null) return;

    for (const channel of Object.keys(tail.channels) as Channel[]) {
        if (channel === "front") continue;
        const tailCandidate = tail.channels[channel];
        if (!tailCandidate || tailCandidate.durationSec <= 1 || tailCandidate.wallDurationSec !== null) continue;
        if (!hasMeasuredDuration(tailCandidate)) continue;

        // Both channels stopped at the same wall instant, so the duration delta
        // is the lead this channel's content accumulated over the session.
        // Positive = this channel's content is ahead of its nominal timestamps
        // (its tail file is shorter). Negative would mean the front leads; the
        // correction still aligns the pair - relative sync is what split view
        // and export need, and the absolute axis is front-anchored either way.
        const leadSec = front.durationSec - tailCandidate.durationSec;
        if (Math.abs(leadSec) < MIN_LEAD_SEC) continue;
        if (Math.abs(leadSec) > MAX_LEAD_SEC) continue;
        if (Math.abs(leadSec) / (sessionSec / 3600) > MAX_LEAD_RATE_SEC_PER_HOUR) continue;

        for (const frame of chain) {
            const candidate = frame.channels[channel];
            if (!candidate) continue;
            // The lead is wall seconds, but consumers apply it on the content
            // axis - on a time-lapse clip (content compressed by the cadence
            // factor) that would over-correct by that factor. Skip; the true
            // in-clip misalignment is lead/cadence, below the noise floor.
            if (candidate.wallDurationSec !== null) continue;
            const elapsed = Math.min(Math.max(frame.startUtc - chain[0]!.startUtc, 0), sessionSec);
            candidate.driftLeadSec = leadSec * (elapsed / sessionSec);
        }
    }
}

/**
 * Whether this candidate's durationSec came from its own container rather than
 * from the per-fingerprint estimate a provisional candidate carries. The
 * whole measurement is a duration DIFFERENCE of a few seconds, so one estimated
 * side turns a healthy pair into a fabricated lead - and the estimate is what a
 * file whose metadata is still pending and a file whose moov read failed both hold.
 */
function hasMeasuredDuration(candidate: VideoCandidate): boolean {
    return candidate.metadataReady !== false && candidate.metadataFailed !== true;
}

function nonFrontCandidates(frame: TripFrame): VideoCandidate[] {
    const out: VideoCandidate[] = [];
    for (const [channel, candidate] of Object.entries(frame.channels)) {
        if (channel !== "front" && candidate) out.push(candidate);
    }
    return out;
}

function anyCandidate(frame: TripFrame): VideoCandidate | null {
    for (const candidate of Object.values(frame.channels)) {
        if (candidate) return candidate;
    }
    return null;
}
