// Raw store operations for the cross-session index cache. UI-free; the
// pipeline glue (partitioning classified files, rebuilding candidates) lives
// in ui/ingest-cache.ts.

import { createLogger } from "../log.js";
import { getIndexCacheLimitBytes } from "./cache-limit.js";
import { openPersistDb, type PersistDb } from "./db.js";
import { accelColumnsByteLength, gpsRecordColumnsByteLength } from "./gps-columns.js";
import {
    type CachedEmbeddedGps,
    type CachedFileIndex,
    type CachedRecordingMetadata,
    INDEX_CACHE_FORMAT,
} from "./types.js";

const log = createLogger("index-cache");

// The size bound (user-configurable, cache-limit.ts) is not a correctness
// knob: without one the store would creep toward gigabytes over months of
// different cards. Bounded by DATA VOLUME, not entry count - a GPS-dense clip
// weighs orders of magnitude more than an empty one, and a terabyte archive is
// tens of thousands of clips, so a count cap either starves it or lets the
// dense case blow up the browser profile. Oldest savedAt first (savedAt
// refreshes on use - LRU-ish); an evicted entry only costs a reindex of that
// file.
// Backstop against pathological tiny-entry counts (volume alone would admit
// millions of empty-record entries, and every prune walks a cursor).
const MAX_ENTRIES = 50_000;
// A cache hit refreshes savedAt only past this age - re-writing thousands of
// untouched entries on every open of a daily folder would be pure churn.
const TOUCH_MIN_AGE_MS = 24 * 60 * 60 * 1000;
// Ceiling on entries refreshed per open. Bounds the write burst when a whole
// big folder crosses the age gate at once; the remainder refreshes next time.
const MAX_TOUCH_PER_CALL = 512;
// Emergency eviction when a write is rejected for lack of room (origin quota,
// not our own bound): drop this share of the oldest entries so the next attempt
// has somewhere to go instead of failing identically forever.
const QUOTA_EVICT_FRACTION = 0.25;
// Entries whose previous size is read in one turn. Bounds the peak memory of a
// big ingest's write-back without giving up the batched round trip.
const PUT_CHUNK = 200;
// Running total of `bytes` across entries, kept in the meta store and updated
// in the same transaction as every put/delete - the prune trigger without a
// full-store walk.
const TOTAL_BYTES_META_KEY = "indexCacheBytes";

/**
 * Fetches cache entries for the given identity keys. Entries written in a
 * different storage format are treated as absent (and left for the prune
 * to age out - deleting them here would put a write transaction on the hot
 * ingest path). Missing keys are simply absent from the result map.
 */
export async function getIndexCacheEntries(keys: string[]): Promise<Map<string, CachedFileIndex>> {
    const db = await openPersistDb();
    const tx = db.transaction("indexCache");
    const out = new Map<string, CachedFileIndex>();
    await Promise.all(
        keys.map(async (key) => {
            const entry = await tx.store.get(key);
            if (isCurrentCacheEntry(entry)) out.set(key, entry);
        }),
    );
    await tx.done;
    return out;
}

/**
 * Refreshes savedAt on the given entries so the volume prune sees them as
 * recently USED, not just once written - a folder opened weekly must outlive
 * one indexed yesterday and never touched again. Entries younger than
 * TOUCH_MIN_AGE_MS are left alone (bounds the write churn of routine opens).
 */
