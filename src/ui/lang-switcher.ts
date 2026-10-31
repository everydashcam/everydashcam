// Language toggler in the header - a button with a Lucide "languages" SVG icon
// and a popover menu listing i18n.LANGS. Icon instead of a text code: ISO 639-1
// two-letter codes (UK, KK) are poorly recognized and conflict with country
// codes ("UK" read as United Kingdom). The active language is shown in the
// popover as a highlighted item.
//
// A language change is ALWAYS a full navigation to the prerendered /<lang>/
// page - there is no live in-place swap. Full reload picks the prerendered HTML
// for the new locale, keeping the URL and canonical/<html lang>/hreflang signals
// consistent with the visible content (Google sees /ru/ ↔ Russian content), and
// means only the active locale's dictionary ships to a given page.
//
// The one wrinkle is app mode (a trip already loaded): a reload discards the
// loaded recordings (File API handles do not survive navigation), so we confirm
// first via showSwitchLangConfirm. Landing mode (body.no-trips) has nothing to
// lose, so it navigates straight away.
//
// localStorage gets written on the navigate path so the next visit to / (root,
// no locale prefix) picks up the choice and prerender HTML for the right
// language is served on first paint.

import { buildLocaleUrl } from "../i18n/seo-config.js";
import { getCurrentLang, LANGS, persistLangChoice, type Lang } from "../i18n/index.js";

import { dom } from "./dom.js";
import { createPopover } from "./popover-lifecycle.js";
import { initMenuKeyboard } from "./menu-keyboard.js";
import { markIntentionalNavigation } from "./nav-intent.js";
import { showSwitchLangConfirm } from "./switch-lang-modal.js";

function isLang(code: string): code is Lang {
    return LANGS.some((l) => l.code === code);
}

// Landing mode = no files imported yet. body.no-trips is the same signal
// the landing layout uses to show/hide hero blocks (see src/ui/landing.ts).
// When false (app mode, a trip is loaded) a language switch would discard the
// loaded recordings on reload, so we confirm first.
function isLandingMode(): boolean {
    return document.body.classList.contains("no-trips");
}

// Navigates to the locale-prefixed URL for `code`. Persists the choice first so
// the root stub "/" honors it on the next visit, then hard-navigates: the
// prerendered HTML for /<lang>/ carries the correct canonical, hreflang,
// og:locale and translated meta. Query and hash are preserved (the landing has
// #faq anchors; losing them on a language switch dumps the user back to the top).
function navigateToLocale(code: Lang): void {
    persistLangChoice(code);
    // The user already confirmed the reload (in app mode) or has nothing loaded
    // to lose (landing mode) - suppress the beforeunload "Leave site?" prompt so
    // there is no redundant second confirmation.
    markIntentionalNavigation();
    location.assign(buildLocaleUrl(code, location.pathname + location.search + location.hash));
}

function renderLangMenu(): void {
    const { langMenu, langToggle } = dom;
    if (!langMenu || !langToggle) return;
    langMenu.innerHTML = "";
    const current = getCurrentLang();
    for (const { code, endonym } of LANGS) {
        const li = document.createElement("li");
        li.setAttribute("role", "none");
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("role", "menuitemradio");
        button.setAttribute("aria-checked", String(code === current));
        button.dataset.lang = code;
        button.lang = code;
        button.textContent = endonym;
        li.appendChild(button);
        langMenu.appendChild(li);
    }
}

let langPopover: ReturnType<typeof createPopover>;

function openLangMenu(): void {
    langPopover.open();
}

function closeLangMenu(restoreFocus = false): void {
    langPopover.close(restoreFocus);
}

export function initLangSwitcher(): void {
    const { langMenu, langToggle } = dom;
    if (!langMenu || !langToggle) return;
    // Button is the static SVG icon from index.html; no text code is injected.
    // Active language is visible in the popover as the highlighted item.
    renderLangMenu();
    langPopover = createPopover({
        button: langToggle,
        panel: langMenu,
        afterOpen: () => langMenu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(),
    });
    initMenuKeyboard({
        button: langToggle,
        menu: langMenu,
        itemSelector: 'button[role="menuitemradio"]',
        onOpen: openLangMenu,
        onClose: () => closeLangMenu(),
    });
    langToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (langMenu.hidden) openLangMenu();
        else closeLangMenu();
    });
    langMenu.addEventListener("click", (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;
        const code = target.dataset.lang;
        if (!code || !isLang(code)) return;
        const from = getCurrentLang();
        // Always close the popover - user made an explicit selection.
        closeLangMenu(true);
        if (from === code) return;
        if (isLandingMode()) {
            // Nothing loaded to lose - navigate straight to /<lang>/.
            navigateToLocale(code);
            return;
        }
        // App mode - a reload discards the loaded recordings. Confirm first,
        // then navigate. On cancel the popover is already closed; nothing else
        // happens and the session is untouched.
        void showSwitchLangConfirm().then((confirmed) => {
            if (confirmed) navigateToLocale(code);
        });
    });
}
