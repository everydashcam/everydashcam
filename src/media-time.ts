import { type Input, MPEG_TS } from "./mediabunny.js";

/**
 * TS timestamps come from a transport clock, not the start of the recording.
 * Other containers retain their composition timeline, including edit lists.
 */
export async function getInputTimeOrigin(input: Input): Promise<number> {
    if ((await input.getFormat()) !== MPEG_TS) return 0;
    const origin = await input.getFirstTimestamp();
    if (!Number.isFinite(origin)) throw new Error("invalid media time origin");
    return origin;
}
