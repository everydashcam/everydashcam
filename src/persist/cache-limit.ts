// User-configurable size bound of the index cache (see index-cache.ts for why
// the bound is by data volume). localStorage, not the persist DB: the prune
// reads it synchronously inside a transaction, and a pref must stay readable
// even when IndexedDB itself is unavailable. No subscribers - the prune reads
// fresh on every run, the settings modal writes and re-prunes explicitly.

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
export const DEFAULT_INDEX_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;

/** Min / max accepted by the settings UI. 64 MB still caches a weekend of
 *  clips; 4 GB is a deliberate ceiling so a typo cannot claim the profile. */
export const INDEX_CACHE_LIMIT_MIN_BYTES = 64 * 1024 * 1024;
export const INDEX_CACHE_LIMIT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const STORAGE_KEY = "everydashcam:indexCache:limitBytes";

/** Current cache size limit in bytes, clamped; the default when unset,
 *  unparsable, or localStorage is unavailable (private mode). */
export function getIndexCacheLimitBytes(): number {
    const raw = readLocalStorage(STORAGE_KEY);
    if (raw === null) return DEFAULT_INDEX_CACHE_LIMIT_BYTES;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0
        ? Math.min(INDEX_CACHE_LIMIT_MAX_BYTES, Math.max(INDEX_CACHE_LIMIT_MIN_BYTES, n))
        : DEFAULT_INDEX_CACHE_LIMIT_BYTES;
}

/** Persists the limit (clamped). The caller is responsible for triggering a
 *  prune when the new limit is below the current cache size. */
export function setIndexCacheLimitBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const clamped = Math.min(INDEX_CACHE_LIMIT_MAX_BYTES, Math.max(INDEX_CACHE_LIMIT_MIN_BYTES, bytes));
    writeLocalStorage(STORAGE_KEY, String(clamped));
}
