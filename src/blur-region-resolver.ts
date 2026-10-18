// Export owns an immutable region snapshot. Walk its spans once as decoded
// frames advance, instead of searching every track in a long trip per frame.

import {
    DETECTOR_FRAME_TIME_EPS_SEC,
    regionRectAt,
    regionStartForExport,
    sortBlurRegionsForPaint,
    type BlurRegion,
    type ResolvedRegionBlur,
} from "./blur-regions.js";
import type { Channel } from "./parsers/types.js";

/** Indexed resolver for one channel of an immutable export snapshot. Supplying
 * exportStartSec applies regionStartForExport; omitting it leaves spans exact.
 * Recreate after editing regions. Held frames and backward jumps are supported. */
export function createRegionBlurResolver(
    regions: readonly BlurRegion[],
    channel: Channel,
    exportStartSec = -Infinity,
): (contentSec: number) => ResolvedRegionBlur[] {
    // Paint order belongs to the original snapshot, including ties between
    // equal styles. Chronological insertion must not change overlapping pixels.
    const entries = sortBlurRegionsForPaint(
        regions.filter((region) => region.channel === channel && region.startSec <= region.endSec),
    )
        .map((region, order) => ({
            region,
            order,
            startSec:
                regionStartForExport(region, exportStartSec) -
                (region.interpolation === "hold" ? DETECTOR_FRAME_TIME_EPS_SEC : 0),
        }))
        .sort((a, b) => a.startSec - b.startSec);
    let next = 0;
    let previousSec = -Infinity;
    let active: typeof entries = [];

    return (contentSec) => {
        if (Number.isNaN(contentSec)) return [];
        if (contentSec < previousSec) {
            next = 0;
            active = [];
        }
        previousSec = contentSec;
        active = active.filter(({ region }) => region.endSec >= contentSec);
        let added = false;
        while (next < entries.length && entries[next]!.startSec <= contentSec) {
            const entry = entries[next++]!;
            if (entry.region.endSec >= contentSec) {
                active.push(entry);
                added = true;
            }
        }
        if (added) active.sort((a, b) => a.order - b.order);
        const out: ResolvedRegionBlur[] = [];
        for (const { region } of active) {
            const rect = regionRectAt(region, contentSec, exportStartSec);
            if (rect) out.push({ rect, style: region.style });
        }
        return out;
    };
}
