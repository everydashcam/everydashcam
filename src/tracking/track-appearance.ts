import { EXIT_VISIBLE_FRACTION } from "./track-guards.js";

export const APPEARANCE_SIZE = 32;
export const REFERENCE_VARIANCE_MIN = 25;
export const REFERENCE_EDGE_ENERGY_MIN = 4;
const PIXEL_COUNT = APPEARANCE_SIZE * APPEARANCE_SIZE;
const HOG_CELL_SIZE = 8;
const HOG_BINS = 8;
const HOG_LENGTH = 4 * 4 * HOG_BINS;
const MIN_COMPARISON_PIXELS = 4;
const NUMERIC_EPSILON = 1e-9;
const MISMATCH_NCC_MAX = 0.25;
const MISMATCH_HOG_MAX = 0.5;
const CONFIRMATION_NCC_MIN = 0.5;
const CONFIRMATION_HOG_MIN = 0.7;

/** The source-backed part of the crop, in normalized crop coordinates.
 * Padding is excluded without stretching the remaining object fragment. */
export interface AppearanceValidRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface AppearanceSample {
    readonly luminance: Float32Array;
    readonly valid: Uint8Array;
    readonly gradientMagnitude: Float32Array;
    readonly gradientBin: Uint8Array;
    readonly variance: number;
    readonly edgeEnergy: number;
    readonly validPixelCount: number;
    readonly visibleFraction: number;
    /** Numerical information only; this is not an acceptance threshold. */
    readonly hasInformation: boolean;
}

export interface AppearanceComparison {
    readonly alignedNcc: number | null;
    readonly spatialHogCosine: number | null;
    /** Unshifted common valid pixels; NCC separately reports its best overlap. */
    readonly validPixelCount: number;
    readonly alignedValidPixelCount: number;
    readonly visibleFraction: number;
    readonly hasInformation: boolean;
}

function reflect(index: number): number {
    if (index < 0) return -index;
    return index >= APPEARANCE_SIZE ? 2 * APPEARANCE_SIZE - index - 2 : index;
}

function hasValidNeighborhood(valid: Uint8Array, x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
        const row = reflect(y + dy) * APPEARANCE_SIZE;
        for (let dx = -1; dx <= 1; dx++) if (!valid[row + reflect(x + dx)]) return false;
    }
    return true;
}

/** A compact fixed-resolution descriptor. Canvas callers can supply an existing
 * 32px crop; other sizes use bilinear sampling. Alpha is not a validity mask. */
