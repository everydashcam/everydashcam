import type { GpsRecord, SkippedLine } from "../types.js";

// Isolated timestamp outlier filter for single-clip embedded GPS streams.
//
// Some dashcam firmwares (confirmed on VIOFO A229 Plus V1.5_260813 freeGPS)
// occasionally write one or two blocks with a corrupted clock field (e.g.
// truncated NMEA time "1514" decoded as 00:15:14 instead of 15:14:44, or
// 00:00:00) while coordinates and surrounding blocks stay intact. Once records
// are sorted by unixSeconds downstream, a single hours-early record floats to
// records[0], stretches the clip's GPS window past its video duration, causes
// deriveStartUtc to reject the filename anchor and fall back to start=gps, and
// rips the clip out of its trip into a phantom standalone trip.
//
// Must run in file/recording order BEFORE any timestamp sort, while each
// record's real neighbors are still adjacent.

const MAX_OUTLIER_RUN = 2;
const MIN_EDGE_CONFIRM_RUN = 3;
const MIN_INTERIOR_JUMP_SEC = 60;
const EDGE_DURATION_SLACK_SEC = 120;
const MIN_CONTINUOUS_STEP_SEC = 10;
const DAY_SEC = 86_400;
// Clean +-1 day jumps belong to midnight date-slip firmware (handled downstream
// by applyGpsDateSlipCorrections in trips.ts, whose gap tolerance is 3600 s)
// and must not be dropped at clip edges. Elapsed recording time across a GPS
// dropout is positive, so allow up to 3600 s forward from +-DAY_SEC while
// keeping a tight 60 s jitter margin in the negative direction (so a leading
// 00:00:00 glitch on a 23:30 clip, delta = +84600, is still rejected).
const DATE_SLIP_BACKWARD_JITTER_SEC = 60;
const DATE_SLIP_FORWARD_GAP_SEC = 3600;

export interface TimestampOutlierOptions {
    /** Container duration in seconds, when known; bounds the total GPS wall
     *  span of an ordinary real-time clip so edge glitches exceeding the clip
     *  duration are rejected while genuine tunnels inside the clip survive. */
    durationSec?: number | null;
    /** Optional parallel group id per input record (same length as `records`).
     *  Consecutive synced records sharing one id come from the same source
     *  clock stamp (e.g. GoPro GPS5 sub-samples interpolated from one GPSU)
     *  and are evaluated and dropped together as one clock unit. */
    clockGroupIds?: readonly number[];
}

function isSyncedRecord(record: GpsRecord): boolean {
    return (
        record.timeUnsynced !== true &&
        !record.externalTrack &&
        !record.timeAssociation &&
        Number.isFinite(record.unixSeconds)
    );
}

function isCleanDateSlip(deltaSec: number): boolean {
    const backwardSlip =
        deltaSec >= -DAY_SEC - DATE_SLIP_BACKWARD_JITTER_SEC && deltaSec <= -DAY_SEC + DATE_SLIP_FORWARD_GAP_SEC;
    const forwardSlip =
        deltaSec >= DAY_SEC - DATE_SLIP_BACKWARD_JITTER_SEC && deltaSec <= DAY_SEC + DATE_SLIP_FORWARD_GAP_SEC;
    return backwardSlip || forwardSlip;
}

function accelMag(record: GpsRecord): number {
    return Math.hypot(record.accelXg, record.accelYg, record.accelZg);
}

// Upper bound on a single normal cadence step when estimating the clip's
// sampling interval (covers even 5-minute time-lapse intervals without letting
// a multi-hour glitch recovery step skew the median on a very short clip).
const MAX_CADENCE_STEP_SEC = 300;

function medianPositiveStep(times: readonly number[]): number {
    const steps: number[] = [];
    for (let i = 1; i < times.length; i++) {
        const dt = times[i]! - times[i - 1]!;
        if (dt > 0 && dt <= MAX_CADENCE_STEP_SEC) steps.push(dt);
    }
    if (steps.length === 0) return 1;
    steps.sort((a, b) => a - b);
    return steps[(steps.length - 1) >> 1]!;
}

