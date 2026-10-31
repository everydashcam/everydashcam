// Readiness gate for the blur features' heavy assets: the onnxruntime-web wasm
// runtimes plus the per-feature ONNX models (ViTTrack for Follow, and detector
// models with ViTTrack for the "blur all ..." checkboxes). The workers fetch these
// lazily, but that fetch is silent - on a slow link the user stares at a frozen
// button while megabytes download, and offline it just fails.
//
// This module front-loads the download from the MAIN thread with a determinate
// progress bar, so the panel can ask for consent, show progress, and explain the
// offline story BEFORE anything heavy happens. Warming here also warms the HTTP
// + service-worker (TRACKER) cache, so the worker's own fetch for the same URLs
// normally hits cache. Cache writes are best effort; workers still verify bytes.
//
// Assets are grouped per feature; a request names the groups it needs and the
// consent copy prices only the files this device has never pulled (the detect
// groups share the WebGPU runtime and ViTTrack, so consenting to plates makes the faces
// checkbox later cost just the face model). Downloads are opt-in and
// remembered per FILE in localStorage. No UI here - the panel subscribes.

import { createLogger } from "../log.js";
import type { AssetPart } from "../tracking/ort-assets.js";
import { TRACKER_ASSETS } from "../tracking/asset-manifest.js";
import { loadAssetParts } from "../tracking/asset-loader.js";

const log = createLogger("blur-assets");

export const TRACKER_MODEL_URL = TRACKER_ASSETS.models.tracker.url;
export const PLATE_MODEL_URL = TRACKER_ASSETS.models.plate.url;
export const FACE_MODEL_URL = TRACKER_ASSETS.models.face.url;
export const TRACKER_ORT_ASSETS = TRACKER_ASSETS.ort;

/** Follow needs ViTTrack and plain WASM. Detection shares its WebGPU runtime
 *  with ViTTrack's WASM session; each checkbox adds its detector model. */
export type BlurAssetGroupId = "track" | "detect-plate" | "detect-face";

function groupAssets(group: BlurAssetGroupId): readonly AssetPart[] {
    switch (group) {
        case "track":
            return [...TRACKER_ORT_ASSETS.wasm.wasm.parts, TRACKER_ASSETS.models.tracker];
        case "detect-plate":
            return [
                ...TRACKER_ORT_ASSETS.webgpu.wasm.parts,
                TRACKER_ASSETS.models.tracker,
                TRACKER_ASSETS.models.plate,
            ];
        case "detect-face":
            return [...TRACKER_ORT_ASSETS.webgpu.wasm.parts, TRACKER_ASSETS.models.tracker, TRACKER_ASSETS.models.face];
    }
}

// Per-file "this device has pulled it" flags. Lets later visits skip the
// consent prompt for already-cached files: the SW TRACKER cache holds them
// (incl. offline), so re-asking would be noise. A cache eviction just means the
// next pass re-downloads through the same warm path - flags are an
// optimization, not a correctness guarantee.
//
// The asset URLs are cache-busted (see TRACKER_ASSETS): an onnxruntime upgrade
// or a re-exported model changes the URL, so the flag key moves with it - a
// device never keys a stale flag to fresh bytes. History is not proof that
// the browser still holds the response.
const ASSET_DOWNLOADED_KEY_PREFIX = "everydashcam:blurAssetDownloaded:";

export type BlurAssetsPhase =
    | "idle" // no download in flight, nothing failed
    | "downloading" // warm in flight, `progress` is live
    | "update" // this build's asset is no longer published
    | "error"; // the last download failed (surfaced so the strip can offer a retry)
// Note: there is deliberately no sticky "offline" phase. Offline-ness is derived
// LIVE by the panel from blurAssetsBlockedOffline(), so a reconnect immediately
// makes the download available again instead of wedging on a phase no code path
// clears. Readiness is not a phase either - it is derived per group from the
// per-file warmed set.

export interface BlurAssetsState {
    phase: BlurAssetsPhase;
    /** 0..1 during "downloading", else meaningless. */
    progress: number;
    /** Groups the in-flight (or failed) download was asked for - the panel uses
     *  it to route progress/error to the strip that initiated the warm. */
    activeGroups: readonly BlurAssetGroupId[] | null;
}

const stateRef: BlurAssetsState = { phase: "idle", progress: 0, activeGroups: null };

