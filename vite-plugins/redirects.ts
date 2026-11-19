// Generates dist/_redirects for Cloudflare Pages. The _redirects file is a
// static config that CF Pages reads on deploy and applies as edge-level
// 301/302/308 redirects - NOT a Pages Function (which we cannot use on the
// current plan). Format docs: https://developers.cloudflare.com/pages/configuration/redirects/
//
// Why this exists:
//
//   Before 2026-05 English vendor pages lived at /cameras/<slug>/ (English
//   was the default locale with urlSegment=""). The migration moves them to
//   /en/cameras/<slug>/ to make every locale symmetric. The old paths may be
//   in:
//     - external backlinks (forum posts, social shares)
//     - Google's index (post-deploy reindexing takes 2-4 weeks)
//     - users' bookmarks
//   so we keep them resolvable via a server-side 301 to the new location.
//   301 preserves link equity (PageRank carries forward); a JS stub redirect
//   wouldn't, and Google would re-evaluate the page as a near-duplicate.
//
// Pages with no _redirects line:
//
//   The site root "/" is NOT in _redirects: it serves a JS stub that resolves
//   the visitor's preferred locale and redirects via location.replace.
//   _redirects could only do a static 302 to one locale, which would defeat
//   the purpose. Same reason "/cameras/" and "/cameras/<slug>/" don't end up
//   doing client-side lang detection - they're language-agnostic legacy URLs
//   that map to a single English destination.
//
// Mirror hosts on Object Storage:
//
//   Object Storage ignores _redirects. A mirror build also writes the same
//   legacy redirects as bucket website settings, which the operator applies
//   by hand (see the delivery repository). Object Storage allows at most 50
//   routing rules and applies the LAST matching rule, so page families that
//   share a source and destination prefix become one prefix rule, and the
//   build proves that the compact rules land every legacy URL where
//   _redirects sends it. Docs: https://yandex.cloud/en/docs/storage/concepts/hosting
//   and https://yandex.cloud/en/docs/storage/concepts/limits

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { getDefaultSeoLocale, getIndexableSeoLocales } from "../src/i18n/seo-config.js";
import { getAlternativeSlugs } from "./alternative-pages.js";
import { resolveSeoDeploymentContext } from "./deployment-profile.js";
import { VENDOR_LIST } from "./vendor-list.js";

/** A legacy path and where it now lives, in the form Cloudflare Pages applies it. */
export interface LegacyRedirect {
    /** Source path without a trailing slash, such as "/cameras/70mai". */
    source: string;
    /** Slash-terminated destination path. */
    destination: string;
    /** "page" matches the source with or without a trailing slash; "tree" also moves every deeper path. */
    scope: "page" | "tree";
}

/** Redirects that share a reason. The comment heads their block in _redirects. */
export interface LegacyRedirectGroup {
    comment: readonly string[];
    redirects: LegacyRedirect[];
    /** One Object Storage prefix rule that covers the whole group, used to stay under the rule limit. */
    objectStoragePrefix?: { source: string; destination: string };
}

/** Bucket website routing rule in the JSON shape `yc storage bucket update --website-settings-from-file` reads. */
export interface ObjectStorageRoutingRule {
    condition: { httpErrorCodeReturnedEquals: "404"; keyPrefixEquals: string };
    redirect: {
        protocol: "PROTOCOL_HTTPS";
        hostname: string;
        httpRedirectCode: "301";
        replaceKeyPrefixWith?: string;
        replaceKeyWith?: string;
    };
}

/** Complete bucket website settings; applying them replaces the bucket's previous settings. */
export interface ObjectStorageWebsiteSettings {
    index: "index.html";
    error: "404.html";
    routingRules: ObjectStorageRoutingRule[];
}

export const OBJECT_STORAGE_WEBSITE_FILE = "_object-storage-website.json";
export const OBJECT_STORAGE_MAX_ROUTING_RULES = 50;

const CLOUDFLARE_HEADER = [
    "# Cloudflare Pages _redirects.",
    "# Generated at build time by vite-plugins/redirects.ts.",
    "# Format: source destination status",
];

/**
 * Lists every legacy page redirect the site keeps. The default locale's URL
 * segment must be non-empty; otherwise a legacy /cameras/ redirect would
 * point at itself.
 */