// Checks whether a continuous, non-decreasing run starting at `anchorIdx`
// advances through at least MIN_EDGE_CONFIRM_RUN distinct timestamps before
// hitting a negative step or a gap > maxStepSec. Requiring positive progress
// rejects stuck clocks (e.g. [00:00:00, 00:00:00, 00:00:00]) while still
// accepting multi-Hz integer-second logs (e.g. 10 Hz XBHT repeating each
// whole second 10 times before ticking to the next second).
function hasAdvancingContinuousRun(
    times: readonly number[],
    anchorIdx: number,
    direction: "forward" | "backward",
    maxStepSec: number,
): boolean {
    if (anchorIdx < 0 || anchorIdx >= times.length) return false;
    let advancingTicks = 1;
    if (direction === "forward") {
        for (let i = anchorIdx + 1; i < times.length; i++) {
            const dt = times[i]! - times[i - 1]!;
            if (dt < 0 || dt > maxStepSec) return false;
            if (dt > 0) {
                advancingTicks++;
                if (advancingTicks >= MIN_EDGE_CONFIRM_RUN) return true;
            }
        }
        return false;
    }
    for (let i = anchorIdx - 1; i >= 0; i--) {
        const dt = times[i + 1]! - times[i]!;
        if (dt < 0 || dt > maxStepSec) return false;
        if (dt > 0) {
            advancingTicks++;
            if (advancingTicks >= MIN_EDGE_CONFIRM_RUN) return true;
        }
    }
    return false;
}