// URLs fully verified this session. Storage remains best-effort: the browser
// can evict cached responses independently of the download history.
const sessionWarmed = new Set<string>();
const cachedAssets = new Set<string>();
let cacheCheck: Promise<void> | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribes to readiness/progress changes (panel strip re-render hook). */
export function subscribeBlurAssets(listener: Listener): () => void {
    listeners.add(listener);
    cacheCheck ??= checkCachedAssets();
    return () => listeners.delete(listener);
}

async function checkCachedAssets(): Promise<void> {
    if (typeof caches === "undefined") return;
    try {
        for (const { url } of assetsOf(["track", "detect-plate", "detect-face"])) {
            // Main-thread fetches and worker imports can send different Origin
            // headers; these versioned static files always contain the same bytes.
            const response = await caches.match(url, { ignoreVary: true });
            if (response && isAssetResponse(response)) cachedAssets.add(url);
        }
        // Download history can be missing even though Cache Storage survived.
        // Notify after the scan so cached features become available offline.
        if (cachedAssets.size > 0) emit();
    } catch (err) {
        log.warn("blur asset cache check failed", { error: err instanceof Error ? err.message : String(err) });
    }
}

function emit(): void {
    for (const l of listeners) l();
}

function setState(phase: BlurAssetsPhase, progress: number, activeGroups: BlurAssetsState["activeGroups"]): void {
    stateRef.phase = phase;
    stateRef.progress = progress;
    stateRef.activeGroups = activeGroups;
    emit();
}

/** Current download snapshot (read-only). */
export function blurAssetsState(): Readonly<BlurAssetsState> {
    return stateRef;
}

function assetsOf(groups: readonly BlurAssetGroupId[]): AssetPart[] {
    // Union preserving order, wasm first - it dominates the bytes, so the
    // progress bar moves honestly from the start.
    const seen = new Set<string>();
    const out: AssetPart[] = [];
    for (const g of groups) {
        for (const a of groupAssets(g)) {
            if (!seen.has(a.url)) {
                seen.add(a.url);
                out.push(a);
            }
        }
    }
    return out;
}

function everDownloaded(url: string): boolean {
    try {
        // Keyed by the cache-busted URL, so a device only counts a file as pulled
        // when it pulled THAT exact version - an onnxruntime upgrade or a
        // re-exported model lands a new URL and re-prompts, honoring consent.
        return localStorage.getItem(ASSET_DOWNLOADED_KEY_PREFIX + url) === "1";
    } catch {
        return false;
    }
}

function rememberDownloaded(url: string): void {
    try {
        localStorage.setItem(ASSET_DOWNLOADED_KEY_PREFIX + url, "1");
    } catch {
        // Private mode / storage disabled: harmless, we just re-prompt next time.
    }
}

function forgetDownloaded(url: string): void {
    cachedAssets.delete(url);
    try {
        localStorage.removeItem(ASSET_DOWNLOADED_KEY_PREFIX + url);
    } catch {
        // Storage may be disabled independently of Cache Storage.
    }
}

/** True once every asset of `groups` is warmed this session - the pass can run
 *  after a verified warm. Workers verify again because storage can be evicted. */
export function blurAssetsReady(groups: readonly BlurAssetGroupId[]): boolean {
    return assetsOf(groups).every((a) => sessionWarmed.has(a.url));
}

/**
 * Whether a heavy download would happen if the user asked for these features
 * right now - i.e. some asset is not warmed this session AND this device has
 * never pulled it. The panel uses it to decide between a silent fast path
 * (skip the prompt, warm from cache in the background) and an explicit
 * "~N MB" consent prompt.
 */
export function blurAssetsNeedDownload(groups: readonly BlurAssetGroupId[]): boolean {
    return assetsOf(groups).some(
        (a) => !sessionWarmed.has(a.url) && !cachedAssets.has(a.url) && !everDownloaded(a.url),
    );
}

/** Rounded MB the consent prompt should quote: only the files this device has
 *  never pulled. Display only. */
export function blurAssetsDownloadMb(groups: readonly BlurAssetGroupId[]): number {
    const mb = assetsOf(groups)
        .filter((a) => !sessionWarmed.has(a.url) && !cachedAssets.has(a.url) && !everDownloaded(a.url))
        .reduce((sum, a) => sum + a.bytes / (1024 * 1024), 0);
    return Math.max(1, Math.round(mb));
}

/** Hard offline prevents a first download. Saved history or cached responses
 *  allow a warm attempt; a failed attempt corrects stale download history. */
export function blurAssetsBlockedOffline(groups: readonly BlurAssetGroupId[]): boolean {
    // A tile-provider outage says nothing about these same-origin files.
    return blurAssetsNeedDownload(groups) && navigator.onLine === false;
}

