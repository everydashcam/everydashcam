import { GPS_POSITION_TOLERANCE_SEC, isValidGpsFix } from "./parser.js";
import type { Channel, GpsRecord } from "./parsers/types.js";

export interface TripGpsSource {
    records: readonly GpsRecord[];
    startUtc: number;
    endUtc: number;
    channel: Channel | null;
}

interface SourceSegment {
    source: TripGpsSource | string;
    trackSegmentSource?: string;
    trackSegment?: number;
    start: number;
    end: number;
    hasFix: boolean;
    parent: SourceSegment | null;
}

function component(segment: SourceSegment): SourceSegment {
    let root = segment;
    while (root.parent !== null) root = root.parent;
    while (segment.parent !== null && segment.parent !== root) {
        const next = segment.parent;
        segment.parent = root;
        segment = next;
    }
    return root;
}

function isSharedLogCut(a: SourceSegment, b: SourceSegment): boolean {
    return (
        a.trackSegmentSource !== undefined &&
        a.trackSegmentSource === b.trackSegmentSource &&
        a.trackSegment !== b.trackSegment
    );
}

function join(a: SourceSegment, b: SourceSegment): void {
    // Overlapping event copies and adjacent clips from one daily log are not
    // independent evidence of continuity across its explicit restart cuts.
    if (isSharedLogCut(a, b)) return;
    const first = component(a);
    const second = component(b);
    if (first !== second) second.parent = first;
}

/** Source-local segment numbers become trip-local continuity components before
 * channels are interleaved. A second channel can cover a first channel's gap;
 * a file rollover alone does not interrupt the route. Input records stay intact. */
