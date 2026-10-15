// Browser-compatibility surfacing. Two outcomes, driven by src/capabilities.ts:
//
//  - FATAL gap (no Web Workers / no <video> / no way to load files): a full
//    blocking gate over the app. "This won't run here" + the cause + what to do.
//    The caller (app.ts) skips the rest of init.
//  - DEGRADED but user-visible gap (no map / no editor+export / no H.264 decode):
//    a proactive, concise notice via the notifications system, so the user is not
//    surprised later. Each feature also explains itself at the point of use
//    (map panel, codec overlay, export panel) - this is the upfront heads-up.
//
// The gate DOM is built here (not in index.html) so it needs no extra CSP hash
// and works regardless of markup changes; it is shown only after the bundle has
// loaded, which is fine - a browser too old to even run the bundle is handled by
// the static landing + splash watchdog (see docs/browser-support.md).

import {
    type CapabilityId,
    type CapabilityReport,
    type WebglRecoveryVerdict,
    capabilitySignature,
    classifyWebglRecovery,
    detectCapabilities,
    headlineDegradations,
} from "../capabilities.js";
import { escapeHtml } from "../escape.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { captureSentryMessage, setSentryContext, setSentryTags } from "../sentry.js";
import { notify } from "./notifications.js";
import {
    openWebglEnableModal,
    revealMapEnableLink,
    setMapEnableConfidence,
    setMapEnableReason,
} from "./webgl-enable-modal.js";

const log = createLogger("capability-gate");

/** Low-cardinality, PII-free browser tags for Sentry (shared by both signals). */
function capabilityTags(report: CapabilityReport): Record<string, string> {
    return {
        engine: report.browser.engine,
        os: report.browser.os,
        browser: report.browser.name || "unknown",
        mobile: String(report.browser.isMobile),
    };
}

const GATE_ID = "capability-gate";
// localStorage flag so the proactive degraded notice does not nag every session.
// Keyed by the gap set: if the set changes (e.g. the user updated and only the
// map gap remains) the notice fires again for the new situation.
const DEGRADED_DISMISS_KEY = "everydashcam:caps-degraded-ack";

/**
 * Detects capabilities and - if a fatal gap exists - renders a blocking gate
 * over the whole app. Returns true when the app must NOT continue normal init
 * (fatal gap). Call EARLY in app.ts: after the i18n bootstrap, before any heavy
 * init.
 */
export function initCapabilityGate(): boolean {
    const report = detectCapabilities();

    // Crash-reporting enrichment: attach the capability signature as global
    // tags/context so it rides on ANY future event (a real crash, the blocking
    // message below). Zero PII - browser facts only. Set once per session;
    // no-op unless crash reporting is built in.
    setSentryTags(capabilityTags(report));
    setSentryContext("capabilities", {
        signature: capabilitySignature(report),
        blocking: report.blocking.join(",") || "none",
        degraded: report.degraded.join(",") || "none",
        ok: report.ok,
    });

    if (report.blocking.length > 0) {
        showBlockingGate(report);
        // Release-health: which exact fatal API combo fails in the wild. A
        // message, not an exception (nothing threw). Fingerprint by the sorted
        // blocking set so all users hitting the same gap collapse into one issue.
        captureSentryMessage("browser capability blocked", {
            level: "error",
            fingerprint: ["capability_blocked", report.blocking.slice().sort().join(",")],
            tags: capabilityTags(report),
            extra: { blocking: report.blocking, signature: capabilitySignature(report) },
        });
        return true;
    }
    return false;
}

// --- blocking gate ----------------------------------------------------------

function showBlockingGate(report: CapabilityReport): void {
    if (typeof document === "undefined") return;
    if (document.getElementById(GATE_ID)) return; // idempotent

    const gate = document.createElement("div");
    gate.id = GATE_ID;
    gate.className = "capability-gate";
    gate.setAttribute("role", "alertdialog");
    gate.setAttribute("aria-modal", "true");
    gate.setAttribute("aria-labelledby", "capability-gate-title");
    gate.tabIndex = -1;
    renderGate(gate, report);
    document.body.appendChild(gate);

    // Lock background scroll and dismiss the splash loader so the gate is the
    // only thing visible. The gate fires dc:ready itself; app.ts's own later rAF
    // dc:ready is a harmless no-op (the splash listener is registered {once:true}).
    document.body.style.overflow = "hidden";
    dispatchEvent(new Event("dc:ready"));
    gate.focus();

    log.warn("blocking gate shown", { blocking: report.blocking });
}

