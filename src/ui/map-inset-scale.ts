// Sizes of what an inset map draws over its basemap - the car, the route and
// the trip flags - as fractions of the inset's height. The player mini-map and
// the map burned into video both read them, so the car and route keep the same
// proportions on screen and in the saved video at any output resolution. The
// values are calibrated on the video overlay; full-size maps keep fixed pixels.

import { MAP_MARKER_SIZE_PX, type MapMarkerSize, mapMarkerSizeScale } from "./map-marker-pref.js";

// A radar arrow sits in a ring and reads a little larger at the same size.
const MARKER_HEIGHT_FRACTION = 0.105;
const RADAR_MARKER_HEIGHT_FRACTION = 0.115;
const TRACK_WIDTH_FRACTION = 5 / 480;
// Flags keep the full-size map's ratio between the flag and a medium car.
const FLAG_TO_MARKER = 32 / MAP_MARKER_SIZE_PX.medium;

/** Side of the square the car marker is drawn in, for an inset `insetHeightPx` tall. */
export function insetMarkerSizePx(insetHeightPx: number, size: MapMarkerSize, isRadar: boolean): number {
    const fraction = isRadar ? RADAR_MARKER_HEIGHT_FRACTION : MARKER_HEIGHT_FRACTION;
    return insetHeightPx * fraction * mapMarkerSizeScale(size);
}

/** Width of the speed-coloured route line, without its outline and halo. */
export function insetTrackWidthPx(insetHeightPx: number): number {
    return insetHeightPx * TRACK_WIDTH_FRACTION;
}

/** Height of a trip start or end flag. */
export function insetFlagHeightPx(insetHeightPx: number): number {
    return insetHeightPx * MARKER_HEIGHT_FRACTION * FLAG_TO_MARKER;
}
