// The one module that imports mediabunny directly (Biome noRestrictedImports
// enforces it for src/). Application code imports the library from here, so
// every bundle that carries a copy - the main thread and each worker - routes
// the library's diagnostics into src/log.ts before any of its code runs.

import { Logging, LogLevel } from "mediabunny";
import { createLogger } from "./log.js";
import { createMediabunnyLogForwarder } from "./mediabunny-log-bridge.js";

export * from "mediabunny";

// Marks the library instance, not this module: a test runner may evaluate this
// module again over an already loaded library, and listeners must stay single.
const BRIDGE_INSTALLED = Symbol.for("everydashcam.mediabunny-log-bridge");
const loggingInstance = Logging as unknown as Record<symbol, boolean | undefined>;
if (!loggingInstance[BRIDGE_INSTALLED]) {
    loggingInstance[BRIDGE_INSTALLED] = true;
    const forward = createMediabunnyLogForwarder(createLogger("mediabunny"));
    // Silent only mutes the library's console output; its events still fire.
    Logging.level = LogLevel.Silent;
    Logging.on("error", (args) => forward("error", args));
    Logging.on("warn", (args) => forward("warn", args));
    Logging.on("info", (args) => forward("info", args));
}
