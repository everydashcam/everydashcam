// Crash reporting via Sentry (errors-only). Single source of truth - no direct
// Sentry.* calls outside this module.
//
// Why this exists: the only diagnostic channel used to be the local ring buffer
// downloaded by hand (near-zero conversion - the silent "it didn't open my
// video" majority never reports). Sentry turns that into automatic crash +
// capability-gap signal. The single strongest reason is release-health by
// browser/os/version under the capability gate (which API combo actually fails
// in the wild), so page sessions (Release Health) are kept on.
//
// Hard constraints honored here:
//  - Privacy first. The project sells "video never leaves your machine"; the
//    ring buffer logs file names / paths UNSCRUBBED by design (it is local).
//    Sentry is the one network sink, so curated events are allowlist-built and
//    everything is run through sentry-scrub.ts before send (beforeSend /
//    beforeBreadcrumb). No coordinates, no file basenames, no user free text,
//    no video - ever.
//  - Reports are enabled by default and can be disabled in settings.
//    The toggle lives in settings (see settings-modal.ts).
//  - Build-time gate. Empty VITE_SENTRY_DSN => the SDK is never imported (the
//    dynamic import is behind the DSN check), so self-hosted forks and dev/CI
//    builds are completely clean - no chunk, no network.
//  - Lazy import. @sentry/browser (~30 KB gz) is dynamically imported so the
//    SEO-critical landing entry stays lean and an empty DSN tree-shakes it out.
//
// Errors-only: no tracing, no replay, no feedback, no profiling integrations
// (also stripped at build via __SENTRY_TRACING__/__SENTRY_DEBUG__ defines).
// breadcrumbsIntegration is deliberately OMITTED so there are NO automatic
// console/dom/fetch/xhr breadcrumbs (console would scoop the unscrubbed logger
// PII; fetch would leak map-tile + blob URLs). Manual breadcrumbs from the
// central logger still flow (addBreadcrumb is core, not the integration).

import { createLogger, type LogSinkEntry, setLogSink } from "./log.js";
import type { SentryClient } from "./sentry-init.js";
import { scrubBreadcrumb, scrubEvent, scrubMessage, scrubValue } from "./sentry-scrub.js";
import { APP_VERSION } from "./version.js";

const log = createLogger("sentry");

// Sentry SeverityLevel, kept local so this module needs only a type-import of
// the SDK (the runtime is dynamically imported).
type BreadcrumbLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";

export type SentryEnvironment = "local" | "staging" | "production";
export type DeploymentOriginTag = "primary" | "mirror";

declare const __DEPLOYMENT_PROFILE__: DeploymentOriginTag | undefined;

export function resolveOriginTag(): DeploymentOriginTag {
    return typeof __DEPLOYMENT_PROFILE__ !== "undefined" && __DEPLOYMENT_PROFILE__ === "mirror" ? "mirror" : "primary";
}

// Wiped by resetAllAppState() via localStorage.clear() (see ui/reset.ts).
export const CRASH_REPORTING_STORAGE_KEY = "everydashcam:crash-reporting";

// Per-session hard cap on events sent, so one bad deploy in a loop cannot burn
// the 5k/month free quota in minutes. Server-side Spike Protection is the real
// backstop (cross-session); this is the deterministic client guard. Dedupe
// (integration) collapses back-to-back identical errors before this counts.
const SESSION_EVENT_CAP = 50;

// Loaded SDK function surface (see sentry-init.ts), or null until the dynamic
// import resolves / after a runtime opt-out. All public helpers no-op while null.
let sentryApi: SentryClient | null = null;
let loading = false;
let sentThisSession = 0;
let runtimeEnabled: boolean | null = null;
let consentWindow: Window | null = null;

// Captures requested before the SDK finished loading (the capability gate fires
// very early, possibly before import() resolves). Replayed on init, capped so a
// stuck import cannot grow it without bound.
type PendingCapture =
    | { kind: "message"; message: string; ctx: CaptureContext }
    | { kind: "exception"; error: unknown; ctx: CaptureContext };
const PENDING_CAP = 30;
const pending: PendingCapture[] = [];

