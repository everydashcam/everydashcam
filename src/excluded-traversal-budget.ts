// Bounds diagnostic-only enumeration of excluded subtrees. Eligible recordings
// never consume this budget; explicitly selected roots remain visible as well.

export const MAX_EXCLUDED_STRUCTURE_ENTRIES = 10_000;
export const MAX_EXCLUDED_DIRECTORY_DEPTH = 32;

export interface ExcludedTraversalBudget {
    remainingEntries: number;
}

export function createExcludedTraversalBudget(): ExcludedTraversalBudget {
    return { remainingEntries: MAX_EXCLUDED_STRUCTURE_ENTRIES };
}

/** Reserves one excluded descendant before retaining its name or descending. */
export function takeExcludedStructureEntry(budget: ExcludedTraversalBudget): boolean {
    if (budget.remainingEntries === 0) return false;
    budget.remainingEntries--;
    return true;
}

/** Depth starts at one when entering an excluded subtree, regardless of its path. */
export function excludedDirectoryLimit(
    budget: ExcludedTraversalBudget,
    excludedDepth: number,
): "entry limit" | "depth limit" | undefined {
    if (excludedDepth === 0) return undefined;
    if (excludedDepth >= MAX_EXCLUDED_DIRECTORY_DEPTH) return "depth limit";
    if (budget.remainingEntries === 0) return "entry limit";
    return undefined;
}
