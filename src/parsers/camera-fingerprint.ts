// Camera fingerprint - cross-channel camera identity. Same string for every
// channel of one physical camera; different string for different cameras of
// the same model. Used as:
//   - the cross-camera isolator in groupTrips: it keys the per-channel frame
//     (`${fp}|t${snap}`) AND partitions the frame->trip walk, so two cameras
//     dropped together never share a frame or a trip even when their footage
//     overlaps in time;
//   - the per-camera TZ bucket key in estimateTzByFingerprint - more accurate
//     than per-channel since F+R+I of one camera share one TZ;
//   - a stable identifier in diagnostics, feedback, and analytics.
//
// Algorithm:
//   1. Walk the FILENAME_CAMERA_KEY library (filename/camera-key.ts). Each
//      technique recognises a specific format and returns a key with the
//      channel marker stripped from both filename and parent path.
//   2. On miss, use a plain mask + full parent path, removing only a recognized
//      spelled-out channel leaf. Keep the enclosing path to isolate devices
//      whose channel folders and filenames happen to be identical.

import { maskName } from "./filename/camera-key.js";
import { classifyFilenameCameraKey } from "./filename/index.js";
import { matchChannelFolder } from "./filename/channel-folder.js";
import type { VendorFile } from "./types.js";

export function cameraFingerprint(file: VendorFile): string {
    const fromTechnique = classifyFilenameCameraKey(file);
    if (fromTechnique !== null) return fromTechnique;
    const dir = matchChannelFolder(file.relativePath)?.parentDir ?? parentDir(file.relativePath);
    return `${maskName(file.file.name)}|${dir}`;
}

function parentDir(relativePath: string): string {
    if (relativePath === "") return "";
    // Drop the file itself (last segment) - we want the parent only.
    const segs = relativePath.split("/").filter((s) => s.length > 0);
    if (segs.length < 2) return ""; // flat drop - filename without folders
    return segs.slice(0, -1).join("/");
}

// Export for tests.
export const _internal = { parentDir };
