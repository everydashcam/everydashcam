// SEO build pipeline for everydashcam. Two plugins:
//
//  - i18nPrerenderPlugin: takes dist/index.html (already minified by
//    minifyHtmlPlugin) and emits a per-locale static version. For "en" it
//    overwrites dist/index.html; for the other 11 locales it writes
//    dist/<urlSegment>/index.html. Per locale we substitute:
//      - <html lang>
//      - <link rel="canonical">           - self-referencing locale URL
//      - <meta http-equiv="content-language"> - HTTP locale (en-US, ru-RU...)
//      - <meta property="og:url">         - same self-referencing URL
//      - <meta property="og:locale">      - en_US / ru_RU / ...
//      - <meta property="og:locale:alternate"> × 11 - all OTHER locales
//      - <meta property="og:title">       - short ≤60 chars, locale-tuned
//      - <meta property="og:description"> - locale-tuned summary
//      - <meta name="twitter:*">          - same as og:* counterparts
//      - hreflang block                   - same complete graph across locales
//      - data-i18n="key" textContent      - from dictionary
//      - data-i18n-attr="..." attributes  - from dictionary
//      - <script id="faq-jsonld">         - locale FAQ for FAQ-rich-snippets
//      - WebApplication JSON-LD           - locale description + URL
//
//    Why all locales: with just / and /ru/ prerendered the other markets
//    (de, es, fr, ja, ko, pl, pt, zh) get only an English HTML with
//    runtime JS-swap - search engines either skip the locale or rank it as a
//    duplicate of EN. Each locale needs its own static HTML with translated
//    meta and self-referencing canonical to compete in its own SERP.
//
//    Runtime JS-swap (applyStaticI18n) keeps working - data-i18n attributes
//    are preserved. If a user hits /de/ but had localStorage="pl", JS swaps
//    the static German text to Polish. detectInitialLang now prefers URL
//    over localStorage so this scenario is uncommon, but the safety net stays.
//
//  - sitemapPlugin: writes dist/sitemap.xml with all locale URLs + vendor
//    pages + privacy.html. Each <url> carries xhtml:link alternates pointing
//    to ALL indexable locale variants of THAT specific URL (complete graph
//    matches the in-HTML hreflang). <lastmod> is emitted only when a URL has
//    independently trackable source history (see git-mtime.ts). Programmatic
//    families backed by shared monolithic files omit it; a shared file mtime
//    would falsely claim that every generated URL changed together.
//
// HTML rewriting is regex-based - the source HTML is under our control,
// attribute order is stable post-minifier-terser (sortAttributes: true),
// and data-i18n elements never contain child HTML (only plain text).
// Adding a real HTML parser (cheerio, parse5) would pull in 200KB+ of
// devDep weight for no functional gain. If a future change breaks the
// regex assumptions, the prerender will silently skip - that lands the
// English literal on every locale, which is still a valid fallback.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import type { I18nKey, Lang } from "../src/i18n/index.js";
import { deDict } from "../src/i18n/de.js";
import { enDict } from "../src/i18n/en.js";
import { esDict } from "../src/i18n/es.js";
import { frDict } from "../src/i18n/fr.js";
import { jaDict } from "../src/i18n/ja.js";
import { koDict } from "../src/i18n/ko.js";
import { plDict } from "../src/i18n/pl.js";
import { ptDict } from "../src/i18n/pt.js";
import { ruDict } from "../src/i18n/ru.js";
import {
    buildHreflangAlternatesMap,
    getDefaultSeoLocale,
    getHreflangCodes,
    getIndexableSeoLocales,
    type SeoLocale,
} from "../src/i18n/seo-config.js";
import {
    PRIMARY_SITE_ORIGIN,
    canonicalLocaleUrl,
    canonicalOriginForLocale,
    currentSiteOrigin,
    searchIndexingMeta,
    profileOwnsCanonicalUrl,
} from "./deployment-profile.js";
import { zhDict } from "../src/i18n/zh.js";
import { getGitMtimeIso, maxGitMtimeIso } from "./git-mtime.js";
import { escapeAttr, escapeText, stringifyJsonLd } from "./html-utils.js";
import { renderSeoLanguageLinks } from "./seo-navigation.js";
import { getAllBrandsCommaSeparated, getLandingBrands } from "./supported-brands.js";
import { getAlternativeSitemapEntries } from "./alternative-pages.js";
import { getFeatureListings, getFeatureSitemapEntries } from "./feature-pages.js";
import { getVendorSitemapEntries } from "./vendor-pages.js";

// Files that, when changed, invalidate every locale homepage URL. The
// homepage HTML is rebuilt from these on every locale - i18n dicts drive
// visible content, SEO config drives URL structure and meta, index.html
// is the baseline, the build plugins are the rewrite engine. A homepage
// URL's lastmod = max(git mtime of all of these). Per-locale dict adds
// to this set in sitemapPlugin (we don't list every dict here).
const HOMEPAGE_SHARED_SOURCES = [
    "index.html",
    "src/i18n/en.ts",
    "src/i18n/seo-config.ts",
    "src/i18n/languages.ts",
    "vite-plugins/seo-prerender.ts",
    "vite-plugins/dynamic-baseline.ts",
    "vite-plugins/seo-navigation.ts",
    "vite-plugins/supported-brands.ts",
    // html-utils provides escapeAttr / escapeText / stringifyJsonLd -
    // any change to escaping rules mutates the rendered HTML, so it
    // counts as a content change for lastmod purposes.
    "vite-plugins/html-utils.ts",
];

// Dictionaries keyed by Lang code. Duplicates src/i18n/index.ts's private
// `dictionaries` map - we don't import that one because the file pulls in
// the runtime IntlMessageFormat / EventTarget code that has no place in a
// Node build plugin. Adding a locale: append a dict here AND in
// src/i18n/index.ts.
const DICTS: Record<Lang, Record<I18nKey, string>> = {
    de: deDict,
    en: enDict,
    es: esDict,
    fr: frDict,
    ja: jaDict,
    ko: koDict,
    pl: plDict,
    pt: ptDict,
    ru: ruDict,
    zh: zhDict,
};

