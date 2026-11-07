// Per-camera reflection applied to the tiles. The controls live in the
// reflection block of the View menu's cameras section (cameras-menu.ts), not
// on the tiles: the choice is remembered per camera and rarely changes, so a
// button painted over every picture would cost more than it gives, most of
// all on touch screens, where it cannot hide behind hover.

import { type CameraFlip, flipCropRect, hasCameraFlip } from "../camera-flip.js";
import type { Channel } from "../parsers/types.js";
import { ALL_CHANNELS, channelTileFor } from "./dom.js";
import { cameraFlipForChannel, saveCameraFlip } from "./camera-flip-pref.js";
import { exportPanelState, notifyExportStateChanged } from "./export-state.js";
import { exitCropEditIfOpen } from "./player-crop.js";
import { state } from "./state.js";

/** Reflection axis of one camera. */
export type CameraFlipAxis = keyof CameraFlip;

/** Whether reflection is frozen: an export holds the configuration or is
 *  being written, and the file must match what was set up. */
export function isCameraFlipLocked(): boolean {
    return exportPanelState.configurationLocked || state.transcodeInProgress;
}

/** Applies every camera's remembered reflection of the open trip to its tile. */
export function syncCameraFlips(): void {
    for (const ch of ALL_CHANNELS) {
        const tile = channelTileFor(ch);
        const flip = cameraFlipForChannel(ch);
        tile.style.setProperty(
            "--camera-flip",
            `translate(${flip.horizontal ? 100 : 0}%, ${flip.vertical ? 100 : 0}%) scale(${flip.horizontal ? -1 : 1}, ${flip.vertical ? -1 : 1})`,
        );
        tile.style.setProperty("--camera-flip-x", flip.horizontal ? "-1" : "1");
        tile.style.setProperty("--camera-flip-y", flip.vertical ? "-1" : "1");
        tile.classList.toggle("camera-flipped", hasCameraFlip(flip));
    }
}

/**
 * Reflects `channel` along `axis`, or undoes it, and remembers the choice for
 * the camera. Its crop is reflected too, so it keeps framing the same part of
 * the picture. Does nothing while reflection is locked.
 */
export function toggleCameraFlip(channel: Channel, axis: CameraFlipAxis): void {
    if (isCameraFlipLocked()) return;
    exitCropEditIfOpen();
    const flip = cameraFlipForChannel(channel);
    const crop = state.composition.crops[channel];
    if (crop) {
        state.composition.crops[channel] = flipCropRect(crop, {
            horizontal: axis === "horizontal",
            vertical: axis === "vertical",
        });
    }
    saveCameraFlip(channel, { ...flip, [axis]: !flip[axis] });
    syncCameraFlips();
    notifyExportStateChanged();
}

export function initPlayerCameraFlip(): void {
    syncCameraFlips();
}
