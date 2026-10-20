import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePortableManifest, PORTABLE_UPDATE_URL } from "./manifest.mjs";
import { compareReleaseTags, isReleaseTag, legacyPortableFilename, portableFilename } from "./release-tags.mjs";
import { createPortableUpdateCheck } from "./updates.js";

function manifest(version = "v2026.09.25.10", locale = "en") {
    const filename = portableFilename(version, locale);
    return {
        schemaVersion: 1,
        distribution: "public",
        version,
        files: {
            [locale]: {
                path: `/downloads/portable/${version}/${filename.replace(/\.html$/, "")}`,
                filename,
                bytes: 1024,
                sha256: "a".repeat(64),
            },
        },
    };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("portable release metadata", () => {
    it("validates real dates and compares revisions numerically", () => {
        expect(isReleaseTag("v2026.02.29")).toBe(false);
        expect(isReleaseTag("v2028.02.29")).toBe(true);
        expect(isReleaseTag("v2026.13.01")).toBe(false);
        expect(isReleaseTag("dev-1234567")).toBe(false);
        expect(compareReleaseTags("v2026.09.25.10", "v2026.09.25.2")).toBeGreaterThan(0);
        expect(compareReleaseTags("v2026.09.25", "v2026.09.25.1")).toBeLessThan(0);
        expect(portableFilename("v2026.09.25.1", "ru")).toBe("everydashcam-2026-09-25.1-ru.html");
    });

    it("accepts exact historical names but rejects mixed old and new paths", () => {
        const current = manifest();
        const filename = legacyPortableFilename(current.version, "en");
        const legacy = {
            ...current,
            files: {
                en: {
                    ...current.files.en!,
                    filename,
                    path: `/downloads/portable/${current.version}/${filename.slice(0, -5)}`,
                },
            },
        };
        expect(parsePortableManifest(legacy)).toEqual(legacy);
        expect(
            parsePortableManifest({
                ...current,
                files: {
                    en: {
                        ...current.files.en,
                        path: legacy.files.en!.path,
                    },
                },
            }),
        ).toBeNull();
        expect(PORTABLE_UPDATE_URL).toBe("https://everydashcam.app/downloads/portable/latest.json");
    });

    it("rejects malformed metadata and paths outside the exact published artifact", () => {
        const valid = manifest();
        expect(parsePortableManifest(valid)).toEqual(valid);
        expect(parsePortableManifest({ ...valid, schemaVersion: 2 })).toBeNull();
        expect(parsePortableManifest({ ...valid, version: "v2026.09.99" })).toBeNull();
        for (const path of ["https://example.test/file.html", "//example.test/file.html", "/downloads/../file.html"]) {
            expect(parsePortableManifest({ ...valid, files: { en: { ...valid.files.en, path } } })).toBeNull();
        }
        expect(parsePortableManifest({ ...valid, files: { en: { ...valid.files.en, bytes: 30_000_000 } } })).toBeNull();
    });
});

describe("portable update checks", () => {
    it("uses a fixed private-data-free request and offers a newer matching download", async () => {
        const onUpdate = vi.fn();
        const events = new EventTarget();
        const fetchMetadata = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(manifest())));
        const check = createPortableUpdateCheck({
            version: "v2026.09.25.2",
            locale: "en",
            events,
            onUpdate,
            fetch: fetchMetadata,
        });
        check.start();
        check.start();
        events.dispatchEvent(new Event("online"));
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(1);
        expect(fetchMetadata.mock.calls[0]?.[0]).toBe(PORTABLE_UPDATE_URL);
        expect(fetchMetadata.mock.calls[0]?.[1]).toMatchObject({
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-cache",
            redirect: "error",
            method: "GET",
        });
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                version: "v2026.09.25.10",
                href: "https://everydashcam.app/downloads/portable/en.html",
            }),
        );
        check.dispose();
    });

    it("uses the primary locale page when the newer release has no matching file", async () => {
        const onUpdate = vi.fn();
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "ru",
            events: new EventTarget(),
            onUpdate,
            fetch: async () => new Response(JSON.stringify(manifest())),
        });
        check.start();
        await settle();
        expect(onUpdate).toHaveBeenCalledWith({ version: "v2026.09.25.10", href: "https://everydashcam.app/ru/" });
        check.dispose();
    });

    it.each(["v2026.09.25.10", "v2026.09.26", "dev-1234567"])("ignores non-newer metadata for %s", async (version) => {
        const onUpdate = vi.fn();
        const check = createPortableUpdateCheck({
            version,
            locale: "en",
            events: new EventTarget(),
            onUpdate,
            fetch: async () => new Response(JSON.stringify(manifest())),
        });
        check.start();
        await settle();
        expect(onUpdate).not.toHaveBeenCalled();
        check.dispose();
    });

    it("retries a network failure only once and only on reconnection", async () => {
        const events = new EventTarget();
        const fetchMetadata = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network unavailable"));
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "en",
            events,
            onUpdate: vi.fn(),
            fetch: fetchMetadata,
        });
        check.start();
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(1);
        events.dispatchEvent(new Event("online"));
        await settle();
        events.dispatchEvent(new Event("online"));
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(2);
        check.dispose();
    });

    it("retries when reconnection arrives before the initial network failure settles", async () => {
        const events = new EventTarget();
        const onUpdate = vi.fn();
        let rejectRequest!: (error: Error) => void;
        const fetchMetadata = vi
            .fn<typeof fetch>()
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectRequest = reject;
                    }),
            )
            .mockImplementation(async () => new Response(JSON.stringify(manifest())));
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "en",
            events,
            onUpdate,
            fetch: fetchMetadata,
        });
        check.start();
        events.dispatchEvent(new Event("online"));
        expect(fetchMetadata).toHaveBeenCalledTimes(1);
        rejectRequest(new TypeError("the old network request failed"));
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(2);
        expect(onUpdate).toHaveBeenCalledOnce();
        events.dispatchEvent(new Event("online"));
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(2);
        check.dispose();
    });

    it.each([new Response("bad json"), new Response("{}"), new Response("unavailable", { status: 503 })])(
        "does not retry invalid or failed HTTP responses",
        async (response) => {
            const events = new EventTarget();
            const onUpdate = vi.fn();
            const fetchMetadata = vi.fn<typeof fetch>().mockResolvedValue(response);
            const check = createPortableUpdateCheck({
                version: "v2026.09.24",
                locale: "en",
                events,
                onUpdate,
                fetch: fetchMetadata,
            });
            check.start();
            events.dispatchEvent(new Event("online"));
            await settle();
            events.dispatchEvent(new Event("online"));
            await settle();
            expect(fetchMetadata).toHaveBeenCalledTimes(1);
            expect(onUpdate).not.toHaveBeenCalled();
            check.dispose();
        },
    );

    it("cancels a pending reconnect retry on disposal", async () => {
        const events = new EventTarget();
        const fetchMetadata = vi.fn<typeof fetch>(
            async (_input, init) =>
                new Promise((_resolve, reject) => {
                    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                        once: true,
                    });
                }),
        );
        const onUpdate = vi.fn();
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "en",
            events,
            onUpdate,
            fetch: fetchMetadata,
        });
        check.start();
        events.dispatchEvent(new Event("online"));
        check.dispose();
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(1);
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it("cancels oversized metadata before reading the remaining body and does not retry it", async () => {
        const events = new EventTarget();
        const onUpdate = vi.fn();
        let chunksRead = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    chunksRead++;
                    if (chunksRead > 2) throw new Error("response read past the metadata limit");
                    controller.enqueue(new Uint8Array(chunksRead === 1 ? 32_768 : 32_769));
                },
                cancel() {
                    cancelled = true;
                },
            },
            { highWaterMark: 0 },
        );
        const fetchMetadata = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "en",
            events,
            onUpdate,
            fetch: fetchMetadata,
        });
        check.start();
        await settle();
        expect(cancelled).toBe(true);
        expect(chunksRead).toBe(2);
        expect(body.locked).toBe(false);
        events.dispatchEvent(new Event("online"));
        await settle();
        expect(fetchMetadata).toHaveBeenCalledTimes(1);
        expect(onUpdate).not.toHaveBeenCalled();
        check.dispose();
    });

    it("applies the metadata limit to UTF-8 bytes instead of decoded characters", async () => {
        const onUpdate = vi.fn();
        const text = JSON.stringify({ ...manifest(), description: "я".repeat(33_000) });
        expect(text.length).toBeLessThan(65_536);
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "en",
            events: new EventTarget(),
            onUpdate,
            fetch: async () => new Response(text),
        });
        check.start();
        await settle();
        expect(onUpdate).not.toHaveBeenCalled();
        check.dispose();
    });

    it("bounds the request duration and aborts work on disposal", async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        const events = new EventTarget();
        const fetchMetadata: typeof fetch = async (_input, init) => {
            const signal = init?.signal;
            if (!signal) throw new Error("missing request signal");
            signals.push(signal);
            return new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                    once: true,
                }),
            );
        };
        const check = createPortableUpdateCheck({
            version: "v2026.09.24",
            locale: "en",
            events,
            onUpdate: vi.fn(),
            fetch: fetchMetadata,
        });
        check.start();
        await vi.advanceTimersByTimeAsync(5000);
        expect(signals[0]?.aborted).toBe(true);
        events.dispatchEvent(new Event("online"));
        check.dispose();
        expect(signals[1]?.aborted).toBe(true);
        await settle();
        events.dispatchEvent(new Event("online"));
        expect(signals).toHaveLength(2);
    });
});