let inFlight: Promise<boolean> | null = null;

async function waitForWarm(pending: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (!signal) {
        await pending;
        return true;
    }
    let onAbort!: () => void;
    const cancelled = new Promise<false>((resolve) => {
        onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([pending.then(() => true), cancelled]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

export interface BlurAssetDownloadOptions {
    /** False limits automatic warming to files already downloaded, after
     *  awaiting cache discovery. Explicit downloads allow new files. */
    canDownloadNew?: boolean;
}

/**
 * Warms the groups' assets into cache with a determinate progress bar, updating
 * the shared state as it goes. Resolves true once everything requested is
 * warmed, false on failure (blocked-offline / network error / stall / abort).
 * On failure the phase is left at "error" (retriable) or "idle" (blocked-offline
 * / user abort) for the strip to render; offline-ness itself is derived live by
 * the caller. A download already in flight (even for other groups) is awaited
 * first - warms are serial, and a follow-up request usually finds its shared
 * files already warmed. Safe to call when already ready (resolves true).
 */
export async function downloadBlurAssets(
    groups: readonly BlurAssetGroupId[],
    signal?: AbortSignal,
    options?: BlurAssetDownloadOptions,
): Promise<boolean> {
    cacheCheck ??= checkCachedAssets();
    if (!(await waitForWarm(cacheCheck, signal))) return false;
    // Serialize behind any in-flight warm (shared files make overlap wasteful
    // and the progress bar ambiguous). Loop: the finished warm may have covered
    // us entirely, or not at all.
    while (inFlight) {
        if (!(await waitForWarm(inFlight, signal))) return false;
    }
    if (signal?.aborted) return false;
    if (blurAssetsReady(groups)) return true;
    if (options?.canDownloadNew === false && blurAssetsNeedDownload(groups)) return false;
    // Hard offline with no downloaded assets: do not even start.
    // Leave the phase at idle - the panel shows the offline story live, and a
    // reconnect lets the very next click through.
    if (blurAssetsBlockedOffline(groups)) return false;
    inFlight = warmAll(groups, signal)
        .then(() => {
            setState("idle", 1, null);
            return true;
        })
        .catch((err: unknown) => {
            // A user cancel resets cleanly; anything else (network drop, a stalled
            // limbo fetch that hit the inactivity limit) is an error the strip
            // can retry. Offline-ness is re-derived live, not pinned to a phase.
            if (err instanceof Error && err.name === "AbortError") {
                setState("idle", 0, null);
                return false;
            }
            setState(
                err instanceof Error && err.name === "AssetUnavailableError" ? "update" : "error",
                0,
                stateRef.activeGroups,
            );
            log.warn("blur asset download failed", { groups, error: err instanceof Error ? err.message : String(err) });
            return false;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

/** Fetches every not-yet-warmed asset in sequence, draining each body to
 *  completion so the full response lands in cache, and reports combined
 *  progress weighted by approximate size. */
async function warmAll(groups: readonly BlurAssetGroupId[], signal?: AbortSignal): Promise<void> {
    const todo = assetsOf(groups).filter((a) => !sessionWarmed.has(a.url));
    const totalMb = Math.max(
        1e-6,
        todo.reduce((sum, a) => sum + a.bytes / (1024 * 1024), 0),
    );
    setState("downloading", 0, groups);
    let baseMb = 0;
    for (const asset of todo) {
        signal?.throwIfAborted();
        try {
            await loadAssetParts([asset], signal, (frac) => {
                setState("downloading", Math.min(1, (baseMb + (asset.bytes / (1024 * 1024)) * frac) / totalMb), groups);
            });
        } catch (err) {
            if (!(err instanceof Error && err.name === "AbortError")) forgetDownloaded(asset.url);
            throw err;
        }
        sessionWarmed.add(asset.url);
        rememberDownloaded(asset.url);
        baseMb += asset.bytes / (1024 * 1024);
        setState("downloading", Math.min(1, baseMb / totalMb), groups);
    }
}

function isAssetResponse(response: Response): boolean {
    return (
        response.status === 200 &&
        !/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "")
    );
}

/** A worker can discover eviction after warming completed. Its next explicit
 * attempt must pass the download gate again, without losing consent history. */
export function invalidateBlurAssetReadiness(): void {
    sessionWarmed.clear();
    cachedAssets.clear();
    emit();
}

export function _resetForTests(): void {
    sessionWarmed.clear();
    cachedAssets.clear();
    cacheCheck = null;
    inFlight = null;
    listeners.clear();
    setState("idle", 0, null);
}