// Hand-tuned short copies for unfurl previews (Slack, Telegram, Twitter,
// Facebook). Falls back to dict["page.title"] / dict["meta.description"]
// when a locale is not listed - keeps the prerender working for 10
// community locales without dictating extra translation keys.
//
// Reason for the override: dict["page.title"] ends with " | everydashcam"
// for SERP recognition, which wastes space in a 60-char OG title.
// dict["meta.description"] is ~200 chars - fine for SERP but Twitter
// cards crop at ~125. Where we have hand-written shorter copies we use
// them; elsewhere we accept a slightly truncated longer line.
interface OgOverride {
    ogTitle?: string;
    ogDescription?: string;
    twitterDescription?: string;
}

const OG_OVERRIDES: Partial<Record<Lang, OgOverride>> = {
    en: {
        ogTitle: "Free Dashcam Player & Editor — GPS map, trim & export",
        ogDescription:
            "Watch dashcam recordings with a route map and speed chart. Combine cameras and save clips in your browser. Free and open source.",
        twitterDescription:
            "Watch and edit dashcam recordings in your browser, with a route map and speed chart. Free and open source.",
    },
    ru: {
        ogTitle: "Бесплатный плеер и редактор видеорегистратора — GPS, обрезка",
        ogDescription:
            "Смотри записи регистратора с картой маршрута и графиком скорости. Объединяй камеры и сохраняй фрагменты в браузере. Бесплатно, с открытым кодом.",
        twitterDescription:
            "Смотри и редактируй записи регистратора в браузере, с картой маршрута и графиком скорости. Бесплатно, с открытым кодом.",
    },
};

// Options applied to all SEO build plugins. Single env-driven flag so far
// (noIndex), but kept as an interface so future per-env knobs add cleanly.
export interface SeoBuildOptions {
    // When true, every prerendered HTML gets a <meta name="robots"
    // content="noindex, nofollow"> in <head>, an `X-Robots-Tag: noindex`
    // header joins the global rule in dist/_headers (covers non-HTML responses:
    // og-cover.png, sitemap.xml), and robots.txt is rewritten to ALLOW
    // crawling. Wired to VITE_NO_INDEX in vite.config.ts - staging Pages
    // env sets it, production does not.
    //
    // Crawling stays allowed on purpose: a robots.txt Disallow would hide
    // both noindex signals from crawlers (a disallowed URL is never
    // fetched), and a URL known from an external link can then be indexed
    // content-less ("Indexed, though blocked by robots.txt" in GSC).
    // Letting the crawler fetch the page and meet the noindex is the
    // reliable way to stay out of the index.
    noIndex?: boolean;
}

/** Pages keys rules by path, so a second global rule replaces the security headers. */
export function addNoIndexHeader(headers: string): string {
    if ([...headers.matchAll(/^\/\*\r?$/gm)].length !== 1) {
        throw new Error("seo-prerender: expected exactly one global headers rule");
    }
    return headers.replace(/^\/\*(\r?\n)/m, "/*$1  X-Robots-Tag: noindex$1");
}

// Full per-locale config the plugin uses to render one HTML. Built from
// SEO_LOCALES + DICTS + OG_OVERRIDES inside getPrerenderLocales(). External
// callers pass either the default list or an override (used by tests).
export interface LocalePrerenderConfig {
    // Reference to the static SEO config entry (lang, urlSegment, ogLocale,
    // hreflang, contentLanguage, ogImage).
    seo: SeoLocale;
    // i18n dictionary - used to fill data-i18n / data-i18n-attr nodes AND to
    // assemble the FAQPage JSON-LD from the same fragments the DOM renders
    // (see buildFaqJsonLd). Single source of truth for visible text.
    dict: Record<I18nKey, string>;
    // Short OG title (≤60 chars), separate from dict["page.title"] - that
    // one targets SERP and runs ~70 chars; OG cards want it terser.
    // Falls back to a derived form of dict["page.title"] (strip site name).
    ogTitle: string;
    // OG description (~150 chars). Falls back to dict["meta.description"].
    ogDescription: string;
    // Twitter description, can differ from OG by being a bit terser.
    // Falls back to dict["meta.description"].
    twitterDescription: string;
}

// Build the full per-locale render configs from the SEO_LOCALES list.
// Exposed for tests that want to render a subset; vite.config.ts passes the
// default (all indexable locales).
export function getPrerenderLocales(): LocalePrerenderConfig[] {
    return getIndexableSeoLocales().map((seo) => {
        const dict = DICTS[seo.lang];
        const override = OG_OVERRIDES[seo.lang] ?? {};
        return {
            seo,
            dict,
            ogTitle: override.ogTitle ?? derivePageTitle(dict),
            ogDescription: override.ogDescription ?? dict["meta.description"],
            twitterDescription: override.twitterDescription ?? dict["meta.description"],
        } satisfies LocalePrerenderConfig;
    });
}

// Backwards compatibility: vite.config.ts and old callers ask for "seo locales"
// in the legacy shape. Returns the same data as getPrerenderLocales().
export function getSeoLocales(): LocalePrerenderConfig[] {
    return getPrerenderLocales();
}

// Strip the "... | everydashcam" tail and similar separators from a SERP-tuned
// page title to get a tighter OG title. Conservative: only cuts at the last
// " | ", which is the convention we use across all dictionaries.
function derivePageTitle(dict: Record<I18nKey, string>): string {
    const full = dict["page.title"];
    const sep = full.lastIndexOf(" | ");
    if (sep > 0) return full.slice(0, sep);
    return full;
}

