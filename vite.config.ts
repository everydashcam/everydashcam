/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { minify as minifyHtml } from "html-minifier-terser";
import { defineConfig } from "vite";
import { documentPagesPlugin } from "./vite-plugins/document-pages.js";
import { cspHashPlugin } from "./vite-plugins/csp-hash.js";
import {
    profileRequiresGlobalNoIndex,
    resolveSeoDeploymentContext,
} from "./vite-plugins/deployment-profile.js";
import { dynamicBaselinePlugin } from "./vite-plugins/dynamic-baseline.js";
import { editionMarkupPlugin } from "./vite-plugins/edition-markup.js";
import { deploymentAssetsPlugin } from "./vite-plugins/deployment-assets.js";
import { devServiceWorkerPlugin } from "./vite-plugins/dev-service-worker.js";
import { indexnowKeyPlugin } from "./vite-plugins/indexnow-key.js";
import { llmsTxtPlugin } from "./vite-plugins/llms-txt.js";
import { lazyBoundariesPlugin } from "./vite-plugins/lazy-boundaries.js";
import { computeMapStyles, mapStylesPlugin } from "./vite-plugins/map-styles.js";
import { migrationPagePlugin } from "./vite-plugins/migration-page.js";
import { redirectsPlugin } from "./vite-plugins/redirects.js";
import { rootStubPlugin } from "./vite-plugins/root-stub.js";
import { portableDownloadsPlugin } from "./vite-plugins/portable-downloads.js";
import { staticSearchMetaPlugin } from "./vite-plugins/static-search-meta.js";
import { standaloneFontsPlugin } from "./vite-plugins/standalone-fonts.js";
import { computeTrackerAssets, trackerAssetsPlugin } from "./vite-plugins/tracker-assets.js";
import { swPrecachePlugin } from "./vite-plugins/sw-precache.js";
import { getSeoLocales, i18nPrerenderPlugin, sitemapPlugin } from "./vite-plugins/seo-prerender.js";
import { alternativePagesPlugin } from "./vite-plugins/alternative-pages.js";
import { featurePagesPlugin } from "./vite-plugins/feature-pages.js";
import { vendorPagesPlugin } from "./vite-plugins/vendor-pages.js";

