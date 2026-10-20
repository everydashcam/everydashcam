import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PRIMARY_ORIGIN = "https://primary.example";
const MIRROR_ORIGIN = "https://mirror.example";
const VALIDATOR = resolve("scripts/check-seo.mjs");
const directories: string[] = [];

interface DeploymentFixture {
    origin?: string;
    noIndex?: boolean;
    cutover?: boolean;
    emptySitemap?: boolean;
    regional?: boolean;
}

function makeArtifacts(options: DeploymentFixture = {}): Record<string, string> {
    const { origin = PRIMARY_ORIGIN, noIndex = false, cutover = false, emptySitemap = false, regional = false } = options;
    const locales = [
        { lang: "en", origin: regional ? origin : PRIMARY_ORIGIN },
        { lang: "ru", origin: regional ? origin : cutover ? MIRROR_ORIGIN : PRIMARY_ORIGIN },
    ];
    const alternates = [
        ...locales.flatMap((locale) =>
            regional
                ? [
                      [locale.lang, `${PRIMARY_ORIGIN}/${locale.lang}/`],
                      [`${locale.lang}-CA`, `${MIRROR_ORIGIN}/${locale.lang}/`],
                  ]
                : [[locale.lang, `${locale.origin}/${locale.lang}/`]],
        ),
        ["x-default", `${PRIMARY_ORIGIN}/en/`],
    ];
    const htmlAlternates = alternates.map(([lang, url]) => `<link rel="alternate" hreflang="${lang}" href="${url}">`).join("");
    const xmlAlternates = alternates.map(([lang, url]) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${url}"/>`).join("");
    const robots = noIndex ? '<meta name="robots" content="noindex, nofollow">' : "";
    const website = JSON.stringify({ "@type": "WebSite", url: `${origin}/` });
    const entries = emptySitemap
        ? ""
        : locales
              .filter((locale) => locale.origin === origin)
              .map((locale) => `<url><loc>${locale.origin}/${locale.lang}/</loc>${xmlAlternates}</url>`)
              .join("");
    const files: Record<string, string> = {
        "index.html": `<!doctype html><html><head>${robots}<script type="application/ld+json">${website}</script></head></html>`,
        _redirects: "/old /en/ 301\n",
        "robots.txt": `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
        _headers: noIndex ? "/*\n  X-Robots-Tag: noindex\n" : "/*\n  Cache-Control: no-cache\n",
        "asset.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "sitemap.xml": `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries}</urlset>`,
    };
    for (const locale of locales) {
        files[`${locale.lang}/index.html`] = `<!doctype html>
<html lang="${locale.lang}"><head>
<title>${locale.lang} title</title><meta name="description" content="description">
<link rel="canonical" href="${locale.origin}/${locale.lang}/">
<meta property="og:url" content="${locale.origin}/${locale.lang}/">
${htmlAlternates}${robots}
<script type="application/ld+json">{"@type":"WebPage","url":"${locale.origin}/${locale.lang}/"}</script>
</head><body><h1>Title</h1><img src="/asset.svg" alt="preview"><a href="/${locale.lang}/">Home</a></body></html>`;
    }
    return files;
}

function validate(...artifacts: Record<string, string>[]): { status: number | null; output: string } {
    const inputs = artifacts.map((files) => {
        const directory = mkdtempSync(join(tmpdir(), "everydashcam-seo-artifacts-"));
        directories.push(directory);
        for (const [path, contents] of Object.entries(files)) {
            const file = join(directory, path);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, contents);
        }
        return directory;
    });
    const result = spawnSync(process.execPath, [VALIDATOR, ...inputs], { encoding: "utf8", timeout: 10_000 });
    expect(result.error, "validator completes without process errors").toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr };
}

function replaceArtifact(files: Record<string, string>, path: string, oldValue: string, newValue: string): void {
    expect(files[path], `fixture contains ${path}`).toContain(oldValue);
    files[path] = files[path]!.replace(oldValue, newValue);
}

function expectRejected(files: Record<string, string>, message: string): void {
    const result = validate(files);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(message);
}

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SEO artifact deployment policies", () => {
    const policies: Array<DeploymentFixture & { label: string }> = [
        { label: "primary" },
        { label: "staging", noIndex: true },
        { label: "mirror canary", origin: MIRROR_ORIGIN, noIndex: true, emptySitemap: true },
        { label: "primary after cutover", cutover: true },
        { label: "mirror after cutover", origin: MIRROR_ORIGIN, cutover: true },
    ];

    it.each(policies)("accepts $label artifacts", (policy) => {
        const result = validate(makeArtifacts(policy));
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("[check-seo] OK");
    });
});

describe("SEO artifact regressions", () => {
    it("rejects a hreflang graph without matching return links", () => {
        const files = makeArtifacts();
        replaceArtifact(files, "ru/index.html", 'hreflang="en"', 'hreflang="de"');
        expectRejected(files, "hreflang graph differs");
    });

    it("rejects sitemap alternates that differ from the HTML", () => {
        const files = makeArtifacts();
        replaceArtifact(files, "sitemap.xml", 'hreflang="ru"', 'hreflang="de"');
        expectRejected(files, "sitemap and HTML hreflang differ");
    });

    it("rejects a missing local preview image", () => {
        const files = makeArtifacts();
        replaceArtifact(files, "en/index.html", "/asset.svg", "/missing.svg");
        expectRejected(files, "references missing local resource /missing.svg");
    });

    it("accepts a stable download redirect to an existing versioned artifact", () => {
        const files = makeArtifacts();
        replaceArtifact(files, "en/index.html", 'href="/en/">Home', 'href="/downloads/portable/en.html">Download');
        files._redirects += "/downloads/portable/en.html /downloads/portable/v2026.10.21/portable-en 302\n";
        files["downloads/portable/v2026.10.21/portable-en"] = "portable bytes";
        const result = validate(files);
        expect(result.status, result.output).toBe(0);
    });

    it.each([
        { label: "a missing target", rules: "/downloads/portable/en.html /missing 302\n" },
        {
            label: "a redirect cycle",
            rules: "/downloads/portable/en.html /download 302\n/download /downloads/portable/en.html 302\n",
        },
        { label: "an external target", rules: "/downloads/portable/en.html https://other.example/asset.svg 302\n" },
        {
            label: "an earlier matching rule",
            rules: "/downloads/* /missing 302\n/downloads/portable/en.html /asset.svg 302\n",
        },
    ])("rejects a local download alias with $label", ({ rules }) => {
        const files = makeArtifacts();
        replaceArtifact(files, "en/index.html", 'href="/en/">Home', 'href="/downloads/portable/en.html">Download');
        files._redirects += rules;
        expectRejected(files, "references missing local resource /downloads/portable/en.html");
    });

    it("rejects a broken redirect even when its source file exists", () => {
        const files = makeArtifacts();
        files._redirects += "/asset.svg /missing.svg 302\n";
        expectRejected(files, "references missing local resource /asset.svg");
    });

    it("rejects an unsupported Cloudflare not-found rewrite", () => {
        const files = makeArtifacts();
        files._redirects += "/* /404.html 404\n";
        expectRejected(files, "unsupported Cloudflare redirect status");
    });

    it("rejects a redirect that covers an indexed canonical URL", () => {
        const files = makeArtifacts();
        files._redirects += "/en/ /ru/ 301\n";
        expectRejected(files, "sitemap URL matches a redirect or rewrite");
    });

    it("rejects malformed structured data", () => {
        const files = makeArtifacts();
        replaceArtifact(files, "en/index.html", `{"@type":"WebPage","url":"${PRIMARY_ORIGIN}/en/"}`, "{broken");
        expectRejected(files, "invalid JSON-LD");
    });

    it("rejects accidental noindex on a production content page", () => {
        const files = makeArtifacts();
        replaceArtifact(files, "en/index.html", "<title>", '<meta name="robots" content="noindex"><title>');
        expectRejected(files, "noindex differs from the deployment policy");
    });
});

describe("paired regional SEO artifacts", () => {
    function makePair(): [Record<string, string>, Record<string, string>] {
        return [makeArtifacts({ regional: true }), makeArtifacts({ regional: true, origin: MIRROR_ORIGIN })];
    }

    function expectPairRejected(pair: [Record<string, string>, Record<string, string>], message: string): void {
        const result = validate(...pair);
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain(message);
    }

    it("validates distinct pages with the same pathname on both hosts", () => {
        const result = validate(...makePair());
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("4 HTML pages, 4 sitemap URLs, 2 build(s)");
        expect(result.output).not.toContain("unverified");
    });

    it("reports the scope of single-build checks without substituting local HTML for external targets", () => {
        const result = validate(makePair()[0]);
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("2 external hreflang targets unverified");
    });

    it("rejects two isolated language graphs without regional counterparts", () => {
        const pair = makePair();
        for (const files of pair) {
            for (const path of Object.keys(files)) {
                files[path] = files[path]!.replace(/<link rel="alternate" hreflang="[^"]+-CA"[^>]*>/g, "").replace(/<xhtml:link rel="alternate" hreflang="[^"]+-CA"[^>]*\/>/g, "");
            }
        }
        expectPairRejected(pair, "hreflang omits its regional counterpart");
    });

    it("rejects a consistent x-default pointing at the mirror", () => {
        const pair = makePair();
        for (const files of pair) {
            for (const path of Object.keys(files)) {
                files[path] = files[path]!.replaceAll(`hreflang="x-default" href="${PRIMARY_ORIGIN}/en/"`, `hreflang="x-default" href="${MIRROR_ORIGIN}/en/"`);
            }
        }
        expectPairRejected(pair, "x-default must target the primary English page");
    });

    it("rejects a target missing only from the mirror artifact", () => {
        const pair = makePair();
        delete pair[1]["ru/index.html"];
        expectPairRejected(pair, `missing or non-canonical page ${MIRROR_ORIGIN}/ru/`);
    });

    it("rejects a mirror canonical that points at the other host", () => {
        const pair = makePair();
        pair[1]["ru/index.html"] = pair[1]["ru/index.html"]!.replaceAll(`${MIRROR_ORIGIN}/ru/`, `${PRIMARY_ORIGIN}/ru/`);
        // Keep a valid graph so the check isolates the actual target identity.
        pair[1]["ru/index.html"] = pair[1]["ru/index.html"]!.replace(`hreflang="ru-CA" href="${PRIMARY_ORIGIN}/ru/"`, `hreflang="ru-CA" href="${MIRROR_ORIGIN}/ru/"`);
        expectPairRejected(pair, "paired production page must be self-canonical");
    });

    it("rejects a graph that differs only on the mirror", () => {
        const pair = makePair();
        replaceArtifact(pair[1], "ru/index.html", 'hreflang="en-CA"', 'hreflang="en-AU"');
        expectPairRejected(pair, "hreflang graph differs");
    });

    it("rejects a canary passed as a production pair", () => {
        const pair = makePair();
        pair[1] = makeArtifacts({ regional: true, origin: MIRROR_ORIGIN, noIndex: true });
        expectPairRejected(pair, "paired validation requires indexable production artifacts");
    });

    it("rejects a root redirect advertised as a language variant", () => {
        const pair = makePair();
        replaceArtifact(pair[0], "index.html", "</head>", `<link rel="alternate" hreflang="en" href="${PRIMARY_ORIGIN}/en/"></head>`);
        expectPairRejected(pair, "root redirect must not have hreflang");
    });

    it("rejects production robots.txt that advertises the other host", () => {
        const pair = makePair();
        replaceArtifact(pair[1], "robots.txt", MIRROR_ORIGIN, PRIMARY_ORIGIN);
        expectPairRejected(pair, "robots.txt must advertise its own sitemap");
    });

    it("rejects crawler blocking rules", () => {
        const pair = makePair();
        pair[1]["robots.txt"] += "User-agent: yandex\nDisallow: /ru/\n";
        expectPairRejected(pair, "robots.txt blocks crawling");
    });

    it.each([
        { label: "portable downloads", rules: "Disallow: /downloads/portable/" },
        { label: "wildcards outside content routes", rules: "Disallow: /*.html$" },
        { label: "a terminal anchor before the trailing slash", rules: "Disallow: /ru$" },
        { label: "case-sensitive paths", rules: "Disallow: /RU/" },
        { label: "an empty Disallow", rules: "Disallow:" },
        { label: "a more specific Allow", rules: "Disallow: /r\nAllow: /ru/" },
        { label: "an equally specific Allow", rules: "Disallow: /ru/\nAllow: /ru/" },
        { label: "a trailing wildcard tied with Allow", rules: "Disallow: /ru/*\nAllow: /ru/" },
        { label: "combined repeated crawler groups", rules: "User-agent: Yandex\nDisallow: /ru/\nUser-agent: yandex\nAllow: /ru/" },
        { label: "a group shared by named crawlers", rules: "User-agent: yandex\nUser-agent: bingbot\nDisallow: /downloads/portable/" },
    ])("accepts robots.txt with $label", ({ rules }) => {
        const pair = makePair();
        pair[1]["robots.txt"] += `${rules}\n`;
        const result = validate(...pair);
        expect(result.status, result.output).toBe(0);
    });

    it.each([
        { label: "a wildcard path", rules: "Disallow: /*u/" },
        { label: "an anchored wildcard path", rules: "Disallow: /*u/$" },
        { label: "a percent-encoded locale", rules: "Disallow: /%72u/" },
        { label: "a longer Disallow after an Allow", rules: "Allow: /r\nDisallow: /ru/" },
        { label: "a named group that overrides wildcard Allow", rules: "Allow: /ru/\nUser-agent: yandex\nDisallow: /ru/" },
        { label: "a named group that only permits the root", rules: "User-agent: bingbot\nAllow: /$\nDisallow: /" },
        { label: "a group shared by named crawlers", rules: "User-agent: yandex\nUser-agent: bingbot\nDisallow: /ru/" },
    ])("rejects content blocked by $label", ({ rules }) => {
        const pair = makePair();
        pair[1]["robots.txt"] += `${rules}\n`;
        expectPairRejected(pair, "robots.txt blocks crawling");
    });

    it("requires crawlable noindex canaries even with an empty sitemap", () => {
        const files = makeArtifacts({ origin: MIRROR_ORIGIN, noIndex: true, emptySitemap: true });
        files["robots.txt"] += "Disallow: /ru/\n";
        expectRejected(files, "robots.txt blocks crawling");
    });

    it("rejects mirror XML that differs from its HTML", () => {
        const pair = makePair();
        replaceArtifact(pair[1], "sitemap.xml", 'hreflang="en-CA"', 'hreflang="en-AU"');
        expectPairRejected(pair, "sitemap and HTML hreflang differ");
    });

    it.each(["yandex", "bingbot", "baiduspider", "googlebot"])("rejects production noindex for %s", (engine) => {
        const pair = makePair();
        replaceArtifact(pair[1], "ru/index.html", "<title>", `<meta name="${engine}" content="noindex"><title>`);
        expectPairRejected(pair, "noindex");
    });

    it.each(["noindex", "yandex: noindex", "googlebot: none"])("rejects matching X-Robots-Tag %s", (directive) => {
        const pair = makePair();
        pair[1]._headers += `/ru/*\n  X-Robots-Tag: ${directive}\n`;
        expectPairRejected(pair, "X-Robots-Tag noindex");
    });

    it("allows noindex headers scoped to technical pages", () => {
        const pair = makePair();
        pair[1]._headers += "/migrate/*\n  X-Robots-Tag: noindex\n";
        const result = validate(...pair);
        expect(result.status, result.output).toBe(0);
    });

    it("rejects an OG URL that points at the other host", () => {
        const pair = makePair();
        replaceArtifact(pair[1], "en/index.html", `<meta property="og:url" content="${MIRROR_ORIGIN}/en/">`, `<meta property="og:url" content="${PRIMARY_ORIGIN}/en/">`);
        expectPairRejected(pair, "og:url differs from canonical");
    });

    it("rejects a JSON-LD URL that points at the other host", () => {
        const pair = makePair();
        replaceArtifact(pair[1], "en/index.html", `"url":"${MIRROR_ORIGIN}/en/"`, `"url":"${PRIMARY_ORIGIN}/en/"`);
        expectPairRejected(pair, "JSON-LD URL differs from canonical");
    });

    it("rejects a breadcrumb that points at the other host", () => {
        const pair = makePair();
        replaceArtifact(pair[1], "en/index.html", "</head>", `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"item":"${PRIMARY_ORIGIN}/en/"}]}</script></head>`);
        expectPairRejected(pair, "breadcrumb differs from canonical origin");
    });

    it("excludes same-host legacy redirects and technical pages from the graph", () => {
        const pair = makePair();
        pair[1]["privacy.html"] = `<html><head><link rel="canonical" href="${MIRROR_ORIGIN}/en/"><meta http-equiv="refresh" content="0; url=/en/"></head></html>`;
        pair[1]["migrate/index.html"] = '<html><head><meta name="robots" content="noindex"></head></html>';
        pair[1]["404.html"] = '<html><head><meta name="robots" content="noindex"></head></html>';
        const result = validate(...pair);
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("4 HTML pages");
    });

    it("rejects legacy redirect stubs advertised as alternates", () => {
        const pair = makePair();
        pair[1]["privacy.html"] = `<html><head><link rel="canonical" href="${MIRROR_ORIGIN}/en/"><meta http-equiv="refresh" content="0; url=/en/"></head></html>`;
        replaceArtifact(pair[0], "en/index.html", `hreflang="en-CA" href="${MIRROR_ORIGIN}/en/"`, `hreflang="en-CA" href="${MIRROR_ORIGIN}/privacy"`);
        expectPairRejected(pair, "hreflang omits its regional counterpart");
    });
});
