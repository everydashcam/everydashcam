/** Returns the callable native API; callers must preserve its Window receiver. */
export function getNativeSaveFilePicker(): NonNullable<Window["showSaveFilePicker"]> | null {
    if (typeof window === "undefined") return null;
    const picker = window.showSaveFilePicker;
    return typeof picker === "function" ? picker : null;
}
