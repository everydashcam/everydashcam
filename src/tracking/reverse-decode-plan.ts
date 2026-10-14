import { isPropagationUpdateDue, PROPAGATION_INTERVAL_SEC } from "./frame-sampling.js";
import type { SourceFrameTiming } from "./propagated-track.js";

interface ReverseDecodeGroup {
    seedIndex: number;
    startIndex: number;
    branchCount: number;
    recoveryWarmupFrames?: number;
    hasHighMotion?: boolean;
}

const MAX_COHORT_GROUPS = 8;
const MAX_COHORT_BRANCHES = 24;

function recoveryWarmupFrames(group: Pick<ReverseDecodeGroup, "recoveryWarmupFrames">): number {
    const count = group.recoveryWarmupFrames ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("reverse decode recovery warmup is invalid");
    return count;
}

/** Bound simultaneously live reverse templates while retaining each seed's
 * one-to-one detector matching. Earlier cohorts finish before later seeds run.
 * A single oversized seed group is the unavoidable floor and runs alone. */
export function planReverseCohorts<T extends ReverseDecodeGroup>(groups: readonly T[]): T[][] {
    const seeds = new Set<number>();
    for (const group of groups) {
        if (
            !Number.isSafeInteger(group.seedIndex) ||
            !Number.isSafeInteger(group.startIndex) ||
            group.startIndex < 0 ||
            group.startIndex >= group.seedIndex ||
            !Number.isSafeInteger(group.branchCount) ||
            group.branchCount <= 0
        ) {
            throw new Error("reverse decode group is invalid");
        }
        recoveryWarmupFrames(group);
        if (seeds.has(group.seedIndex)) throw new Error("reverse decode seed indices must be unique");
        seeds.add(group.seedIndex);
    }

    const cohorts: T[][] = [];
    let cohort: T[] = [];
    let branchCount = 0;
    for (const group of [...groups].sort((a, b) => a.seedIndex - b.seedIndex)) {
        if (
            cohort.length > 0 &&
            (cohort.length >= MAX_COHORT_GROUPS || branchCount + group.branchCount > MAX_COHORT_BRANCHES)
        ) {
            cohorts.push(cohort);
            cohort = [];
            branchCount = 0;
        }
        cohort.push(group);
        branchCount += group.branchCount;
        if (branchCount >= MAX_COHORT_BRANCHES || cohort.length >= MAX_COHORT_GROUPS) {
            cohorts.push(cohort);
            cohort = [];
            branchCount = 0;
        }
    }
    if (cohort.length > 0) cohorts.push(cohort);
    return cohorts;
}

/** Retain only pixels needed by a cohort's reverse inference schedules. Each
 * seed owns a greedy reverse cadence; detector reanchors do not shift it.
 * Source frames through the first inference interval calibrate reverse motion
 * even when the forward seed has no later observations. These extra source
 * frames do not shift cadence.
 * Extra detector/branch-endpoint indices, recovery warmup, and long displayed
 * holds need pixels but never shift that cadence. High-motion groups retain
 * every source frame. The caller still advances propagation
 * through every source frame using a lazy pixel getter, preserving gap checks
 * and interpolation. */
export function planReverseFrameIndices(
    frames: readonly SourceFrameTiming[],
    groups: readonly Pick<ReverseDecodeGroup, "seedIndex" | "startIndex" | "recoveryWarmupFrames" | "hasHighMotion">[],
    requiredIndices: readonly number[] = [],
): number[] {
    let previousSec = Number.NEGATIVE_INFINITY;
    for (const frame of frames) {
        if (!Number.isFinite(frame.contentSec) || frame.contentSec <= previousSec) {
            throw new Error("reverse decode frame timestamps must be finite and increasing");
        }
        if (!Number.isFinite(frame.durationSec) || frame.durationSec <= 0) {
            throw new Error("reverse decode frame duration must be finite and positive");
        }
        previousSec = frame.contentSec;
    }
    const selected = new Set<number>();
    for (const group of groups) {
        if (
            !Number.isSafeInteger(group.startIndex) ||
            !Number.isSafeInteger(group.seedIndex) ||
            group.startIndex < 0 ||
            group.startIndex >= group.seedIndex ||
            group.seedIndex >= frames.length
        ) {
            throw new Error("reverse decode group frame bounds are invalid");
        }
        const warmup = recoveryWarmupFrames(group);
        selected.add(group.seedIndex);
        selected.add(group.startIndex);
        let previousInferenceSec = frames[group.seedIndex]!.contentSec;
        let isCalibrating = true;
        for (let index = group.seedIndex - 1; index > group.startIndex; index--) {
            const frame = frames[index]!;
            if (
                group.hasHighMotion ||
                isCalibrating ||
                group.seedIndex - index <= warmup ||
                frame.durationSec > PROPAGATION_INTERVAL_SEC + 1e-6
            ) {
                selected.add(index);
            }
            const contentSec = frame.contentSec;
            if (!isPropagationUpdateDue(previousInferenceSec, contentSec)) continue;
            selected.add(index);
            previousInferenceSec = contentSec;
            isCalibrating = false;
        }
    }
    for (const index of requiredIndices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length) {
            throw new Error("reverse decode required frame index is invalid");
        }
        if (groups.some((group) => index >= group.startIndex && index <= group.seedIndex)) selected.add(index);
    }
    return [...selected].sort((a, b) => a - b);
}
