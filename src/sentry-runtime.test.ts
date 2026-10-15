// Exercise the real SDK with an intercepted fetch boundary. No event leaves
// the process, including automatic client reports and session envelopes.
import { captureSession, getClient, getIsolationScope, startSession } from "@sentry/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, getLogBuffer } from "./log.js";
import {
    CRASH_REPORTING_STORAGE_KEY,
    _resetForTests,
    captureSentryException,
    captureSentryMessage,
    crashReportingEnabled,
    initSentry,
    setCrashReportingEnabled,
    setSentryContext,
    setSentryTags,
} from "./sentry.js";

interface RequestRecord {
    body: string;
    signal: AbortSignal | null | undefined;
}

let requests: RequestRecord[] = [];
let shouldHoldRequests = false;
let storedChoices: Map<string, string>;
let browserWindow: EventTarget;

function sendStorageEvent(key: string | null = CRASH_REPORTING_STORAGE_KEY): void {
    browserWindow.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea: localStorage }));
}

async function interceptedFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    requests.push({ body: String(init?.body), signal: init?.signal });
    if (shouldHoldRequests) {
        await new Promise<void>((_resolve, reject) => {
            if (init?.signal?.aborted) reject(init.signal.reason);
            else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
    }
    return new Response("{}", { status: 200 });
}

beforeEach(() => {
    _resetForTests();
    requests = [];
    shouldHoldRequests = false;
    vi.stubGlobal("fetch", interceptedFetch);
    browserWindow = Object.assign(new EventTarget(), { location: { hostname: "everydashcam.app" } });
    vi.stubGlobal("window", browserWindow);
    storedChoices = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => storedChoices.get(key) ?? null,
        setItem: (key: string, value: string) => storedChoices.set(key, value),
    });
    vi.stubEnv("VITE_SENTRY_DSN", "https://deadbeef@o4511528520843264.ingest.de.sentry.io/9998887");
});

