import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import { portablePlugin, portableMapAssets } from "./vite-plugins/portable.js";

// This config never imports the hosted config or loads a checkout's .env files.
export default defineConfig((): UserConfig => {
    const locale = process.env.DC_PORTABLE_LOCALE;
    const version = process.env.DC_PORTABLE_VERSION;
    const filename = process.env.DC_PORTABLE_FILENAME;
    const fullVersionUrl = process.env.DC_PORTABLE_FULL_VERSION_URL;
    const yandexTilesKey = process.env.PORTABLE_YANDEX_TILES_API_KEY?.trim() ?? "";
    if (!locale || !version || !filename || !fullVersionUrl) {
        throw new Error("use npm run build:portable to supply portable build inputs");
    }
    const resourcePlugin = () =>
        portablePlugin({ locale, version, filename, fullVersionUrl, hasYandexTilesKey: yandexTilesKey.length > 0 });
    return {
        envDir: false,
        envPrefix: "DC_PORTABLE_UNUSED_",
        publicDir: false,
        define: {
            __PORTABLE__: "true",
            __PORTABLE_LOCALE__: JSON.stringify(locale),
            __PORTABLE_MAP_ASSETS__: JSON.stringify(portableMapAssets()),
            __APP_VERSION__: JSON.stringify(version),
            __DEPLOYMENT_PROFILE__: JSON.stringify("portable"),
            __DC_TRACKER_ASSETS__: "{}",
            __SENTRY_DEBUG__: "false",
            __SENTRY_TRACING__: "false",
            "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(""),
            "import.meta.env.VITE_DEFAULT_MAP_PROVIDER": JSON.stringify(""),
            "import.meta.env.VITE_YANDEX_TILES_API_KEY": JSON.stringify(yandexTilesKey),
        },
        resolve: {
            alias: [
                { find: /^\.\/styles\/index\.css$/, replacement: resolve("src/portable/styles.css") },
                {
                    find: /^.*\/blur-(?:track|detect|assets)\.js$/,
                    replacement: resolve("src/portable/blur-disabled.ts"),
                },
                { find: /^.*\/map-style-source\.js$/, replacement: resolve("src/portable/map-style-source.ts") },
                {
                    find: /^\.\/(?:components\/(?:offline-banner|footer|lang-banner|wco)|modals\/(?:whats-new|offline-use))\.css$/,
                    replacement: resolve("src/portable/web-only.css"),
                },
            ],
        },
        plugins: [resourcePlugin()],
        css: { postcss: {} },
        // Classic workers, unlike the hosted build: inline workers start from a
        // blob: URL, and Chromium refuses a module worker from a blob: URL on a
        // file: page ("Refused to cross-origin redirects of the top-level worker
        // script."). Vite's inline wrapper falls back to a data: URL only on a
        // synchronous throw, so every worker would fail to load there.
        worker: { format: "iife", plugins: () => [resourcePlugin()] },
        build: {
            target: "es2022",
            outDir: process.env.DC_PORTABLE_OUT_DIR || "dist-portable",
            emptyOutDir: false,
            cssCodeSplit: false,
            modulePreload: false,
            assetsInlineLimit: Number.MAX_SAFE_INTEGER,
            sourcemap: false,
            rolldownOptions: {
                input: resolve("src/app.ts"),
                output: { codeSplitting: false },
            },
        },
    };
});