export async function touchIndexCacheEntries(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await openPersistDb();
    const now = Date.now();
    const tx = db.transaction("indexCache", "readwrite");
    // Which of these keys are actually stale, decided from the savedAt INDEX -
    // key-only, so nothing is deserialized to answer a question about a
    // timestamp. Reading every hit's full payload (records included) to find
    // the handful past the age gate was the expensive half of this pass.
    const staleByAge = await tx.store.index("bySavedAt").getAllKeys(IDBKeyRange.upperBound(now - TOUCH_MIN_AGE_MS));
    const wanted = new Set<IDBValidKey>(keys);
    const due = staleByAge.filter((key) => wanted.has(key));
    // A rewrite is a full re-serialization of the entry, so a folder untouched
    // for a day would rewrite its whole payload at once (hundreds of MB on a
    // big card). Bound the burst instead - and take the OLDEST first, in the
    // index's own order: those are the ones the prune would evict next, and
    // refreshing them moves the rest up the queue, so repeated opens converge
    // instead of re-picking the same prefix forever.
    const batch = due.slice(0, MAX_TOUCH_PER_CALL);
    await Promise.all(
        batch.map(async (key) => {
            const entry = await tx.store.get(key);
            if (!isCurrentCacheEntry(entry)) return;
            entry.savedAt = now;
            // Voided on purpose (the batch is fire-and-forget), but with its own
            // catch: an aborted transaction rejects every pending request, and a
            // bare `void` would surface each as an unhandled rejection in the
            // diagnostic ring buffer. tx.done below still reports the failure.
            void tx.store.put(entry).catch(() => {});
        }),
    );
    await tx.done;
    if (batch.length > 0) {
        log.info("refreshed cache recency", { touched: batch.length, deferred: due.length - batch.length });
    }
}

/** Narrow old IndexedDB values before current code reads their artifact shape. */
export function isCurrentCacheEntry(value: unknown): value is CachedFileIndex {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Partial<CachedFileIndex>;
    return (
        entry.cacheFormat === INDEX_CACHE_FORMAT &&
        typeof entry.identityKey === "string" &&
        typeof entry.savedAt === "number" &&
        typeof entry.metadata === "object" &&
        entry.metadata !== null
    );
}

// IndexedMp4 fields, cache revisions, ids, and IndexedDB record overhead.
const BYTES_PER_ENTRY = 512;

/**
 * Approximate stored size of an entry. Arithmetic, not serialization: dense
 * telemetry dominates, and its typed columns report their exact payload, so
 * the volume bound keeps meaning roughly what it says without cloning the
 * entry solely for accounting.
 */
export function approxEntryBytes(
    identityKey: string,
    metadata: CachedRecordingMetadata,
    embeddedGps: CachedEmbeddedGps | undefined,
): number {
    const repairBytes = metadata.repair ? metadata.repair.patchedMoov.byteLength + 256 : 0;
    let gpsBytes = 0;
    if (embeddedGps?.status === "parsed") {
        gpsBytes = gpsRecordColumnsByteLength(embeddedGps.recordColumns);
        if (embeddedGps.accelColumns) gpsBytes += accelColumnsByteLength(embeddedGps.accelColumns);
    }
    return identityKey.length * 2 + gpsBytes + repairBytes + BYTES_PER_ENTRY;
}

/** Assembles one immutable artifact snapshot for storage. */
export function buildCacheEntry(
    identityKey: string,
    metadata: CachedRecordingMetadata,
    embeddedGps: CachedEmbeddedGps | undefined,
): CachedFileIndex {
    const entry: CachedFileIndex = {
        identityKey,
        cacheFormat: INDEX_CACHE_FORMAT,
        savedAt: Date.now(),
        bytes: approxEntryBytes(identityKey, metadata, embeddedGps),
        metadata,
    };
    if (embeddedGps) entry.embeddedGps = embeddedGps;
    return entry;
}

/**
 * Whether a failed cache write ran out of ORIGIN quota, given every error the
 * failure produced. Takes a list because the quota name survives in only one of
 * them and it is usually not the one that was thrown: an unhandled request error
 * aborts its transaction, so every other request still queued there - including
 * the total-bytes read this code awaits first - is re-reported as AbortError.
 * Matching by name alone: IndexedDB hands back a real DOMException, so there is
 * nothing here to match on message text.
 */
export function isQuotaFailure(errors: readonly unknown[]): boolean {
    return errors.some((err) => err instanceof DOMException && (err.name === "QuotaExceededError" || err.code === 22));
}

