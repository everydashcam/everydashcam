interface ReverseDecodeGroup {
    seedIndex: number;
    startIndex: number;
    branchCount: number;
}

const MAX_COHORT_GROUPS = 8;
const MAX_COHORT_BRANCHES = 24;

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
