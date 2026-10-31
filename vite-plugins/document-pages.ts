// Standalone documents keep their reviewed translations in public/*.html.
// Each generated URL contains one article; the old URL is only a locale picker.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import type { Lang } from "../src/i18n/index.js";
import { LANGS } from "../src/i18n/languages.js";
import { getIndexableSeoLocales, type SeoLocale } from "../src/i18n/seo-config.js";
import {
    canonicalLocaleUrl,
    currentSiteOrigin,
    resolveSeoDeploymentContext,
    searchIndexingMeta,
    type SeoDeploymentContext,
} from "./deployment-profile.js";
import { DOCUMENT_DESCRIPTIONS } from "./document-pages-meta.js";
import { assertHtmlMatchCount, escapeAttr, escapeText } from "./html-utils.js";
import { buildSeoAlternates, renderSeoAlternates } from "./seo-alternates.js";
import { getLanguageNavigationLabel } from "./seo-navigation.js";

export const DOCUMENT_SLUGS = ["privacy", "terms", "add-my-camera"] as const;
export type DocumentSlug = (typeof DOCUMENT_SLUGS)[number];

export interface DocumentSource {
    slug: DocumentSlug;
    html: string;
    articles: ReadonlyMap<Lang, string>;
    locales: readonly SeoLocale[];
}

interface DocumentRenderOptions {
    noIndex?: boolean;
    deployment?: SeoDeploymentContext;
    runtimeScriptUrl?: string;
}

