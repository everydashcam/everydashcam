// The redaction set the user actually sees: hand-drawn zones plus fresh
// plate/face detection results. Keep this composition in one place so preview,
// still-frame capture and export cannot quietly disagree about privacy.

import type { BlurRegion } from "../blur-regions.js";
import type { Channel } from "../parsers/types.js";

import { detectRegions } from "./blur-detect.js";
import { activeBlurRegions } from "./blur-regions-state.js";
import { exportPanelState } from "./export-state.js";
import { channelPlayers } from "./dom.js";
import { channelPresentedFrame } from "./player-frame-time.js";

/** Live effective regions of the active trip. Do not retain across edits. */
export function activeEffectiveBlurRegions(): BlurRegion[] {
    return [...activeBlurRegions(), ...detectRegions()];
}

/** Preview and still capture use export coverage only when the settled player
 * clock has reached the trim but its displayed frame precedes it. Seeking
 * before the selection must keep ordinary source-frame coverage. */
export function previewExportStartSec(channel: Channel, frameContentSec: number): number {
    const start = exportPanelState.range?.startTripSec;
    if (start === undefined || frameContentSec >= start) return -Infinity;
    const clock = channelPresentedFrame(channel, true, channelPlayers[channel].currentTime);
    return clock && clock.contentSec >= start ? start : -Infinity;
}
