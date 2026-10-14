export interface DetectionPolicy {
    seedScoreMin: number;
    strongScore: number;
}

/** Shared acceptance policy for sparse propagation and source-frame detection.
 * Persistent background hits can corroborate each other, so plates require a
 * stronger initial observation. These floors are score policies,
 * not measured probabilities of correct anonymization. */
export const DETECTION_POLICIES: Readonly<Record<"plate" | "face", Readonly<DetectionPolicy>>> = {
    plate: { seedScoreMin: 0.7, strongScore: 0.7 },
    face: { seedScoreMin: 0.25, strongScore: 0.45 },
};

/** Sub-floor observations can maintain a matched object, but cannot create an
 * object or add detector-confirmation evidence. Keep the decoder's raw floor
 * separate so these maintenance observations remain available. */
export function canSeedDetection(score: number, policy: Pick<DetectionPolicy, "seedScoreMin">): boolean {
    return Number.isFinite(score) && score >= policy.seedScoreMin;
}
