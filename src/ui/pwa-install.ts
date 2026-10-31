// Installation state and native prompt for the offline-use chooser, plus the
// one-shot post-export toast and the fallback installation guide.

import { createSubscribers } from "../subscribers.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { buildLucideIcon, SVG_NS } from "./icons.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";

const log = createLogger("pwa-install");

// BeforeInstallPromptEvent is missing from lib.dom (non-standard). Extend the
// global so TS does not complain about addEventListener("beforeinstallprompt").
interface BeforeInstallPromptEvent extends Event {
    readonly platforms: ReadonlyArray<string>;
    readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
    prompt(): Promise<void>;
}

declare global {
    interface WindowEventMap {
        beforeinstallprompt: BeforeInstallPromptEvent;
        appinstalled: Event;
    }
}

// navigator.getInstalledRelatedApps - non-standard, in Chrome/Edge. Returns
// the list of related installed apps (PWA + UWP + Android) that this site
// claims kinship with via manifest's related_applications. For self-PWA
// detection we look for an entry with platform === "webapp".
type RelatedApp = { platform: string; id?: string; url?: string; version?: string };
type NavWithRelatedApps = Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> };

// Single source of truth for this module's localStorage keys.
const STORAGE_TOAST_SHOWN = "everydashcam:pwa:toast:shown";
const STORAGE_TOAST_DISMISSED_AT = "everydashcam:pwa:toast:dismissedAt";
// Cross-window installed signal. Set when ANY of:
//   - the current load is itself in standalone display-mode,
//   - the appinstalled event fires,
//   - navigator.getInstalledRelatedApps returns our PWA.
// Read on every init. Lets a browser-tab page on the same origin know that
// the PWA exists in a parallel window. Required because:
//   - getInstalledRelatedApps doesn't work on localhost (HTTPS-only) and
//     mismatches when related_applications uses prod URLs in dev,
//   - Chrome still fires beforeinstallprompt in browser tabs even when the
//     PWA is installed for the same origin in another window.
// Wiped by Danger zone reset (which clears all localStorage), preserved by
// the lighter "Clear offline cache" action.
//
// The signal is sticky on purpose, but there is no 'appuninstalled' web event
// to clear it after the user removes the PWA. So we also clear it whenever an
// authoritative source says we're NOT installed: a fired beforeinstallprompt
// (only fires when installable, i.e. not installed) or a getInstalledRelatedApps
// negative on browsers that have the API. Without that, an install->uninstall
// cycle leaves the install action unavailable until the user wipes site data. See
// clearInstalledSignal() and its callers.
const STORAGE_INSTALLED_SIGNAL = "everydashcam:pwa:installed";

// After an explicit dismiss, suppress the toast for 30 days. The offline-use
// chooser stays available, so the toast is just a one-shot reminder.
const TOAST_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

type InstallStrategy = "skip" | "already-installed" | "chromium" | "safari-mac";
export type PwaInstallState = "install" | "guide" | "installed" | "unsupported";

// Module state. Reset on every full page reload.
let strategy: InstallStrategy = "skip";
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
let installRevision = 0;
let lastEmittedState: PwaInstallState = "unsupported";
const stateListeners = createSubscribers<Parameters<(state: PwaInstallState) => void>>("pwa-install");

// Unknown results must not clear a stored installation signal.
let relatedAppsCheckPromise: Promise<boolean | null> | null = null;
// Confirmed installation survives a blocked localStorage write in this page.
let installedAccordingToOS = false;

// --- Detection ---

function matchesDisplayMode(mode: string): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(`(display-mode: ${mode})`).matches;
}

function isStandalone(): boolean {
    if (matchesDisplayMode("standalone")) return true;
    if (matchesDisplayMode("window-controls-overlay")) return true;
    if (matchesDisplayMode("fullscreen")) return true;
    // Legacy iOS Safari flag for "Add to Home Screen" PWAs.
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    return iosStandalone === true;
}

function isIOSorIPadOS(): boolean {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    // iPadOS 13+ sends a Desktop UA that looks like macOS Safari by default.
    // Distinguish by touch points - Mac has 0, iPad usually >= 1.
    if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
    return false;
}

function isFirefox(): boolean {
    return /Firefox/.test(navigator.userAgent);
}

