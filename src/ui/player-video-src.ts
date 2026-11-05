// Low-level video <src> attachment primitives + the WeakMaps that track
// "which file owns which <video>" and "which blob URL did we create".
//
// Why a separate module: both the playback core (attachCandidateToVideo) and
// the mini-map (syncMinimap) need to read/write these markers and call
// setVideoSrcFromFile/clearVideoSrc. Keeping them here breaks a would-be
// cycle player <-> zoom.

import type { VideoCandidate } from "../trips.js";
import { isRawHevcName } from "../video-format-names.js";

// videoAttachedFile: which File currently "owns" a <video>. Idempotency of
// attachCandidateToVideo and race protection in the MSE IIFE both rely on
// comparing this marker. Also used by the mini-map and callers to know which
// file is playing without traversing the candidate chain.
//
// videoOwnedBlobUrl: blob URLs we created in setVideoSrcFromFile (native
// path) - revoked on next change or clearVideoSrc. The MSE backend owns its
// URL separately (per-file-mse.ts) and revokes on dispose - not in this map.
export const videoAttachedFile: WeakMap<HTMLVideoElement, File> = new WeakMap();
export const videoOwnedBlobUrl: WeakMap<HTMLVideoElement, string> = new WeakMap();

/**
 * Single decision: does this candidate need PerFileMseBackend instead of
 * native <video>.src? True for hev1/broken-hvcC HEVC, MPEG-TS sticks and
 * Matroska (.mkv) - none of these containers is natively decodable via
 * <video>.src in Chromium/Firefox/Safari - and for IMA-ADPCM audio (Mio/Navman):
 * there the VIDEO decodes natively but the audio does not, so we route through
 * MSE to decode ADPCM and re-encode it to an MSE-playable codec while
 * stream-copying the video. This is the deliberate "only patched files leave
 * native <video>" contract - a normal MP4 with AAC audio stays on the native
 * path.
 *
 * Used everywhere the player must choose between the two pipelines: attach,
 * preload eligibility, mini-map. Keep all callsites going through this helper.
 */
export function requiresMseBackend(cand: VideoCandidate): boolean {
    return (
        cand.needsHevcRemux ||
        cand.isTransportStream ||
        cand.isMatroska ||
        cand.audioNeedsTranscode ||
        // A raw HEVC stream has no container <video> could open; its MP4 view
        // exists only for mediabunny (blob-source.ts demuxView).
        isRawHevcName(cand.file.name)
    );
}

/**
 * Sets <video>.src to a new blob URL for file. Revokes the previous URL we
 * created for the same <video> (if any) to prevent blob URL leaks on channel
 * file changes. Idempotent: no-op if the file is already attached.
 *
 * Revoke is safe immediately after `v.src = newUrl`: per the HTML spec the
 * media element resolves the URL to a local Blob reference at load() time,
 * and revoking later does not break the already-resolved binding. Confirmed
 * on Chromium/Firefox/Safari.
 */
export function setVideoSrcFromFile(v: HTMLVideoElement, file: File): void {
    if (videoAttachedFile.get(v) === file) return;
    const prev = videoOwnedBlobUrl.get(v);
    const url = URL.createObjectURL(file);
    videoAttachedFile.set(v, file);
    videoOwnedBlobUrl.set(v, url);
    v.src = url;
    v.load();
    if (prev !== undefined) URL.revokeObjectURL(prev);
}

/**
 * Fully detaches <video> from its current source: revokes the owned blob URL,
 * clears markers, removeAttribute("src") + load(). After this <video> is in
 * NETWORK_EMPTY and decoder/network resources are released.
 *
 * Does NOT touch any MSE backend (managed in state.channelBackends, disposed
 * via disposeChannelBackend). Callers switching between MSE and native must
 * handle dispose+attach order themselves.
 */
export function clearVideoSrc(v: HTMLVideoElement): void {
    const prev = videoOwnedBlobUrl.get(v);
    videoAttachedFile.delete(v);
    videoOwnedBlobUrl.delete(v);
    v.removeAttribute("src");
    v.load();
    if (prev !== undefined) URL.revokeObjectURL(prev);
}