export function readDocumentSources(sourceDir = resolve(process.cwd(), "public")): DocumentSource[] {
    return DOCUMENT_SLUGS.map((slug) => {
        const html = readFileSync(resolve(sourceDir, `${slug}.html`), "utf8");
        const articles = new Map<Lang, string>();
        const known = getIndexableSeoLocales();
        for (const match of html.matchAll(/<article\b[^>]*data-lang="([a-z]+)"[^>]*>[\s\S]*?<\/article>/g)) {
            const locale = known.find((candidate) => candidate.lang === match[1]);
            if (!locale || articles.has(locale.lang))
                throw new Error(`document-pages: invalid article locale in ${slug}`);
            articles.set(locale.lang, match[0].replace(/^(<article\b[^>]*?)\s+hidden(?:="[^"]*")?/, "$1"));
        }
        assertHtmlMatchCount(html, /<article\b/gi, articles.size, `${slug} localized article markers`);
        if (!articles.has("en")) throw new Error(`document-pages: missing English article in ${slug}`);
        return { slug, html, articles, locales: known.filter((locale) => articles.has(locale.lang)) };
    });
}

function documentTitle(source: DocumentSource, lang: Lang): string {
    const title = source.articles.get(lang)?.match(/<h1>([^<]+)<\/h1>/)?.[1];
    if (!title) throw new Error(`document-pages: missing title for ${source.slug}/${lang}`);
    return `${title} | everydashcam`;
}

function pageHead(source: DocumentSource, locale: SeoLocale, canonical: string): string {
    assertHtmlMatchCount(source.html, /<head\b/gi, 1, `${source.slug} head`);
    const originalHead = source.html.match(/<head[^>]*>([\s\S]*?)<\/head>/)?.[1];
    if (!originalHead) throw new Error(`document-pages: missing head in ${source.slug}`);
    assertHtmlMatchCount(originalHead, /<title>/g, 1, `${source.slug} title`);
    assertHtmlMatchCount(originalHead, /<link rel="canonical"[^>]*>/g, 1, `${source.slug} canonical`);
    assertHtmlMatchCount(originalHead, /<meta name="description"[^>]*>/g, 1, `${source.slug} description`);
    return originalHead
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${documentTitle(source, locale.lang)}</title>`)
        .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escapeAttr(canonical)}">`)
        .replace(
            /<meta name="description"[^>]*>/,
            `<meta name="description" content="${escapeAttr(DOCUMENT_DESCRIPTIONS[source.slug][locale.lang])}">`,
        );
}

export function renderDocumentPage(
    source: DocumentSource,
    locale: SeoLocale,
    options: DocumentRenderOptions = {},
): string {
    if (!source.articles.has(locale.lang))
        throw new Error(`document-pages: unavailable translation ${source.slug}/${locale.lang}`);
    const context = options.deployment ?? resolveSeoDeploymentContext();
    const tail = `${source.slug}/`;
    const canonical = canonicalLocaleUrl(locale, tail, context);
    const article = source.articles
        .get(locale.lang)!
        .replace(/href="\?lang=en"/g, `href="/en/${tail}"`)
        .replace(
            /href="\/(privacy|terms|add-my-camera)(?:\.html)?(?:\?lang=([a-z]+))?"/g,
            (_match, slug: string, language?: string) => {
                const target =
                    language && source.locales.some((candidate) => candidate.lang === language)
                        ? language
                        : locale.urlSegment;
                return `href="/${target}/${slug}/"`;
            },
        )
        .replace(/href="https:\/\/everydashcam\.app\/?"/g, `href="/${locale.urlSegment}/"`);
    const links = LANGS.flatMap(({ code, endonym }) => {
        const candidate = source.locales.find((item) => item.lang === code);
        if (!candidate) return [];
        const selected = candidate.lang === locale.lang ? ' class="active" aria-current="page"' : "";
        return [
            `<a href="/${candidate.urlSegment}/${tail}" data-set-lang="${candidate.lang}" lang="${candidate.hreflang}"${selected}>${escapeText(endonym)}</a>`,
        ];
    }).join("\n");
    const description = escapeAttr(DOCUMENT_DESCRIPTIONS[source.slug][locale.lang]);
    return `<!doctype html>
<html lang="${locale.lang}" data-doc-slug="${source.slug}" data-doc-locales="${source.locales.map((item) => item.lang).join(",")}">
<head>${pageHead(source, locale, canonical)}
<meta http-equiv="content-language" content="${locale.contentLanguage}">
${searchIndexingMeta(locale, !!options.noIndex, context)}
${renderSeoAlternates(tail, source.locales, context)}
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeAttr(canonical)}">
<meta property="og:locale" content="${locale.ogLocale}">
<meta property="og:title" content="${escapeAttr(documentTitle(source, locale.lang))}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${escapeAttr(`${currentSiteOrigin(context)}/${locale.ogImage}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(documentTitle(source, locale.lang))}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${escapeAttr(`${currentSiteOrigin(context)}/${locale.ogImage}`)}">
</head>
<body>
<nav class="lang-switcher" aria-label="${escapeAttr(getLanguageNavigationLabel(locale.lang))}">${links}</nav>
<main>${article}</main>
<script src="${escapeAttr(options.runtimeScriptUrl ?? "/doc-lang.js")}"></script>
</body>
</html>`;
}

export function renderDocumentStub(source: DocumentSource, options: DocumentRenderOptions = {}): string {
    const context = options.deployment ?? resolveSeoDeploymentContext();
    const locale = source.locales.find((item) => item.lang === "en")!;
    const path = `/en/${source.slug}/`;
    const canonical = `${currentSiteOrigin(context)}${path}`;
    // A blocking external script selects saved/query language before refresh.
    // With JavaScript disabled the refresh and ordinary link select English.
    return `<!doctype html>
<html lang="en" data-doc-slug="${source.slug}" data-doc-locales="${source.locales.map((item) => item.lang).join(",")}" data-doc-redirect="true">
<head>${pageHead(source, locale, canonical)}
${options.noIndex ? '<meta name="robots" content="noindex, nofollow">' : ""}
<script src="${escapeAttr(options.runtimeScriptUrl ?? "/doc-lang.js")}"></script>
<meta http-equiv="refresh" content="0; url=${path}">
</head>
<body><main><a href="${path}">${documentTitle(source, "en")}</a></main></body>
</html>`;
}

export function getDocumentSitemapEntries() {
    return readDocumentSources().flatMap((source) => {
        const graph = buildSeoAlternates(`${source.slug}/`, source.locales);
        return source.locales.map((locale) => ({
            loc: canonicalLocaleUrl(locale, `${source.slug}/`),
            changefreq: "monthly",
            priority: "0.3",
            ...graph,
        }));
    });
}

export function documentPagesPlugin(options: { noIndex?: boolean } = {}): Plugin {
    let isBuild = false;
    let root = process.cwd();
    return {
        name: "everydashcam-document-pages",
        configResolved(config) {
            isBuild = config.command === "build";
            root = config.root;
        },
        closeBundle() {
            if (!isBuild) return;
            const dist = resolve(root, "dist");
            // Installed workers keep runtime responses across upgrades. Pair the
            // new single-language HTML with its script instead of a cached old
            // /doc-lang.js that can hide the only article or miss the redirect.
            const runtime = readFileSync(resolve(root, "public/doc-lang.js"), "utf8");
            const revision = createHash("sha256").update(runtime).digest("hex").slice(0, 16);
            // Keep document-only code outside the /assets/ app precache.
            const runtimeScriptUrl = `/doc-lang.${revision}.js`;
            writeFileSync(resolve(dist, runtimeScriptUrl.slice(1)), runtime);
            const renderOptions = { ...options, runtimeScriptUrl };
            for (const source of readDocumentSources(resolve(root, "public"))) {
                for (const locale of source.locales) {
                    const dir = resolve(dist, locale.urlSegment, source.slug);
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(resolve(dir, "index.html"), renderDocumentPage(source, locale, renderOptions));
                }
                writeFileSync(resolve(dist, `${source.slug}.html`), renderDocumentStub(source, renderOptions));
            }
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.method !== "GET" && req.method !== "HEAD") return next();
                const path = (req.url ?? "").split(/[?#]/, 1)[0];
                const match = path?.match(
                    /^\/(?:(?<lang>[a-z]+)\/)?(?<slug>privacy|terms|add-my-camera)(?:\.html|\/)?$/,
                );
                if (!match?.groups) return next();
                const source = readDocumentSources(resolve(root, "public")).find(
                    (item) => item.slug === match.groups!.slug,
                )!;
                const locale = source.locales.find((item) => item.urlSegment === match.groups!.lang);
                if (match.groups.lang && !locale) return next();
                const html = locale ? renderDocumentPage(source, locale, options) : renderDocumentStub(source, options);
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(req.method === "HEAD" ? "" : html);
            });
        },
    };
}
