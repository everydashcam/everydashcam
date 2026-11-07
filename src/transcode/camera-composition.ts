// Frame plan of a multi-camera export: where each camera sits, interval by
// interval. The availability of the cameras changes inside a clip (a camera
// starts late, stops, a main camera without footage hands its place to the
// next one), so the plan is a list of spans with one layout each. The preview
// lays out with the same engine call in output units (ui/player-layout.ts),
// which keeps the file and the editor in step.

import { type CameraPresence, cameraAvailabilitySpans } from "../camera-availability.js";
import {
    type CameraArrangementMode,
    type CameraTileLayout,
    computeCameraLayout,
    type OverlayPosition,
    outputMinThumbHeight,
} from "../camera-layout.js";
import type { Channel } from "../parsers/types.js";
import type { Trip } from "../trips.js";

/** The arrangement settings an export lays out with. */
export interface CameraArrangement {
    mode: CameraArrangementMode;
    thumbScale: number | null;
    allowOverlay: boolean;
    overlayPositions: Partial<Record<Channel, OverlayPosition>>;
}

export interface CompositionSpan {
    /** Content-time range of the trip this layout covers. */
    startSec: number;
    endSec: number;
    /** Tiles in output pixels, in paint order: the main camera first, the
     *  smaller ones after it, so windows over the main one land on top. */
    tiles: CameraTileLayout[];
    presence: Partial<Record<Channel, CameraPresence>>;
    /** Camera blurred behind the whole frame when the letterbox is blurred:
     *  the main one, or the first with a picture. null when none has one. */
    backdrop: Channel | null;
}

export interface CompositionPlanRequest {
    trip: Trip;
    /** Visible cameras in arrangement order; the first is the main one. */
    channels: readonly Channel[];
    arrangement: CameraArrangement;
    /** Picture width / height per camera after its crop. */
    aspects: Partial<Record<Channel, number>>;
    width: number;
    height: number;
    startSec: number;
    endSec: number;
}

const FALLBACK_ASPECT = 16 / 9;

/**
 * Splits [startSec, endSec) into spans of one layout each. A range the trip
 * timeline does not cover (it cannot happen for a range inside the trip) gets
 * one span with every camera absent, so callers always have a layout.
 */
export function planCompositionSpans(request: CompositionPlanRequest): CompositionSpan[] {
    const { trip, channels, arrangement, startSec, endSec } = request;
    const availability = cameraAvailabilitySpans(trip, channels, arrangement.mode, startSec, endSec);
    const spans = availability.length
        ? availability
        : [
              {
                  startSec,
                  endSec,
                  availability: {
                      order: [...channels],
                      presence: Object.fromEntries(channels.map((channel) => [channel, "absent" as const])),
                  },
              },
          ];
    const layouts = new Map<string, CameraTileLayout[]>();
    return spans.map((span) => {
        const order = span.availability.order;
        const key = order.join(",");
        let tiles = layouts.get(key);
        if (!tiles) {
            tiles = computeCameraLayout({
                width: request.width,
                height: request.height,
                cameras: order.map((channel) => ({ channel, aspect: request.aspects[channel] ?? FALLBACK_ASPECT })),
                mode: arrangement.mode,
                thumbScale: arrangement.thumbScale,
                allowOverlay: arrangement.allowOverlay,
                overlayPositions: arrangement.overlayPositions,
                gap: 0,
                minThumbHeight: outputMinThumbHeight(request.width, request.height),
            }).tiles;
            layouts.set(key, tiles);
        }
        const presence = span.availability.presence;
        return {
            startSec: span.startSec,
            endSec: span.endSec,
            tiles,
            presence,
            backdrop: order.find((channel) => presence[channel] !== "absent") ?? null,
        };
    });
}

/**
 * Span lookup for a playhead that only moves forward (the export's tick loop).
 * A time past the last span stays on it: tick rounding can step a hair over
 * the range end.
 */
export function createCompositionCursor(spans: readonly CompositionSpan[]): (sec: number) => CompositionSpan {
    let index = 0;
    return (sec) => {
        while (index < spans.length - 1 && sec >= spans[index]!.endSec) index++;
        return spans[index]!;
    };
}