export function i18nPrerenderPlugin(locales: LocalePrerenderConfig[], options: SeoBuildOptions = {}): Plugin {
    // No apply restriction (the dev middleware below must run under `vite dev`),
    // so closeBundle needs its own build guard: Vite's dev PluginContainer.close()
    // also invokes closeBundle hooks, and without the guard a Ctrl-C of the dev
    // server would silently (re)write dist/<lang>/index.html from a stale baseline.
    let isBuild = false;
    return {
        name: "everydashcam-i18n-prerender",
        configResolved(config) {
            isBuild = config.command === "build";
        },
        closeBundle() {
            if (!isBuild) return;
            const distDir = resolve(process.cwd(), "dist");
            const indexPath = resolve(distDir, "index.html");
            // Read the baseline HTML that Vite wrote to dist/index.html. This
            // is what we'll localize. After this plugin finishes, dist/index.html
            // will be overwritten by rootStubPlugin with the redirect stub -
            // root URL is no longer a content page.
            const baseHtml = readFileSync(indexPath, "utf-8");

            for (const locale of locales) {
                const localized = applyLocale(baseHtml, locale, options);
                const segment = locale.seo.urlSegment;
                // Every locale (including English at /en/) lives in its own
                // subdirectory now. urlSegment is non-empty by SEO_LOCALES
                // invariant - assert defensively because an empty segment
                // here would write to the wrong path silently.
                if (segment === "") {
                    throw new Error(
                        `i18n-prerender: locale "${locale.seo.lang}" has empty urlSegment - ` +
                            "every locale must live under /<segment>/ since the / root migration",
                    );
                }
                const targetDir = resolve(distDir, segment);
                mkdirSync(targetDir, { recursive: true });
                writeFileSync(resolve(targetDir, "index.html"), localized);
            }
        },
        configureServer(server) {
            // Dev middleware for /<lang>/ routes. Reads the source index.html,
            // runs Vite's transformIndexHtml chain (which expands the dynamic
            // baseline placeholders and injects vite-client / HMR), then runs
            // applyLocale on top so the served HTML has the locale's title,
            // canonical, og:locale, etc.
            //
            // Without this middleware, `npm run dev` on /de/ would fall to the
            // SPA index.html with English baseline strings - the lang switcher
            // would still work via the runtime data-i18n swap, but a user
            // sanity-checking the prerender output before deploy would see
            // misleading content.
            server.middlewares.use(async (req, res, next) => {
                if (req.method !== "GET" && req.method !== "HEAD") return next();
                const rawUrl = req.url ?? "/";
                const pathOnly = rawUrl.split(/[?#]/, 1)[0] ?? "/";

                // Only handle bare /<lang>/ URLs. Anything deeper (vendor pages,
                // assets) is handled by other middleware or by vite default.
                const segments = pathOnly.split("/").filter((s) => s.length > 0);
                if (segments.length !== 1) return next();
                const locale = locales.find((l) => l.seo.urlSegment === segments[0]);
                if (!locale) return next();

                try {
                    const sourceHtml = readFileSync(
                        resolve(server.config.root, "index.html"),
                        "utf-8",
                    );
                    // server.transformIndexHtml applies the full vite pipeline:
                    // our dynamicBaselinePlugin (placeholder expansion) +
                    // vite's HMR client injection. We then run applyLocale on
                    // the result.
                    const transformed = await server.transformIndexHtml(rawUrl, sourceHtml);
                    const localized = applyLocale(transformed, locale, options);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(req.method === "HEAD" ? "" : localized);
                } catch (err) {
                    server.config.logger.error(
                        `[i18n-prerender] failed to render ${pathOnly}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                    return next();
                }
            });
        },
    };
}

export function sitemapPlugin(options: SeoBuildOptions = {}): Plugin {
    return {
        name: "everydashcam-sitemap",
        apply: "build",
        closeBundle() {
            const distDir = resolve(process.cwd(), "dist");
            const indexable = getIndexableSeoLocales();

            // Homepage entries: one per locale, with full alternates pointing
            // at every other locale's homepage. The default locale (en)
            // signals priority 1.0, others 0.9 - convention, search engines
            // do not strictly require this but it signals the editorial
            // structure. The root "/" stub is intentionally NOT in the
            // sitemap (it's a noindex redirect page); only the /<lang>/
            // homepages are listed.
            const homepageAlternates = buildHreflangAlternatesMap(localeHomeUrl);
            const defaultLocale = getDefaultSeoLocale();
            const defaultLang = defaultLocale.lang;
            const defaultHomeUrl = localeHomeUrl(defaultLocale);
            const entries: SitemapEntry[] = [];
            for (const loc of indexable) {
                const url = localeHomeUrl(loc);
                // lastmod = max git-mtime of every source that contributes
                // to this URL's rendered HTML. Per-locale dict is included
                // alongside HOMEPAGE_SHARED_SOURCES so a translation-only
                // PR bumps the lastmod for that one locale, not the others.
                const lastmod = maxGitMtimeIso([
                    ...HOMEPAGE_SHARED_SOURCES,
                    `src/i18n/${loc.lang}.ts`,
                ]);
                entries.push({
                    loc: url,
                    changefreq: "weekly",
                    priority: loc.lang === defaultLang ? "1.0" : "0.9",
                    alternates: homepageAlternates,
                    // For homepage entries x-default points at the default
                    // locale's home (/en/), matching the policy used for
                    // sub-pages (vendor pages target their English variant).
                    // Uniform "English variant" across the whole graph.
                    xDefaultUrl: defaultHomeUrl,
                    lastmod: lastmod ?? undefined,
                });
            }

            // Vendor pages: emitted by vendor-pages.ts and described in
            // getVendorSitemapEntries(). They carry per-page alternates and
            // omit lastmod while their content shares monolithic files.
            entries.push(...getVendorSitemapEntries());

            // Competitor "alternative-to" pages: /alternatives/ hub + per
            // competitor, per locale. Same alternates and omitted-lastmod
            // policy as vendor pages (see getAlternativeSitemapEntries).
            entries.push(...getAlternativeSitemapEntries());

            // Use-case feature pages: /<lang>/<slug>/ for combine-cameras and
            // data-overlay, per locale. Same alternates and omitted-lastmod
            // policy as the vendor / alternative pages.
            entries.push(...getFeatureSitemapEntries());

            // Privacy is a standalone page with internal lang switcher
            // (see public/privacy.html). One URL, no alternates needed - hence
            // no xDefaultUrl either. lastmod = mtime of the HTML itself.
            //
            // Canonical URL is /privacy (no .html): CF Pages normalizes any
            // request to /privacy.html with a 308 to /privacy. Putting the
            // 308-redirecting URL in the sitemap was the previous form and
            // caused "Discovered - currently not indexed" in GSC because Google
            // dislikes redirecting URLs in sitemaps - it expects canonical /
            // 200-responding URLs there.
            entries.push({
                loc: `${PRIMARY_SITE_ORIGIN}/privacy`,
                changefreq: "monthly",
                priority: "0.3",
                lastmod: getGitMtimeIso("public/privacy.html") ?? undefined,
            });

            // Terms of use - same standalone / internal lang-switcher shape
            // as privacy (public/terms.html), same canonical rules.
            entries.push({
                loc: `${PRIMARY_SITE_ORIGIN}/terms`,
                changefreq: "monthly",
                priority: "0.3",
                lastmod: getGitMtimeIso("public/terms.html") ?? undefined,
            });

            // "Help us add your dashcam" page - same standalone / internal
            // lang-switcher shape as privacy (public/add-my-camera.html). One
            // extension-less URL, no alternates. It is a support / onboarding
            // funnel, so keep priority low.
            entries.push({
                loc: `${PRIMARY_SITE_ORIGIN}/add-my-camera`,
                changefreq: "monthly",
                priority: "0.3",
                lastmod: getGitMtimeIso("public/add-my-camera.html") ?? undefined,
            });

            // Each origin advertises only URLs it canonically owns. Alternates
            // inside those entries still form the complete cross-origin graph.
            const ownedEntries = entries.filter((entry) => profileOwnsCanonicalUrl(entry.loc));
            const xml = buildSitemap(ownedEntries);
            writeFileSync(resolve(distDir, "sitemap.xml"), xml);

            // Staging / preview deploys: overwrite the static robots.txt
            // (from public/, Vite copied as-is) and append a noindex header
            // rule to _headers. Crawling is deliberately ALLOWED - a
            // Disallow:/ would hide the noindex signals (meta robots in the
            // HTML, X-Robots-Tag in _headers) because a disallowed URL is
            // never fetched, and a URL known from an external link can then
            // be indexed content-less. The crawler must be able to fetch the
            // page to see "noindex"; see SeoBuildOptions.
            if (options.noIndex) {
                writeFileSync(
                    resolve(distDir, "robots.txt"),
                    [
                        "# Generated at build time because VITE_NO_INDEX is set.",
                        "# This deploy is a staging / preview environment and must stay out of",
                        "# search indexes. Crawling is allowed on purpose: every response carries",
                        "# X-Robots-Tag: noindex (see _headers), and a Disallow here would stop",
                        "# crawlers from ever seeing that signal.",
                        "User-agent: *",
                        "Allow: /",
                        "",
                    ].join("\n"),
                );
                const headersPath = resolve(distDir, "_headers");
                const existing = readFileSync(headersPath, "utf-8");
                writeFileSync(headersPath, addNoIndexHeader(existing));
            } else {
                const origin = currentSiteOrigin();
                writeFileSync(
                    resolve(distDir, "robots.txt"),
                    [
                        `# ${new URL(origin).hostname} robots.txt`,
                        "# Public web app, no backend, no private routes.",
                        "User-agent: *",
                        "Allow: /",
                        "",
                        `Sitemap: ${origin}/sitemap.xml`,
                        "",
                    ].join("\n"),
                );
            }
        },
    };
}

export interface SitemapEntry {
    loc: string;
    changefreq: string;
    priority: string;
    // Map from hreflang code → URL. If set, emits xhtml:link alternate entries
    // for that hreflang signal. For /cameras/70mai/ the alternates point at
    // the localized variants of THAT specific page (e.g. /de/cameras/70mai/),
    // not at site roots - otherwise crawlers think a vendor page's
    // translation is the homepage.
    alternates?: Record<string, string>;
    // Required whenever `alternates` is set. URL for the x-default hreflang
    // signal. Uniformly the English variant of THIS page across the whole
    // graph (homepage entries point at /en/, vendor entries at /en/cameras/<slug>/).
    xDefaultUrl?: string;
    // ISO 8601 datetime of the most recent change to this URL's source
    // files (git mtime). When omitted (file not tracked, git unavailable),
    // <lastmod> is skipped for that entry rather than stamped with build
    // date - per Google guidance, no signal beats a wrong signal.
    lastmod?: string;
}

// <lastmod> derivation policy: each caller passes the latest git committer
// date of the source files that produce the URL. Build date is intentionally
// NOT used as a fallback - a uniform "build date" on every entry trains
// crawlers to ignore the signal site-wide. <changefreq> and <priority> are
// weak signals (Google ignores them) but Yandex / Bing still parse them,
// so they stay.
function buildSitemap(entries: SitemapEntry[]): string {
    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
    for (const entry of entries) {
        lines.push("  <url>");
        lines.push(`    <loc>${entry.loc}</loc>`);
        if (entry.lastmod) {
            lines.push(`    <lastmod>${entry.lastmod}</lastmod>`);
        }
        lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
        lines.push(`    <priority>${entry.priority}</priority>`);
        if (entry.alternates) {
            for (const [hreflang, url] of Object.entries(entry.alternates)) {
                lines.push(`    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${url}"/>`);
            }
            // x-default targeting policy (uniform "English variant" everywhere):
            //  - homepage entries: point at /en/ (the default locale's home),
            //    NOT the root stub /. The root is a content-less noindex
            //    redirect - a poor x-default target for crawlers that follow it;
            //    /en/ carries the actual English fallback content. Set per entry
            //    via xDefaultUrl (see the homepage loop above, defaultHomeUrl).
            //  - vendor / sub-page entries: point at the English variant of that
            //    specific page (e.g. /en/cameras/70mai/). Same English-fallback
            //    rule, applied page-by-page.
            // The xDefaultUrl field is set per-entry by the caller; we
            // require it for any entry with alternates to avoid a silent
            // wrong x-default if the field is forgotten.
            if (!entry.xDefaultUrl) {
                throw new Error(`sitemap: entry ${entry.loc} has alternates but no xDefaultUrl`);
            }
            lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${entry.xDefaultUrl}"/>`);
        }
        lines.push("  </url>");
    }
    lines.push("</urlset>");
    return `${lines.join("\n")}\n`;
}

// Self-referencing absolute URL for a locale's homepage. Every locale,
// including English, lives under /<segment>/ - the root "/" is a redirect
// stub (rootStubPlugin), not a locale's home. Always slash-terminated -
// Cloudflare Pages 308-redirects /xx → /xx/, so we keep canonical URLs
// slash-terminated.
function localeHomeUrl(locale: SeoLocale): string {
    return canonicalLocaleUrl(locale);
}


// Exported for tests. Production callers go through i18nPrerenderPlugin.
export function applyLocale(html: string, locale: LocalePrerenderConfig, options: SeoBuildOptions): string {
    let out = html;
    const indexable = getIndexableSeoLocales();
    const selfUrl = localeHomeUrl(locale.seo);
    const canonicalOrigin = canonicalOriginForLocale(locale.seo);
    // hreflang x-default points at the default locale's home (/en/), not at
    // the root stub. Rationale: x-default is the content-fallback URL for
    // unmatched languages; our root "/" is a redirect-only stub with no
    // content, so it can't serve that role meaningfully. /en/ has the
    // English content that an unmatched-language visitor falls back to.
    // This matches the policy applied to sub-pages (vendor pages, /cameras/
    // index) where x-default targets the English variant of that page.
    // Mixed policy (root vs /en/ depending on the page type) is replaced
    // by uniform "English variant" everywhere.
    const xDefaultUrl = localeHomeUrl(getDefaultSeoLocale());

    // <html lang="...">: replace whatever value is there with the locale code.
    // The source HTML ships with "en"; for /ru/ we flip to "ru" so screen
    // readers and CSS :lang() see the right language for the document.
    out = out.replace(/<html([^>]*?)\blang="[^"]*"/i, (_m, rest) => `<html data-prerendered${rest}lang="${locale.seo.lang}"`);

    // canonical / og:url - self-referencing per locale. Without distinct
    // canonical, both URLs would canonicalize to / and the /ru/ page would
    // never rank.
    //
    // Anchor regex uses the closing quote of the rel/property value rather
    // than a trailing \b. \b expects a transition between word and non-word
    // chars; after `"` the next char is typically `>` (also non-word) and
    // \b does NOT match between two non-word chars - the regex would fail.
    out = replaceAttr(out, /<link\b[^>]*\brel="canonical"/i, "href", selfUrl);
    out = replaceAttr(out, /<meta\b[^>]*\bproperty="og:url"/i, "content", selfUrl);

    // Content-Language: HTTP-form locale code for Yandex / Baidu / Naver /
    // older Bing - they read this when hreflang is absent (Baidu, Naver do
    // not support hreflang at all). Anchor on http-equiv="content-language"
    // to avoid touching other meta tags.
    out = replaceAttr(
        out,
        /<meta\b[^>]*\bhttp-equiv="content-language"/i,
        "content",
        locale.seo.contentLanguage,
    );

    // og:locale uses BCP47 region form (en_US, ru_RU), not just the 2-letter code.
    // The closing quote in `property="og:locale"` is what distinguishes it from
    // `property="og:locale:alternate"` (which has the colon, not the quote,
    // after "og:locale") - so anchoring on the literal `"` is enough.
    out = replaceAttr(out, /<meta\b[^>]*\bproperty="og:locale"/i, "content", locale.seo.ogLocale);

    // og:locale:alternate cluster - point at every OTHER indexable locale.
    // Source HTML ships with 11 entries (all locales except en); we rewrite
    // them all to be {indexable} - {selfLocale}.
    out = rewriteOgLocaleAlternates(out, locale.seo, indexable);

    // hreflang cluster - rebuild the full graph. Every locale (including
    // English) emits a self-referencing /<lang>/ link plus 11 alternates
    // plus x-default → the default locale's home (/en/), per the uniform
    // "English variant" policy (see xDefaultUrl above). Google requires
    // symmetric / bidirectional links.
    out = rewriteHreflangBlock(out, indexable, xDefaultUrl);

    // og:title / twitter:title - locale-tuned short strings, used by Slack /
    // Telegram / Twitter previews. Not in the dict because dict["page.title"]
    // is long-form SERP-oriented; OG cards want ≤60 chars.
    out = replaceAttr(out, /<meta\b[^>]*\bproperty="og:title"/i, "content", locale.ogTitle);
    out = replaceAttr(out, /<meta\b[^>]*\bname="twitter:title"/i, "content", locale.ogTitle);

    // og:description / twitter:description overrides are applied AFTER the
    // data-i18n-attr swap below (see that block). Order matters: in index.html
    // these tags must NOT carry data-i18n-attr, but applying the override after
    // the swap makes the OG copy robust even if data-i18n-attr is ever re-added
    // to them - otherwise the swap would clobber it back to meta.description
    // (the bug this guards against). meta name="description" keeps its
    // data-i18n-attr and stays at dict["meta.description"] - only the social
    // cards diverge.

    // og:image / twitter:image - per-locale 1200x630 cover. Source HTML ships
    // with EN cover; we have hand-designed Russian cover at og-cover-ru.png;
    // other locales fall back to the EN cover (seo-config.ts decides per locale).
    const ogImage = `${canonicalOrigin}/${locale.seo.ogImage}`;
    out = replaceAttr(out, /<meta\b[^>]*\bproperty="og:image"/i, "content", ogImage);
    out = replaceAttr(out, /<meta\b[^>]*\bname="twitter:image"/i, "content", ogImage);

    // data-i18n="key" - replace textContent of the element. We rely on
    // data-i18n elements containing only plain text (no child HTML);
    // confirmed by grep at write-time of this plugin. If a future change
    // adds a child element, the regex won't match and we silently fall
    // back to the source literal.
    out = out.replace(
        /<([a-zA-Z][\w-]*)([^>]*?\bdata-i18n="([^"]+)"[^>]*?)>([^<]*)<\/\1>/g,
        (match, tag, attrs, key, _oldText) => {
            const value = locale.dict[key as I18nKey];
            if (value === undefined) return match;
            return `<${tag}${attrs}>${escapeText(value)}</${tag}>`;
        },
    );

    // data-i18n-attr="attr:key,attr:key" - set the listed attributes on the
    // same element. Same swap that applyStaticI18n() does at runtime; running
    // it at build time means crawlers see the localized values without JS.
    out = out.replace(/<([a-zA-Z][\w-]*)([^>]*\bdata-i18n-attr="([^"]+)"[^>]*)>/g, (_match, tag, allAttrs, spec) => {
        let newAttrs = allAttrs as string;
        for (const pair of spec.split(",")) {
            const [attr, key] = pair.split(":").map((s: string) => s.trim());
            if (!attr || !key) continue;
            const value = locale.dict[key as I18nKey];
            if (value === undefined) continue;
            newAttrs = setAttribute(newAttrs, attr, value);
        }
        return `<${tag}${newAttrs}>`;
    });

    // og:description / twitter:description - locale-tuned social-card copy,
    // applied here (after the data-i18n-attr swap above) so it is the final
    // word on these two tags regardless of whether they carry data-i18n-attr.
    // OG_OVERRIDES provides hand-tuned en/ru copy; other locales fall back to
    // dict["meta.description"] (see getPrerenderLocales).
    out = replaceAttr(out, /<meta\b[^>]*\bproperty="og:description"/i, "content", locale.ogDescription);
    out = replaceAttr(out, /<meta\b[^>]*\bname="twitter:description"/i, "content", locale.twitterDescription);

    // FAQPage JSON-LD - replace the body of the marked <script>. Crawlers
    // pick FAQ from the page's language, so we want the locale FAQ on each.
    out = out.replace(
        /(<script\b[^>]*\bid="faq-jsonld"[^>]*>)[\s\S]*?(<\/script>)/i,
        (_m, openTag: string, closeTag: string) => `${openTag}${buildFaqJsonLd(locale.dict)}${closeTag}`,
    );

    // i18n dictionary data island - bake the FULL active-locale dictionary in so
    // the runtime reads it synchronously (src/i18n/index.ts readI18nIsland), with
    // no dictionary JS shipped in the bundle. The island is type="application/json"
    // (inert data, no CSP script-src hash). Escape "<" -> < so a value that
    // contains "</script>" cannot break out of the tag; JSON.parse reverses it.
    // Fail loudly if the placeholder island is missing: without it the runtime
    // ships a blank UI on this locale.
    const beforeIsland = out;
    out = out.replace(
        /(<script\b[^>]*\bid="dc-i18n"[^>]*>)[\s\S]*?(<\/script>)/i,
        (_m, openTag: string, closeTag: string) =>
            `${openTag}${JSON.stringify(locale.dict).replace(/</g, "\\u003c")}${closeTag}`,
    );
    if (out === beforeIsland) {
        throw new Error(
            `seo-prerender: no <script id="dc-i18n"> data island found in baseline HTML for locale "${locale.seo.lang}" - ` +
                "the placeholder island in index.html is required so the runtime dictionary ships per locale",
        );
    }

    // WebApplication JSON-LD - the description field carries the locale
    // meta.description; URL is the self-referencing locale homepage. inLanguage
    // is unchanged (lists all supported locales, not the page's language).
    out = rewriteWebApplicationJsonLd(out, locale, selfUrl, canonicalOrigin);
    out = rewriteWebsiteJsonLd(out, canonicalOrigin);

    // Camera links prefer the current locale, but each brand has an explicit
    // publication set. Falling back to English keeps homepage links valid when
    // a localized brand page does not exist. The cameras hub exists everywhere.
    const defaultSegment = getDefaultSeoLocale().urlSegment;
    for (const brand of getLandingBrands()) {
        const segment = brand.locales.includes(locale.seo.lang)
            ? locale.seo.urlSegment
            : defaultSegment;
        out = out.replaceAll(
            `href="/cameras/${brand.slug}/"`,
            `href="/${segment}/cameras/${brand.slug}/"`,
        );
    }
    out = out.replaceAll(
        'href="/cameras/"',
        `href="/${locale.seo.urlSegment}/cameras/"`,
    );

    // Keep comparison links in the visitor's locale.
    out = out.replace(/href="\/alternatives\//g, `href="/${locale.seo.urlSegment}/alternatives/`);

    // Footer links to the use-case feature pages use bare "/<slug>/" baselines
    // (same reason as /cameras/ and /alternatives/ above); rewrite each to the
    // locale-prefixed form so a /de/ visitor stays on /de/. Looped over the slug
    // list so a new feature page is picked up without touching this rewrite.
    for (const { slug } of getFeatureListings()) {
        out = out.replace(new RegExp(`href="/${slug}/`, "g"), `href="/${locale.seo.urlSegment}/${slug}/`);
    }

    // noscript "Continue to everydashcam" link points at /en/ in the baseline
    // (so the source HTML view looks sensible and matches the data-i18n
    // English fallback). Per locale we rewrite it to /<segment>/ so a
    // JS-disabled visitor on /ru/ continues to /ru/, not back to /en/.
    // Same shape as the /cameras/ rewrite above; absolute URLs (canonical,
    // hreflang, og:url) are unaffected.
    out = out.replace(/href="\/en\/"/g, `href="/${locale.seo.urlSegment}/"`);

    out = out.replace(
        /<div\b[^>]*\bid="seo-language-links"[^>]*><\/div>/i,
        renderSeoLanguageLinks(locale.seo.lang, (target) => `/${target.urlSegment}/`),
    );

    out = out.replace(/<head>/i, `<head>${searchIndexingMeta(locale.seo, options.noIndex ?? false)}`);

    return out;
}

// Rebuild the og:locale:alternate cluster from scratch.
// Strategy: find every existing <meta property="og:locale:alternate" ...> tag,
// remove them as a contiguous block (replacing the span from first to last
// match), then inject a fresh set of N-1 tags (one per indexable locale OTHER
// than the self-locale). This is structurally identical to rewriteHreflangBlock
// and avoids the previous walk-and-replace fragility where the output count
// was tied to whatever count happened to live in the baseline HTML.
function rewriteOgLocaleAlternates(
    html: string,
    selfLocale: SeoLocale,
    indexable: ReadonlyArray<SeoLocale>,
): string {
    const tagRe = /<meta\b[^>]*\bproperty="og:locale:alternate"[^>]*>/gi;
    const matches: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(html)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
    }
    if (matches.length === 0) {
        throw new Error(
            "seo-prerender: no <meta property=\"og:locale:alternate\"> tags found in baseline HTML - " +
                "the baseline must carry at least one tag as an anchor for the rewrite",
        );
    }

    const others = indexable.filter((l) => l.lang !== selfLocale.lang);
    const replacement = others
        .map((loc) => `<meta property="og:locale:alternate" content="${loc.ogLocale}">`)
        .join("");
    const first = matches[0]!;
    const last = matches[matches.length - 1]!;
    return `${html.slice(0, first.start)}${replacement}${html.slice(last.end)}`;
}

// Rebuild the complete hreflang block. Strategy: find every existing
// <link rel="alternate" hreflang="..."> (12 + x-default in the source HTML),
// remove them as a contiguous block, then inject a fresh set inside the
// same position. The block lives in <head> and is contiguous in the source
// (kept that way for the regex to find).
//
// Throws on 0 matches: if the baseline ever ships without an hreflang block,
// every prerendered locale would emit a page with zero hreflang signals -
// catastrophic for SEO but silent (no test would notice). Better to fail
// loudly at build time.
function rewriteHreflangBlock(html: string, indexable: ReadonlyArray<SeoLocale>, xDefaultUrl: string): string {
    // The `\b` after the closing quote of `rel="alternate"` would NOT match -
    // \b requires a transition between a word char and a non-word char, and
    // both `"` and the following space are non-word. So we anchor on the
    // opening of the attribute value, not the closing.
    const linkRe = /<link\b[^>]*\brel="alternate"[^>]*\bhreflang="[^"]+"[^>]*>/gi;
    const matches: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(html)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
    }
    if (matches.length === 0) {
        throw new Error(
            "seo-prerender: no <link rel=\"alternate\" hreflang=...> tags found in baseline HTML - " +
                "hreflang cluster is required for multi-locale SEO",
        );
    }

    const first = matches[0]!;
    const last = matches[matches.length - 1]!;
    const linesArr = indexable.flatMap((loc) =>
        getHreflangCodes(loc).map(
            (code) => `<link rel="alternate" hreflang="${code}" href="${localeHomeUrl(loc)}">`,
        ),
    );
    linesArr.push(`<link rel="alternate" hreflang="x-default" href="${xDefaultUrl}">`);
    const replacement = linesArr.join("");
    return `${html.slice(0, first.start)}${replacement}${html.slice(last.end)}`;
}

