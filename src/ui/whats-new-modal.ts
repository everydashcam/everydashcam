// "What's new" panel + its topbar badge. The dot on #whats-new-btn lights up
// when changelog entries newer than the last acknowledged one exist
// (src/persist/changelog-seen.ts) - a quiet hint, never a popup. Entry texts
// live in src/changelog/entries.ts and are imported lazily on first open, so
// the ever-growing history stays out of the entry bundle; only the tiny
// latest-id module rides in it (via changelog-seen).

import { changelogIdDate } from "../changelog/id.js";
import { escapeHtml } from "../escape.js";
import { getCurrentLang, t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { initChangelogSeen, markChangelogSeen } from "../persist/changelog-seen.js";
import { formatDate } from "./date-format.js";
import { activateModal, deactivateModal, isAnyModalOpen, wireBackdropDismiss } from "./modal-helper.js";

import type { ChangelogCategory, ChangelogEntry } from "../changelog/entries.js";
import type { I18nKey } from "../i18n/index.js";

const log = createLogger("ui:whats-new");

// Lucide outlines, 24px viewBox - inner paths only, the <svg> wrapper is
// shared in renderIcon. video / circle-plus / trending-up / wrench.
const CATEGORY_ICON_PATHS: Record<ChangelogCategory, string> = {
    support:
        '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    feature: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    improvement: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
    fix: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};

const CATEGORY_LABEL_KEYS: Record<ChangelogCategory, I18nKey> = {
    support: "whatsnew.category.support",
    feature: "whatsnew.category.feature",
    improvement: "whatsnew.category.improvement",
    fix: "whatsnew.category.fix",
};

function renderIcon(category: ChangelogCategory): string {
    // role="img" + aria-label voices the category for screen readers; the
    // sighted user reads it from the icon shape and the tooltip.
    return `<span class="whats-new-item-icon" role="img" aria-label="${escapeHtml(t(CATEGORY_LABEL_KEYS[category]))}" title="${escapeHtml(t(CATEGORY_LABEL_KEYS[category]))}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CATEGORY_ICON_PATHS[category]}</svg>
    </span>`;
}

function renderModalBody(entries: readonly ChangelogEntry[]): string {
    const lang = getCurrentLang();
    const sections: string[] = [];
    let currentDate: string | null = null;
    let items: string[] = [];
    const flush = () => {
        if (currentDate === null || items.length === 0) return;
        // Parsed as UTC midnight, the zone the formatters read: the id's date
        // part is calendar data, not an instant, so no zone may shift its day.
        const heading = formatDate(new Date(`${currentDate}T00:00:00Z`), { year: true, month: "long" });
        sections.push(`<section class="whats-new-group">
            <h3>${escapeHtml(heading)}</h3>
            <ul>${items.join("")}</ul>
        </section>`);
        items = [];
    };
    for (const entry of entries) {
        const date = changelogIdDate(entry.id);
        if (date !== currentDate) {
            flush();
            currentDate = date;
        }
        items.push(
            `<li class="whats-new-item">${renderIcon(entry.category)}<span>${escapeHtml(entry.text[lang])}</span></li>`,
        );
    }
    flush();
    return sections.join("");
}

function modalEl(): HTMLElement | null {
    return document.getElementById("whats-new-modal");
}

// The lazy chunk is fetched once; the promise doubles as the double-click
// guard while the first fetch is in flight.
let entriesPromise: Promise<readonly ChangelogEntry[]> | null = null;
let bodyRendered = false;

async function openWhatsNewModal(): Promise<void> {
    const m = modalEl();
    if (!m) return;
    if (!bodyRendered) {
        entriesPromise ??= import("../changelog/entries.js").then((mod) => mod.CHANGELOG_ENTRIES);
        let entries: readonly ChangelogEntry[];
        try {
            entries = await entriesPromise;
        } catch (err) {
            // Chunk fetch failed (offline first visit, deploy race) - drop the
            // promise so a later click retries instead of caching the failure.
            // The dot stays lit (nothing was acknowledged), which is the retry
            // hint.
            entriesPromise = null;
            log.warn("changelog chunk failed to load", { err: err instanceof Error ? err.message : String(err) });
            return;
        }
        if (m.hidden === false) return; // a parallel click already opened it
        // While the chunk loaded on a slow connection the user may have opened
        // another dialog - popping the panel now would pile on top and steal
        // its focus.
        if (isAnyModalOpen()) return;
        const body = document.getElementById("whats-new-modal-body");
        if (!body) return;
        body.innerHTML = renderModalBody(entries);
        bodyRendered = true;
    }
    // Acknowledge only what actually rendered: stamping on click would burn
    // the badge even when the load fails and the user saw nothing.
    markChangelogSeen();
    const dot = document.getElementById("whats-new-dot");
    if (dot) dot.hidden = true;
    m.hidden = false;
    // Info-only content - focus goes to the scrollable card (tabindex="-1")
    // so PageDown/arrows scroll a list that outgrows the viewport; the
    // overlay root would swallow those keys.
    const card = m.querySelector<HTMLElement>(".whats-new-modal-card");
    activateModal(m, { onClose: closeWhatsNewModal, initialFocus: card ?? m });
}

function closeWhatsNewModal(): void {
    const m = modalEl();
    if (!m) return;
    m.hidden = true;
    deactivateModal(m);
}

export function initWhatsNewModal(): void {
    const m = modalEl();
    const btn = document.getElementById("whats-new-btn");
    if (!m || !btn) return;
    // The first-visit stamp is the storage contract and runs regardless of
    // whether the dot element exists on this page.
    const hasUnseen = initChangelogSeen();
    const dot = document.getElementById("whats-new-dot");
    if (dot && hasUnseen) dot.hidden = false;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void openWhatsNewModal();
    });
    wireBackdropDismiss(m, closeWhatsNewModal, { cardSelector: ".whats-new-modal-card" });
}
