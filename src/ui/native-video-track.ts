// HTMLMediaElement.readyState values are specified numeric constants. Keeping
// the check independent from the DOM lets Vitest's node environment cover it.
const HAVE_METADATA = 1;

/** The part of an HTMLVideoElement that reveals whether it kept a video track. */
export interface VideoElementMetadata {
    readyState: number;
    videoWidth: number;
    videoHeight: number;
}

/**
 * Whether a native <video> has loaded a file's metadata without a video track.
 * Chromium's demuxer skips a video stream that the platform cannot decode, for
 * example HEVC on Windows without a hardware decoder, and plays the remaining
 * audio without a MediaError ("skipping invalid or unsupported video track" in
 * media/filters/ffmpeg_demuxer.cc). Zero dimensions after metadata are the only
 * signal. The caller must already know that the file contains video, because an
 * audio-only file looks the same.
 */
export function hasDroppedVideoTrack(video: VideoElementMetadata): boolean {
    return video.readyState >= HAVE_METADATA && video.videoWidth === 0 && video.videoHeight === 0;
}