// Rewrite the WebApplication JSON-LD block (anchored on id="webapp-jsonld") to
// carry the canonical application/site identifiers, locale description, the
// self-referencing URL, supported languages and supported brands. These values
// are derived from single sources of truth at build time so adding a locale
// or brand does not require touching the static JSON-LD literal in
// index.html separately:
//
//   - description ← locale.dict["meta.description"]
//   - url         ← per-locale self-referencing URL
//   - inLanguage  ← SEO_LOCALES (hreflang form)
//   - featureList ← the vendor-support entry is rewritten to list every brand
//     from SUPPORTED_BRANDS. The other featureList entries (capability lines
//     like "Plays MP4/MOV/MPEG-TS in the browser") are preserved as-is.
//
// The explicit id="webapp-jsonld" anchor avoids the previous fragility where
// the regex relied on attribute order produced by html-minifier-terser's
// sortAttributes - if the minifier ever ordered `id` before `type` on the FAQ
// script, the lookahead-based filter would have silently picked the wrong
// block. Anchoring on a unique id makes the match deterministic.
function rewriteWebApplicationJsonLd(
    html: string,
    locale: LocalePrerenderConfig,
    selfUrl: string,
    canonicalOrigin: string,
): string {
    const re = /(<script\b[^>]*\bid="webapp-jsonld"[^>]*>)([\s\S]*?)(<\/script>)/i;
    if (!re.test(html)) {
        throw new Error(
            'seo-prerender: <script id="webapp-jsonld"> not found in baseline HTML - ' +
                "WebApplication JSON-LD anchor is required for per-locale rewrite",
        );
    }
    return html.replace(re, (match, openTag: string, body: string, closeTag: string) => {
        try {
            const parsed: Record<string, unknown> = JSON.parse(body);
            if (parsed["@type"] !== "WebApplication") return match;
            parsed["@id"] = `${canonicalOrigin}/#webapp`;
            parsed.description = locale.dict["meta.description"];
            parsed.url = selfUrl;
            parsed.isPartOf = { "@id": `${canonicalOrigin}/#website` };
            parsed.inLanguage = getIndexableSeoLocales().map((l) => l.hreflang);
            parsed.featureList = rewriteFeatureList(parsed.featureList);
            return `${openTag}${stringifyJsonLd(parsed)}${closeTag}`;
        } catch {
            // JSON-LD malformed (e.g. someone added a comment inside the
            // script block during edit). Leave it as-is rather than
            // corrupt the page.
            return match;
        }
    });
}

