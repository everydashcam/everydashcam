// Per-clip technical-details panel for the expanded trip card. Opt-in: it is
// built and revealed only when the user clicks the info toggle on a clip row
// (see the "file-details" delegated action in sidebar.ts). This is the explicit
// "technical details" surface where the codec / container / bitrate / fps jargon
// voice.md otherwise keeps out of driver-facing copy is allowed (voice.md
// carve-out 4). Display-only: it reads VideoCandidate fields and never mutates
// state or drives playback/export.

import type { VideoCodec } from "mediabunny";

import { escapeHtml } from "../escape.js";
import { getDateLocale, t } from "../i18n/index.js";
import type { Channel } from "../parsers/types.js";
import {
    frameChannels,
    tripChannels,
    type StartSource,
    type Trip,
    type TripFrame,
    type VideoCandidate,
} from "../trips.js";

import { channelDisplayLabel, formatBytes, formatDuration, formatNumber } from "./format.js";

/** One label/value row of the details grid. value is already HTML-safe. */
interface DetailRow {
    labelKey: Parameters<typeof t>[0];
    value: string;
    /** Monospace the value column (codec strings, dimensions, paths). */
    mono?: boolean;
}

/** Friendly video-codec name from the mediabunny enum, or null when unknown
 *  (caller falls back to the raw FourCC). */
function videoCodecName(codec: VideoCodec | null): string | null {
    switch (codec) {
        case "avc":
            return "H.264";
        case "hevc":
            return "H.265";
        case "av1":
            return "AV1";
        case "vp9":
            return "VP9";
        case "vp8":
            return "VP8";
        default:
            return null;
    }
}

/** Friendly audio-codec name from an MP4 sample-entry 4cc or a mediabunny codec
 *  name. Falls back to the raw token (NUL-stripped) so an unmapped format still
 *  shows something honest. Returns null only for an empty token. */
function audioCodecName(raw: string | null): string | null {
    if (!raw) return null;
    // The IMA-ADPCM entry is the QuickTime "ms" + WAVE tag 0x0011 (Mio/Navman) -
    // match its exact bytes before the NUL strip, not any "ms"-prefixed tag (other
    // ms-wrapped WAVE formats exist and are not ADPCM).
    if (
        raw.charCodeAt(0) === 0x6d &&
        raw.charCodeAt(1) === 0x73 &&
        raw.charCodeAt(2) === 0x00 &&
        raw.charCodeAt(3) === 0x11
    ) {
        return "ADPCM";
    }
    const s = raw.replace(/\0/g, "").trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (low === "mp4a" || low === "aac") return "AAC";
    if (low === "opus") return "Opus";
    if (low === "ac-3" || low === "ac3") return "AC-3";
    if (low === "ec-3" || low === "eac3") return "E-AC-3";
    if (low === "alac") return "ALAC";
    if (low === "flac") return "FLAC";
    if (low === "vorbis") return "Vorbis";
    if (low.includes("mp3")) return "MP3";
    if (low.startsWith("pcm") || ["sowt", "twos", "lpcm", "in24", "fl32", "raw "].includes(low)) return "PCM";
    return s;
}

/** Container name for the details panel. Filename-derived (matches the flags on
 *  the candidate); MP4/MOV is the default. */
function containerName(candidate: VideoCandidate): string {
    if (candidate.isTransportStream) return "MPEG-TS";
    if (candidate.isMatroska) return "Matroska";
    return "MP4";
}

/** Localized "how the clip's start time was derived" label. */
function timeSourceLabel(source: StartSource): string {
    switch (source) {
        case "embedded":
            return t("fileDetails.timeSource.embedded");
        case "mp4":
            return t("fileDetails.timeSource.mp4");
        case "gps":
            return t("fileDetails.timeSource.gps");
        case "name":
            return t("fileDetails.timeSource.name");
        case "mtime":
            return t("fileDetails.timeSource.mtime");
    }
}

/** fps with just enough precision: whole number for CFR (30/25), two decimals
 *  for the 29.97/23.976 family. */
function formatFps(fps: number): string {
    const rounded = Math.round(fps * 100) / 100;
    const isWhole = Math.abs(rounded - Math.round(rounded)) < 0.01;
    return `${formatNumber(rounded, isWhole ? 0 : 2)} fps`;
}

/** Sample rate as kHz (48 kHz, 44.1 kHz). */
function formatSampleRate(hz: number): string {
    const khz = hz / 1000;
    const isWhole = Math.abs(khz - Math.round(khz)) < 0.01;
    return `${formatNumber(khz, isWhole ? 0 : 1)} kHz`;
}

/** Average bitrate = size*8 / duration, in Mbps. null when duration is unknown. */
function formatAvgBitrate(bytes: number, durationSec: number): string | null {
    if (!(durationSec > 0)) return null;
    const mbps = (bytes * 8) / durationSec / 1e6;
    return `${formatNumber(mbps, 1)} Mbps`;
}

/** Folder part of a clip's path ("Normal/Front"), or null for a flat drop with
 *  no directory structure. */
function folderOf(relativePath: string): string | null {
    const dir = relativePath.split("/").slice(0, -1).join("/");
    return dir || null;
}

