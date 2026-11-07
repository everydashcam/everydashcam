// Picture shape of each camera of the open trip: what the layout engine sizes
// tiles by, in the viewer, the export editor and the export itself.

import type { Channel } from "../parsers/types.js";
import { computeEffectiveAspect } from "../transcode/compose.js";
import { type Trip, tripCandidatesByChannel } from "../trips.js";
import { channelPlayers } from "./dom.js";
import { activeTrip, state } from "./state.js";

const FALLBACK_ASPECT = 16 / 9;

// Last aspect seen per camera of the open trip: used before a tile's video has
// metadata, so a camera seen once keeps its shape instead of jumping to 16:9.
const knownAspects = new Map<Channel, number>();
let knownTrip: Trip | null = null;

/** Width / height of a camera's whole picture: the playing video, else the
 *  last one seen on this trip, else the recordings' stored size (rotation
 *  applied), else 16:9. */
export function cameraSourceAspect(channel: Channel): number {
    const trip = activeTrip();
    if (trip !== knownTrip) {
        knownAspects.clear();
        knownTrip = trip;
    }
    const video = channelPlayers[channel];
    if (video.videoWidth > 0 && video.videoHeight > 0) {
        const aspect = video.videoWidth / video.videoHeight;
        knownAspects.set(channel, aspect);
        return aspect;
    }
    const known = knownAspects.get(channel);
    if (known) return known;
    if (trip) {
        for (const candidate of tripCandidatesByChannel(trip, channel)) {
            if (!candidate.width || !candidate.height) continue;
            const turned = candidate.rotation === 90 || candidate.rotation === 270;
            return turned ? candidate.height / candidate.width : candidate.width / candidate.height;
        }
    }
    return FALLBACK_ASPECT;
}

/** Shape of a camera's picture in an export: its crop's shape. */
export function cameraExportAspect(channel: Channel): number {
    return computeEffectiveAspect(cameraSourceAspect(channel), state.composition.crops[channel] ?? null);
}

/** Picture shape as laid out on screen: export mode previews the crop. */
export function cameraLayoutAspect(channel: Channel): number {
    return state.exportModeOpen ? cameraExportAspect(channel) : cameraSourceAspect(channel);
}