export function buildAppearanceSample(
    rgba: ArrayLike<number>,
    width: number,
    height: number,
    validRect: AppearanceValidRect = { x: 0, y: 0, w: 1, h: 1 },
): AppearanceSample {
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        rgba.length !== width * height * 4 ||
        ![validRect.x, validRect.y, validRect.w, validRect.h].every(Number.isFinite) ||
        validRect.w < 0 ||
        validRect.h < 0
    )
        throw new Error("invalid appearance pixels");

    const left = Math.max(0, validRect.x);
    const top = Math.max(0, validRect.y);
    const right = Math.min(1, validRect.x + validRect.w);
    const bottom = Math.min(1, validRect.y + validRect.h);
    const luminance = new Float32Array(PIXEL_COUNT);
    const valid = new Uint8Array(PIXEL_COUNT);
    const gradientMagnitude = new Float32Array(PIXEL_COUNT);
    const gradientBin = new Uint8Array(PIXEL_COUNT);
    let sum = 0;
    let sumSquares = 0;
    let validPixelCount = 0;
    for (let y = 0; y < APPEARANCE_SIZE; y++) {
        const normalizedY = (y + 0.5) / APPEARANCE_SIZE;
        const sy = Math.max(0, Math.min(height - 1, normalizedY * height - 0.5));
        const y0 = Math.floor(sy);
        const y1 = Math.min(height - 1, y0 + 1);
        const fy = sy - y0;
        for (let x = 0; x < APPEARANCE_SIZE; x++) {
            const normalizedX = (x + 0.5) / APPEARANCE_SIZE;
            const sx = Math.max(0, Math.min(width - 1, normalizedX * width - 0.5));
            const x0 = Math.floor(sx);
            const x1 = Math.min(width - 1, x0 + 1);
            const fx = sx - x0;
            const a = (y0 * width + x0) * 4;
            const b = (y0 * width + x1) * 4;
            const c = (y1 * width + x0) * 4;
            const d = (y1 * width + x1) * 4;
            let value = 0;
            for (let channel = 0; channel < 3; channel++) {
                const weight = channel === 0 ? 0.2126 : channel === 1 ? 0.7152 : 0.0722;
                value +=
                    weight *
                    ((1 - fy) * ((1 - fx) * rgba[a + channel]! + fx * rgba[b + channel]!) +
                        fy * ((1 - fx) * rgba[c + channel]! + fx * rgba[d + channel]!));
            }
            if (!Number.isFinite(value)) throw new Error("invalid appearance pixels");
            const index = y * APPEARANCE_SIZE + x;
            luminance[index] = value;
            if (normalizedX >= left && normalizedX < right && normalizedY >= top && normalizedY < bottom) {
                valid[index] = 1;
                sum += value;
                sumSquares += value * value;
                validPixelCount++;
            }
        }
    }

    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 0; y < APPEARANCE_SIZE; y++) {
        const above = reflect(y - 1) * APPEARANCE_SIZE;
        const below = reflect(y + 1) * APPEARANCE_SIZE;
        const row = y * APPEARANCE_SIZE;
        for (let x = 0; x < APPEARANCE_SIZE; x++) {
            const index = row + x;
            const previousX = reflect(x - 1);
            const nextX = reflect(x + 1);
            const gx =
                luminance[above + nextX]! +
                2 * luminance[row + nextX]! +
                luminance[below + nextX]! -
                luminance[above + previousX]! -
                2 * luminance[row + previousX]! -
                luminance[below + previousX]!;
            const gy =
                luminance[below + previousX]! +
                2 * luminance[below + x]! +
                luminance[below + nextX]! -
                luminance[above + previousX]! -
                2 * luminance[above + x]! -
                luminance[above + nextX]!;
            gradientMagnitude[index] = Math.hypot(gx, gy);
            const angle = ((Math.atan2(gy, gx) % Math.PI) + Math.PI) % Math.PI;
            gradientBin[index] = Math.min(HOG_BINS - 1, Math.floor((angle * HOG_BINS) / Math.PI));
            if (!valid[index]) continue;
            if (x + 1 < APPEARANCE_SIZE && valid[index + 1]) {
                edgeSum += (luminance[index + 1]! - luminance[index]!) ** 2;
                edgeCount++;
            }
            if (y + 1 < APPEARANCE_SIZE && valid[index + APPEARANCE_SIZE]) {
                edgeSum += (luminance[index + APPEARANCE_SIZE]! - luminance[index]!) ** 2;
                edgeCount++;
            }
        }
    }
    const variance = validPixelCount ? Math.max(0, sumSquares / validPixelCount - (sum / validPixelCount) ** 2) : 0;
    const edgeEnergy = edgeCount ? edgeSum / edgeCount : 0;
    return {
        luminance,
        valid,
        gradientMagnitude,
        gradientBin,
        variance,
        edgeEnergy,
        validPixelCount,
        visibleFraction: validPixelCount / PIXEL_COUNT,
        hasInformation:
            validPixelCount >= MIN_COMPARISON_PIXELS && variance > NUMERIC_EPSILON && edgeEnergy > NUMERIC_EPSILON,
    };
}

/** Compare frozen object coordinates, allowing two normalized pixels of crop
 * jitter for NCC. HOG keeps its spatial cells fixed. Neither score alone proves
 * identity; missing pixels do not identify which object fragment remains. */
