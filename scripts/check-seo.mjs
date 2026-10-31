import { hostedHtmlFiles } from "./_build-files.mjs";
// Validate final artifacts, including changes introduced after HTML rendering.
// A single build can validate local pages; pass both builds to prove cross-host
// hreflang targets exist and return the same graph. Never merge pages by path.

import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const LEGACY_DOCUMENTS = new Set(["/privacy", "/terms", "/add-my-camera"]);
const NOINDEX = /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i;

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

function parseDocument(path, mimeType) {
    return new DOMParser({
        onError(level, message) {
            if (level !== "warning") throw new Error(`${path}: ${message}`);
        },
    }).parseFromString(readFileSync(path, "utf8"), mimeType);
}

function elements(node, tag) {
    return Array.from(node.getElementsByTagName(tag));
}

function metaValues(doc, name) {
    return elements(doc, "meta")
        .filter((node) => (node.getAttribute("name") ?? node.getAttribute("property"))?.toLowerCase() === name)
        .map((node) => node.getAttribute("content") ?? "");
}

function isNoIndex(doc) {
    return [...metaValues(doc, "robots"), ...metaValues(doc, "googlebot")].some((value) => NOINDEX.test(value));
}

function hasSearchNoIndex(doc) {
    // Recognize engine-specific directives too; an indexable regional page must
    // not silently remain excluded for one engine after a policy transition.
    return elements(doc, "meta").some(
        (node) =>
            /^(?:robots|googlebot(?:-news)?|bingbot|yandex(?:bot)?|baiduspider|naver|yeti|slurp|duckduckbot)$/i.test(
                node.getAttribute("name") ?? "",
            ) && NOINDEX.test(node.getAttribute("content") ?? ""),
    );
}

