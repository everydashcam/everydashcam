export interface DetectionPolicy {
    seedScoreMin: number;
    strongScore: number;
}

export interface DetectionThresholds {
    plate: number;
    face: number;
}

export const DETECTION_THRESHOLD_MIN = 0.1;
export const DETECTION_THRESHOLD_MAX = 1;
export const DETECTION_THRESHOLD_STEP = 0.01;

/** Face candidates and single-hit confirmation share one score floor. */
export const FACE_SCORE_MIN = 0.45;

/** Shared acceptance policy for sparse propagation and source-frame detection.
 * Persistent background hits can corroborate each other, so each seed must
 * already meet its single-hit confirmation floor. These are score policies,
 * not measured probabilities of correct anonymization. */
export const DETECTION_POLICIES: Readonly<Record<"plate" | "face", Readonly<DetectionPolicy>>> = {
    plate: { seedScoreMin: 0.7, strongScore: 0.7 },
    face: { seedScoreMin: FACE_SCORE_MIN, strongScore: FACE_SCORE_MIN },
};

/** User-selected thresholds always confirm an eligible seed on its first hit. */
export function detectionPolicy(scoreMin: number): DetectionPolicy {
    if (!Number.isFinite(scoreMin) || scoreMin < DETECTION_THRESHOLD_MIN || scoreMin > DETECTION_THRESHOLD_MAX) {
        throw new Error("detection threshold is out of range");
    }
    return { seedScoreMin: scoreMin, strongScore: scoreMin };
}

/** Sub-floor observations can maintain a matched object, but cannot create an
 * object or add detector-confirmation evidence. Keep the decoder's raw floor
 * separate so these maintenance observations remain available. */
export function canSeedDetection(score: number, policy: Pick<DetectionPolicy, "seedScoreMin">): boolean {
    return Number.isFinite(score) && score >= policy.seedScoreMin;
}