export function compareAppearance(reference: AppearanceSample, candidate: AppearanceSample): AppearanceComparison {
    const common = new Uint8Array(PIXEL_COUNT);
    let validPixelCount = 0;
    for (let i = 0; i < PIXEL_COUNT; i++) {
        common[i] = reference.valid[i]! && candidate.valid[i]! ? 1 : 0;
        validPixelCount += common[i]!;
    }
    let alignedNcc: number | null = null;
    let alignedValidPixelCount = 0;
    if (reference.hasInformation && candidate.hasInformation) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                let count = 0;
                let sumA = 0;
                let sumB = 0;
                let squaresA = 0;
                let squaresB = 0;
                let product = 0;
                for (let y = Math.max(0, dy); y < Math.min(APPEARANCE_SIZE, APPEARANCE_SIZE + dy); y++) {
                    const rowA = y * APPEARANCE_SIZE;
                    const rowB = (y - dy) * APPEARANCE_SIZE;
                    for (let x = Math.max(0, dx); x < Math.min(APPEARANCE_SIZE, APPEARANCE_SIZE + dx); x++) {
                        const aIndex = rowA + x;
                        const bIndex = rowB + x - dx;
                        if (!reference.valid[aIndex] || !candidate.valid[bIndex]) continue;
                        const a = reference.luminance[aIndex]!;
                        const b = candidate.luminance[bIndex]!;
                        sumA += a;
                        sumB += b;
                        squaresA += a * a;
                        squaresB += b * b;
                        product += a * b;
                        count++;
                    }
                }
                if (count < MIN_COMPARISON_PIXELS) continue;
                const varianceA = Math.max(0, squaresA - (sumA * sumA) / count);
                const varianceB = Math.max(0, squaresB - (sumB * sumB) / count);
                const denominator = Math.sqrt(varianceA * varianceB);
                if (denominator <= NUMERIC_EPSILON) continue;
                const ncc = Math.max(-1, Math.min(1, (product - (sumA * sumB) / count) / denominator));
                if (alignedNcc === null || ncc > alignedNcc) {
                    alignedNcc = ncc;
                    alignedValidPixelCount = count;
                }
            }
        }
    }

    const referenceHog = new Float64Array(HOG_LENGTH);
    const candidateHog = new Float64Array(HOG_LENGTH);
    if (reference.hasInformation && candidate.hasInformation && validPixelCount >= MIN_COMPARISON_PIXELS) {
        for (let y = 0; y < APPEARANCE_SIZE; y++) {
            for (let x = 0; x < APPEARANCE_SIZE; x++) {
                if (!hasValidNeighborhood(common, x, y)) continue;
                const index = y * APPEARANCE_SIZE + x;
                const cell = (Math.floor(y / HOG_CELL_SIZE) * 4 + Math.floor(x / HOG_CELL_SIZE)) * HOG_BINS;
                referenceHog[cell + reference.gradientBin[index]!]! += reference.gradientMagnitude[index]!;
                candidateHog[cell + candidate.gradientBin[index]!]! += candidate.gradientMagnitude[index]!;
            }
        }
    }
    let product = 0;
    let referenceNorm = 0;
    let candidateNorm = 0;
    for (let i = 0; i < HOG_LENGTH; i++) {
        product += referenceHog[i]! * candidateHog[i]!;
        referenceNorm += referenceHog[i]! ** 2;
        candidateNorm += candidateHog[i]! ** 2;
    }
    const denominator = Math.sqrt(referenceNorm * candidateNorm);
    const spatialHogCosine = denominator > NUMERIC_EPSILON ? Math.max(0, Math.min(1, product / denominator)) : null;
    return {
        alignedNcc,
        spatialHogCosine,
        validPixelCount,
        alignedValidPixelCount,
        visibleFraction: validPixelCount / PIXEL_COUNT,
        hasInformation: alignedNcc !== null && spatialHogCosine !== null,
    };
}