function isSafariMac(): boolean {
    if (isIOSorIPadOS()) return false;
    const ua = navigator.userAgent;
    // Every Chromium UA includes "Safari" for historical reasons - the
    // distinguishing markers are Chromium/Edge/Opera tokens.
    return /Safari/.test(ua) && !/Chrome|Chromium|Edg\/|OPR\//.test(ua);
}

function isChromium(): boolean {
    if (isFirefox()) return false;
    // UA Client Hints are a reliable Chromium-only signal.
    const uad = (
        navigator as Navigator & {
            userAgentData?: { brands: ReadonlyArray<{ brand: string }> };
        }
    ).userAgentData;
    if (uad?.brands) {
        return uad.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Brave|Opera|Yandex/i.test(b.brand));
    }
    // UA string fallback. Edg/ - Chromium Edge, OPR/ - Opera, YaBrowser - Yandex.
    return /Chrome|Chromium|Edg\/|OPR\/|YaBrowser/.test(navigator.userAgent);
}

function detectStrategy(): InstallStrategy {
    if (isStandalone()) return "already-installed";
    if (isIOSorIPadOS()) return "skip";
    if (isFirefox()) return "skip";
    if (isSafariMac()) return "safari-mac";
    if (isChromium()) return "chromium";
    return "skip";
}

/**
 * Once-per-session query against navigator.getInstalledRelatedApps. Resolves
 * with `true` if the OS reports our PWA as installed. The returned promise
 * is memoized - subsequent callers (init override + toast gate) share it
 * and don't trigger a second IPC.
 *
 * Chrome/Edge only (Android 84+, Desktop 140+). On browsers without the
 * API, resolves to `null` immediately. Errors are logged and return `null` -
 * we never want this defensive check to break the install flow.
 */
function checkInstalledRelatedAppsOnce(): Promise<boolean | null> {
    if (relatedAppsCheckPromise) return relatedAppsCheckPromise;
    const nav = navigator as NavWithRelatedApps;
    if (typeof nav.getInstalledRelatedApps !== "function") {
        relatedAppsCheckPromise = Promise.resolve(null);
        return relatedAppsCheckPromise;
    }
    relatedAppsCheckPromise = nav
        .getInstalledRelatedApps()
        .then((apps) => {
            const found = apps.some((a) => a.platform === "webapp");
            if (found) log.info("getInstalledRelatedApps reports we are installed", { apps });
            return found;
        })
        .catch((err: unknown) => {
            log.warn("getInstalledRelatedApps failed", { error: err instanceof Error ? err.message : String(err) });
            return null;
        });
    return relatedAppsCheckPromise;
}

/** Stores the "this origin has an installed PWA somewhere" flag. */
function setInstalledSignal(): void {
    try {
        localStorage.setItem(STORAGE_INSTALLED_SIGNAL, "1");
    } catch {
        // private mode - signal won't survive reload, but matchMedia will
        // still cover the in-window case.
    }
}

/** Reads the cross-window installed signal. */
function hasInstalledSignal(): boolean {
    try {
        return localStorage.getItem(STORAGE_INSTALLED_SIGNAL) === "1";
    } catch {
        return false;
    }
}

/**
 * Drops the stale installed signal after an uninstall. Called only from
 * authoritative "not installed" sources (beforeinstallprompt / OS negative),
 * never speculatively - the whole point of the signal is to survive a reload.
 */
function clearInstalledSignal(): void {
    try {
        localStorage.removeItem(STORAGE_INSTALLED_SIGNAL);
    } catch {
        // private mode - nothing was persisted anyway.
    }
}

/**
 * Synchronous "is the app already installed?" combining all three local
 * signals. Used by show-functions to suppress the install CTA and by
 * requestPwaInstall to swap the action. Does NOT include the async
 * getInstalledRelatedApps result - callers that can await get it
 * separately via checkInstalledRelatedAppsOnce().
 */
function isLikelyInstalled(): boolean {
    return isStandalone() || installedAccordingToOS || hasInstalledSignal();
}

export function getPwaInstallState(): PwaInstallState {
    if (isLikelyInstalled()) return "installed";
    if (strategy === "chromium") return deferredPrompt ? "install" : "guide";
    if (strategy === "safari-mac") return "guide";
    return "unsupported";
}

export function subscribePwaInstallState(listener: (state: PwaInstallState) => void): () => void {
    return stateListeners.subscribe(listener, [getPwaInstallState()]);
}

