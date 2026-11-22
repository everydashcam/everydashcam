// mediabunny writes its diagnostics straight to console, where the
// downloadable log ring buffer never sees them: decoder-record and SPS parse
// errors or unclosed-sample leaks were missing from bug reports. This module
// decides how those messages enter the app logger; src/mediabunny.ts wires it
// to the library.

import type { Logger } from "./log.js";
import { IMA_ADPCM_SAMPLE_ENTRY } from "./parsers/internal/mp4-walker.js";

/** Event names of mediabunny's Logging emitter. */
export type MediabunnyLogLevel = "error" | "warn" | "info";

// Distinct messages remembered for de-duplication. The library's messages are
// fixed strings or vary by a codec name or sample size; the cap only bounds
// memory should that change.
const MAX_TRACKED_MESSAGES = 100;

// The app decodes Mio/Navman IMA ADPCM audio itself, so mediabunny not naming
// a codec for that sample entry is expected on every such recording.
const EXPECTED_WARNINGS: ReadonlySet<string> = new Set([
    `Unsupported audio codec (sample entry type '${IMA_ADPCM_SAMPLE_ENTRY}').`,
]);

/**
 * Returns a handler for one mediabunny log event: its level and the arguments
 * the library would have passed to console. String arguments form the message;
 * the first Error is kept with its stack; other values are stringified into
 * ctx.details. The first occurrence of a message is logged in full, repeats
 * are counted and logged again only at 10, 100, 1000, ... occurrences, so a
 * per-packet parse error or the once-per-second sample-leak warning cannot
 * flush the ring buffer. Expected warnings and info messages go to debug.
 */
export function createMediabunnyLogForwarder(
    logger: Logger,
): (level: MediabunnyLogLevel, args: readonly unknown[]) => void {
    const occurrences = new Map<string, number>();
    return (level, args) => {
        const { message, error, details } = describeLogArguments(args);
        const key = `${level}:${message}`;
        if (!occurrences.has(key) && occurrences.size >= MAX_TRACKED_MESSAGES) occurrences.clear();
        const count = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, count);
        if (count > 1 && !isPowerOfTen(count)) return;

        let payload: unknown;
        if (count > 1) payload = { repeated: count };
        else if (error) payload = error;
        else if (details.length > 0) payload = { details };

        if (level === "info" || EXPECTED_WARNINGS.has(message)) logger.debug(message, payload);
        else if (level === "warn") logger.warn(message, payload);
        else logger.error(message, payload);
    };
}

interface DescribedLogArguments {
    message: string;
    error: Error | null;
    details: string[];
}

function describeLogArguments(args: readonly unknown[]): DescribedLogArguments {
    const parts: string[] = [];
    const details: string[] = [];
    let error: Error | null = null;
    for (const arg of args) {
        if (typeof arg === "string") parts.push(arg);
        else if (arg instanceof Error && !error) error = arg;
        else details.push(String(arg));
    }
    return { message: parts.join(" ") || "mediabunny log without a message", error, details };
}

function isPowerOfTen(value: number): boolean {
    let remaining = value;
    while (remaining >= 10 && remaining % 10 === 0) remaining /= 10;
    return remaining === 1;
}