// Tags / contexts requested before load (e.g. the capability signature) -
// applied once the SDK is ready and then carried on every event.
let pendingTags: Record<string, string> | null = null;
const pendingContexts = new Map<string, Record<string, unknown>>();

/** Build-time DSN. Empty => crash reporting is not built into this bundle. */
export function getSentryDsn(): string {
    return (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "";
}

/** True when a DSN was baked in at build time. Gates the SDK import and the UI toggle. */
export function isCrashReportingBuilt(): boolean {
    return getSentryDsn() !== "";
}

/** Effective preference, checked synchronously before collecting any telemetry. */
export function crashReportingEnabled(): boolean {
    if (!isCrashReportingBuilt()) return false;
    if (runtimeEnabled !== null) return runtimeEnabled;
    try {
        return localStorage.getItem(CRASH_REPORTING_STORAGE_KEY) !== "off";
    } catch {
        return true;
    }
}

/**
 * Classifies the runtime environment from the hostname. Mirrors the [data-env]
 * tint in app.ts (single source of truth - app.ts imports this). Used as the
 * Sentry `environment` tag; beta and prod also route to separate Sentry
 * projects via their own VITE_SENTRY_DSN, so this is mostly for *.pages.dev
 * preview deploys landing in the beta project.
 */
export function resolveEnvironment(
    host: string,
    deploymentProfile: DeploymentOriginTag = resolveOriginTag(),
): SentryEnvironment {
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || /^192\.168\./.test(host)) return "local";
    if (
        host === "dashcamigo.app" ||
        host === "www.dashcamigo.app" ||
        host === "everydashcam.app" ||
        host === "www.everydashcam.app" ||
        host === "ru.everydashcam.app"
    )
        return "production";
    if (host === "beta.everydashcam.app") return "staging";
    if (deploymentProfile === "mirror") return "production";
    return "staging";
}

function persistEnabled(on: boolean): boolean {
    try {
        localStorage.setItem(CRASH_REPORTING_STORAGE_KEY, on ? "on" : "off");
        return true;
    } catch (err) {
        log.warn("could not persist crash-reporting choice", err);
        return false;
    }
}

function listenForConsentChanges(): void {
    if (consentWindow || !isCrashReportingBuilt() || typeof window === "undefined") return;
    consentWindow = window;
    consentWindow.addEventListener("storage", onConsentStorageChange);
}

function onConsentStorageChange(event: StorageEvent): void {
    if (event.key !== null && event.key !== CRASH_REPORTING_STORAGE_KEY) return;
    try {
        if (event.storageArea !== localStorage) return;
    } catch {
        return;
    }
    // Read the current value: a queued event may precede a newer choice.
    runtimeEnabled = null;
    syncClientWithConsent();
}

/**
 * Kicks off crash reporting. Idempotent and safe to call early - it dynamically
 * imports the SDK only when a DSN is built and the user has not opted out. Any
 * import / init failure is swallowed (the app must not depend on Sentry).
 */
export function initSentry(): void {
    listenForConsentChanges();
    void loadAndInit();
}