function renderGate(gate: HTMLElement, report: CapabilityReport): void {
    const browserName = report.browser.name;
    const missing = report.blocking.join(", ");
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

    gate.innerHTML = `
        <div class="capability-gate-card">
            <svg class="capability-gate-icon" width="40" height="40" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <path d="M12 9v4"/><path d="M12 17h.01"/>
            </svg>
            <h1 id="capability-gate-title" class="capability-gate-title">${escapeHtml(t("caps.gate.title"))}</h1>
            <p class="capability-gate-body">${escapeHtml(t("caps.gate.body"))}</p>
            <p class="capability-gate-advice">${escapeHtml(
                t("caps.gate.advice", { known: browserName ? "yes" : "no", browser: browserName }),
            )}</p>
            <details class="capability-gate-details">
                <summary>${escapeHtml(t("caps.gate.detailsSummary"))}</summary>
                <pre class="capability-gate-tech">missing: ${escapeHtml(missing)}\n${escapeHtml(ua)}</pre>
            </details>
        </div>
    `;
}

// --- proactive degraded notice ----------------------------------------------

/**
 * Surfaces a concise, proactive notice for user-visible degraded gaps that are
 * relevant at startup: no editor+export, no H.264 decode. Reuses the
 * notifications system (toast + persistent bell entry). Fires at most once per
 * gap-set across sessions. Call AFTER initNotifications(), only when
 * initCapabilityGate() returned false. Safe no-op when nothing relevant is
 * missing. NOTE: the map (webgl) gap is deliberately NOT handled here - it is
 * surfaced lazily by surfaceMapUnavailable() the first time the map actually
 * fails to init (when the viewer opens), not over the bare landing.
 */
export function surfaceDegradedCapabilities(): void {
    const report = detectCapabilities();
    const headline = headlineDegradations(report);
    if (headline.length === 0) return;

    // Decode / editor: one concise toast, once per gap-set across sessions.
    // Decode and the editor are mutually prioritized (a browser missing H.264
    // decode can't watch at all, so that message wins over the editor one). The
    // map gap is excluded - it surfaces lazily on first map failure, not here.
    const toastGaps = headline.filter((id) => id !== "webgl");
    if (toastGaps.length === 0) return;
    // WebCodecs is secure-context-only, so on a plain-http origin (a self-hosted
    // LAN setup - see docs/self-hosting.md) the editor gap is an http problem,
    // not a browser-version problem. "Update your browser" would be a lie there;
    // point at HTTPS/localhost instead.
    const insecureOrigin = report.degraded.includes("secureContext");
    // secureContext participates in the ack key so the http-caused variant and a
    // genuinely-outdated-browser variant do not dismiss each other.
    const ackGaps: string[] = insecureOrigin ? [...toastGaps, "secureContext"] : [...toastGaps];
    const setKey = ackGaps.sort().join(",");
    if (alreadyAcked(setKey)) return;

    const fired: CapabilityId[] = [];
    if (toastGaps.includes("h264Decode")) {
        notify({ severity: "warn", messageKey: "caps.notice.decode" });
        fired.push("h264Decode");
    } else if (toastGaps.includes("webCodecsDecode") || toastGaps.includes("webCodecsEncode")) {
        notify({
            severity: "warn",
            messageKey: insecureOrigin ? "caps.notice.insecureContext" : "caps.notice.editor",
        });
        // Record the capability ids actually missing, not a hard-coded
        // "webCodecsDecode": an encode-only gap must stay identifiable in logs.
        for (const id of ["webCodecsDecode", "webCodecsEncode"] as const) {
            if (toastGaps.includes(id)) fired.push(id);
        }
        // Keep an http-origin gap distinguishable from an outdated browser.
        if (insecureOrigin) fired.push("secureContext");
    }

    if (fired.length === 0) return;
    ackDismiss(setKey);
    // Expected browser limitations stay in capability context and breadcrumbs;
    // only a blocking gate or an actual failed operation creates an issue.
    log.info("degraded notice shown", { shown: fired });
}

// Auto-surface (modal or quiet toast) for the map gap fires once per browser
// session (sessionStorage, not localStorage): it should remind again in a fresh
// session, just not nag on every reload within one. The in-panel re-entry link is
// revealed every time instead, so the help is never lost.
const WEBGL_SURFACE_KEY = "everydashcam:webgl-surfaced";