function hasUsableAppearance(sample: AppearanceSample): boolean {
    return (
        sample.hasInformation &&
        [sample.variance, sample.edgeEnergy, sample.visibleFraction].every(Number.isFinite) &&
        sample.variance >= REFERENCE_VARIANCE_MIN &&
        sample.edgeEnergy >= REFERENCE_EDGE_ENERGY_MIN &&
        sample.visibleFraction >= EXIT_VISIBLE_FRACTION
    );
}

function usableComparison(reference: AppearanceSample, candidate: AppearanceSample): AppearanceComparison | null {
    if (!hasUsableAppearance(reference) || !hasUsableAppearance(candidate)) return null;
    const comparison = compareAppearance(reference, candidate);
    if (
        !comparison.hasInformation ||
        comparison.visibleFraction < EXIT_VISIBLE_FRACTION ||
        comparison.alignedValidPixelCount / PIXEL_COUNT < EXIT_VISIBLE_FRACTION
    )
        return null;
    return comparison;
}

function isClearMismatch(comparison: AppearanceComparison | null): boolean {
    return (
        comparison !== null &&
        comparison.alignedNcc !== null &&
        comparison.spatialHogCosine !== null &&
        comparison.alignedNcc < MISMATCH_NCC_MAX &&
        comparison.spatialHogCosine < MISMATCH_HOG_MAX
    );
}

function isPositiveConfirmation(comparison: AppearanceComparison | null): boolean {
    return (
        comparison !== null &&
        comparison.alignedNcc !== null &&
        comparison.spatialHogCosine !== null &&
        comparison.alignedNcc >= CONFIRMATION_NCC_MIN &&
        comparison.spatialHogCosine >= CONFIRMATION_HOG_MIN
    );
}

/** A conservative clear-change heuristic, not an identity guarantee. Similar
 * distractors can pass, while pose changes or misplaced object crops can differ.
 * Both descriptors must disagree, and tiny or low-detail fragments abstain. */
export function appearanceMismatch(reference: AppearanceSample, candidate: AppearanceSample): boolean {
    return isClearMismatch(usableComparison(reference, candidate));
}

/** A frozen appearance reference with a persistent uncertainty state. After a
 * clear mismatch or an explicit request to verify a suspicious transition,
 * merely avoiding another mismatch is not enough: both descriptors must agree
 * strongly before tracking resumes. These heuristic scores cannot prove identity
 * or distinguish every similar distractor. Only a trusted seed replaces the
 * reference; accepted candidates never teach it their own appearance. */
export class TrackAppearanceReference {
    private seed: AppearanceSample | null = null;
    private uncertain = false;

    setSeed(sample: AppearanceSample | null): void {
        this.uncertain = false;
        this.seed =
            sample && hasUsableAppearance(sample)
                ? {
                      ...sample,
                      luminance: sample.luminance.slice(),
                      valid: sample.valid.slice(),
                      gradientMagnitude: sample.gradientMagnitude.slice(),
                      gradientBin: sample.gradientBin.slice(),
                  }
                : null;
    }

    get needsVerification(): boolean {
        return this.uncertain;
    }

    /** A provisional check can rescue a weak model response, but failure is not
     * evidence of an identity switch. Only successful confirmation changes its state. */
    rejects(
        candidate: AppearanceSample | null,
        {
            requireConfirmation = false,
            provisional = false,
        }: { requireConfirmation?: boolean; provisional?: boolean } = {},
    ): boolean {
        if (!this.seed) return provisional;
        const comparison = candidate ? usableComparison(this.seed, candidate) : null;
        const rejected =
            this.uncertain || requireConfirmation || provisional
                ? !isPositiveConfirmation(comparison)
                : isClearMismatch(comparison);
        if (!rejected || !provisional) this.uncertain = rejected;
        return rejected;
    }
}