async function loadAndInit(): Promise<void> {
    if (sentryApi || loading) return;
    if (!isCrashReportingBuilt() || !crashReportingEnabled()) return;
    if (typeof window === "undefined") return;
    // Build-time dead-code elimination: when VITE_SENTRY_DSN is UNSET, Vite
    // folds this to `if (!undefined)` and Rollup drops the import() + the entire
    // @sentry chunk - a self-hosted fork that omits the var ships zero Sentry
    // bytes. An explicit empty value is folded away too.
    if (!import.meta.env.VITE_SENTRY_DSN) return;
    loading = true;
    try {
        // Dynamic import of the static-import island (sentry-init.ts) - this is
        // what keeps the @sentry chunk tree-shaken to errors-only. See that file.
        const { initSentryClient } = await import("./sentry-init.js");
        // The dynamic import is an async window during which the user may have
        // opted out via the settings toggle (setCrashReportingEnabled(false)
        // ran, but sentryApi was still null so its teardown was a no-op).
        // Re-check before arming the client - otherwise a toggle flipped
        // mid-load is silently ignored and the SDK comes up despite opt-out.
        if (!crashReportingEnabled()) return;
        const environment = resolveEnvironment(window.location.hostname);
        sentryApi = initSentryClient({
            dsn: getSentryDsn(),
            release: APP_VERSION,
            environment,
            isEnabled: crashReportingEnabled,
            beforeSend: (event) => {
                if (!crashReportingEnabled()) return null;
                if (event.exception?.values?.some((exception) => exception.type === "AbortError")) return null;
                if (sentThisSession >= SESSION_EVENT_CAP) return null;
                sentThisSession++;
                // scrubEvent mutates in place; the Sentry event type is a
                // structural superset of our local ScrubbableEvent shape.
                scrubEvent(event as unknown as Parameters<typeof scrubEvent>[0]);
                return event;
            },
            beforeBreadcrumb: (breadcrumb) => {
                if (!crashReportingEnabled()) return null;
                scrubBreadcrumb(breadcrumb as unknown as Parameters<typeof scrubBreadcrumb>[0]);
                return breadcrumb;
            },
        });

        sentryApi.setTag("origin", resolveOriginTag());

        // Apply any tags/contexts requested before load.
        if (pendingTags) {
            for (const [k, v] of Object.entries(pendingTags)) sentryApi.setTag(k, v);
            pendingTags = null;
        }
        for (const [name, context] of pendingContexts) sentryApi.setContext(name, context);
        pendingContexts.clear();

        // Forward the central logger into Sentry as breadcrumbs (scrubbed in
        // beforeBreadcrumb). No events from here - uncaught/rejection events
        // come from globalHandlersIntegration, curated events from
        // captureSentry*. This avoids double-counting uncaught errors.
        setLogSink(forwardLogToSentry);

        // Replay captures requested during the async window.
        for (const p of pending) {
            if (p.kind === "message") sendMessage(p.message, p.ctx);
            else sendException(p.error, p.ctx);
        }
        pending.length = 0;

        log.debug("crash reporting initialized", { environment });
    } catch (err) {
        log.warn("crash reporting init failed", err);
    } finally {
        loading = false;
    }
}

/**
 * Enable/disable crash reporting at runtime (the settings toggle). Persists the
 * choice and either spins up the SDK or tears it down. A session-local choice
 * still takes effect when browser storage is blocked.
 */
export function setCrashReportingEnabled(on: boolean): void {
    listenForConsentChanges();
    runtimeEnabled = on;
    // A session override is needed only when storage rejected the choice.
    // Otherwise later choices from another tab must remain authoritative.
    if (persistEnabled(on)) runtimeEnabled = null;
    syncClientWithConsent();
}

function syncClientWithConsent(): void {
    if (crashReportingEnabled()) {
        void loadAndInit();
    } else {
        // Stop forwarding logs, drop the pre-load queue (incl. tags/contexts
        // requested before load), and immediately stop the client's transport.
        setLogSink(null);
        pending.length = 0;
        pendingTags = null;
        pendingContexts.clear();
        if (sentryApi) {
            try {
                void sentryApi.close().catch((err: unknown) => log.warn("crash reporting shutdown failed", err));
            } catch (err) {
                log.warn("crash reporting shutdown failed", err);
            }
            sentryApi = null;
        }
    }
}

export interface CaptureContext {
    level?: BreadcrumbLevel;
    // Stable grouping key (e.g. [extractor.id, err.name]) - must contain NO PII.
    fingerprint?: string[];
    // Low-cardinality, allowlisted strings (codec, reason, stage, engine...).
    tags?: Record<string, string>;
    // Allowlisted structured context. Scrubbed again before send.
    extra?: Record<string, unknown>;
}

/**
 * Curated message capture (a deliberate, non-exception signal: capability gap,
 * "nothing loaded", a format that failed to parse). No-op unless built and
 * enabled. Caller passes allowlisted tags/extra; we scrub as a second line.
 */
export function captureSentryMessage(message: string, ctx: CaptureContext = {}): void {
    if (!crashReportingEnabled()) return;
    if (sentryApi) sendMessage(message, ctx);
    else queue({ kind: "message", message, ctx });
}

/**
 * Curated exception capture (a real thrown failure with a stack). No-op unless
 * built and enabled. User cancellation is never an error report.
 */