export function legacyRedirectGroups(): LegacyRedirectGroup[] {
    const defaultSegment = getDefaultSeoLocale().urlSegment;
    // Sanity check - if the default locale somehow becomes empty
    // again, this file would 301 to /cameras/, an infinite loop.
    if (!defaultSegment) {
        throw new Error("redirects: default locale has empty urlSegment - cannot build legacy /cameras/* redirects");
    }
    const page = (source: string, destination: string): LegacyRedirect => ({ source, destination, scope: "page" });

    // NAVITEL used to live under the alternatives section as a competitor
    // page. It is now a supported-camera page; preserve indexed URLs and send
    // each old locale to the matching new page where it exists, otherwise to
    // the English canonical.
    const navitel = VENDOR_LIST.find((vendor) => vendor.slug === "navitel");
    if (!navitel) {
        throw new Error("redirects: NAVITEL landing page is missing");
    }

    return [
        {
            comment: [
                "# Legacy English vendor URLs - pre-2026-05 they lived directly",
                "# under /cameras/<slug>/ because English was the default locale",
                "# with an empty URL segment. After migration they live under",
                "# /<defaultSegment>/cameras/<slug>/. 301 preserves PageRank.",
            ],
            redirects: VENDOR_LIST.map((vendor) =>
                page(`/cameras/${vendor.slug}`, `/${defaultSegment}/cameras/${vendor.slug}/`),
            ),
            objectStoragePrefix: { source: "/cameras", destination: `/${defaultSegment}/cameras` },
        },
        {
            comment: ["# Legacy English /cameras/ section hub."],
            redirects: [page("/cameras", `/${defaultSegment}/cameras/`)],
            objectStoragePrefix: { source: "/cameras", destination: `/${defaultSegment}/cameras` },
        },
        {
            // Alternative-to pages never had a bare (locale-less) URL - they
            // were born under /<lang>/. These 301s exist only so a hand-typed
            // or externally-linked /alternatives/<slug>/ resolves to the
            // English page instead of returning a 404.
            comment: ["# Locale-less /alternatives/* -> English variant."],
            redirects: [
                ...getAlternativeSlugs().map((slug) =>
                    page(`/alternatives/${slug}`, `/${defaultSegment}/alternatives/${slug}/`),
                ),
                page("/alternatives", `/${defaultSegment}/alternatives/`),
            ],
            objectStoragePrefix: { source: "/alternatives", destination: `/${defaultSegment}/alternatives` },
        },
        {
            comment: ["# Retired NAVITEL alternative page -> supported-camera page."],
            redirects: [
                page("/alternatives/navitel-dvr-player", `/${defaultSegment}/cameras/navitel/`),
                ...getIndexableSeoLocales().map((locale) => {
                    const destinationSegment = navitel.locales.includes(locale.lang)
                        ? locale.urlSegment
                        : defaultSegment;
                    return page(
                        `/${locale.urlSegment}/alternatives/navitel-dvr-player`,
                        `/${destinationSegment}/cameras/navitel/`,
                    );
                }),
            ],
        },
        {
            // These pages existed before locale coverage became explicit but
            // had no meaningful search visibility. Redirect instead of leaving
            // indexed URLs as 404s after the build stops emitting them.
            comment: ["# Retired low-signal vendor locales -> English canonical."],
            redirects: [
                { source: "/pt/cameras/blackvue", slug: "blackvue" },
                { source: "/ko/cameras/garmin", slug: "garmin" },
                { source: "/pt/cameras/vantrue", slug: "vantrue" },
                { source: "/pt/cameras/thinkware", slug: "thinkware" },
            ].map((retired) => page(retired.source, `/${defaultSegment}/cameras/${retired.slug}/`)),
        },
        {
            // Retired locales: kk and uk pages no longer build, but their URLs
            // sit in search indexes and bookmarks. 301 to the English
            // (x-default) variant with the deep path preserved, so
            // /uk/cameras/70mai/ lands on the English page, not the homepage.
            comment: ["# Retired locales -> English (x-default) variant."],
            redirects: ["kk", "uk"].map((retired) => ({
                source: `/${retired}`,
                destination: `/${defaultSegment}/`,
                scope: "tree" as const,
            })),
        },
    ];
}

/**
 * Renders groups as Cloudflare Pages _redirects text. Trailing slashes are
 * significant in _redirects matching and no asset exists at a legacy path to
 * trigger slash normalization, so every page source is emitted both with and
 * without its trailing slash. The result ends with a newline.
 */
export function renderCloudflareRedirects(groups: readonly LegacyRedirectGroup[]): string {
    const lines = [...CLOUDFLARE_HEADER, ""];
    for (const group of groups) {
        lines.push(...group.comment);
        for (const redirect of group.redirects) {
            lines.push(`${redirect.source} ${redirect.destination} 301`);
            lines.push(
                redirect.scope === "tree"
                    ? `${redirect.source}/* ${redirect.destination}:splat 301`
                    : `${redirect.source}/ ${redirect.destination} 301`,
            );
        }
        lines.push("");
    }
    return lines.join("\n");
}

/**
 * Converts groups into Object Storage routing rules for the given host.
 * Every rule fires only for a missing object, so it can never shadow a
 * published page. Rules are ordered from the shortest key prefix to the
 * longest because Object Storage applies the last matching rule.
 */