export function normalizeTripTrackSegments(sources: readonly TripGpsSource[]): readonly (readonly GpsRecord[])[] {
    if (!sources.some((source) => source.records.some((record) => record.trackSegment !== undefined))) {
        return sources.map((source) => source.records);
    }

    const bySource = new Map<TripGpsSource | string, Map<string, SourceSegment>>();
    const sourceSegments = sources.map((source) => {
        let fixRun = 0;
        let previousHasFix: boolean | undefined;
        let previousRecord: GpsRecord | undefined;
        let previousSegment: SourceSegment | undefined;
        let previousIdentity: TripGpsSource | string | undefined;
        let previousFixRun = -1;
        return source.records.map((record) => {
            const hasFix = isValidGpsFix(record);
            if (previousHasFix !== undefined && previousHasFix !== hasFix) fixRun++;
            previousHasFix = hasFix;
            const identity = record.externalTrackKey ?? source;
            let segment: SourceSegment | undefined;
            // Consecutive records nearly always continue the previous segment;
            // reuse it without building the lookup key. Anything not provably
            // identical falls through to the keyed lookup, which also decides
            // values the key conflates (undefined and NaN segments, -0 and 0).
            if (
                previousSegment &&
                previousRecord &&
                previousIdentity === identity &&
                previousFixRun === fixRun &&
                previousRecord.trackSegmentSource === record.trackSegmentSource &&
                Object.is(previousRecord.trackSegment, record.trackSegment)
            ) {
                segment = previousSegment;
            } else {
                let segments = bySource.get(identity);
                if (!segments) {
                    segments = new Map();
                    bySource.set(identity, segments);
                }
                const key = JSON.stringify([record.trackSegmentSource, record.trackSegment, fixRun]);
                segment = segments.get(key);
                if (!segment) {
                    segment = {
                        source: identity,
                        trackSegmentSource: record.trackSegmentSource,
                        trackSegment: record.trackSegment,
                        start: record.unixSeconds,
                        end: record.unixSeconds,
                        hasFix,
                        parent: null,
                    };
                    segments.set(key, segment);
                }
            }
            previousIdentity = identity;
            previousFixRun = fixRun;
            segment.start = Math.min(segment.start, record.unixSeconds);
            segment.end = Math.max(segment.end, record.unixSeconds);
            // A daily log rollover can occur inside one video. Scope counters
            // by collection, then join only consecutive fixes across files;
            // explicit restart boundaries within either file stay separate.
            if (
                previousRecord?.trackSegmentSource !== undefined &&
                record.trackSegmentSource !== undefined &&
                previousRecord.trackSegmentSource !== record.trackSegmentSource &&
                previousSegment?.hasFix &&
                hasFix &&
                !record.externalTrackKey &&
                record.unixSeconds > previousRecord.unixSeconds &&
                record.unixSeconds - previousRecord.unixSeconds <= GPS_POSITION_TOLERANCE_SEC
            )
                join(previousSegment, segment);
            previousRecord = record;
            previousSegment = segment;
            return segment;
        });
    });

    const segments = [...bySource.values()].flatMap((source) => [...source.values()]);
    const spans = segments
        .filter((segment) => segment.hasFix && segment.start < segment.end)
        .sort((a, b) => a.start - b.start);
    let active: SourceSegment[] = [];
    for (const segment of spans) {
        active = active.filter((other) => other.end > segment.start);
        for (const other of active) {
            if (other.source !== segment.source) join(other, segment);
        }
        active.push(segment);
    }
    // A singleton supplies no interval. Attach it to one covered component,
    // without letting a point at a cut reconnect two explicitly separate spans.
    const singletons = segments
        .filter((segment) => segment.hasFix && segment.start === segment.end)
        .sort((a, b) => a.start - b.start);
    active = [];
    let spanIndex = 0;
    for (const segment of singletons) {
        while (spanIndex < spans.length && spans[spanIndex]!.start <= segment.start) {
            active.push(spans[spanIndex++]!);
        }
        active = active.filter((other) => other.end >= segment.start);
        const covered = active.find((other) => other.source !== segment.source && !isSharedLogCut(other, segment));
        if (covered) join(covered, segment);
    }

    const previousByChannel = new Map<Channel | null, number>();
    const sourceOrder = sources
        .map((source, index) => ({ source, index }))
        .sort((a, b) => a.source.startUtc - b.source.startUtc);
    for (const { source, index } of sourceOrder) {
        const previousIndex = previousByChannel.get(source.channel);
        // A short protected copy must not hide the enclosing loop clip's end.
        if (previousIndex === undefined || source.endUtc > sources[previousIndex]!.endUtc) {
            previousByChannel.set(source.channel, index);
        }
        if (previousIndex === undefined) continue;
        const previous = sources[previousIndex]!;
        const last = sourceSegments[previousIndex]!.at(-1);
        const first = sourceSegments[index]![0];
        if (!last?.hasFix || !first?.hasFix || typeof last.source === "string" || typeof first.source === "string")
            continue;
        if (
            Math.abs(source.startUtc - previous.endUtc) <= GPS_POSITION_TOLERANCE_SEC &&
            Math.abs(last.end - previous.endUtc) <= GPS_POSITION_TOLERANCE_SEC &&
            Math.abs(first.start - source.startUtc) <= GPS_POSITION_TOLERANCE_SEC
        )
            join(last, first);
    }

    const ids = new Map<SourceSegment, number>();
    return sources.map((source, sourceIndex) =>
        source.records.map((record, recordIndex) => {
            const root = component(sourceSegments[sourceIndex]![recordIndex]!);
            let id = ids.get(root);
            if (id === undefined) {
                id = ids.size;
                ids.set(root, id);
            }
            // Always a copy: candidate records are mutated in place later
            // (local clock corrections), and trips must not move with them.
            // A plain spread clones on the engine's fast path; rest
            // destructuring with an excluded key does not, so it only runs
            // for the records that actually carry the key.
            if (!("trackSegmentSource" in record)) return { ...record, trackSegment: id };
            const { trackSegmentSource: _source, ...normalized } = record;
            return { ...normalized, trackSegment: id };
        }),
    );
}
