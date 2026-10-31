import { createSubscribers } from "./subscribers.js";
import { readLocalStorage, writeLocalStorage } from "./local-storage.js";
export type EncoderPreference = "auto" | "hardware" | "software";

const STORAGE_KEY = "everydashcam:encoder";
let cached: EncoderPreference | null = null;
const listeners = createSubscribers("encoder-preference");

export function isEncoderPreference(value: unknown): value is EncoderPreference {
    return value === "auto" || value === "hardware" || value === "software";
}

export function getEncoderPreference(): EncoderPreference {
    if (cached !== null) return cached;
    const stored = readLocalStorage(STORAGE_KEY);
    cached = isEncoderPreference(stored) ? stored : "auto";
    return cached;
}

export function encoderAcceleration(preference: EncoderPreference): HardwareAcceleration {
    return preference === "software"
        ? "prefer-software"
        : preference === "hardware"
          ? "prefer-hardware"
          : "no-preference";
}

export function setEncoderPreference(preference: EncoderPreference): void {
    if (getEncoderPreference() === preference) return;
    cached = preference;
    writeLocalStorage(STORAGE_KEY, preference);
    listeners.emit();
}

export function subscribeEncoderPreference(listener: () => void): () => void {
    return listeners.subscribe(listener);
}

export function _resetForTests(): void {
    cached = null;
    listeners.clear();
}
