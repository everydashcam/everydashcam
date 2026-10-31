// This entry is injected only by the dev server, before the app can accept
// local files. Unregistering does not release the current page's controller;
// one navigation is necessary to stop it serving stale Vite modules.
import { prepareDevPage } from "./ui/dev-service-worker.js";

if (await prepareDevPage()) await import("./app.js");
