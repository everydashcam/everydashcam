import { createLogger } from "../log.js";
import { captureSentryMessage } from "../sentry.js";

import { state } from "./state.js";

const log = createLogger("ingest");

/**
 * Reports parser failures by stage and parser without sending file names.
 * Failures to read the source file get their own issue group, so storage and
 * browser read faults never hide a parser regression behind one fingerprint.
 */
export function reportParseErrors(
    stage: string,
    errors: ReadonlyArray<{ extractor?: string; sidecarId?: string; isSourceRead?: boolean }>,
): void {
    if (errors.length === 0) return;
    const parseFailuresByParser = new Map<string, number>();
    const readFailuresByParser = new Map<string, number>();
    for (const error of errors) {
        const parser = error.extractor ?? error.sidecarId ?? "unknown";
        const counts = error.isSourceRead === true ? readFailuresByParser : parseFailuresByParser;
        counts.set(parser, (counts.get(parser) ?? 0) + 1);
    }
    for (const [parser, count] of parseFailuresByParser) {
        captureSentryMessage("gps parse failed", {
            level: "warning",
            fingerprint: ["gps_parse_failed", stage, parser],
            tags: { stage, parser },
            extra: { count },
        });
    }
    for (const [parser, count] of readFailuresByParser) {
        captureSentryMessage("gps source read failed", {
            level: "warning",
            fingerprint: ["gps_source_read_failed", stage, parser],
            tags: { stage, parser },
            extra: { count },
        });
    }
}

/** Logs malformed GPS records added after the supplied cumulative baseline. */
export function reportSkippedGpsRecords(baseline: number): void {
    const skipped = (state.gpsLog?.skipped ?? []).slice(baseline);
    if (skipped.length === 0) return;
    const byReason = new Map<string, number>();
    for (const record of skipped) byReason.set(record.reason, (byReason.get(record.reason) ?? 0) + 1);
    log.warn("gps records skipped", {
        total: skipped.length,
        byReason: Object.fromEntries(byReason),
    });
}