function emitInstallState(): void {
    const state = getPwaInstallState();
    if (state === lastEmittedState) return;
    lastEmittedState = state;
    stateListeners.emit(state);
}

// --- DOM helpers ---

function $btn(id: string): HTMLButtonElement | null {
    return document.getElementById(id) as HTMLButtonElement | null;
}

function getBanner(): HTMLElement | null {
    return document.getElementById("install-banner");
}

function getModal(): HTMLElement | null {
    return document.getElementById("install-modal");
}

// --- Show / hide ---

function hideBanner(): void {
    const banner = getBanner();
    if (banner) banner.hidden = true;
}

function closeGuideModal(): void {
    const modal = getModal();
    if (!modal) return;
    modal.hidden = true;
    deactivateModal(modal);
}

/** Shared post-show a11y wiring for the install modal (guide / already-
 *  installed both reuse the same DOM). */
function activateInstallModal(modal: HTMLElement): void {
    activateModal(modal, {
        onClose: closeGuideModal,
        initialFocus: document.getElementById("install-modal-close"),
    });
}

// --- Click handlers ---

export async function requestPwaInstall(): Promise<void> {
    // At-click detection. The button may have surfaced before our install
    // signals fired (Chrome quirk firing beforeinstallprompt in browser tab
    // even when the PWA is installed for the same origin; localhost where
    // getInstalledRelatedApps refuses to work). When that happens, swap the
    // action: instead of triggering a prompt that won't work, point the
    // user at where the installed app actually lives.
    if (isLikelyInstalled()) {
        log.info("install click on already-installed app, showing launch hint");
        openAlreadyInstalledModal();
        return;
    }

    // Chromium with a captured beforeinstallprompt - fire the native dialog.
    if (strategy === "chromium" && deferredPrompt) {
        // prompt() needs the click's user activation and each event is single-use.
        // Keep a local reference: appinstalled can clear shared state while awaited.
        const prompt = deferredPrompt;
        deferredPrompt = null;
        emitInstallState();
        try {
            await prompt.prompt();
            const { outcome } = await prompt.userChoice;
            log.info("native install prompt outcome", { outcome });
        } catch (err) {
            // A failed prompt is not proof of installation; its browser service
            // may be unavailable. Only installation signals justify the hint.
            log.warn("native install prompt failed", { error: err instanceof Error ? err.message : String(err) });
            if (isLikelyInstalled()) openAlreadyInstalledModal();
            else openGuideModal();
        }
        return;
    }

    // No deferredPrompt (safari-mac, or chromium before the event arrived) -
    // keep the guide usable even while the background OS query is pending.
    openGuideModal();
}

function openGuideModal(): void {
    const modal = getModal();
    const body = document.getElementById("install-modal-body");
    const title = document.getElementById("install-modal-title");
    if (!modal || !body) return;

    // Full re-render of the body - which guide depends on strategy. The
    // title also resets to the "install" wording in case openAlreadyInstalled
    // had previously swapped it.
    body.replaceChildren();
    if (title) title.textContent = t("pwa.guide.title");
    if (strategy === "safari-mac") {
        body.append(...renderSafariMacGuide());
    } else if (strategy === "chromium") {
        body.append(...renderChromiumGuide());
    } else {
        // Other strategies have no guide content - leave the modal closed.
        return;
    }
    modal.hidden = false;
    activateInstallModal(modal);
}

/**
 * Modal shown when the user clicks the install button but detection at-click
 * says the PWA is already installed. Reuses the same #install-modal DOM as
 * the install guide; we just swap title and body content. No JS API exists
 * to launch an installed PWA from a browser tab, so the body is a textual
 * pointer to where the installed app actually lives.
 */
function openAlreadyInstalledModal(): void {
    const modal = getModal();
    const body = document.getElementById("install-modal-body");
    const title = document.getElementById("install-modal-title");
    if (!modal || !body) return;

    body.replaceChildren();
    if (title) title.textContent = t("pwa.installed.title");

    const intro = document.createElement("p");
    intro.className = "install-modal-intro";
    intro.textContent = t("pwa.installed.body");
    body.appendChild(intro);

    // Chromium-only hint about the address-bar "Open in app" icon. On
    // Safari/Firefox no such button exists, so we omit it there.
    if (isChromium()) {
        const hint = document.createElement("p");
        hint.className = "install-modal-intro";
        hint.textContent = t("pwa.installed.chromiumHint");
        body.appendChild(hint);
    }

    modal.hidden = false;
    activateInstallModal(modal);
}