afterEach(async () => {
    setCrashReportingEnabled(false);
    await vi.dynamicImportSettled();
    await getClient()?.flush(1000);
    _resetForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("crash reporting consent lifecycle", () => {
    it("starts a fresh page session after opt-in and counts exceptions without treating messages as errors", async () => {
        vi.stubGlobal("document", {});
        getIsolationScope().setUser({ id: "private-user", email: "private@example.com", ip_address: "192.0.2.1" });
        initSentry();
        await vi.dynamicImportSettled();
        await getClient()?.flush(1000);
        const sessions = () =>
            requests
                .filter((request) => request.body.includes('"type":"session"'))
                .map((request) => {
                    const session: { sid: string; init: boolean; errors: number; status: string } = JSON.parse(
                        request.body.split("\n")[2]!,
                    );
                    return session;
                });
        expect(sessions()).toHaveLength(1);
        const first = sessions()[0]!;
        expect(first).toMatchObject({ init: true, errors: 0, status: "ok" });

        captureSentryMessage("capability warning", { level: "warning" });
        await getClient()?.flush(1000);
        expect(sessions()).toHaveLength(2);
        expect(sessions()[1]).toMatchObject({ sid: first.sid, errors: 0, status: "ok" });
        captureSentryException(new Error("handled processing failure"));
        await getClient()?.flush(1000);
        expect(sessions()).toHaveLength(3);
        expect(sessions()[2]).toMatchObject({ sid: first.sid, init: false, errors: 1 });

        setCrashReportingEnabled(false);
        expect(getIsolationScope().getSession()).toBeUndefined();
        expect(getIsolationScope().getUser()).toEqual({});
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        await getClient()?.flush(1000);
        expect(sessions()).toHaveLength(4);
        expect(sessions()[3]).toMatchObject({ init: true, errors: 0, status: "ok" });
        expect(sessions()[3]!.sid).not.toBe(first.sid);
        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).not.toContain("private-user");
        expect(payload).not.toContain("private@example.com");
        expect(payload).not.toContain("192.0.2.1");
    });

    it("blocks session envelopes as soon as persisted consent is withdrawn", async () => {
        initSentry();
        await vi.dynamicImportSettled();
        startSession({ ignoreDuration: true });
        captureSession();
        await getClient()?.flush(1000);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.body).toContain('"type":"session"');

        storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "off");
        // The storage event can be queued behind a session update.
        captureSession();
        await getClient()?.flush(1000);
        expect(requests).toHaveLength(1);
    });

    it("forgets active breadcrumbs, tags and contexts across opt-out", async () => {
        initSentry();
        await vi.dynamicImportSettled();
        setSentryTags({ phase: "old-enabled-tag" });
        setSentryContext("phase", { state: "old-enabled-context" });
        createLogger("sentry-test").info("old-enabled-breadcrumb");
        setCrashReportingEnabled(false);
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        captureSentryMessage("new report after opt-in");
        await getClient()?.flush(1000);
        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).toContain("new report after opt-in");
        expect(payload).not.toContain("old-enabled");
        expect(getIsolationScope().getScopeData().contexts.phase).toBeUndefined();
    });

    it("stops the active transport after another tab opts out", async () => {
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        const client = getClient();
        shouldHoldRequests = true;
        captureSentryMessage("in flight before cross-tab opt-out");
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        const signal = requests[0]?.signal;
        expect(signal?.aborted).toBe(false);

        storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "off");
        expect(crashReportingEnabled()).toBe(false);
        sendStorageEvent();
        expect(signal?.aborted).toBe(true);
        expect(client?.getOptions().enabled).toBe(false);
        client?.captureException(new Error("uncaught after cross-tab opt-out"));
        captureSentryMessage("message after cross-tab opt-out");
        await client?.flush(1000);
        expect(requests).toHaveLength(1);

        shouldHoldRequests = false;
        storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "on");
        sendStorageEvent();
        await vi.dynamicImportSettled();
        captureSentryMessage("message after cross-tab opt-in");
        expect(await getClient()?.flush(1000)).toBe(true);
        expect(requests).toHaveLength(2);
        expect(requests[1]?.body).toContain("message after cross-tab opt-in");
    });

    it("discards pending captures when another tab withdraws consent during SDK load", async () => {
        setCrashReportingEnabled(true);
        captureSentryMessage("pending before cross-tab opt-out");
        storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "off");
        sendStorageEvent();
        await vi.dynamicImportSettled();
        expect(requests).toHaveLength(0);

        storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "on");
        sendStorageEvent();
        await vi.dynamicImportSettled();
        captureSentryMessage("fresh message after cross-tab opt-in");
        expect(await getClient()?.flush(1000)).toBe(true);
        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).toContain("fresh message after cross-tab opt-in");
        expect(payload).not.toContain("pending before cross-tab opt-out");
    });

    it.each(["everydashcam.app", "beta.everydashcam.app", "ru.everydashcam.app", "deploy-preview.pages.dev"])(
        "sends startup errors without a saved preference on %s",
        async (hostname) => {
            Object.assign(browserWindow, { location: { hostname } });
            initSentry();
            captureSentryException(new Error("startup error before SDK load"));
            setSentryTags({ startup: "startup-tag" });
            await vi.dynamicImportSettled();
            expect(await getClient()?.flush(1000)).toBe(true);
            const payload = requests.map((request) => request.body).join("\n");
            expect(payload).toContain("startup error before SDK load");
            expect(payload).toContain("startup-tag");
            expect(storedChoices.has(CRASH_REPORTING_STORAGE_KEY)).toBe(false);
        },
    );

    it("restores default reporting when another tab clears the saved opt-out", async () => {
        storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "off");
        initSentry();
        await vi.dynamicImportSettled();
        expect(requests).toHaveLength(0);
        storedChoices.clear();
        sendStorageEvent(null);
        await vi.dynamicImportSettled();
        captureSentryMessage("report after settings reset");
        expect(await getClient()?.flush(1000)).toBe(true);
        expect(requests.map((request) => request.body).join("\n")).toContain("report after settings reset");
    });

    it.each(["everydashcam.app", "self-host.test", "deploy-preview.pages.dev", "localhost"])(
        "discards startup errors while opted out on %s",
        async (hostname) => {
            Object.assign(browserWindow, { location: { hostname } });
            storedChoices.set(CRASH_REPORTING_STORAGE_KEY, "off");
            initSentry();
            captureSentryMessage("before consent message");
            captureSentryException(new Error("before consent exception"));
            setSentryTags({ startup: "before-consent-tag" });
            setSentryContext("startup", { status: "before-consent-context" });
            await vi.dynamicImportSettled();
            expect(requests).toHaveLength(0);

            setCrashReportingEnabled(true);
            captureSentryMessage("after consent message");
            setSentryTags({ optedIn: "after-consent-tag" });
            setSentryContext("enabled", { status: "after-consent-context" });
            await vi.dynamicImportSettled();
            expect(await getClient()?.flush(1000)).toBe(true);

            const payload = requests.map((request) => request.body).join("\n");
            expect(payload).toContain("after consent message");
            expect(payload).toContain("after-consent-tag");
            expect(payload).toContain("after-consent-context");
            expect(payload).not.toContain("before consent");
            expect(payload).not.toContain("before-consent");
        },
    );

    it("cancels initialization and drops its pending queue when consent is withdrawn", async () => {
        setCrashReportingEnabled(true);
        captureSentryMessage("cancelled pending message");
        setSentryContext("cancelled", { status: "cancelled-pending-context" });
        setCrashReportingEnabled(false);
        await vi.dynamicImportSettled();
        expect(requests).toHaveLength(0);

        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        captureSentryMessage("fresh consent message");
        expect(await getClient()?.flush(1000)).toBe(true);
        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).toContain("fresh consent message");
        expect(payload).not.toContain("cancelled pending message");
        expect(payload).not.toContain("cancelled-pending-context");
    });

    it("aborts pending transport and prevents close from flushing more reports", async () => {
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        const client = getClient();
        expect(client).toBeDefined();

        shouldHoldRequests = true;
        captureSentryMessage("in flight report");
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        const signal = requests[0]?.signal;
        expect(signal?.aborted).toBe(false);

        let releaseQueuedEvent = () => {};
        const queued = new Promise<void>((resolve) => {
            releaseQueuedEvent = resolve;
        });
        client?.addEventProcessor(async (event) => {
            if (event.message === "queued before shutdown") await queued;
            return event;
        });
        captureSentryMessage("queued before shutdown");
        setCrashReportingEnabled(false);
        expect(signal?.aborted).toBe(true);
        releaseQueuedEvent();
        captureSentryMessage("after shutdown report");
        // Uncaught errors use the SDK directly, so exercise that path too.
        client?.captureException(new Error("uncaught after shutdown"));
        await client?.flush(1000);
        expect(requests).toHaveLength(1);

        shouldHoldRequests = false;
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        captureSentryMessage("enabled again report");
        expect(await getClient()?.flush(1000)).toBe(true);
        expect(requests).toHaveLength(2);
        expect(requests[1]?.body).toContain("enabled again report");
        expect(requests[1]?.signal?.aborted).toBe(false);
    });

    it("keeps a new client enabled when an older close finishes late", async () => {
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        const oldClient = getClient();
        let releaseOldEvent = () => {};
        const oldEvent = new Promise<void>((resolve) => {
            releaseOldEvent = resolve;
        });
        oldClient?.addEventProcessor(async (event) => {
            await oldEvent;
            return event;
        });
        captureSentryMessage("old pending report");
        setCrashReportingEnabled(false);
        setSentryTags({ inactive: "disabled-tag" });
        setSentryContext("inactive", { status: "disabled-context" });
        createLogger("sentry-test").info("disabled breadcrumb");
        oldClient?.captureException(new Error("disabled exception"));

        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        releaseOldEvent();
        await oldClient?.flush(1000);
        captureSentryMessage("new client report");
        expect(await getClient()?.flush(1000)).toBe(true);

        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).toContain("new client report");
        expect(payload).not.toContain("old pending report");
        expect(payload).not.toContain("disabled");
    });
});

