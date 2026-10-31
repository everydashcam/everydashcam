const RELOAD_KEY = "everydashcam:dev-sw-reload";

export async function prepareDevPage(): Promise<boolean> {
    if (!("serviceWorker" in navigator)) return true;
    const swUrl = new URL(`${import.meta.env.BASE_URL}sw.js`, location.href).href;
    const isOurs = (worker: ServiceWorker | null) => worker?.scriptURL === swUrl;
    const controlled = isOurs(navigator.serviceWorker.controller);
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
        if ([registration.active, registration.waiting, registration.installing].some(isOurs)) {
            await registration.unregister();
        }
    }
    // User preferences, annotations and map caches are independent of code.
    try {
        for (const name of await caches.keys()) {
            if (/^everydashcam-(?:precache|runtime|tracker|releases)-/.test(name)) await caches.delete(name);
        }
    } catch {
        /* Development still works when storage is disabled. */
    }
    if (controlled) {
        if (sessionStorage.getItem(RELOAD_KEY) === swUrl) {
            throw new Error(
                "development page is still controlled by a retired service worker; close its tabs and reopen",
            );
        }
        sessionStorage.setItem(RELOAD_KEY, swUrl);
        location.reload();
        return false;
    }
    try {
        sessionStorage.removeItem(RELOAD_KEY);
    } catch {
        /* Storage is optional. */
    }
    return true;
}