function absoluteUrl(value, label) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label}: invalid absolute URL ${JSON.stringify(value)}`);
    }
    requireCondition(url.protocol === "https:" && !url.username && !url.password, `${label}: expected HTTPS URL`);
    requireCondition(!url.search && !url.hash, `${label}: canonical URLs cannot contain a query or fragment`);
    requireCondition(!/\.html$/i.test(url.pathname), `${label}: HTML URLs must use the extension-less form`);
    return url;
}

function alternateMap(nodes, label) {
    const result = new Map();
    for (const node of nodes) {
        if (node.getAttribute("rel") !== "alternate" || !node.hasAttribute("hreflang")) continue;
        const lang = node.getAttribute("hreflang").toLowerCase();
        requireCondition(lang && !result.has(lang), `${label}: duplicate or empty hreflang ${lang}`);
        const url = absoluteUrl(node.getAttribute("href"), `${label} hreflang ${lang}`);
        result.set(lang, url.href);
    }
    return result;
}

function sameAlternates(left, right) {
    return left.size === right.size && [...left].every(([lang, url]) => right.get(lang) === url);
}

function isFile(path) {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function localFile(directory, pathname) {
    const path = resolve(directory, `.${decodeURIComponent(pathname)}`);
    requireCondition(
        path === directory || path.startsWith(`${directory}/`),
        `URL escapes the build directory: ${pathname}`,
    );
    if (isFile(path)) return path;
    if (isFile(`${path}.html`)) return `${path}.html`;
    if (isFile(join(path, "index.html"))) return join(path, "index.html");
    return null;
}

function localResource(build, pathname) {
    const visited = new Set();
    while (!visited.has(pathname)) {
        visited.add(pathname);
        // Pages applies the first matching redirect even when a file exists.
        const redirect = build.redirects.find(({ pattern }) => pattern.test(pathname));
        if (!redirect) return localFile(build.directory, pathname);
        // Resolve exact local aliases; dynamic destinations need their captures
        // expanded before they can prove that a referenced artifact exists.
        if (redirect.source !== pathname) return null;
        const target = new URL(redirect.destination, build.origin);
        if (target.origin !== build.origin) return null;
        pathname = target.pathname;
        // A Pages proxy serves its first target without applying another rule.
        if (redirect.status === "200") return localFile(build.directory, pathname);
    }
    return null;
}

function jsonLd(doc, label) {
    return elements(doc, "script")
        .filter((node) => node.getAttribute("type") === "application/ld+json")
        .flatMap((node) => {
            let data;
            try {
                data = JSON.parse(node.textContent);
            } catch {
                throw new Error(`${label}: invalid JSON-LD in ${node.getAttribute("id") || "script"}`);
            }
            requireCondition(
                data !== null && typeof data === "object",
                `${label}: JSON-LD must contain an object or array`,
            );
            const nodes = Array.isArray(data) ? data : (data["@graph"] ?? [data]);
            requireCondition(
                Array.isArray(nodes) && nodes.every((value) => value !== null && typeof value === "object"),
                `${label}: JSON-LD graph must contain objects`,
            );
            return nodes;
        });
}

function pathPattern(source) {
    return new RegExp(
        `^${source
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/:[A-Za-z]\w*/g, "[^/]+")
            .replace(/\*/g, ".*")}$`,
    );
}

function noIndexHeaderRules(directory) {
    const rules = [];
    let source;
    for (const line of readFileSync(join(directory, "_headers"), "utf8").split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        if (!/^\s/.test(line)) source = line.trim();
        else if (/^\s*X-Robots-Tag\s*:/i.test(line) && NOINDEX.test(line.replace(/^\s*X-Robots-Tag\s*:/i, ""))) {
            requireCondition(source, "X-Robots-Tag has no matching header rule");
            rules.push(pathPattern(source));
        }
    }
    return rules;
}

function normalizedRobotsPath(value) {
    return value.replace(/[^\x21-\x7e]/gu, encodeURIComponent).replace(/%[\da-f]{2}/gi, (escaped) => {
        const character = String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
        return /[\w.~-]/.test(character) ? character : escaped.toUpperCase();
    });
}

function robotsGroups(directives) {
    const groups = [];
    let group;
    for (const line of directives) {
        const directive = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line);
        if (!directive) continue;
        const [, field, value] = directive;
        if (field.toLowerCase() === "user-agent") {
            if (!group || group.hasRules) {
                group = { agents: new Set(), rules: [], hasRules: false };
                groups.push(group);
            }
            group.agents.add(value.toLowerCase());
        } else if (group) {
            group.hasRules = true;
            if (!value.startsWith("/")) continue;
            // Trailing wildcards do not make a prefix rule more specific.
            // Other wildcards and the terminal anchor follow the REP matching
            // used by search crawlers, with Allow winning equal-length rules.
            const source = normalizedRobotsPath(value).replace(/\*+$/, "");
            const anchored = source.endsWith("$");
            const path = anchored ? source.slice(0, -1) : source;
            const pattern = new RegExp(
                `^${path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}${anchored ? "$" : ""}`,
            );
            group.rules.push({ pattern, length: source.length, allow: field.toLowerCase() === "allow" });
        }
    }
    // A named crawler does not inherit the wildcard group's Allow rules.
    // Repeated groups for the same crawler do combine, regardless of case.
    const byAgent = new Map();
    for (const { agents, rules } of groups) {
        for (const agent of agents) byAgent.set(agent, [...(byAgent.get(agent) ?? []), ...rules]);
    }
    return byAgent;
}

function checkCrawlable(groups, url) {
    const path = normalizedRobotsPath(url.pathname);
    for (const [agent, rules] of groups) {
        let winner;
        for (const rule of rules) {
            if (!rule.pattern.test(path)) continue;
            if (!winner || rule.length > winner.length || (rule.length === winner.length && rule.allow)) winner = rule;
        }
        requireCondition(winner?.allow !== false, `${url.href}: robots.txt blocks crawling for ${agent}`);
    }
}

function checkStructuredUrls(nodes, canonical) {
    for (const node of nodes) {
        const type = node["@type"];
        if (type === "WebSite") {
            requireCondition(
                node.url === `${canonical.origin}/`,
                `${canonical.href}: WebSite URL differs from canonical origin`,
            );
        } else if (["WebApplication", "WebPage", "CollectionPage", "HowTo", "FAQPage"].includes(type) && node.url) {
            requireCondition(node.url === canonical.href, `${canonical.href}: JSON-LD URL differs from canonical`);
        } else if (type === "BreadcrumbList") {
            requireCondition(Array.isArray(node.itemListElement), `${canonical.href}: breadcrumbs have no items`);
            for (const item of node.itemListElement) {
                const url = absoluteUrl(item.item, `${canonical.href} breadcrumb`);
                requireCondition(
                    url.origin === canonical.origin,
                    `${canonical.href}: breadcrumb differs from canonical origin`,
                );
            }
            requireCondition(
                node.itemListElement.at(-1)?.item === canonical.href,
                `${canonical.href}: final breadcrumb differs from canonical`,
            );
        }
    }
}

function readBuild(directory) {
    const root = parseDocument(join(directory, "index.html"), "text/html");
    const rootWebsite = jsonLd(root, "/").find((node) => node["@type"] === "WebSite");
    requireCondition(rootWebsite, "root redirect has no WebSite structured data");
    const origin = absoluteUrl(rootWebsite.url, "root WebSite").origin;
    const globalNoIndex = isNoIndex(root);
    requireCondition(
        alternateMap(elements(root, "link"), `${origin}/`).size === 0,
        "root redirect must not have hreflang",
    );
    const robots = readFileSync(join(directory, "robots.txt"), "utf8");
    const directives = robots.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim());
    const crawlerGroups = robotsGroups(directives);
    checkCrawlable(crawlerGroups, new URL(origin));
    if (!globalNoIndex)
        requireCondition(
            directives.filter((line) => /^Sitemap:/i.test(line)).length === 1 &&
                directives.some((line) => line === `Sitemap: ${origin}/sitemap.xml`),
            `${origin}: robots.txt must advertise its own sitemap`,
        );
    const headerRules = noIndexHeaderRules(directory);
    const sitemap = parseDocument(join(directory, "sitemap.xml"), "application/xml");
    requireCondition(
        sitemap.documentElement.localName === "urlset" && sitemap.documentElement.namespaceURI === SITEMAP_NS,
        "sitemap.xml must contain a urlset in the sitemap namespace",
    );
    const entries = new Map();
    for (const node of Array.from(sitemap.getElementsByTagNameNS(SITEMAP_NS, "url"))) {
        const locations = Array.from(node.getElementsByTagNameNS(SITEMAP_NS, "loc"));
        requireCondition(locations.length === 1, "sitemap entry must have exactly one loc");
        const url = absoluteUrl(locations[0].textContent.trim(), "sitemap loc");
        requireCondition(url.origin === origin, `sitemap contains an URL owned by another deployment: ${url.href}`);
        requireCondition(url.pathname !== "/", "sitemap includes the root redirect");
        requireCondition(!entries.has(url.href), `sitemap contains duplicate URL ${url.href}`);
        const alternates = alternateMap(Array.from(node.getElementsByTagNameNS(XHTML_NS, "link")), url.href);
        entries.set(url.href, { url, alternates });
    }
    requireCondition(entries.size > 0 || globalNoIndex, "indexable deployment has an empty sitemap");

    const pages = new Map();
    for (const file of hostedHtmlFiles(directory)) {
        const name = relative(directory, file);
        if (name === "index.html") continue;
        const route = `/${name.replace(/index\.html$/, "").replace(/\.html$/, "")}`;
        const actual = new URL(route, origin);
        const doc = parseDocument(file, "text/html");
        const head = elements(doc, "head")[0];
        requireCondition(head, `${actual.href}: missing head`);
        if (route === "/migrate/" || route === "/404") {
            requireCondition(isNoIndex(doc), `${route}: technical page must stay noindex`);
            requireCondition(!entries.has(actual.href), `${route}: technical page must not appear in the sitemap`);
            continue;
        }
        // Downloads and technical routes can be excluded, but crawlers need
        // access to content, noindex canaries and legacy redirect stubs.
        checkCrawlable(crawlerGroups, actual);
        const links = elements(head, "link");
        const canonicals = links.filter((node) => node.getAttribute("rel") === "canonical");
        requireCondition(canonicals.length === 1, `${actual.href}: expected exactly one canonical`);
        const canonical = absoluteUrl(canonicals[0].getAttribute("href"), `${actual.href} canonical`);
        const refresh = elements(head, "meta").find(
            (node) => node.getAttribute("http-equiv")?.toLowerCase() === "refresh",
        );
        const alternates = alternateMap(links, actual.href);
        if (LEGACY_DOCUMENTS.has(route) && refresh) {
            requireCondition(
                !entries.has(actual.href),
                `${actual.href}: legacy redirect must not appear in the sitemap`,
            );
            requireCondition(alternates.size === 0, `${actual.href}: legacy redirect must not have hreflang`);
            requireCondition(
                canonical.origin === origin,
                `${actual.href}: legacy redirect must stay on the current host`,
            );
            const target = /(?:^|;)\s*url\s*=\s*(.+)$/i.exec(refresh.getAttribute("content") ?? "")?.[1];
            requireCondition(
                target && new URL(target, actual).href === canonical.href,
                `${actual.href}: redirect fallback differs from canonical`,
            );
            requireCondition(
                localFile(directory, canonical.pathname),
                `${actual.href}: redirect target has no local HTML`,
            );
            continue;
        }
        requireCondition(
            canonical.pathname === route,
            `${actual.href}: canonical points at another route ${canonical.href}`,
        );
        requireCondition(
            elements(head, "title").length === 1 && elements(head, "title")[0].textContent.trim(),
            `${actual.href}: missing or duplicate title`,
        );
        const descriptions = metaValues(head, "description");
        requireCondition(
            descriptions.length === 1 && descriptions[0].trim(),
            `${actual.href}: missing or duplicate description`,
        );
        requireCondition(doc.documentElement.getAttribute("lang"), `${actual.href}: missing document language`);
        requireCondition(
            elements(doc, "h1").some((node) => node.textContent.trim()),
            `${actual.href}: missing main heading`,
        );
        requireCondition(!refresh, `${actual.href}: content page redirects with meta refresh`);
        requireCondition(
            isNoIndex(doc) === globalNoIndex,
            `${actual.href}: noindex differs from the deployment policy`,
        );
        if (!globalNoIndex && canonical.href === actual.href) {
            requireCondition(!hasSearchNoIndex(doc), `${actual.href}: indexable page has a search-engine noindex meta`);
            requireCondition(
                !headerRules.some((pattern) => pattern.test(route) || pattern.test(actual.href)),
                `${actual.href}: indexable page has an X-Robots-Tag noindex header`,
            );
        }
        const ogUrls = metaValues(head, "og:url");
        requireCondition(
            ogUrls.length === 1 && ogUrls[0] === canonical.href,
            `${actual.href}: og:url differs from canonical`,
        );
        checkStructuredUrls(jsonLd(doc, actual.href), canonical);
        requireCondition(!route.endsWith("/") || alternates.size > 0, `${actual.href}: localized page has no hreflang`);
        pages.set(actual.href, { doc, actual, canonical, alternates, directory, globalNoIndex });
    }
    requireCondition(pages.size > 0, "deployment has no content pages");

    const redirects = [];
    for (const line of readFileSync(join(directory, "_redirects"), "utf8").split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        const [source, destination, status = "302"] = line.trim().split(/\s+/);
        requireCondition(
            ["200", "301", "302", "303", "307", "308"].includes(status),
            `unsupported Cloudflare redirect status: ${line}`,
        );
        const pattern = pathPattern(source);
        redirects.push({ source, destination, status, pattern });
        for (const { url } of entries.values()) {
            requireCondition(
                !pattern.test(url.pathname) && !pattern.test(url.href),
                `sitemap URL matches a redirect or rewrite: ${url.href}`,
            );
        }
    }
    return { directory, origin, globalNoIndex, entries, pages, redirects };
}

function check() {
    const directories = process.argv.slice(2);
    requireCondition(
        directories.length <= 2,
        "usage: node scripts/check-seo.mjs [primary-directory] [mirror-directory]",
    );
    const builds = (directories.length ? directories : ["dist"]).map((directory) => readBuild(resolve(directory)));
    const byOrigin = new Map(builds.map((build) => [build.origin, build]));
    requireCondition(byOrigin.size === builds.length, "paired builds must have distinct origins");
    if (builds.length === 2) {
        for (const build of builds) {
            requireCondition(
                !build.globalNoIndex,
                `${build.origin}: paired validation requires indexable production artifacts`,
            );
            for (const [href, page] of build.pages) {
                requireCondition(
                    page.canonical.href === href,
                    `${href}: paired production page must be self-canonical`,
                );
            }
        }
    }
    const pages = new Map(builds.flatMap((build) => [...build.pages]));
    const unverified = new Set();
    for (const build of builds) {
        for (const [href, page] of build.pages) {
            const { canonical, alternates, doc, actual } = page;
            if (canonical.href === href && !build.globalNoIndex) {
                requireCondition(build.entries.has(href), `${href}: canonical page missing from sitemap`);
            }
            if (alternates.size > 0) {
                requireCondition(alternates.has("x-default"), `${href}: missing x-default alternate`);
                if (builds.length === 2) {
                    const counterpart = new URL(
                        actual.pathname,
                        builds.find((candidate) => candidate.origin !== build.origin).origin,
                    ).href;
                    requireCondition(
                        [...alternates.values()].includes(counterpart),
                        `${href}: hreflang omits its regional counterpart ${counterpart}`,
                    );
                    const englishPath = actual.pathname.replace(/^\/[^/]+\//, "/en/");
                    requireCondition(
                        alternates.get("x-default") === new URL(englishPath, builds[0].origin).href,
                        `${href}: x-default must target the primary English page`,
                    );
                }
                requireCondition(
                    [...alternates.values()].includes(canonical.href),
                    `${href}: hreflang omits its own canonical`,
                );
                for (const [lang, targetHref] of alternates) {
                    const targetUrl = new URL(targetHref);
                    const target = pages.get(targetHref);
                    if (!target && !byOrigin.has(targetUrl.origin) && builds.length === 1) {
                        unverified.add(targetHref);
                        continue;
                    }
                    requireCondition(
                        target?.canonical.href === targetHref,
                        `${href}: hreflang ${lang} targets a missing or non-canonical page ${targetHref}`,
                    );
                    requireCondition(
                        sameAlternates(alternates, target.alternates),
                        `${href}: hreflang graph differs from ${targetHref}`,
                    );
                    if (!build.globalNoIndex)
                        requireCondition(
                            !hasSearchNoIndex(target.doc),
                            `${href}: hreflang targets a noindex page ${targetHref}`,
                        );
                    if (lang !== "x-default") {
                        requireCondition(
                            target.doc.documentElement.getAttribute("lang").toLowerCase().split("-")[0] ===
                                lang.split("-")[0],
                            `${href}: hreflang ${lang} does not match target language`,
                        );
                    }
                }
            }
            function checkReference(value, label) {
                if (!value || value.startsWith("#")) return;
                // Relative navigation/resources resolve on the served host,
                // including legacy cross-canonical pages and mirror canaries.
                const url = new URL(value, actual);
                const targetBuild = byOrigin.get(url.origin);
                if (!targetBuild) return;
                requireCondition(
                    localResource(targetBuild, url.pathname),
                    `${href}: ${label} references missing local resource ${value}`,
                );
            }
            for (const node of elements(doc, "a")) checkReference(node.getAttribute("href"), "link");
            for (const node of elements(doc, "link")) checkReference(node.getAttribute("href"), "head link");
            for (const tag of ["img", "script", "source", "video"]) {
                for (const node of elements(doc, tag)) {
                    checkReference(node.getAttribute("src"), tag);
                    checkReference(node.getAttribute("poster"), "video poster");
                    const srcset = node.getAttribute("srcset");
                    if (srcset && !srcset.startsWith("data:")) {
                        for (const candidate of srcset.split(","))
                            checkReference(candidate.trim().split(/\s+/)[0], "srcset");
                    }
                }
            }
            for (const name of ["og:image", "twitter:image"]) {
                for (const value of metaValues(doc, name)) checkReference(value, name);
            }
        }
        for (const { url, alternates } of build.entries.values()) {
            const page = pages.get(url.href);
            requireCondition(
                page?.canonical.href === url.href,
                `sitemap URL has no matching canonical HTML: ${url.href}`,
            );
            requireCondition(
                sameAlternates(alternates, page.alternates),
                `${url.href}: sitemap and HTML hreflang differ`,
            );
        }
    }
    const entryCount = builds.reduce((sum, build) => sum + build.entries.size, 0);
    process.stdout.write(
        `[check-seo] OK - ${pages.size} HTML pages, ${entryCount} sitemap URLs, ${builds.length} build(s)\n`,
    );
    if (unverified.size)
        process.stdout.write(
            `[check-seo] ${unverified.size} external hreflang targets unverified; pass both build directories to validate their HTML\n`,
        );
}

try {
    check();
} catch (error) {
    process.stderr.write(`[check-seo] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
