import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    _resetForTests,
    blurAssetsBlockedOffline,
    blurAssetsNeedDownload,
    blurAssetsReady,
    blurAssetsState,
    downloadBlurAssets,
    FACE_MODEL_URL,
    PLATE_MODEL_URL,
    subscribeBlurAssets,
    TRACKER_MODEL_URL,
    TRACKER_ORT_ASSETS,
} from "./blur-assets.js";
import { reportMapTileNetworkError, reportMapTilesOk } from "./connectivity.js";

const assetFiles = computeTrackerAssets("serve").files;
function assetResponse(url: string | URL | Request): Response {
    const path = url instanceof Request ? url.url : String(url);
    const bytes = assetFiles.get(path);
    if (!bytes) throw new Error(`unexpected asset: ${path}`);
    return new Response(new Uint8Array(bytes));
}

let history: Map<string, string>;

beforeEach(() => {
    _resetForTests();
    history = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => history.get(key) ?? null,
        setItem: (key: string, value: string) => history.set(key, value),
        removeItem: (key: string) => history.delete(key),
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("caches", { match: async () => undefined });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => assetResponse(url)),
    );
});

afterEach(() => {
    reportMapTilesOk();
    vi.unstubAllGlobals();
});

describe("blur assets offline readiness", () => {
    it("shares the detector runtime and tracker model without downloading the Follow runtime", async () => {
        expect(await downloadBlurAssets(["detect-plate", "detect-face"])).toBe(true);
        expect(fetch).toHaveBeenCalledWith(PLATE_MODEL_URL, expect.anything());
        expect(fetch).toHaveBeenCalledWith(FACE_MODEL_URL, expect.anything());
        expect(fetch).toHaveBeenCalledWith(TRACKER_MODEL_URL, expect.anything());
        const downloaded = vi.mocked(fetch).mock.calls.map(([url]) => url);
        const plainWasm = TRACKER_ORT_ASSETS.wasm.wasm;
        const plainUrls = plainWasm.parts.map((part) => part.url);
        expect(downloaded.filter((url) => plainUrls.includes(String(url)))).toEqual([]);
        expect(new Set(downloaded).size, "shared runtime and model download once").toBe(downloaded.length);
        expect(blurAssetsReady(["detect-plate", "detect-face"])).toBe(true);
        expect(blurAssetsReady(["track"])).toBe(false);
        expect(await downloadBlurAssets(["track"])).toBe(true);
        expect(
            vi
                .mocked(fetch)
                .mock.calls.slice(downloaded.length)
                .map(([url]) => url),
        ).toEqual(plainUrls);
        expect(blurAssetsReady(["track"])).toBe(true);
    });

    it("keeps tracker download progress owned by the requested detection group", async () => {
        const downloadingGroups: Array<readonly string[] | null> = [];
        const unsubscribe = subscribeBlurAssets(() => {
            if (blurAssetsState().phase === "downloading") downloadingGroups.push(blurAssetsState().activeGroups);
        });
        try {
            expect(await downloadBlurAssets(["detect-plate"])).toBe(true);
            expect(downloadingGroups.length).toBeGreaterThan(0);
            for (const groups of downloadingGroups) expect(groups).toEqual(["detect-plate"]);
            const callsAfterPlate = vi.mocked(fetch).mock.calls.length;
            expect(await downloadBlurAssets(["detect-face"])).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(callsAfterPlate + 1);
            expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe(FACE_MODEL_URL);
        } finally {
            unsubscribe();
        }
    });

    it("downloads same-origin models while the tile provider is unreachable", async () => {
        reportMapTileNetworkError();
        expect(blurAssetsBlockedOffline(["track"])).toBe(false);
        expect(await downloadBlurAssets(["track"])).toBe(true);
        expect(blurAssetsReady(["track"])).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("finds cached models offline even when download history is missing", async () => {
        vi.stubGlobal("navigator", { onLine: false });
        vi.stubGlobal("caches", { match: async () => new Response(new Uint8Array([1, 2, 3])) });
        const changed = vi.fn();
        subscribeBlurAssets(changed);
        await vi.waitFor(() => expect(changed).toHaveBeenCalled());
        expect(blurAssetsNeedDownload(["track"])).toBe(false);
        expect(blurAssetsBlockedOffline(["track"])).toBe(false);
        expect(await downloadBlurAssets(["track"])).toBe(true);
    });

    it("waits for delayed cache discovery before automatically warming cached models", async () => {
        let release!: () => void;
        const discovered = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.stubGlobal("caches", {
            match: async () => {
                await discovered;
                return new Response(new Uint8Array([1, 2, 3]));
            },
        });
        const warmed = downloadBlurAssets(["detect-plate"], undefined, { canDownloadNew: false });
        expect(history.size).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
        release();
        expect(await warmed).toBe(true);
        expect(blurAssetsReady(["detect-plate"])).toBe(true);
        expect(fetch).toHaveBeenCalled();
    });

    it("keeps first-time downloads behind consent after cache discovery", async () => {
        expect(await downloadBlurAssets(["detect-plate"], undefined, { canDownloadNew: false })).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        expect(blurAssetsNeedDownload(["detect-plate"])).toBe(true);
        expect(blurAssetsState().phase).toBe("idle");
        expect(await downloadBlurAssets(["detect-plate"])).toBe(true);
    });

    it("does not restart a cancelled automatic warm when cache discovery completes", async () => {
        let release!: () => void;
        const discovered = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.stubGlobal("caches", {
            match: async () => {
                await discovered;
                return new Response(new Uint8Array([1, 2, 3]));
            },
        });
        const controller = new AbortController();
        const warmed = downloadBlurAssets(["detect-plate"], controller.signal, { canDownloadNew: false });
        const checked = new Promise<void>((resolve) => subscribeBlurAssets(resolve));
        controller.abort();
        expect(await warmed).toBe(false);
        release();
        await checked;
        expect(fetch).not.toHaveBeenCalled();
        expect(blurAssetsReady(["detect-plate"])).toBe(false);
    });

    it("blocks uncached models offline without attempting a download", async () => {
        vi.stubGlobal("navigator", { onLine: false });
        expect(await downloadBlurAssets(["track"])).toBe(false);
        expect(blurAssetsBlockedOffline(["track"])).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        expect(blurAssetsState().phase).toBe("idle");
    });

    it("corrects download history after an evicted asset fails offline", async () => {
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => (history.has(key) ? null : "1"),
            removeItem: (key: string) => history.set(key, "removed"),
        });
        vi.stubGlobal("navigator", { onLine: false });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("failed to fetch");
            }),
        );
        expect(blurAssetsBlockedOffline(["track"])).toBe(false);
        expect(await downloadBlurAssets(["track"])).toBe(false);
        expect(blurAssetsBlockedOffline(["track"])).toBe(true);
        expect(blurAssetsState().phase).toBe("error");
    });

    it("keeps downloads usable when Cache Storage is unavailable", async () => {
        vi.stubGlobal("caches", {
            match: async () => {
                throw new DOMException("denied", "SecurityError");
            },
        });
        expect(await downloadBlurAssets(["track"])).toBe(true);
    });

    it("rejects an HTML fallback instead of marking a model ready", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response("<!doctype html><title>offline</title>", {
                        headers: { "content-type": "text/html; charset=utf-8" },
                    }),
            ),
        );
        expect(await downloadBlurAssets(["track"])).toBe(false);
        expect(blurAssetsReady(["track"])).toBe(false);
        expect(history.size).toBe(0);
    });

    it("does not fetch or report an error for an already cancelled request", async () => {
        expect(await downloadBlurAssets(["track"], AbortSignal.abort())).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        expect(blurAssetsState().phase).toBe("idle");
    });

    it("rejects empty assets and leaves the failed feature available to retry", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array())),
        );
        expect(await downloadBlurAssets(["track"])).toBe(false);
        expect(blurAssetsReady(["track"])).toBe(false);
        expect(history.size).toBe(0);
        expect(blurAssetsState()).toMatchObject({ phase: "error", activeGroups: ["track"] });

        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string | URL | Request) => assetResponse(url)),
        );
        expect(await downloadBlurAssets(["track"])).toBe(true);
        expect(blurAssetsReady(["track"])).toBe(true);
    });

    it("keeps an interrupted response retriable when cancellation crosses its last chunk", async () => {
        const controller = new AbortController();
        const unsubscribe = subscribeBlurAssets(() => {
            if (blurAssetsState().progress > 0) controller.abort();
        });
        try {
            expect(await downloadBlurAssets(["track"], controller.signal)).toBe(false);
            expect(blurAssetsReady(["track"])).toBe(false);
            expect(history.size).toBe(0);
            expect(blurAssetsState().phase).toBe("idle");
        } finally {
            unsubscribe();
        }
        expect(await downloadBlurAssets(["track"])).toBe(true);
    });

    it("cancels a queued warm without waiting for or aborting another feature's download", async () => {
        let finish!: (response: Response) => void;
        const fetcher = vi
            .fn<(url: string | URL | Request) => Promise<Response>>()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockImplementation(async (url) => assetResponse(url));
        vi.stubGlobal("fetch", fetcher);
        const tracking = downloadBlurAssets(["track"]);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        const controller = new AbortController();
        const detection = downloadBlurAssets(["detect-face"], controller.signal);
        // Let the cache check settle and enter the queue behind tracking.
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();
        try {
            expect(await detection).toBe(false);
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(blurAssetsState().phase).toBe("downloading");
        } finally {
            finish(assetResponse(TRACKER_ORT_ASSETS.wasm.wasm.parts[0]!.url));
            expect(await tracking).toBe(true);
        }
    });
});