// App version for the footer, logs and diagnostics. A tagged checkout - the
// production deploy and the release artifact both check out the tag - reports
// the release id (v2026.07.27); anything else falls back to the git short
// SHA. Either form gets -dirty if the working copy has uncommitted changes.
// Computed once at vite startup (dev-server or build) and passed into code
// via `define: { __APP_VERSION__: ... }`. If the repo is not a git checkout
// (unpacked archive or CI without .git) - "unknown".
function getAppVersion(): string {
    try {
        let id: string;
        try {
            id = execSync("git describe --tags --exact-match HEAD", {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        } catch {
            id = execSync("git rev-parse --short HEAD", {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        }
        let dirty = false;
        try {
            // exit 0 = clean, exit 1 = has changes (execSync throws).
            execSync("git diff --quiet HEAD --", { stdio: "ignore" });
        } catch {
            dirty = true;
        }
        return dirty ? `${id}-dirty` : id;
    } catch {
        return "unknown";
    }
}
const APP_VERSION = getAppVersion();

// HTML minification (Vite does not do it by default, only JS/CSS). Applied
// via transformIndexHtml in the "post" phase - after all asset-injection
// processing. Strips comments, collapses whitespace, minifies inline scripts
// (JSON-LD is left alone - its type is "application/ld+json", not text/javascript).
// removeScriptTypeAttributes is disabled on purpose: otherwise Vite's entry
// script loses its type="module" and the app fails to load.
function minifyHtmlPlugin() {
    return {
        name: "minify-html",
        apply: "build" as const,
        transformIndexHtml: {
            order: "post" as const,
            handler: async (html: string) => {
                return await minifyHtml(html, {
                    collapseWhitespace: true,
                    removeComments: true,
                    minifyCSS: true,
                    minifyJS: true,
                    useShortDoctype: true,
                    removeRedundantAttributes: true,
                    removeStyleLinkTypeAttributes: true,
                    removeScriptTypeAttributes: false,
                    removeAttributeQuotes: false,
                    sortAttributes: true,
                    sortClassName: true,
                });
            },
        },
    };
}

// VITE_NO_INDEX flags a build whose output should stay out of search engine
// indexes. Set as an env-var on the staging CF Pages project; production
// project leaves it unset. When set:
//   - <meta name="robots" content="noindex, nofollow"> goes into every
//     prerendered HTML (landing /, /ru/, /cameras/, /ru/cameras/, all
//     vendor pages), and the root stub gets its noindex
//   - dist/_headers gets an `X-Robots-Tag: noindex` rule for /* (covers
//     non-HTML responses: og-cover.png, sitemap.xml)
//   - robots.txt is rewritten to ALLOW crawling - a Disallow would hide
//     both noindex signals from crawlers (a disallowed URL is never
//     fetched) and externally-linked URLs could be indexed content-less.
//     See SeoBuildOptions in vite-plugins/seo-prerender.ts.
const SEO_DEPLOYMENT = resolveSeoDeploymentContext();
const NO_INDEX =
    process.env.VITE_NO_INDEX === "1" ||
    process.env.VITE_NO_INDEX === "true" ||
    profileRequiresGlobalNoIndex(SEO_DEPLOYMENT);

// Sentry instrumentation is enabled only when all three build-time secrets are
// present. The plugin injects release/debug IDs in the exact build that produces
// the deployed assets, but the network upload runs as a bounded, non-fatal
// workflow step after Vite exits. Keeping uploads out of Vite's writeBundle
// hook prevents a Sentry API outage from hanging the entire deploy. Public source
// maps remain available for DevTools even without Sentry credentials.
const SENTRY_INSTRUMENTATION = Boolean(
    process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default defineConfig(({ command }) => {
    // Snapshot bytes once for both the manifest and dev/build delivery.
    const trackerAssets = computeTrackerAssets(command);
    const mapAssets = computeMapStyles(command);
    return {
    define: {
        __DC_MAP_STYLES__: JSON.stringify(mapAssets.urls),
        __PORTABLE__: "false",
        __PORTABLE_LOCALE__: JSON.stringify(""),
        __PORTABLE_MAP_ASSETS__: "{}",
        // Available across app code as `__APP_VERSION__: string`. Inlined
        // literally by the minifier (Oxc) - typed in `src/version.ts`.
        __APP_VERSION__: JSON.stringify(APP_VERSION),
        // Generic build origin tag for diagnostics. SEO ownership details and
        // mirror hostname/locales remain build-only in SEO_MIRROR_CONFIG.
        __DEPLOYMENT_PROFILE__: JSON.stringify(SEO_DEPLOYMENT.profile),
        // Shared binary metadata for the download gate and inference workers.
        __DC_TRACKER_ASSETS__: JSON.stringify(trackerAssets.app),
        // Tree-shake Sentry's tracing + debug scaffolding out of the errors-only
        // build. Safe ONLY because src/sentry.ts never imports the tracing/replay
        // integrations nor calls startSpan() - flipping __SENTRY_TRACING__ to
        // false while using tracing APIs would break them. See Sentry's
        // tree-shaking docs.
        __SENTRY_DEBUG__: JSON.stringify(false),
        __SENTRY_TRACING__: JSON.stringify(false),
    },
    plugins: [
        devServiceWorkerPlugin(),
        migrationPagePlugin(),
        editionMarkupPlugin(),
        // Legal/support source templates emit localized documents and legacy stubs.
        documentPagesPlugin({ noIndex: NO_INDEX }),
        // Dev-only: serve public/<slug>.html for its extension-less clean URL
        // (/add-my-camera, /privacy, ...). Cloudflare Pages (prod) and `vite
        // preview` resolve clean URLs to the .html automatically; `vite dev`
        // does not - a bare /add-my-camera falls through to the app-shell
        // index.html, so footer links open the main app while reviewing
        // locally. Reads the file directly (order-independent, no reliance on
        // the public-serving middleware position). The `public/<slug>.html`
        // existence gate means this never shadows the app's locale routes
        // (/en/, /ru/, ...) or hashed assets. Build/preview unaffected.
        {
            name: "everydashcam-dev-clean-html",
            apply: "serve",
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    const path = (req.url ?? "").split("?")[0] ?? "";
                    if (/^\/[a-z0-9-]+$/i.test(path)) {
                        const file = resolve(process.cwd(), "public", `${path.slice(1)}.html`);
                        if (existsSync(file)) {
                            res.setHeader("Content-Type", "text/html; charset=utf-8");
                            res.end(readFileSync(file));
                            return;
                        }
                    }
                    next();
                });
            },
        },
        // Expands SEO-baseline placeholders in index.html (bootstrap lang list,
        // hreflang cluster, og:locale:alternate cluster) from SEO_LOCALES.
        // Runs in both dev and build; uses transformIndexHtml order:"pre" so
        // the expansion happens BEFORE minifyHtmlPlugin (which is "post").
        dynamicBaselinePlugin(),
        // IndexNow proof-of-ownership file from INDEXNOW_KEY env; no env ->
        // no file (forks, local dev). See vite-plugins/indexnow-key.ts for
        // why the key is NOT a committed public/ file.
        indexnowKeyPlugin(),
        minifyHtmlPlugin(),
        lazyBoundariesPlugin(),
        standaloneFontsPlugin(),
        mapStylesPlugin(mapAssets),
        // SEO build pipeline. All three plugins run in closeBundle, AFTER vite
        // has written dist/index.html and html-minifier has minified it. See
        // vite-plugins/seo-prerender.ts for the rationale (hreflang, two
        // per-locale static URLs, structured data, sitemap). Vendor pages
        // emit per-vendor /cameras/<slug>/ static HTML for SERP long-tail.
        // noIndex flips staging deploys to noindex+Disallow without changing
        // production behavior.
        i18nPrerenderPlugin(getSeoLocales(), { noIndex: NO_INDEX }),
        vendorPagesPlugin({ noIndex: NO_INDEX }),
        // Competitor "alternative-to" landing pages: /<lang>/alternatives/<slug>/
        // + the /<lang>/alternatives/ hub. Same machinery as vendor pages,
        // captures navigational demand for the retained dashcam tools (Dashcam
        // Viewer, CamGeoPlayer, Telemetry Overlay). See alternative-pages.ts.
        alternativePagesPlugin({ noIndex: NO_INDEX }),
        // Use-case landing pages: /<lang>/<feature-slug>/ (slug list =
        // FeatureSlug in vite-plugins/feature-pages.ts). Same machinery as the
        // vendor / alternative plugins; surfaces capabilities the homepage
        // buries (merge, overlay, privacy blur).
        featurePagesPlugin({ noIndex: NO_INDEX }),
        sitemapPlugin({ noIndex: NO_INDEX }),
        // rootStubPlugin overwrites dist/index.html with a redirect stub
        // AFTER i18nPrerenderPlugin has read it as the baseline for the
        // per-locale outputs. The stub redirects (meta refresh + JS) with
        // canonical → /en/, contains the same bootstrap as locale pages
        // (one CSP hash for both), and JS-redirects every visitor to
        // /<lang>/ on the client. noIndex (staging) adds a robots noindex
        // meta; production carries no robots meta - Google treats the
        // instant meta-refresh as a redirect, and mixing noindex with a
        // canonical sends conflicting signals. Must run BEFORE cspHashPlugin
        // so the hash plugin sees the stub's bootstrap (identical to locale
        // pages by construction).
        rootStubPlugin({ noIndex: NO_INDEX }),
        // public/*.html bypasses Vite's HTML transform hooks. Apply the same
        // search policy to those standalone documents before CSP and precache
        // hash their final bytes.
        staticSearchMetaPlugin({ noIndex: NO_INDEX, deployment: SEO_DEPLOYMENT }),
        // Generate site redirects before portable publication adds stable downloads.
        redirectsPlugin(),
        // Unit tests must not depend on locally staged download artifacts.
        !process.env.VITEST && portableDownloadsPlugin(),
        // CSP for the inline bootstrap: 'sha256-...' into dist/_headers, plus
        // (META_CSP=1 builds) the policy as a <meta> in every HTML for hosts
        // that cannot send headers. MUST run AFTER every HTML-writing plugin
        // above (the hash and the meta need the final markup) and BEFORE
        // swPrecachePlugin - the precache manifest hashes the shells, so a
        // later HTML edit would break offline reconciliation.
        cspHashPlugin({
            stripCloudflareAnalytics:
                process.env.DISABLE_CLOUDFLARE_ANALYTICS === "1" ||
                process.env.DISABLE_CLOUDFLARE_ANALYTICS === "true",
        }),
        // Emit immutable inference files before Workbox collects the finished build.
        trackerAssetsPlugin(trackerAssets),
        swPrecachePlugin(),
        deploymentAssetsPlugin([...trackerAssets.urls, ...mapAssets.files.keys()]),
        // llms.txt for AI agents (Claude, Perplexity, ChatGPT). Independent
        // of noIndex - the file lists production URLs, so even on staging
        // it points agents at the canonical site. See vite-plugins/llms-txt.ts.
        llmsTxtPlugin(),
        // Source-map preparation for the hosted builds. The plugin injects a
        // debug ID into every chunk, but deliberately performs no Sentry API
        // calls: deploy/release workflows upload with a step timeout and retain
        // maps in the published dist. release.name = APP_VERSION
        // (tag or short git SHA) matches the runtime release in sentry-init.ts.
        // The plugin only mangles chunk assets, not the inline bootstrap, so
        // the CSP hash above stays valid.
        ...(SENTRY_INSTRUMENTATION
            ? [
                  sentryVitePlugin({
                      org: process.env.SENTRY_ORG,
                      project: process.env.SENTRY_PROJECT,
                      authToken: process.env.SENTRY_AUTH_TOKEN,
                      release: {
                          name: APP_VERSION,
                          create: false,
                          finalize: false,
                          setCommits: false,
                          deploy: false,
                      },
                      telemetry: false,
                      sourcemaps: {
                          disable: "disable-upload",
                      },
                  }),
              ]
            : []),
    ],
    build: {
        target: "es2022",
        // Public sources let DevTools debug the deployed build without Sentry.
        // Separate maps stay out of the runtime boot graph and PWA precache.
        sourcemap: true,
        outDir: "dist",
        // SVG icons and small assets up to 8KB get inlined into JS/CSS - fewer HTTP requests.
        assetsInlineLimit: 8192,
        cssMinify: true,
        // Our browser floor (current/previous major, 2025+) natively supports
        // <link rel=modulepreload>, so Vite's polyfill fallback is dead weight
        // on the landing page's critical path (CLAUDE.md: we don't write
        // fallbacks for outdated APIs). Not needed for offline either - we load
        // from the SW cache.
        modulePreload: { polyfill: false },
        // Oxc - Vite 8's default minifier (the unified Rust toolchain, Rolldown/Oxc).
        // console is NOT dropped: all logs go through the runtime-gated logger
        // (src/log.ts); prod default is warn, and the user can enable debug/info
        // via localStorage for bug reports (the primary diagnostic channel, since
        // there's no backend - see CLAUDE.md "Logging"). Oxc keeps console calls
        // by default, which is exactly what we want.
        minify: "oxc",
        rolldownOptions: {
            output: {
                // Strip ALL comments, including dependency license banners
                // (mediabunny MPL `/*!...`). Oxc keeps legal comments by
                // default, and bundling duplicates them dozens of times (once
                // per module/worker) - pure bloat. Matches the previous terser
                // `format.comments:false`. This covers only the main-thread
                // graph; workers are stripped via `worker.rolldownOptions` below.
                comments: false,
                // Vendor splitting: npm dependencies are moved into separate
                // named chunks - on Cloudflare Pages this gives a good cache-hit
                // rate for returning visitors (vendor changes rarely, the app
                // chunk redeploys often). A group does NOT make its chunk eager:
                // reachability decides that, so a lazily-imported package listed
                // here still lands in an async chunk.
                //
                // vendor-media is the one group that exists for correctness, not
                // caching. Left to itself, Rolldown slices mediabunny by which
                // entries reach each module, and the slices end up importing each
                // other: `sample.js` calls polyfillSymbolDispose() from
                // `misc.js` at module top level while `index.js` re-exports
                // `sample.js` back, so whichever chunk evaluates first reads a
                // binding the other has not assigned yet. mediabunny's own module
                // graph is acyclic - the cycle is created by the split - and it
                // fails only at runtime ("... is not a function" on first
                // ingest), never at build time. One group, one chunk, no cycle.
                // The other lazy libs are left ungrouped - Rolldown splits
                // chart.js too, but acyclically, and a split is only a hazard
                // when the pieces reference each other's top-level bindings.
                // (Workers bundle their own copy of mediabunny independently -
                // this is main-thread graph only.)
                // Eager dependency boundaries are checked by lazyBoundariesPlugin.
                //
                // The object form of manualChunks was removed in Rolldown; the
                // equivalent is codeSplitting.groups with { name, test }: test
                // matches a module by its node_modules path, the group pulls in
                // its dependencies too.
                codeSplitting: {
                    groups: [
                        { name: "vendor-i18n", test: /node_modules[\\/]intl-messageformat[\\/]/ },
                        { name: "vendor-media", test: /node_modules[\\/]mediabunny[\\/]/ },
                    ],
                },
            },
        },
    },
    // Workers are a SEPARATE build graph (their own Rolldown pass); the
    // build.rolldownOptions above does not reach them. Each worker bundles its
    // own copy of mediabunny, so without this each one carries dozens of
    // duplicated MPL license banners. Strip comments here too. We set ONLY
    // output.comments - Vite fills in the worker format/entry itself (merged,
    // not overwritten).
    worker: {
        rolldownOptions: {
            output: {
                comments: false,
            },
        },
    },
    // onnxruntime-web/wasm is only reachable through the blur-zone tracker
    // worker, and Vite's cold-start dep scanner does not crawl worker entry
    // points - so it is discovered LATE, on the first track pass, which forces a
    // mid-session re-optimize + browserHash bump. That strands the mediabunny
    // copy already loaded by the export/preview workers: two live instances
    // ("Mediabunny was loaded twice"), and the cross-instance InputFormat
    // instanceof check in `new Input({ formats })` then throws "options.formats
    // must be an array of InputFormat". Pre-bundling it up front keeps the
    // browserHash stable from the start. Dev-only concern - each worker
    // self-bundles mediabunny once in the production build.
    optimizeDeps: {
        // Scan source entry points only: generated portable HTML can contain
        // large inline bundles and must not enter the dev dependency crawl.
        entries: ["index.html", "migrate/index.html"],
        include: ["onnxruntime-web/wasm", "onnxruntime-web/webgpu"],
    },
    server: {
        port: 5173,
        open: false,
    },
    preview: {
        port: 4173,
        // Cross-origin isolation for the perf-test harness:
        // performance.measureUserAgentSpecificMemory() (single source of truth
        // for total page memory including Web Workers) requires
        // `crossOriginIsolated == true`, which in turn requires both COOP and
        // COEP headers. Without them the API throws SecurityError and the
        // harness can only see main-thread JS heap - tests for tracking memory
        // regressions in transcode/preview/gps-extract workers are blind.
        //
        // Gated by PERF_TEST=1 so production preview (and everydashcam.app
        // itself) stay unchanged. COEP=require-corp can break third-party
        // assets that lack CORP headers (map tiles, analytics scripts) -
        // perf-tests run on an offline-ish localhost and don't depend on them.
        headers:
            process.env.PERF_TEST === "1"
                ? {
                      "Cross-Origin-Opener-Policy": "same-origin",
                      "Cross-Origin-Embedder-Policy": "require-corp",
                  }
                : undefined,
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        // Coverage is a reporting lens, not a gate: run on demand via
        // `npm run test:coverage`, read by a human to find untested logic. No
        // CI threshold - a number-chasing gate rewards asserting-nothing tests
        // and punishes DOM/worker code the node env cannot reach anyway. Only
        // activates under --coverage, so plain `npm test` is unaffected.
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "json-summary"],
            reportsDirectory: "tests/coverage",
            include: ["src/**/*.ts"],
            exclude: [
                "src/**/*.test.ts",
                "src/**/*.bench.ts",
                "src/**/__fixtures__/**",
                "src/types/**",
            ],
        },
    },
    // Disable PostCSS config auto-discovery. Without this, Vite walks the
    // filesystem upward looking for postcss.config.* and may pick up a config
    // from an unrelated nested repo (e.g. a clone inside private/
    // for research) that depends on devDeps we do not have installed. Our CSS
    // pipeline does not need PostCSS plugins - empty object short-circuits.
    css: { postcss: {} },
    };
});