export function captureSentryException(error: unknown, ctx: CaptureContext = {}): void {
    if (!crashReportingEnabled()) return;
    if (error instanceof Error && error.name === "AbortError") return;
    if (sentryApi) sendException(error, ctx);
    else queue({ kind: "exception", error, ctx });
}

function queue(p: PendingCapture): void {
    if (pending.length >= PENDING_CAP) pending.shift();
    pending.push(p);
}

function sendMessage(message: string, ctx: CaptureContext): void {
    if (!sentryApi) return;
    try {
        sentryApi.captureMessage(scrubMessage(message), {
            level: ctx.level ?? "warning",
            fingerprint: ctx.fingerprint,
            tags: ctx.tags,
            extra: ctx.extra ? (scrubValue(ctx.extra) as Record<string, unknown>) : undefined,
        });
    } catch (err) {
        log.warn("captureMessage failed", err);
    }
}

function sendException(error: unknown, ctx: CaptureContext): void {
    if (!sentryApi) return;
    try {
        sentryApi.captureException(error, {
            level: ctx.level,
            fingerprint: ctx.fingerprint,
            tags: ctx.tags,
            extra: ctx.extra ? (scrubValue(ctx.extra) as Record<string, unknown>) : undefined,
        });
    } catch (err) {
        log.warn("captureException failed", err);
    }
}

/**
 * Sets low-cardinality global tags carried on every subsequent event (e.g. the
 * browser engine/os and capability signature). Queued until the SDK loads.
 */
export function setSentryTags(tags: Record<string, string>): void {
    if (!crashReportingEnabled()) return;
    if (sentryApi) {
        for (const [k, v] of Object.entries(tags)) sentryApi.setTag(k, v);
    } else {
        pendingTags = { ...(pendingTags ?? {}), ...tags };
    }
}

/**
 * Sets a named structured context (e.g. "capabilities") carried on every
 * subsequent event. Queued until the SDK loads. Scrubbed defensively.
 */
export function setSentryContext(name: string, context: Record<string, unknown>): void {
    if (!crashReportingEnabled()) return;
    const safe = scrubValue(context) as Record<string, unknown>;
    if (sentryApi) sentryApi.setContext(name, safe);
    else pendingContexts.set(name, safe);
}

// Breadcrumb sink wired into the central logger. Message + data are scrubbed in
// beforeBreadcrumb (one scrub point). Never throws into the logger.
function forwardLogToSentry(entry: LogSinkEntry): void {
    if (!sentryApi || !crashReportingEnabled()) return;
    const level: BreadcrumbLevel = entry.level === "warn" ? "warning" : entry.level;
    const data: Record<string, unknown> = {};
    // Annotation storage/restore errors can quote arbitrary note text. Their
    // messages are static; retain that trail while keeping payloads local.
    const isNotesLog = /^(?:annotations(?:-sidecar)?|notes-storage-choice|migration-restore)(?::|$)/.test(entry.ns);
    if (entry.ctx && !isNotesLog) Object.assign(data, entry.ctx);
    // Unknown extensions are arbitrary filename suffixes, including user text.
    delete data.byExtension;
    if (entry.err && !isNotesLog) {
        // Key deliberately does NOT contain "name": the scrubber's
        // FILENAME_KEY_RE masks any *name* key's value to "***" (per its own
        // contract: rename the key, never loosen the regex).
        data.errKind = entry.err.name;
        data.errorMessage = entry.err.message;
    }
    if (entry.scope) data.scope = entry.scope;
    try {
        sentryApi.addBreadcrumb({
            category: entry.ns,
            level,
            message: entry.msg,
            data: Object.keys(data).length > 0 ? data : undefined,
        });
    } catch {
        // Never let breadcrumb forwarding break a log call.
    }
}

// Test-only reset. Never called in production.
export function _resetForTests(): void {
    consentWindow?.removeEventListener("storage", onConsentStorageChange);
    consentWindow = null;
    if (sentryApi) void sentryApi.close().catch(() => {});
    sentryApi = null;
    loading = false;
    sentThisSession = 0;
    runtimeEnabled = null;
    pending.length = 0;
    pendingTags = null;
    pendingContexts.clear();
    setLogSink(null);
}