// WebSite identifies the canonical domain or subdomain, not the locale path.
// Keep duplicate pages byte-consistent with their canonical counterpart by
// deriving this node from the locale's canonical owner rather than the host
// that happens to serve the build.
function rewriteWebsiteJsonLd(html: string, canonicalOrigin: string): string {
    const re = /(<script\b[^>]*\bid="website-jsonld"[^>]*>)([\s\S]*?)(<\/script>)/i;
    if (!re.test(html)) {
        throw new Error(
            'seo-prerender: <script id="website-jsonld"> not found in baseline HTML - ' +
                "WebSite JSON-LD is required for canonical origin ownership",
        );
    }
    return html.replace(re, (match, openTag: string, body: string, closeTag: string) => {
        try {
            const parsed: Record<string, unknown> = JSON.parse(body);
            if (parsed["@type"] !== "WebSite") return match;
            parsed["@id"] = `${canonicalOrigin}/#website`;
            parsed.url = `${canonicalOrigin}/`;
            return `${openTag}${stringifyJsonLd(parsed)}${closeTag}`;
        } catch {
            return match;
        }
    });
}

// Identify the "vendor support" line in featureList (any string entry whose
// lowercase tail ends with " vendor support") and rewrite it with the current
// SUPPORTED_BRANDS list. Capability lines (no "vendor support" suffix) and
// non-string entries (schema.org allows nested objects in featureList) are
// preserved verbatim. If duplicate vendor-support entries exist they are
// deduplicated - only the first is replaced, the rest are dropped, so the
// SERP rich snippet doesn't show two near-identical lines.
// If no matching entry is found, append a new one - which means even a
// freshly authored JSON-LD without a vendor-line still gets one.
//
// Return type is unknown[] (not string[]) because we preserve non-string
// entries as-is; lying via `as string` would be an unsafe cast.
function rewriteFeatureList(existing: unknown): unknown[] {
    const brandsLine = `${getAllBrandsCommaSeparated()} vendor support`;
    if (!Array.isArray(existing)) return [brandsLine];
    let replaced = false;
    const out: unknown[] = [];
    for (const entry of existing) {
        if (typeof entry === "string" && entry.toLowerCase().endsWith(" vendor support")) {
            if (replaced) continue; // drop duplicate vendor-support entries
            out.push(brandsLine);
            replaced = true;
        } else {
            out.push(entry);
        }
    }
    if (!replaced) out.push(brandsLine);
    return out;
}

