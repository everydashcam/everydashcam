// Compatibility fixture: the older worker revalidates unknown ML URLs in the
// background and ignores the repair header. New content-addressed URLs are
// unknown to that worker. Keep its historical fetch contract for upgrade tests.
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || event.request.method !== "GET" || event.request.mode === "navigate")
        return;
    const tracker = /^\/(ort|models)\//.test(url.pathname);
    event.respondWith(
        (async () => {
            const cache = await caches.open(tracker ? "everydashcam-tracker-v3" : "everydashcam-runtime-v3");
            const hit = await cache.match(event.request, { ignoreVary: true });
            if (hit && !tracker) return hit;
            const network = fetch(event.request)
                .then(async (response) => {
                    if (response.status === 200) await cache.put(event.request, response.clone());
                    return response;
                })
                .catch(() => Response.error());
            event.waitUntil(network);
            return hit || network;
        })(),
    );
});
