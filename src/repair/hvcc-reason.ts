/**
 * Damage pattern an hvcC repair fixed (see repair/hvcc.ts): "header" (A) and
 * "arrays" (B) made the footage unplayable; "profile" (C) affected only
 * decoders that take a codec string, while native playback already worked.
 * B wins when B and C combine. Dependency-free so cached index entries can be
 * validated without loading the repair code.
 */
export type HvcCRepairReason = "header" | "arrays" | "profile";

export function isHvcCRepairReason(value: unknown): value is HvcCRepairReason {
    return value === "header" || value === "arrays" || value === "profile";
}