// Structured answers must match visible copy, including inline link labels.
function buildFaqJsonLd(dict: Record<I18nKey, string>): string {
    const linkedAnswer = (id: 2 | 12 | 13): string =>
        `${dict[`landing.faq.a${id}.before`]}${dict[`landing.faq.a${id}.link`]}${dict[`landing.faq.a${id}.after`]}`;
    const items: Array<{ q: string; a: string }> = [
        { q: dict["landing.faq.q2"], a: linkedAnswer(2) },
        { q: dict["landing.faq.q4"], a: dict["landing.faq.a4"] },
        { q: dict["landing.faq.q3"], a: dict["landing.faq.a3"] },
        { q: dict["landing.faq.q9"], a: dict["landing.faq.a9"] },
        { q: dict["landing.faq.q6"], a: dict["landing.faq.a6"] },
        { q: dict["landing.faq.q13"], a: linkedAnswer(13) },
        { q: dict["landing.faq.q12"], a: linkedAnswer(12) },
    ];
    const payload = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((item) => ({
            "@type": "Question",
            name: item.q,
            acceptedAnswer: {
                "@type": "Answer",
                text: item.a,
            },
        })),
    };
    return stringifyJsonLd(payload);
}

// Finds an element matching `anchorRe`, then within its opening tag replaces
// the value of `attr`. If `attr` is not present on that element, appends it.
// anchorRe must match the start of the tag through some part of its attributes.
function replaceAttr(html: string, anchorRe: RegExp, attr: string, value: string): string {
    const anchorMatch = anchorRe.exec(html);
    if (!anchorMatch) return html;
    const tagStart = anchorMatch.index;
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd < 0) return html;
    const tag = html.slice(tagStart, tagEnd + 1);
    const updated = setAttributeInTag(tag, attr, value);
    return `${html.slice(0, tagStart)}${updated}${html.slice(tagEnd + 1)}`;
}

