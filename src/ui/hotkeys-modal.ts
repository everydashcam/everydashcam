// UX-10: player hotkey cheatsheet modal. Opened by the ? button or Shift+/ (key="?").
// Closed by Esc, backdrop click, or another ?. Content is driven by i18n keys hotkeys.action.*;
// the modal is a cheatsheet only - actual hotkeys are defined in src/ui/player.ts initPlayer keydown handler.

import { escapeHtml } from "../escape.js";
import { t } from "../i18n/index.js";
import { activateModal, deactivateModal, isAnyModalOpen, wireBackdropDismiss } from "./modal-helper.js";

interface HotkeyRow {
    keys: string[];
    label: string;
}

interface HotkeyGroup {
    title: string;
    rows: HotkeyRow[];
}

function buildGroups(): HotkeyGroup[] {
    return [
        {
            title: t("hotkeys.group.playback"),
            rows: [
                { keys: ["Space", "K"], label: t("hotkeys.action.playPause") },
                { keys: ["U"], label: t("hotkeys.action.mute") },
                { keys: ["F"], label: t("hotkeys.action.fullscreen") },
                { keys: ["<", ">"], label: t("hotkeys.action.speed") },
            ],
        },
        {
            title: t("hotkeys.group.seek"),
            rows: [
                { keys: ["J"], label: t("hotkeys.action.seekBack10") },
                { keys: ["L"], label: t("hotkeys.action.seekFwd10") },
                { keys: ["←", "→"], label: t("hotkeys.action.seekFine") },
                { keys: ["Shift+←", "Shift+→"], label: t("hotkeys.action.seekFineLong") },
                { keys: [",", "."], label: t("hotkeys.action.frameStep") },
                { keys: ["0", "9"], label: t("hotkeys.action.seekStart") },
            ],
        },
        {
            title: t("hotkeys.group.view"),
            rows: [
                { keys: ["C"], label: t("hotkeys.action.toggleChart") },
                { keys: ["T"], label: t("hotkeys.action.toggleStrip") },
                { keys: ["M"], label: t("hotkeys.action.toggleMap") },
                { keys: ["G"], label: t("hotkeys.action.toggleReadout") },
                { keys: ["V"], label: t("hotkeys.action.cameraMode") },
                { keys: ["N"], label: t("hotkeys.action.nextCamera") },
            ],
        },
        {
            title: t("hotkeys.group.export"),
            rows: [
                { keys: ["E"], label: t("hotkeys.action.export") },
                { keys: ["I", "O"], label: t("hotkeys.action.setClipEdges") },
                { keys: ["Shift+I", "Shift+O"], label: t("hotkeys.action.gotoClipEdges") },
            ],
        },
        {
            title: t("hotkeys.group.misc"),
            rows: [
                { keys: ["S"], label: t("hotkeys.action.snapshot") },
                { keys: ["R"], label: t("hotkeys.action.loop") },
                { keys: ["+", "-"], label: t("hotkeys.action.zoomTimeline") },
                {
                    keys: [t("hotkeys.input.wheel"), t("hotkeys.input.pinch")],
                    label: t("hotkeys.action.zoomVideo"),
                },
                { keys: ["Z"], label: t("hotkeys.action.zoomReset") },
                { keys: ["?"], label: t("hotkeys.action.help") },
            ],
        },
    ];
}

function renderModalBody(): string {
    const groups = buildGroups();
    const html = groups
        .map((group) => {
            const rows = group.rows
                .map((row) => {
                    const keysHtml = row.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(" ");
                    return `<dt>${keysHtml}</dt><dd>${escapeHtml(row.label)}</dd>`;
                })
                .join("");
            return `<section class="hotkeys-modal-group">
                <h3>${escapeHtml(group.title)}</h3>
                <dl>${rows}</dl>
            </section>`;
        })
        .join("");
    return html;
}

let bodyRendered = false;

function modalEl(): HTMLElement | null {
    return document.getElementById("hotkeys-modal");
}

function isHotkeysModalOpen(): boolean {
    const m = modalEl();
    return !!m && !m.hidden;
}

function openHotkeysModal(): void {
    const m = modalEl();
    if (!m) return;
    if (!bodyRendered) {
        const body = document.getElementById("hotkeys-modal-body");
        if (body) body.innerHTML = renderModalBody();
        bodyRendered = true;
    }
    m.hidden = false;
    // No focusable controls inside (info-only) - the manager pins focus to the
    // tabindex="-1" root so Tab cannot escape behind the backdrop.
    activateModal(m, { onClose: closeHotkeysModal, initialFocus: m });
}

function closeHotkeysModal(): void {
    const m = modalEl();
    if (!m) return;
    m.hidden = true;
    deactivateModal(m);
}

export function initHotkeysModal(): void {
    const m = modalEl();
    if (!m) return;
    const helpBtn = document.getElementById("player-help");
    helpBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isHotkeysModalOpen()) closeHotkeysModal();
        else openHotkeysModal();
    });
    // Backdrop click (outside the card) closes the modal; the card stops its own clicks.
    wireBackdropDismiss(m, closeHotkeysModal, { cardSelector: ".hotkeys-modal-card" });
    // ? toggle via global keydown. Escape-close is handled centrally by the
    // modal manager (activateModal); we only own the "?" open/toggle here.
    document.addEventListener("keydown", (e) => {
        // Skip when focus is in an editable control.
        if (e.target instanceof HTMLElement) {
            const tag = e.target.tagName;
            if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
        }
        // Inert while another modal is open (same convention as
        // player-hotkeys/view-menu) - the modal manager's capture trap only
        // swallows Escape/Tab, so without this "?" stacked the cheatsheet on
        // top of settings/feedback/export. Toggling our OWN modal stays allowed.
        if (isAnyModalOpen() && !isHotkeysModalOpen()) return;
        // ? = Shift+/ on most layouts. Accept both.
        if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
            e.preventDefault();
            if (isHotkeysModalOpen()) closeHotkeysModal();
            else openHotkeysModal();
        }
    });
}
