import { createLogger } from "../log.js";
import { getNativeSaveFilePicker } from "../native-file-picker.js";
import { notify } from "./notifications.js";

const log = createLogger("file-picker");

type PickerKind = "directory" | "open" | "save";

let activePicker: { kind: PickerKind; openedAt: number } | null = null;

// Invoke immediately so the caller's user activation reaches the native picker.
export function showSaveFilePicker(
    options: Parameters<NonNullable<Window["showSaveFilePicker"]>>[0],
): Promise<FileSystemFileHandle> {
    const picker = getNativeSaveFilePicker();
    if (!picker) throw new Error("native save picker is unavailable");
    return picker.call(window, options);
}

function notifyBusy(): void {
    notify({ severity: "warn", messageKey: "filePicker.busy" });
}

/** Runs a native picker inside the current user gesture. A competing request
 *  returns null; queueing it would lose the activation required by the browser.
 *  Only the native promise settling releases ownership, never a UI dismissal. */
export async function withFilePicker<T>(
    kind: PickerKind,
    pick: () => Promise<T>,
    onBusy: () => void = notifyBusy,
): Promise<T | null> {
    if (activePicker) {
        log.warn("file picker blocked", {
            requested: kind,
            active: activePicker.kind,
            pendingMs: Date.now() - activePicker.openedAt,
        });
        onBusy();
        return null;
    }

    activePicker = { kind, openedAt: Date.now() };
    try {
        return await pick();
    } catch (err) {
        // Chromium can retain a picker we do not own. A retry would still
        // conflict and may no longer have a fresh user gesture.
        if (err instanceof Error && err.name === "NotAllowedError" && /file picker already active/i.test(err.message)) {
            log.warn("browser file picker already active", { requested: kind, err: err.message });
            onBusy();
            return null;
        }
        throw err;
    } finally {
        activePicker = null;
    }
}

export function _resetForTests(): void {
    activePicker = null;
}