function findPassOutliers(times: readonly number[], hasKnownDuration: boolean, maxTotalSpanSec: number): Set<number> {
    const count = times.length;
    const dropPos = new Set<number>();
    if (count < 3) return dropPos;

    const medianStep = medianPositiveStep(times);
    const maxStepSec = Math.max(MIN_CONTINUOUS_STEP_SEC, medianStep * 3);
    const minJumpSec = Math.max(MIN_INTERIOR_JUMP_SEC, medianStep * 5);

    // 1. Interior spikes (length 1..MAX_OUTLIER_RUN): prev and next are
    //    continuous with each other, while every record between them lies far
    //    outside [prev, next]. Require at least one outer neighbor (when any
    //    exists) to corroborate (prev, next) so two identically glitched stamps
    //    sandwiching a valid record cannot outvote it. Maintain surviving nodes
    //    in an Int32Array doubly-linked list with a bounded-revisit worklist so
    //    cascading alternating glitches (e.g. [0, -3600, 2, -3600, ..., n, n+1])
    //    converge to a fixed point in O(n) instead of O(n^2).
    const prevNode = new Int32Array(count);
    const nextNode = new Int32Array(count);
    const alive = new Uint8Array(count);
    const inWorklist = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        prevNode[i] = i - 1;
        nextNode[i] = i + 1 < count ? i + 1 : -1;
        alive[i] = 1;
    }

    const worklist: number[] = [];
    const enqueue = (node: number): void => {
        if (node < 0 || !alive[node] || inWorklist[node]) return;
        inWorklist[node] = 1;
        worklist.push(node);
    };
    // Seed right-to-left so the LIFO worklist visits left-to-right first.
    for (let i = count - 2; i >= 0; i--) enqueue(i);

    while (worklist.length > 0) {
        const left = worklist.pop()!;
        inWorklist[left] = 0;
        if (!alive[left]) continue;

        const prev = times[left]!;
        let midEnd = left;
        let droppedRight = -1;
        for (let runLen = 1; runLen <= MAX_OUTLIER_RUN; runLen++) {
            midEnd = nextNode[midEnd]!;
            if (midEnd === -1) break;
            const right = nextNode[midEnd]!;
            if (right === -1) break;

            const next = times[right]!;
            const bridge = next - prev;
            // Use the original recording-order span so an earlier drop does
            // not shrink the allowed elapsed bridge.
            const origSpan = right - left;
            const maxBridgeSec = Math.max(MIN_CONTINUOUS_STEP_SEC, (origSpan + 1) * medianStep * 3);
            if (bridge < 0 || bridge > maxBridgeSec) continue;

            const outerLeft = prevNode[left]!;
            const outerRight = nextNode[right]!;
            const hasOuterNeighbor = outerLeft !== -1 || outerRight !== -1;
            // Require strictly advancing time on the corroborating side so a
            // stuck clock (e.g. [0, 0, 15:00:02, 0, 15:00:04, 15:00:05] or
            // [0, 15:00:01, 15:00:02, 0]) cannot use identical zero timestamps
            // to outvote valid records even when no outer neighbor exists.
            const prevStep = outerLeft !== -1 ? prev - times[outerLeft]! : -1;
            const nextStep = outerRight !== -1 ? times[outerRight]! - next : -1;
            const prevCorroborated = prevStep >= 0 && prevStep <= maxStepSec && (bridge > 0 || prevStep > 0);
            const nextCorroborated = nextStep >= 0 && nextStep <= maxStepSec && (bridge > 0 || nextStep > 0);
            if ((hasOuterNeighbor || bridge === 0) && !prevCorroborated && !nextCorroborated) continue;

            let allOutliers = true;
            for (let cur = nextNode[left]!; cur !== right; cur = nextNode[cur]!) {
                const t = times[cur]!;
                // Preserve clean +-1 day midnight date slips inside the clip so
                // downstream applyGpsDateSlipCorrections can repair the date
                // without losing the fix's coordinates.
                const isInteriorDateSlip =
                    (t + DAY_SEC >= prev - DATE_SLIP_BACKWARD_JITTER_SEC &&
                        t + DAY_SEC <= next + DATE_SLIP_BACKWARD_JITTER_SEC) ||
                    (t - DAY_SEC >= prev - DATE_SLIP_BACKWARD_JITTER_SEC &&
                        t - DAY_SEC <= next + DATE_SLIP_BACKWARD_JITTER_SEC);
                if ((t >= prev - minJumpSec && t <= next + minJumpSec) || isInteriorDateSlip) {
                    allOutliers = false;
                    break;
                }
            }
            if (!allOutliers) continue;

            for (let cur = nextNode[left]!; cur !== right; cur = nextNode[cur]!) {
                alive[cur] = 0;
                dropPos.add(cur);
            }
            nextNode[left] = right;
            prevNode[right] = left;
            droppedRight = right;
            break;
        }

        if (droppedRight !== -1) {
            // Re-check only nodes whose immediate bridge or outer-neighbor
            // corroboration changed: `right`, `left`, and up to
            // MAX_OUTLIER_RUN + 1 alive predecessors of `left`.
            enqueue(droppedRight);
            enqueue(left);
            let back = prevNode[left]!;
            for (let steps = 0; steps <= MAX_OUTLIER_RUN && back !== -1; steps++) {
                enqueue(back);
                back = prevNode[back]!;
            }
        }
    }

    const survivingPos: number[] = [];
    const survivingTimes: number[] = [];
    for (let i = 0; i < count; i++) {
        if (alive[i]) {
            survivingPos.push(i);
            survivingTimes.push(times[i]!);
        }
    }
    const survivingCount = survivingTimes.length;

    // 2. Leading spikes (length 1..MAX_OUTLIER_RUN): first 1-2 surviving units
    //    disagree sharply with an immediately following advancing run. When
    //    container duration is known, compare the total clip span with vs
    //    without the leading unit (ignoring an uncorroborated single spike on
    //    the opposite edge) instead of comparing only the local gap or
    //    multiplying record count by median step.
    for (let runLen = 1; runLen <= MAX_OUTLIER_RUN && runLen + MIN_EDGE_CONFIRM_RUN <= survivingCount; runLen++) {
        if (!hasAdvancingContinuousRun(survivingTimes, runLen, "forward", maxStepSec)) continue;
        const anchorTime = survivingTimes[runLen]!;
        let farValidTime = anchorTime;
        if (hasKnownDuration) {
            for (let j = runLen + 1; j < survivingCount; j++) {
                const t = survivingTimes[j]!;
                const step = t - survivingTimes[j - 1]!;
                if (step < 0 || step > maxStepSec) continue;
                if (t >= anchorTime && t - anchorTime <= maxTotalSpanSec && t > farValidTime) {
                    farValidTime = t;
                }
            }
        }
        let allOutliers = true;
        for (let k = 0; k < runLen; k++) {
            const t = survivingTimes[k]!;
            const gap = anchorTime - t;
            const isBackwardGlitch = gap < -minJumpSec;
            const isImpossibleEarlyGlitch = hasKnownDuration && gap >= minJumpSec && farValidTime - t > maxTotalSpanSec;
            if ((!isBackwardGlitch && !isImpossibleEarlyGlitch) || isCleanDateSlip(gap)) {
                allOutliers = false;
                break;
            }
        }
        if (allOutliers) {
            for (let k = 0; k < runLen; k++) dropPos.add(survivingPos[k]!);
            break;
        }
    }

    // 3. Trailing spikes (length 1..MAX_OUTLIER_RUN): last 1-2 surviving units
    //    disagree sharply with an immediately preceding advancing run.
    for (let runLen = 1; runLen <= MAX_OUTLIER_RUN && runLen + MIN_EDGE_CONFIRM_RUN <= survivingCount; runLen++) {
        const anchorIdx = survivingCount - runLen - 1;
        if (!hasAdvancingContinuousRun(survivingTimes, anchorIdx, "backward", maxStepSec)) continue;
        const anchorTime = survivingTimes[anchorIdx]!;
        let nearValidTime = anchorTime;
        if (hasKnownDuration) {
            for (let j = anchorIdx - 1; j >= 0; j--) {
                const t = survivingTimes[j]!;
                const step = survivingTimes[j + 1]! - t;
                if (step < 0 || step > maxStepSec) continue;
                if (t <= anchorTime && anchorTime - t <= maxTotalSpanSec && t < nearValidTime) {
                    nearValidTime = t;
                }
            }
        }
        let allOutliers = true;
        for (let k = survivingCount - runLen; k < survivingCount; k++) {
            const t = survivingTimes[k]!;
            const gap = t - anchorTime;
            const isBackwardGlitch = gap < -minJumpSec;
            const isImpossibleLateGlitch = hasKnownDuration && gap >= minJumpSec && t - nearValidTime > maxTotalSpanSec;
            if ((!isBackwardGlitch && !isImpossibleLateGlitch) || isCleanDateSlip(gap)) {
                allOutliers = false;
                break;
            }
        }
        if (allOutliers) {
            for (let k = survivingCount - runLen; k < survivingCount; k++) dropPos.add(survivingPos[k]!);
            break;
        }
    }

    return dropPos;
}

