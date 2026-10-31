import type { Plugin } from "vite";

// Old installed dev workers still request /sw.js before the new app boots.
// Retire them with a network-only worker. Never reload a running client here.
const RETIRE_WORKER = `self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil((async()=>{
await self.clients.claim(); await self.registration.unregister();
})()));`;

export function devServiceWorkerPlugin(): Plugin {
    return {
        name: "everydashcam-dev-service-worker",
        apply: "serve",
        transformIndexHtml: {
            order: "pre",
            handler(html) {
                return html.replace('src="/src/app.ts"', 'src="/src/dev-entry.ts"');
            },
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if ((req.url ?? "").split("?")[0] !== "/sw.js") return next();
                res.setHeader("content-type", "text/javascript");
                res.setHeader("cache-control", "no-store");
                res.end(RETIRE_WORKER);
            });
        },
    };
}
