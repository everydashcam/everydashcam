import { createFrameSampler } from "./frame-sampling.js";

/** The caller already initialized the tracker on seedSec. Keep one sampler for
 * the entire Follow pass, including segment boundaries. Overlapping predecessor
 * frames cannot rewind the search or consume a tick a second time. */
export function createFollowSampler(intervalSec: number, seedSec: number): (contentSec: number) => boolean {
    if (!(intervalSec > 0)) throw new Error("follow sampling interval is invalid");
    const sample = createFrameSampler(intervalSec, seedSec);
    sample(seedSec);
    let previousFrameSec = seedSec;
    return (contentSec): boolean => {
        if (!Number.isFinite(contentSec)) throw new Error("follow sampling timestamp is invalid");
        if (contentSec <= previousFrameSec) return false;
        previousFrameSec = contentSec;
        return sample(contentSec);
    };
}