function renderSafariMacGuide(): HTMLElement[] {
    const intro = document.createElement("p");
    intro.className = "install-modal-intro";
    intro.textContent = t("pwa.guide.safariMac.intro");

    const ol = document.createElement("ol");
    ol.className = "install-modal-steps";
    for (const key of [
        "pwa.guide.safariMac.step1",
        "pwa.guide.safariMac.step2",
        "pwa.guide.safariMac.step3",
    ] as const) {
        const li = document.createElement("li");
        li.textContent = t(key);
        ol.appendChild(li);
    }

    const ctaWrap = document.createElement("div");
    ctaWrap.className = "install-modal-cta-wrap";
    const cta = document.createElement("a");
    cta.className = "dc-btn dc-btn--primary";
    cta.href = "https://www.google.com/chrome/";
    cta.target = "_blank";
    cta.rel = "noopener noreferrer";
    cta.textContent = t("pwa.guide.safariMac.cta");
    ctaWrap.appendChild(cta);

    return [intro, ol, ctaWrap];
}

function renderChromiumGuide(): HTMLElement[] {
    const intro = document.createElement("p");
    intro.className = "install-modal-intro";
    intro.textContent = t("pwa.guide.chromium.intro");

    const ol = document.createElement("ol");
    ol.className = "install-modal-steps";

    // Step 1 ends with an inline copy of the actual install glyph - same
    // monitor-with-down-arrow icon Chrome renders in the address bar.
    // Helps the user recognize the shape they should look for.
    const step1 = document.createElement("li");
    step1.append(t("pwa.guide.chromium.step1"), " ", buildInstallGlyph());
    ol.appendChild(step1);

    const step2 = document.createElement("li");
    step2.textContent = t("pwa.guide.chromium.step2");
    ol.appendChild(step2);

    return [intro, ol];
}

/**
 * Inline SVG copy of the Lucide monitor-down icon, a visual stand-in for Chrome's address-bar
 * install icon. Wrapped in a chip-style span so it reads as a clickable
 * artifact, not body text.
 */
function buildInstallGlyph(): HTMLSpanElement {
    const wrap = document.createElement("span");
    wrap.className = "install-modal-inline-glyph";
    wrap.setAttribute("aria-hidden", "true");
    // monitor-down: arrow paths from the shared builder + the monitor base rect.
    const svg = buildLucideIcon(["M12 13V3", "m8 9 4 4 4-4"]);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", "2");
    rect.setAttribute("y", "15");
    rect.setAttribute("width", "20");
    rect.setAttribute("height", "6");
    rect.setAttribute("rx", "2");
    svg.appendChild(rect);
    wrap.appendChild(svg);
    return wrap;
}

// --- Toast ---

function shouldShowToast(): boolean {
    if (strategy !== "chromium" && strategy !== "safari-mac") return false;
    try {
        // Already shown in a previous session - do not re-pester. The user
        // still has the offline-use chooser if they want to install.
        if (localStorage.getItem(STORAGE_TOAST_SHOWN) === "1") return false;
        // If a dismissedAt timestamp exists - respect the cooldown. SHOWN is
        // always set together with the toast display, so this check is
        // defensive future-proofing.
        const at = Number(localStorage.getItem(STORAGE_TOAST_DISMISSED_AT));
        if (at && Date.now() - at < TOAST_DISMISS_COOLDOWN_MS) return false;
        return true;
    } catch {
        return false;
    }
}

function showToast(): void {
    if (isLikelyInstalled()) {
        log.warn("showToast suppressed: detected as installed");
        return;
    }
    const banner = getBanner();
    if (!banner) return;
    banner.hidden = false;
    try {
        localStorage.setItem(STORAGE_TOAST_SHOWN, "1");
    } catch {
        // private mode - the toast fired in this session, retry next time.
    }
}

/**
 * Shows the install toast if the strategy allows it, the user hasn't seen
 * it before, AND the OS doesn't report the PWA as already installed.
 * Idempotent. Called after leaving a successfully completed export.
 */