/** Writes entries (upsert by identityKey), then prunes the store to its size
 *  bound. Puts and the running-total update share one transaction - a torn
 *  write can neither leave a partial batch visible nor desync the total. */
export async function putIndexCacheEntries(entries: CachedFileIndex[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await openPersistDb();
    const tx = db.transaction(["indexCache", "meta"], "readwrite");
    const store = tx.objectStore("indexCache");
    const meta = tx.objectStore("meta");
    let total = 0;
    // The put that actually hit the quota. Its rejection is the ONLY place the
    // QuotaExceededError name survives: an unhandled request error aborts the
    // transaction, and every other request still queued in it - including the
    // meta.get below, which is awaited first - is re-reported as AbortError.
    // Reading the name off the thrown error alone therefore never sees a quota
    // failure, and the eviction this whole path exists for would not fire.
    let putRejection: unknown;
    try {
        let delta = 0;
        // Read the previous sizes in bounded groups: one await per entry
        // serialized a whole card's worth of round trips, while a single
        // Promise.all over ten thousand entries would hold every previous
        // payload (records included) in memory at once.
        for (let start = 0; start < entries.length; start += PUT_CHUNK) {
            const chunk = entries.slice(start, start + PUT_CHUNK);
            const previous = await Promise.all(chunk.map((entry) => store.get(entry.identityKey)));
            for (const [index, entry] of chunk.entries()) {
                // Upsert accounting: replacing an entry swaps its bytes, it does not add.
                delta += (entry.bytes ?? 0) - (previous[index]?.bytes ?? 0);
                // Voided, but with its own catch: an aborted transaction rejects
                // every pending request, and each bare `void` would land in the
                // diagnostic ring buffer as an unhandled rejection. The abort
                // itself still surfaces through tx.done. Keep the FIRST
                // rejection - the later ones are the abort cascade, this one
                // carries the real reason.
                void store.put(entry).catch((err: unknown) => {
                    putRejection ??= err;
                });
            }
        }
        total = (await readTotalBytes(meta)) + delta;
        await meta.put(String(total), TOTAL_BYTES_META_KEY);
        await tx.done;
    } catch (err) {
        // Out of room, specifically: the ORIGIN quota, which our own byte
        // accounting cannot see, so the ordinary prune below would find nothing
        // to do and every future write would fail the same way. Make room by
        // age and let the next ingest try again. Any other abort (the browser
        // closing the connection, a version change) leaves the store alone -
        // throwing entries away would not help it.
        //
        // Three sources, because only one of them is ever the quota: what was
        // thrown here is usually the abort cascade's AbortError, the failing
        // put's own rejection carries the real name, and tx.error is what the
        // transaction was aborted WITH when the put's catch has not settled yet.
        if (isQuotaFailure([err, putRejection, tx.error])) {
            await evictOldestFraction(db, QUOTA_EVICT_FRACTION).catch((evictErr: unknown) => {
                // Nothing left to try - say so, or the store looks merely full.
                log.warn("index cache quota eviction failed", {
                    err: evictErr instanceof Error ? evictErr.message : String(evictErr),
                });
            });
        }
        throw err;
    }
    await pruneIndexCache(db, total);
}

/**
 * Deletes the oldest `fraction` of entries (by savedAt) and rebases the running
 * byte total on what is left. The recovery path for a rejected write, where the
 * accounting-driven prune has no reason to fire.
 */
async function evictOldestFraction(db: PersistDb, fraction: number): Promise<void> {
    const tx = db.transaction(["indexCache", "meta"], "readwrite");
    const store = tx.objectStore("indexCache");
    const target = Math.ceil((await store.count()) * fraction);
    if (target <= 0) {
        await tx.done;
        return;
    }
    let freed = 0;
    let deleted = 0;
    let cursor = await store.index("bySavedAt").openCursor();
    while (cursor && deleted < target) {
        freed += cursor.value.bytes ?? 0;
        deleted++;
        await cursor.delete();
        cursor = await cursor.continue();
    }
    const meta = tx.objectStore("meta");
    const remaining = Math.max(0, (await readTotalBytes(meta)) - freed);
    await meta.put(String(remaining), TOTAL_BYTES_META_KEY);
    await tx.done;
    log.warn("index cache write rejected, evicted oldest entries", { deleted, totalBytes: remaining });
}

async function readTotalBytes(meta: { get(key: string): Promise<string | undefined> }): Promise<number> {
    const raw = await meta.get(TOTAL_BYTES_META_KEY);
    const parsed = raw === undefined ? 0 : Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Approximate cache footprint for the settings UI: the running byte total and
 * the entry count. Reads the maintained accounting, no store walk - entries
 * written before the `bytes` field existed are invisible to the total (they
 * are also first in line for eviction). Rejects when IndexedDB is unavailable;
 * the caller degrades to "unknown".
 */
export async function getIndexCacheStats(): Promise<{ totalBytes: number; entryCount: number }> {
    const db = await openPersistDb();
    const tx = db.transaction(["indexCache", "meta"]);
    const [entryCount, totalBytes] = await Promise.all([
        tx.objectStore("indexCache").count(),
        readTotalBytes(tx.objectStore("meta")),
    ]);
    await tx.done;
    return { totalBytes: Math.max(0, totalBytes), entryCount };
}

/**
 * Wipes the whole index cache and zeroes its byte accounting in one
 * transaction. Folders and annotations are untouched - the only cost is a full
 * re-index on the next open of each folder. Rejects when IndexedDB is
 * unavailable (nothing to clear then anyway).
 */
export async function clearIndexCache(): Promise<void> {
    const db = await openPersistDb();
    const tx = db.transaction(["indexCache", "meta"], "readwrite");
    await tx.objectStore("indexCache").clear();
    await tx.objectStore("meta").put("0", TOTAL_BYTES_META_KEY);
    await tx.done;
    log.info("index cache cleared");
}

/**
 * Runs the ordinary size-bound prune against the CURRENT limit, outside any
 * write. For the settings modal: shrinking the limit must reclaim the space
 * right away, not on the next ingest's write-back.
 */
export async function pruneIndexCacheToLimit(): Promise<void> {
    const db = await openPersistDb();
    const tx = db.transaction("meta");
    const total = await readTotalBytes(tx.store);
    await tx.done;
    await pruneIndexCache(db, total);
}

async function pruneIndexCache(db: PersistDb, totalHint: number): Promise<void> {
    const limitBytes = getIndexCacheLimitBytes();
    const countTx = db.transaction("indexCache");
    const count = await countTx.store.count();
    await countTx.done;
    if (totalHint <= limitBytes && count <= MAX_ENTRIES) return;

    // Count/total and the deletions share one transaction - a check taken
    // outside it can race a concurrent batch write and over-delete.
    const tx = db.transaction(["indexCache", "meta"], "readwrite");
    const store = tx.objectStore("indexCache");
    const meta = tx.objectStore("meta");
    let total = await readTotalBytes(meta);
    let entriesLeft = await store.count();
    let deleted = 0;
    let cursor = await store.index("bySavedAt").openCursor();
    while (cursor && (total > limitBytes || entriesLeft > MAX_ENTRIES)) {
        const entry = cursor.value;
        // A pre-`bytes` entry never contributed to the total (subtracts 0);
        // a legacy-format one is unreadable anyway - the walk clears
        // both as it reaches them, reclaiming space the total cannot see.
        total -= entry.bytes ?? 0;
        entriesLeft--;
        deleted++;
        await cursor.delete();
        cursor = await cursor.continue();
    }
    if (deleted > 0) await meta.put(String(Math.max(0, total)), TOTAL_BYTES_META_KEY);
    await tx.done;
    if (deleted > 0) {
        log.info("pruned index cache", { deleted, kept: entriesLeft, totalBytes: Math.max(0, total) });
    }
}
