// Export button in the player bar: enabled/disabled state and tooltip.
// Owns the "export in progress" flag, set externally via the onInProgress
// hook in export-panel.ts. The click handler that toggles export-mode is
// wired in export-panel.ts (openOrCloseExportMode).

import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { withShortcutHint } from "./shortcut-hint.js";

let exportInProgress = false;

/** External hook: marks that a background export has started/finished. */
export function setExportInProgress(v: boolean): void {
    exportInProgress = v;
    syncExportButton();
}

/**
 * Syncs the Export button: disabled-state and tooltip. Disabled when no trip
 * is loaded or an export is in progress. On mobile the same button lives in the
 * player-bar and overflows into the kebab last (player-bar-overflow.ts).
 */
export function syncExportButton(): void {
    const btn = dom.exportBtn;
    if (!btn) return;
    const hasActive = state.active !== null;
    const disabled = !hasActive || exportInProgress;
    btn.disabled = disabled;
    const label = t("player.export.label");
    btn.title = withShortcutHint(label, "E");
    btn.setAttribute("aria-label", label);
}
