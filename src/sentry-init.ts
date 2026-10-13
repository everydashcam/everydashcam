// Static-import island for @sentry/browser, loaded via dynamic import() from
// sentry.ts. This indirection is what makes the errors-only build small.
//
// A dynamically-imported module is an async CHUNK ENTRY, and Rollup keeps ALL
// of an entry's exports (a runtime import() could read any of them). So
// `import("@sentry/browser")` directly ships the FULL SDK - replay + tracing +
// feedback, ~130 KB gz - no matter which exports you destructure. By making
// THIS module the dynamic entry and importing only the named exports we use
// STATICALLY from @sentry/browser, those imports are statically analyzable and
// Rollup tree-shakes the unused integrations away (~30 KB gz, errors-only).
//
// Keep this module a thin shim: no scrubbing logic lives here (that stays in
// sentry-scrub.ts, unit-tested in node). beforeSend/beforeBreadcrumb are passed
// in as callbacks so the SDK-touching surface is minimal.

import {
    addBreadcrumb,
    browserApiErrorsIntegration,
    browserSessionIntegration,
    captureException,
    captureMessage,
    dedupeIntegration,
    functionToStringIntegration,
    globalHandlersIntegration,
    httpContextIntegration,
    inboundFiltersIntegration,
    init,
    linkedErrorsIntegration,
    setContext,
    setTag,
} from "@sentry/browser";
import type { Breadcrumb, ErrorEvent } from "@sentry/browser";

export interface SentryClientOptions {
    dsn: string;
    release: string;
    environment: string;
    beforeSend: (event: ErrorEvent) => ErrorEvent | null;
    beforeBreadcrumb: (breadcrumb: Breadcrumb) => Breadcrumb | null;
}

// The exact SDK surface sentry.ts calls after init.
export interface SentryClient {
    captureException: typeof captureException;
    captureMessage: typeof captureMessage;
    addBreadcrumb: typeof addBreadcrumb;
    setTag: typeof setTag;
    setContext: typeof setContext;
    close: () => Promise<boolean>;
}

/**
 * Initializes the Sentry browser SDK with the project's errors-only config and
 * returns the function surface sentry.ts uses. Called exactly once, from inside
 * the dynamic import in sentry.ts.
 *
 * Errors-only: explicit integration list (defaultIntegrations:false), NO
 * breadcrumbs integration (no automatic console/dom/fetch/xhr crumbs), no
 * tracing, no replay, no feedback, no profiling. sendDefaultPii:false. Noise
 * filters mirror app.ts's ring-buffer isNoise.
 */
export function initSentryClient(opts: SentryClientOptions): SentryClient {
    const requests = new AbortController();
    const client = init({
        dsn: opts.dsn,
        release: opts.release,
        environment: opts.environment,
        // TODO: migrate this privacy policy to explicit dataCollection settings
        // before upgrading to SDK 11, which removes sendDefaultPii.
        sendDefaultPii: false,
        transportOptions: { fetchOptions: { signal: requests.signal } },
        defaultIntegrations: false,
        integrations: [
            globalHandlersIntegration(),
            browserApiErrorsIntegration(),
            inboundFiltersIntegration(),
            functionToStringIntegration(),
            linkedErrorsIntegration(),
            dedupeIntegration(),
            httpContextIntegration(),
            // Release Health (crash-free sessions by browser/os/version) - the
            // strongest reason to run Sentry here. Separate quota from errors.
            browserSessionIntegration(),
        ],
        ignoreErrors: [
            /^ResizeObserver loop/,
            /__chromium_devtools_/,
            /__lighthouse_/,
            // MapLibre shader/link failures with an EMPTY driver log are a lost
            // WebGL context caught mid-compile (GPU process crash/reset), thrown
            // unhandled from MapLibre's own rAF - its isContextLost() guard runs
            // only before compileShader (webgl/program.ts), so it stays racy.
            // A real driver failure carries a non-empty info log and still gets
            // through. The episode itself stays observable via the curated
            // "map webgl context lost/restored" messages (src/ui/map.ts).
            /^Could not compile (fragment|vertex) shader: (null)?$/,
            /^Program failed to link: (null)?$/,
        ],
        denyUrls: [/chrome-extension:\/\//, /moz-extension:\/\//, /safari-extension:\/\//, /^extensions\//],
        beforeSend: opts.beforeSend,
        beforeBreadcrumb: opts.beforeBreadcrumb,
    });
    return {
        captureException,
        captureMessage,
        addBreadcrumb,
        setTag,
        setContext,
        close: async () => {
            // SDK close() flushes before disabling. Revoke consent before that
            // async window, and abort requests already handed to the transport.
            if (client) client.getOptions().enabled = false;
            requests.abort();
            return client?.close() ?? true;
        },
    };
}
