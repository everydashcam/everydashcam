import { CacheExpiration } from "workbox-expiration";
import { TRACKER } from "./sw-cache.js";
import { isCacheableAssetResponse, trackerCacheUrl } from "./sw-policy.js";

export const TRACKER_MAX_ENTRIES = 24;
const LEGACY_TRACKER = "everydashcam-tracker-v3";

/** Preserve downloaded binaries while giving Workbox their expiration metadata. */
export async function migrateLegacyTrackerCache(): Promise<void> {
    if (!(await caches.has(LEGACY_TRACKER))) return;
    const legacy = await caches.open(LEGACY_TRACKER);
    const target = await caches.open(TRACKER);
    const expiration = new CacheExpiration(TRACKER, {
        maxEntries: TRACKER_MAX_ENTRIES,
        matchOptions: { ignoreVary: true },
    });
    for (const request of await legacy.keys()) {
        const url = new URL(request.url);
        if (url.origin !== self.location.origin || !/^\/(?:ort|models)\//.test(url.pathname)) continue;
        const response = await legacy.match(request);
        if (!response || !isCacheableAssetResponse(response)) continue;
        const key = trackerCacheUrl(request.url);
        const existing = await target.match(key, { ignoreVary: true });
        if (!existing || !isCacheableAssetResponse(existing)) {
            await target.put(key, response);
        }
        // ExpirationPlugin cannot count entries written outside its strategy
        // until the corresponding IndexedDB timestamp exists.
        await expiration.updateTimestamp(key);
    }
    await expiration.expireEntries();
    // A failed copy or metadata write leaves the source available for retry.
    await caches.delete(LEGACY_TRACKER);
}