/**
 * Drops isolated clock glitches (1-2 consecutive synced clock units jumping
 * far away from their recording-order neighbors) from a single clip's record
 * stream. Unsynced, external, and directory-log records are preserved in place.
 *
 * Returns a new array when any record is dropped, or the original array when
 * clean. Appends one SkippedLine per dropped record when `skipped` is provided.
 * Idempotent by construction: repeats passes until no further outliers remain.
 */
export function dropIsolatedTimestampOutliers(
    records: GpsRecord[],
    skipped?: SkippedLine[],
    opts: TimestampOutlierOptions = {},
): GpsRecord[] {
    const useClockGroups = opts.clockGroupIds !== undefined && opts.clockGroupIds.length === records.length;
    const units: Array<{ time: number; recordIndices: number[] }> = [];
    let lastGroupId: number | null = null;
    for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (!isSyncedRecord(record)) continue;
        if (useClockGroups) {
            const groupId = opts.clockGroupIds![i]!;
            if (lastGroupId === groupId && units.length > 0) {
                units[units.length - 1]!.recordIndices.push(i);
                continue;
            }
            lastGroupId = groupId;
        }
        units.push({ time: record.unixSeconds, recordIndices: [i] });
    }
    if (units.length < 3) return records;

    // Only apply the edge span cap when an independent container duration is
    // known: without it (e.g. MPEG-TS, time-lapse, or our own pause-spliced
    // GPMF exports), a genuine multi-minute tunnel after fix 0 cannot be
    // distinguished from an impossibly early leading timestamp.
    const hasKnownDuration =
        opts.durationSec !== undefined &&
        opts.durationSec !== null &&
        Number.isFinite(opts.durationSec) &&
        opts.durationSec > 0;
    const maxTotalSpanSec = hasKnownDuration ? opts.durationSec! + EDGE_DURATION_SLACK_SEC : Number.POSITIVE_INFINITY;

    // Iterate to a fixed point so dropping a large spike that skewed the
    // initial medianPositiveStep also catches smaller remaining spikes in the
    // same call, guaranteeing strict idempotence (f(f(x)) === f(x)).
    let activeUnits = units.map((_, idx) => idx);
    const droppedUnits = new Set<number>();
    while (activeUnits.length >= 3) {
        const currentTimes = activeUnits.map((u) => units[u]!.time);
        const passDrops = findPassOutliers(currentTimes, hasKnownDuration, maxTotalSpanSec);
        if (passDrops.size === 0) break;
        const nextActive: number[] = [];
        for (let i = 0; i < activeUnits.length; i++) {
            if (passDrops.has(i)) droppedUnits.add(activeUnits[i]!);
            else nextActive.push(activeUnits[i]!);
        }
        activeUnits = nextActive;
    }

    if (droppedUnits.size === 0) return records;

    const dropRecordIndices = new Set<number>();
    const sortedDropRecIndices: number[] = [];
    const survivingSyncedRecordIndices: number[] = [];
    for (let u = 0; u < units.length; u++) {
        const recIndices = units[u]!.recordIndices;
        if (droppedUnits.has(u)) {
            for (const recIndex of recIndices) {
                dropRecordIndices.add(recIndex);
                sortedDropRecIndices.push(recIndex);
            }
        } else {
            for (const recIndex of recIndices) {
                survivingSyncedRecordIndices.push(recIndex);
            }
        }
    }

    for (const recIndex of sortedDropRecIndices) {
        skipped?.push({
            line: recIndex + 1,
            raw: `<record ${recIndex + 1}, unix=${records[recIndex]!.unixSeconds}>`,
            reason: "isolated timestamp outlier",
        });
    }

    // Preserve peak G-sensor impact readings from dropped records by
    // transplanting max-|G| onto the nearest surviving synced neighbor in
    // recording order (cloned, never mutating input records).
    const transplants = new Map<number, GpsRecord>();
    if (survivingSyncedRecordIndices.length > 0) {
        let cursor = 0;
        for (const recIndex of sortedDropRecIndices) {
            const dropped = records[recIndex]!;
            const donorG = accelMag(dropped);
            if (donorG === 0) continue;
            while (
                cursor + 1 < survivingSyncedRecordIndices.length &&
                survivingSyncedRecordIndices[cursor + 1]! < recIndex
            ) {
                cursor++;
            }
            const leftIdx = survivingSyncedRecordIndices[cursor]!;
            const rightIdx =
                cursor + 1 < survivingSyncedRecordIndices.length ? survivingSyncedRecordIndices[cursor + 1]! : leftIdx;
            const targetIdx = Math.abs(recIndex - leftIdx) <= Math.abs(rightIdx - recIndex) ? leftIdx : rightIdx;
            const current = transplants.get(targetIdx) ?? records[targetIdx]!;
            if (donorG > accelMag(current)) transplants.set(targetIdx, dropped);
        }
    }

    const out: GpsRecord[] = [];
    for (let idx = 0; idx < records.length; idx++) {
        if (dropRecordIndices.has(idx)) continue;
        const rec = records[idx]!;
        const donor = transplants.get(idx);
        out.push(donor ? { ...rec, accelXg: donor.accelXg, accelYg: donor.accelYg, accelZg: donor.accelZg } : rec);
    }
    return out;
}