describe("errors-only reporting", () => {
    it("keeps arbitrary extension histograms local while retaining safe ingest counts", async () => {
        initSentry();
        await vi.dynamicImportSettled();
        const byExtension = { ".mp4": 1, ".private-suffix": 1 };
        createLogger("ingest").info("ingest started", { byExtension, totalFiles: 2 });
        captureSentryMessage("ingest produced no playable trips");
        await getClient()?.flush(1000);
        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).toContain("ingest started");
        expect(payload).toContain('"totalFiles":2');
        expect(payload).not.toContain("byExtension");
        expect(payload).not.toContain("private-suffix");
        expect(
            getLogBuffer()
                .filter((entry) => entry.ns === "ingest")
                .at(-1)?.ctx,
        ).toEqual({
            byExtension,
            totalFiles: 2,
        });
    });

    it.each(["annotations", "annotations-sidecar", "notes-storage-choice", "migration-restore"])(
        "keeps %s note details in the local ring while sending the static diagnostic trail",
        async (namespace) => {
            initSentry();
            await vi.dynamicImportSettled();
            const logger = createLogger(namespace);
            logger.warn("note storage payload failed", { err: "private-note-context", note: "private-note-text" });
            logger.error("note storage operation failed", new Error("private-note-error"));
            captureSentryMessage("annotation persistence failed", {
                level: "error",
                tags: { feature: "annotations" },
            });
            await getClient()?.flush(1000);
            const payload = requests.map((request) => request.body).join("\n");
            expect(payload).toContain("annotation persistence failed");
            expect(payload).toContain("note storage payload failed");
            expect(payload).toContain("note storage operation failed");
            expect(payload).toContain(`"category":"${namespace}"`);
            expect(payload).not.toContain("private-note");
            const local = getLogBuffer().filter((entry) => entry.ns === namespace);
            expect(local.find((entry) => entry.msg === "note storage payload failed")?.ctx).toEqual({
                err: "private-note-context",
                note: "private-note-text",
            });
            expect(local.find((entry) => entry.msg === "note storage operation failed")?.err?.message).toBe(
                "private-note-error",
            );
        },
    );

    it("drops manual and automatic cancellation reports but preserves real exceptions", async () => {
        initSentry();
        captureSentryException(new DOMException("cancelled pending", "AbortError"));
        await vi.dynamicImportSettled();
        captureSentryException(new DOMException("cancelled active", "AbortError"));
        getClient()?.captureException(new DOMException("cancelled unhandled", "AbortError"));
        captureSentryException(new Error("actual processing failure"));
        await getClient()?.flush(1000);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.body).toContain("actual processing failure");
        expect(requests[0]?.body).not.toContain("cancelled");
    });

    it("keeps only the latest context queued before initialization", async () => {
        setSentryContext("phase", { state: "superseded-context" });
        setSentryContext("phase", { state: "current-context" });
        initSentry();
        captureSentryMessage("queued report");
        await vi.dynamicImportSettled();
        await getClient()?.flush(1000);
        expect(requests[0]?.body).toContain("current-context");
        expect(requests[0]?.body).not.toContain("superseded-context");
    });

    it("limits reports across client restarts without sending client-report envelopes", async () => {
        initSentry();
        await vi.dynamicImportSettled();
        for (let i = 0; i < 55; i++) {
            captureSentryMessage(`failure ${i}`);
            await getClient()?.flush(1000);
        }
        expect(requests).toHaveLength(50);
        setCrashReportingEnabled(false);
        setCrashReportingEnabled(true);
        await vi.dynamicImportSettled();
        captureSentryMessage("failure after restart");
        await getClient()?.flush(1000);
        expect(requests).toHaveLength(50);
        expect(requests.every((request) => !request.body.includes('"type":"client_report"'))).toBe(true);
    });

    it("sends scrubbed exception stacks and manual breadcrumbs without raw user data", async () => {
        initSentry();
        await vi.dynamicImportSettled();
        createLogger("sentry-test").warn("processing failed", {
            filename: "Private Family Trip.mp4",
            lat: 55.7558,
            lon: 37.6173,
            codec: "hevc",
        });
        const error = new Error('cannot read "Private Family Trip.mp4"');
        error.stack = "Error: failed\n    at decode (https://everydashcam.app/assets/player.js?token=secret:42:7)";
        captureSentryException(error, { tags: { operation: "playback" } });
        await getClient()?.flush(1000);
        const payload = requests.map((request) => request.body).join("\n");
        expect(payload).toContain("player.js");
        expect(payload).toContain('"lineno":42');
        expect(payload).toContain("hevc");
        expect(payload).not.toContain("Private Family");
        expect(payload).not.toContain("secret");
        expect(payload).not.toContain("55.7558");
        expect(payload).not.toContain("37.6173");
    });
});