export function objectStorageRoutingRules(
    groups: readonly LegacyRedirectGroup[],
    hostname: string,
): ObjectStorageRoutingRule[] {
    const rules = new Map<string, ObjectStorageRoutingRule>();
    const add = (keyPrefix: string, target: { replaceKeyPrefixWith: string } | { replaceKeyWith: string }): void => {
        const rule: ObjectStorageRoutingRule = {
            condition: { httpErrorCodeReturnedEquals: "404", keyPrefixEquals: keyPrefix },
            redirect: { protocol: "PROTOCOL_HTTPS", hostname, httpRedirectCode: "301", ...target },
        };
        const existing = rules.get(keyPrefix);
        if (existing && JSON.stringify(existing) !== JSON.stringify(rule)) {
            throw new Error(`redirects: conflicting Object Storage rules for key prefix "${keyPrefix}"`);
        }
        rules.set(keyPrefix, rule);
    };
    for (const group of groups) {
        if (group.objectStoragePrefix) {
            add(objectKey(group.objectStoragePrefix.source), {
                replaceKeyPrefixWith: objectKey(group.objectStoragePrefix.destination),
            });
            continue;
        }
        for (const redirect of group.redirects) {
            if (redirect.scope === "tree") {
                add(objectKey(redirect.source), {
                    replaceKeyPrefixWith: objectKey(redirect.destination).replace(/\/$/, ""),
                });
            } else {
                add(objectKey(redirect.source), { replaceKeyWith: objectKey(redirect.destination) });
            }
        }
    }
    return [...rules.values()].sort(
        (left, right) => left.condition.keyPrefixEquals.length - right.condition.keyPrefixEquals.length,
    );
}

/**
 * Throws when the rules exceed the Object Storage limit or when any legacy
 * URL, with or without its trailing slash, would land somewhere other than its
 * _redirects destination. A tree redirect is also checked with a deeper path.
 * The check models Object Storage: the last matching rule wins, and a target
 * without a trailing slash reaches its directory through the bucket's own
 * slash redirect.
 */
export function assertObjectStorageRulesMatch(
    groups: readonly LegacyRedirectGroup[],
    rules: readonly ObjectStorageRoutingRule[],
): void {
    const problems: string[] = [];
    if (rules.length > OBJECT_STORAGE_MAX_ROUTING_RULES) {
        problems.push(`${rules.length} routing rules, Object Storage allows ${OBJECT_STORAGE_MAX_ROUTING_RULES}`);
    }
    for (const redirect of groups.flatMap((group) => group.redirects)) {
        const samples: Array<[path: string, expected: string]> = [
            [redirect.source, redirect.destination],
            [`${redirect.source}/`, redirect.destination],
        ];
        if (redirect.scope === "tree") {
            samples.push([`${redirect.source}/cameras/`, `${redirect.destination}cameras/`]);
        }
        for (const [path, expected] of samples) {
            const landing = objectStorageLanding(rules, path);
            if (landing !== expected) {
                problems.push(`${path}: Object Storage lands on ${landing ?? "404"}, _redirects sends ${expected}`);
            }
        }
    }
    if (problems.length > 0) {
        throw new Error(`redirects: Object Storage rules diverge from _redirects\n  ${problems.join("\n  ")}`);
    }
}

function objectStorageLanding(rules: readonly ObjectStorageRoutingRule[], path: string): string | null {
    const key = objectKey(path);
    let target: string | null = null;
    for (const rule of rules) {
        const prefix = rule.condition.keyPrefixEquals;
        if (!key.startsWith(prefix)) continue;
        target = rule.redirect.replaceKeyWith ?? `${rule.redirect.replaceKeyPrefixWith}${key.slice(prefix.length)}`;
    }
    if (target === null) return null;
    return target.endsWith("/") ? `/${target}` : `/${target}/`;
}

function objectKey(path: string): string {
    return path.replace(/^\//, "");
}

export function redirectsPlugin(): Plugin {
    return {
        name: "everydashcam-redirects",
        apply: "build",
        closeBundle() {
            const distDir = resolve(process.cwd(), "dist");
            // A top-level 404.html disables Pages' SPA fallback. _redirects
            // does not support 404 rewrites; a catch-all also shadows assets.
            if (!existsSync(resolve(distDir, "404.html"))) {
                throw new Error("redirects: 404.html is required to prevent soft 404 responses");
            }
            const groups = legacyRedirectGroups();
            writeFileSync(resolve(distDir, "_redirects"), renderCloudflareRedirects(groups));

            const context = resolveSeoDeploymentContext();
            if (context.profile !== "mirror" || !context.mirror) return;
            const rules = objectStorageRoutingRules(groups, new URL(context.mirror.origin).host);
            assertObjectStorageRulesMatch(groups, rules);
            const settings: ObjectStorageWebsiteSettings = {
                index: "index.html",
                error: "404.html",
                routingRules: rules,
            };
            writeFileSync(resolve(distDir, OBJECT_STORAGE_WEBSITE_FILE), `${JSON.stringify(settings, null, 2)}\n`);
        },
    };
}