/** Builds the label/value rows for one clip (one channel of a frame). */
function rowsForCandidate(candidate: VideoCandidate): DetailRow[] {
    const rows: DetailRow[] = [];

    const folder = folderOf(candidate.relativePath);
    if (folder) rows.push({ labelKey: "fileDetails.path", value: escapeHtml(folder), mono: true });

    // Until the mandatory read settles, only the path and byte size are facts.
    // Estimated duration would also fabricate bitrate, clock source and no-GPS.
    if (candidate.metadataReady === false) {
        rows.push({ labelKey: "fileDetails.size", value: formatBytes(candidate.file.size), mono: true });
        return rows;
    }

    if (candidate.width && candidate.height) {
        let res = `${candidate.width}×${candidate.height}`;
        // Rotation belongs with the frame geometry; only when the display matrix
        // actually turns the picture (0 is the common case and adds noise).
        if (candidate.rotation !== 0) res += ` · ${candidate.rotation}°`;
        rows.push({ labelKey: "fileDetails.resolution", value: res, mono: true });
    }

    if (candidate.fps && candidate.fps > 0) {
        rows.push({ labelKey: "fileDetails.frameRate", value: formatFps(candidate.fps), mono: true });
    }

    // Video codec: friendly name + the fullest identifier we have (RFC 6381
    // string for HEVC/TS, else the sample-entry FourCC).
    const vName = videoCodecName(candidate.codec);
    const vDetail = candidate.videoCodecString ?? candidate.codecParam;
    if (vName || vDetail) {
        const value = vName && vDetail ? `${vName} · ${escapeHtml(vDetail)}` : escapeHtml(vName ?? vDetail!);
        rows.push({ labelKey: "fileDetails.video", value, mono: true });
    }

    // Audio: friendly codec + channels + sample rate, or an explicit "no audio".
    if (candidate.audio) {
        const aName = audioCodecName(candidate.audio.codec);
        const parts: string[] = [];
        if (aName) parts.push(escapeHtml(aName));
        if (candidate.audio.channels > 0) parts.push(`${candidate.audio.channels}ch`);
        if (candidate.audio.sampleRate > 0) parts.push(formatSampleRate(candidate.audio.sampleRate));
        rows.push({ labelKey: "fileDetails.audio", value: parts.length ? parts.join(" · ") : "—", mono: true });
    } else {
        // Ready metadata with no audio track is definitive. A still-provisional
        // clip has not been read yet, so we say nothing rather than "no audio".
        rows.push({ labelKey: "fileDetails.audio", value: t("fileDetails.none.audio"), mono: false });
    }

    rows.push({ labelKey: "fileDetails.container", value: containerName(candidate), mono: true });

    // Size and a rough average bitrate on one row.
    let sizeVal = formatBytes(candidate.file.size);
    const bitrate = formatAvgBitrate(candidate.file.size, candidate.durationSec);
    if (bitrate) sizeVal += ` · ${bitrate}`;
    rows.push({ labelKey: "fileDetails.size", value: sizeVal, mono: true });

    rows.push({ labelKey: "fileDetails.duration", value: escapeHtml(formatDuration(candidate.durationSec)) });

    // How the wall-clock start was anchored - the reliability signal for the
    // marker/chart sync (see StartSource in trips.ts).
    rows.push({ labelKey: "fileDetails.timeSource", value: timeSourceLabel(candidate.startSource) });

    // GPS: point count + which technique produced it, or an explicit "no GPS".
    if (candidate.records.length > 0) {
        const pts = new Intl.NumberFormat(getDateLocale()).format(candidate.records.length);
        let gps = `${pts} pts`;
        if (candidate.appliedExtractors.length > 0) {
            gps += ` · ${escapeHtml(candidate.appliedExtractors.join(", "))}`;
        }
        rows.push({ labelKey: "fileDetails.gps", value: gps });
    } else {
        rows.push({ labelKey: "fileDetails.gps", value: t("fileDetails.none.gps") });
    }

    return rows;
}

function renderRows(rows: DetailRow[]): string {
    return rows
        .map(
            (r) =>
                `<div class="file-details-row${r.mono ? " mono" : ""}"><span class="file-details-label">${escapeHtml(
                    t(r.labelKey),
                )}</span><span class="file-details-value">${r.value}</span></div>`,
        )
        .join("");
}

/**
 * Builds the technical-details HTML for one clip row (one frame). Multi-camera
 * frames get one section per camera, each headed by the camera label; single-
 * camera frames render a bare grid. The returned string is inserted into a
 * container the caller creates - it is fully escaped and safe for innerHTML.
 */
export function buildFileDetailsHtml(frame: TripFrame, trip: Trip): string {
    const channels = frameChannels(frame);
    const multi = tripChannels(trip).length > 1;
    const sections: string[] = [];
    for (const ch of channels) {
        const candidate = frame.channels[ch as Channel];
        if (!candidate) continue;
        const grid = `<div class="file-details-grid">${renderRows(rowsForCandidate(candidate))}</div>`;
        if (multi) {
            sections.push(`<div class="file-details-camera">${escapeHtml(channelDisplayLabel(ch, trip))}</div>${grid}`);
        } else {
            sections.push(grid);
        }
    }
    return sections.join("");
}
