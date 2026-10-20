import type { GpsRecord, VendorFile } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";

const MIN_RECORDINGS = 3;
const CLOCK_TOLERANCE_SEC = 3;

/** A session verdict, separate from parser-owned records and their cache. */
export function usableCandidateRecords(candidate: Pick<VideoCandidate, "records" | "hasStaleGps">): GpsRecord[] {
    return candidate.hasStaleGps ? candidate.records.filter((record) => record.externalTrack) : candidate.records;
}

/** Repeated fixes across non-overlapping normal recordings cannot calibrate
 *  their clocks. Advancing container and filename clocks must corroborate the
 *  recording sequence; copies and simultaneous channels are not evidence. */
export function findStaleGpsCandidates(
    candidates: readonly VideoCandidate[],
    parseFilenameTime: (file: VendorFile) => Date | null,
): Set<VideoCandidate> {
    interface Evidence {
        candidate: VideoCandidate;
        nameTime: number;
        containerOffset: number;
    }
    const groups = new Map<string, Evidence[]>();
    const siblings = new Map<string, Evidence[]>();
    for (const candidate of candidates) {
        if (
            candidate.metadataReady === false ||
            candidate.metadataFailed ||
            candidate.isTimelapse ||
            (candidate.recordingMode !== null && candidate.recordingMode !== "normal") ||
            candidate.embeddedStartUtcHint !== null ||
            candidate.createdUtc === null ||
            !Number.isFinite(candidate.durationSec) ||
            candidate.durationSec <= 0
        )
            continue;
        const first = candidate.records.find((record) => !record.externalTrack && !record.timeAssociation);
        if (
            !first ||
            !Number.isFinite(first.unixSeconds) ||
            candidate.records.some(
                (record) =>
                    !record.externalTrack &&
                    !record.timeAssociation &&
                    (record.timeUnsynced ||
                        record.unixSeconds !== first.unixSeconds ||
                        record.lat !== first.lat ||
                        record.lon !== first.lon),
            )
        )
            continue;
        const nameTime = parseFilenameTime(candidate)?.getTime();
        if (nameTime === undefined || !Number.isFinite(nameTime)) continue;
        const created = candidate.createdUtc.getTime() / 1000;
        if (!Number.isFinite(created)) continue;
        const key = JSON.stringify([
            candidate.sourceKey ?? null,
            candidate.fingerprint,
            candidate.channel,
            first.unixSeconds,
        ]);
        const group = groups.get(key) ?? [];
        const evidence = { candidate, nameTime: nameTime / 1000, containerOffset: created - nameTime / 1000 };
        group.push(evidence);
        groups.set(key, group);
        const siblingKey = JSON.stringify([
            candidate.sourceKey ?? null,
            candidate.fingerprint,
            nameTime,
            first.unixSeconds,
        ]);
        const siblingGroup = siblings.get(siblingKey) ?? [];
        siblingGroup.push(evidence);
        siblings.set(siblingKey, siblingGroup);
    }
    const stale = new Set<VideoCandidate>();
    for (const group of groups.values()) {
        group.sort((a, b) => a.nameTime - b.nameTime);
        // Both start-stamped and finalize-stamped containers are admissible.
        for (const finalize of [false, true]) {
            const chains: Evidence[][] = [];
            for (const entry of group) {
                const offset = entry.containerOffset - (finalize ? entry.candidate.durationSec : 0);
                const chain = chains.find((entries) => {
                    const first = entries[0]!;
                    const firstOffset = first.containerOffset - (finalize ? first.candidate.durationSec : 0);
                    return Math.abs(offset - firstOffset) <= CLOCK_TOLERANCE_SEC;
                });
                if (chain) chain.push(entry);
                else chains.push([entry]);
            }
            for (const chain of chains) {
                let count = 0;
                let end = Number.NEGATIVE_INFINITY;
                let previousName = Number.NEGATIVE_INFINITY;
                for (const entry of chain) {
                    if (entry.nameTime === previousName || entry.nameTime < end - CLOCK_TOLERANCE_SEC) continue;
                    count++;
                    previousName = entry.nameTime;
                    end = entry.nameTime + entry.candidate.durationSec;
                }
                if (count >= MIN_RECORDINGS) for (const entry of chain) stale.add(entry.candidate);
            }
        }
    }
    // A partially copied rear/interior channel may lack enough clips to prove
    // repetition itself. Its exact recording twin can supply that evidence.
    for (const group of siblings.values()) {
        const confirmed = group.filter((entry) => stale.has(entry.candidate));
        for (const entry of group) {
            if (
                confirmed.some(
                    (other) =>
                        Math.abs(entry.containerOffset - other.containerOffset) <= CLOCK_TOLERANCE_SEC ||
                        Math.abs(
                            entry.containerOffset -
                                entry.candidate.durationSec -
                                (other.containerOffset - other.candidate.durationSec),
                        ) <= CLOCK_TOLERANCE_SEC,
                )
            )
                stale.add(entry.candidate);
        }
    }
    return stale;
}