// Run the surface logic at most once per page load (the trigger fires on every
// trip-open; the in-panel reveal persists, so re-running on later opens is just
// wasted work). The modal's own once-per-session gate is sessionStorage above.
let mapGapSurfacedThisLoad = false;

/**
 * Surfaces a missing map, matching the advice to what the user can actually do on
 * their platform (we never point at a setting that does not exist there):
 *   - mobile -> a short notice (no hardware-acceleration toggle on a phone);
 *   - desktop + recoverable -> the WebGL walkthrough modal, with a confident
 *     intro when we proved the GPU is alive and a hedged one otherwise;
 *   - desktop + unrecognized browser -> a "try a mainstream browser" notice.
 * Reveals the in-panel re-entry link whenever a desktop-recoverable gap is seen;
 * opens the proactive surface once per browser session. Called the first time the
 * map fails to init (from trip-ui-init, when the viewer opens) - NOT at startup,
 * so it never pops over the bare landing. Async because the verdict cross-checks a
 * WebGPU adapter (see classifyWebglRecovery). Never rejects.
 */
export async function surfaceMapUnavailable(): Promise<void> {
    if (mapGapSurfacedThisLoad) return;
    mapGapSurfacedThisLoad = true;
    try {
        const report = detectCapabilities();
        let verdict: WebglRecoveryVerdict;
        try {
            verdict = await classifyWebglRecovery();
        } catch {
            verdict = { recoverable: false, reason: "absent", renderer: null };
        }
        log.info("map gap classified", {
            recoverable: verdict.recoverable,
            reason: verdict.reason,
            renderer: verdict.renderer,
        });

        // Mobile is a hard pre-empt: the desktop "turn on hardware acceleration"
        // steps don't exist on a phone/tablet, so never show the modal there - just
        // a short notice. (A mobile with a software renderer still classifies
        // recoverable, hence the explicit isMobile guard rather than the verdict.)
        const mobile = report.browser.isMobile;
        // We only ASSERT the cause ("it's switched off") when a signal proved the
        // GPU is alive; the desktop heuristic is a guess, so it gets the hedged intro.
        const confident = verdict.reason === "softwareRendering" || verdict.reason === "gpuAlive";

        // Reveal the in-panel "turn the map on" link every session a desktop
        // recoverable gap is seen, so it is present whenever the map panel shows its
        // notice - even after the one-time modal was acked. Hidden until map fails.
        if (verdict.recoverable && !mobile) {
            setMapEnableConfidence(confident);
            setMapEnableReason(verdict.reason);
            revealMapEnableLink();
        }

        // The proactive surface (modal / toast) is shown once across sessions.
        if (webglSurfaced()) return;
        markWebglSurfaced();
        if (mobile) {
            notify({ severity: "warn", messageKey: "map.unavailable.mobile" });
        } else if (verdict.recoverable) {
            openWebglEnableModal("auto");
        } else {
            // Desktop but the browser is unrecognized: the real fix is switching to
            // a mainstream one, not toggling a setting we cannot point at.
            notify({ severity: "warn", messageKey: "map.unavailable.tryBrowser" });
        }
    } catch (err) {
        // "Never rejects" contract: the only caller is a fire-and-forget
        // `void surfaceMapUnavailable()` (app.ts onPlayFrame). A throw in the
        // notify / modal tail would otherwise surface as an unhandled
        // rejection - Sentry noise in prod, and a teardown failure in the fail-loud
        // e2e suite. Log and swallow.
        log.warn("map-gap surfacing failed", { err: err instanceof Error ? err.message : String(err) });
    }
}

function webglSurfaced(): boolean {
    try {
        // sessionStorage: once per browser session/tab, re-reminds in a fresh one.
        return sessionStorage.getItem(WEBGL_SURFACE_KEY) === "1";
    } catch {
        return false; // storage blocked (private mode) - surface again
    }
}

function markWebglSurfaced(): void {
    try {
        sessionStorage.setItem(WEBGL_SURFACE_KEY, "1");
    } catch {
        // Not persistable (private mode) - it will simply surface again.
    }
}

function alreadyAcked(setKey: string): boolean {
    try {
        return localStorage.getItem(DEGRADED_DISMISS_KEY) === setKey;
    } catch {
        return false; // localStorage blocked (private mode) - show it this session
    }
}

function ackDismiss(setKey: string): void {
    try {
        localStorage.setItem(DEGRADED_DISMISS_KEY, setKey);
    } catch {
        // Not persistable (private mode) - it will simply show again next session.
    }
}