export async function maybeShowPostExportToast(): Promise<void> {
    // Authoritative OS-level check. The synchronous strategy may say
    // "chromium" (browser tab) while the OS knows we're installed elsewhere
    // - in that case the user has already taken the action, no need to
    // re-pester. Awaiting here adds a few ms on browsers that have the API,
    // and resolves immediately on browsers without it.
    if (await checkInstalledRelatedAppsOnce()) return;
    if (!shouldShowToast()) return;
    const banner = getBanner();
    if (!banner) return;

    showToast();
}

// --- Init ---

/** Initializes installation detection and guide/toast controls once per page. */
export function initPwaInstall(): void {
    if (initialized) return;
    initialized = true;
    strategy = detectStrategy();

    // The already-installed hint uses this modal even on unsupported browsers.
    $btn("install-modal-close")?.addEventListener("click", closeGuideModal);
    const guideModal = getModal();
    if (guideModal) wireBackdropDismiss(guideModal, closeGuideModal, { cardSelector: ".export-modal-card" });
    // Escape is handled centrally by the modal manager (activateInstallModal).

    // Standalone is conclusive; a stored signal must still be reconciled with
    // the browser because there is no appuninstalled event to clear it.
    if (strategy === "already-installed") {
        installedAccordingToOS = true;
        setInstalledSignal();
        log.info("strategy detected", { strategy });
        emitInstallState();
        return;
    }
    log.info("strategy detected", { strategy, installedSignal: hasInstalledSignal() });
    emitInstallState();

    // A delayed OS result must not overwrite a newer native install event.
    const checkRevision = installRevision;
    void checkInstalledRelatedAppsOnce().then((installed) => {
        if (checkRevision !== installRevision) return;
        if (installed) {
            installedAccordingToOS = true;
            setInstalledSignal();
            hideBanner();
            closeGuideModal();
            emitInstallState();
            return;
        }
        // Missing or failed detection is unknown, not proof of an uninstall.
        if (installed === false && hasInstalledSignal()) {
            log.info("OS reports not installed but a stale installed-signal exists; clearing it");
            clearInstalledSignal();
            installedAccordingToOS = false;
            emitInstallState();
        }
    });

    if (strategy === "skip") {
        return;
    }

    // Toast buttons.
    $btn("install-banner-install")?.addEventListener("click", () => {
        void requestPwaInstall();
        hideBanner();
    });
    $btn("install-banner-dismiss")?.addEventListener("click", () => {
        hideBanner();
        try {
            localStorage.setItem(STORAGE_TOAST_DISMISSED_AT, String(Date.now()));
        } catch {
            // private mode - dismiss will not survive a reload; the toast is
            // already closed in the current session.
        }
    });

    // Chromium - wait for the event. preventDefault() is mandatory, otherwise
    // Chrome will show its own mini-banner on mobile and steal the UX.
    window.addEventListener("beforeinstallprompt", (ev) => {
        ev.preventDefault();
        installRevision++;
        deferredPrompt = ev;
        log.debug("beforeinstallprompt captured", { platforms: ev.platforms });
        // An installable app supersedes the stored/OS result from an earlier
        // installation; there is no separate appuninstalled event.
        if (hasInstalledSignal()) {
            log.info("beforeinstallprompt fired with a stale installed-signal; clearing it");
            clearInstalledSignal();
        }
        installedAccordingToOS = false;
        emitInstallState();
    });

    // Install completed - regardless of who triggered it. Hide everything
    // and persist the cross-window signal so future tab loads short-circuit.
    window.addEventListener("appinstalled", () => {
        log.info("pwa appinstalled");
        installRevision++;
        installedAccordingToOS = true;
        setInstalledSignal();
        deferredPrompt = null;
        hideBanner();
        closeGuideModal();
        emitInstallState();
    });

    // Display-mode can flip mid-session (e.g. user toggled fullscreen, or the
    // browser switched the window into standalone after install). When that
    // happens, drop any visible install UI immediately. We listen on both
    // standalone and WCO since either signals "the user is inside the
    // installed app right now".
    for (const mode of ["standalone", "window-controls-overlay"]) {
        window.matchMedia?.(`(display-mode: ${mode})`).addEventListener("change", (ev) => {
            installRevision++;
            if (ev.matches) {
                log.info("display-mode changed to installed", { mode });
                hideBanner();
                closeGuideModal();
            }
            emitInstallState();
        });
    }
}