// Within a string that is the body of an opening tag's attribute list
// (i.e. what's between the tag name and `>`), find `attr="..."` and replace
// the value, or append if missing.
function setAttribute(attrs: string, attr: string, value: string): string {
    const re = new RegExp(`\\b${attr}="[^"]*"`, "i");
    if (re.test(attrs)) {
        // Function replacement: a plain replacement string would interpret
        // $&, $`, $' and $$ inside the dict value as substitution patterns.
        return attrs.replace(re, () => `${attr}="${escapeAttr(value)}"`);
    }
    return `${attrs} ${attr}="${escapeAttr(value)}"`;
}

// Same as setAttribute but operating on a full opening tag (`<meta ... >`).
function setAttributeInTag(tag: string, attr: string, value: string): string {
    const re = new RegExp(`\\b${attr}="[^"]*"`, "i");
    if (re.test(tag)) {
        // Function replacement - see setAttribute for the $-pattern rationale.
        return tag.replace(re, () => `${attr}="${escapeAttr(value)}"`);
    }
    // Insert before the closing > / />.
    const selfClose = tag.endsWith("/>");
    const closeLen = selfClose ? 2 : 1;
    return `${tag.slice(0, -closeLen)} ${attr}="${escapeAttr(value)}"${selfClose ? " />" : ">"}`;
}
