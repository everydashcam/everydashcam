// Build-time SEO policy. A regional map opts both hosts into indexable locale
// pairs after cutover; without it the legacy single-owner policy remains.
// Runtime language selection stays on the current hostname.

import { getHreflangCodes, getIndexableSeoLocales, type SeoLocale } from "../src/i18n/seo-config.js";

export const PRIMARY_SITE_ORIGIN = "https://everydashcam.app";
export const LARGE_IMAGE_PREVIEW_META = '<meta name="robots" content="max-image-preview:large">';

// Intl's CLDR region names include reserved, macro and test regions that are
// not ISO 3166-1 country codes accepted by the search graph.
const NON_COUNTRY_REGIONS = new Set(["AC", "CP", "DG", "EA", "EU", "EZ", "IC", "QO", "TA", "UN", "XA", "XB", "XK", "ZZ"]);

export type DeploymentProfile = "primary" | "mirror";

export interface SeoMirrorConfig {
    origin: string;
    localeSegments: ReadonlyArray<string>;
    rootLocaleSegment: string;
    regionalHreflangs?: Readonly<Record<string, string>>;
}

export interface SeoDeploymentContext {
    profile: DeploymentProfile;
    seoCutover: boolean;
    mirror: SeoMirrorConfig | null;
}

type BuildEnv = Readonly<Record<string, string | undefined>>;

function parseEnabled(name: string, value: string | undefined): boolean {
    if (value === undefined || value === "" || value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    throw new Error(`${name} must be 0, 1, false or true, got ${JSON.stringify(value)}`);
}

export function parseDeploymentProfile(value: string | undefined): DeploymentProfile {
    if (value === undefined || value === "" || value === "primary") return "primary";
    if (value === "mirror") return "mirror";
    throw new Error(`DEPLOYMENT_PROFILE must be "primary" or "mirror", got ${JSON.stringify(value)}`);
}

function parseMirrorConfig(raw: string | undefined): SeoMirrorConfig | null {
    if (!raw) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("SEO_MIRROR_CONFIG must be valid JSON");
    }
    if (!value || typeof value !== "object") throw new Error("SEO_MIRROR_CONFIG must be a JSON object");
    const candidate = value as Record<string, unknown>;
    const rawOrigin = typeof candidate.origin === "string" ? candidate.origin.trim() : "";
    let parsedOrigin: URL;
    try {
        parsedOrigin = new URL(rawOrigin);
    } catch {
        throw new Error("SEO_MIRROR_CONFIG.origin must be an HTTPS origin without a path");
    }
    if (
        parsedOrigin.protocol !== "https:" ||
        parsedOrigin.pathname !== "/" ||
        parsedOrigin.search ||
        parsedOrigin.hash ||
        parsedOrigin.username ||
        parsedOrigin.password
    ) {
        throw new Error("SEO_MIRROR_CONFIG.origin must be an HTTPS origin without a path");
    }
    const origin = parsedOrigin.origin;
    if (origin === PRIMARY_SITE_ORIGIN) {
        throw new Error("SEO_MIRROR_CONFIG.origin must differ from the primary origin");
    }
    const localeSegments = candidate.localeSegments;
    const rootLocaleSegment = candidate.rootLocaleSegment;
    if (
        !Array.isArray(localeSegments) ||
        localeSegments.length === 0 ||
        !localeSegments.every((segment) => typeof segment === "string" && /^[a-z0-9-]+$/.test(segment))
    ) {
        throw new Error("SEO_MIRROR_CONFIG.localeSegments must be a non-empty array of URL segments");
    }
    if (typeof rootLocaleSegment !== "string" || !localeSegments.includes(rootLocaleSegment)) {
        throw new Error("SEO_MIRROR_CONFIG.rootLocaleSegment must belong to localeSegments");
    }
    const uniqueLocaleSegments = [...new Set(localeSegments)];
    const knownLocaleSegments = new Set(getIndexableSeoLocales().map((locale) => locale.urlSegment));
    const unknownLocaleSegments = uniqueLocaleSegments.filter((segment) => !knownLocaleSegments.has(segment));
    if (unknownLocaleSegments.length > 0) {
        throw new Error(
            `SEO_MIRROR_CONFIG.localeSegments contains unknown URL segments: ${unknownLocaleSegments.join(", ")}`,
        );
    }
    const regionalHreflangs = parseRegionalHreflangs(candidate.regionalHreflangs, uniqueLocaleSegments);
    if (regionalHreflangs && uniqueLocaleSegments.length !== localeSegments.length) {
        throw new Error("SEO_MIRROR_CONFIG.localeSegments must not contain duplicates in regional mode");
    }
    return {
        origin,
        localeSegments: uniqueLocaleSegments,
        rootLocaleSegment,
        ...(regionalHreflangs ? { regionalHreflangs } : {}),
    };
}

function parseRegionalHreflangs(
    value: unknown,
    localeSegments: readonly string[],
): Readonly<Record<string, string>> | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("SEO_MIRROR_CONFIG.regionalHreflangs must be an object");
    }
    const map = value as Record<string, unknown>;
    const locales = getIndexableSeoLocales();
    const segments = locales.map((locale) => locale.urlSegment);
    if (
        localeSegments.length !== segments.length ||
        Object.keys(map).length !== segments.length ||
        segments.some((segment) => !localeSegments.includes(segment) || !Object.hasOwn(map, segment))
    ) {
        throw new Error("SEO_MIRROR_CONFIG.regionalHreflangs and localeSegments must cover every indexable locale");
    }

    const claimedCodes = new Set<string>();
    const claim = (code: string) => {
        const normalized = code.toLowerCase();
        if (claimedCodes.has(normalized)) {
            throw new Error(`SEO_MIRROR_CONFIG.regionalHreflangs contains a duplicate hreflang code: ${code}`);
        }
        claimedCodes.add(normalized);
    };
    for (const locale of locales) {
        for (const code of getHreflangCodes(locale)) claim(code);
    }
    const regions = new Intl.DisplayNames("en", { type: "region", fallback: "none" });
    const result: Record<string, string> = {};
    for (const locale of locales) {
        const code = map[locale.urlSegment];
        if (typeof code !== "string" || !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2}$/.test(code)) {
            throw new Error(`SEO_MIRROR_CONFIG.regionalHreflangs.${locale.urlSegment} must be a language, optional script and region code`);
        }
        const parsed = new Intl.Locale(code);
        const base = new Intl.Locale(locale.hreflang);
        if (parsed.language !== base.language || parsed.script !== base.script) {
            throw new Error(`SEO_MIRROR_CONFIG.regionalHreflangs.${locale.urlSegment} must preserve its language and script`);
        }
        if (parsed.toString() !== code || !parsed.region || !regions.of(parsed.region) || NON_COUNTRY_REGIONS.has(parsed.region)) {
            throw new Error(`SEO_MIRROR_CONFIG.regionalHreflangs.${locale.urlSegment} must use a country region code`);
        }
        claim(code);
        result[locale.urlSegment] = code;
    }
    return result;
}

export function resolveSeoDeploymentContext(env: BuildEnv = process.env): SeoDeploymentContext {
    const profile = parseDeploymentProfile(env.DEPLOYMENT_PROFILE);
    const seoCutover = parseEnabled("SEO_CUTOVER", env.SEO_CUTOVER);
    const mirror = parseMirrorConfig(env.SEO_MIRROR_CONFIG);
    if ((profile === "mirror" || seoCutover) && !mirror) {
        throw new Error("SEO_MIRROR_CONFIG is required for a mirror build or SEO cutover");
    }
    return { profile, seoCutover, mirror };
}

export function currentSiteOrigin(context: SeoDeploymentContext = resolveSeoDeploymentContext()): string {
    if (context.profile === "primary") return PRIMARY_SITE_ORIGIN;
    if (!context.mirror) throw new Error("mirror profile has no SEO mirror configuration");
    return context.mirror.origin;
}

export function canonicalProfileForLocale(
    locale: Pick<SeoLocale, "urlSegment">,
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): DeploymentProfile {
    if (usesRegionalSeo(context)) return context.profile;
    const mirrorOwns = context.seoCutover && context.mirror?.localeSegments.includes(locale.urlSegment);
    return mirrorOwns ? "mirror" : "primary";
}

/** Both hosts become indexable only when regional configuration and cutover agree. */
export function usesRegionalSeo(context: SeoDeploymentContext = resolveSeoDeploymentContext()): boolean {
    return context.seoCutover && context.mirror?.regionalHreflangs !== undefined;
}

export function canonicalOriginForLocale(
    locale: Pick<SeoLocale, "urlSegment">,
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): string {
    return canonicalProfileForLocale(locale, context) === "mirror" ? context.mirror!.origin : PRIMARY_SITE_ORIGIN;
}

/** Canonical URL for one localized route. `tail` is relative to /<lang>/. */
export function canonicalLocaleUrl(
    locale: Pick<SeoLocale, "urlSegment">,
    tail = "",
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): string {
    const cleanTail = tail.replace(/^\/+/, "");
    return `${canonicalOriginForLocale(locale, context)}/${locale.urlSegment}/${cleanTail}`;
}

export function profileOwnsLocale(
    locale: Pick<SeoLocale, "urlSegment">,
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): boolean {
    return canonicalProfileForLocale(locale, context) === context.profile;
}

/** The mirror is a crawlable noindex canary until explicit SEO cutover. */
export function profileRequiresGlobalNoIndex(
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): boolean {
    return context.profile === "mirror" && !context.seoCutover;
}

/** Yandex-specific duplicate suppression after cutover; Google still sees canonical. */
export function localeNeedsYandexNoIndex(
    locale: Pick<SeoLocale, "urlSegment">,
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): boolean {
    return !usesRegionalSeo(context) && context.seoCutover && !profileOwnsLocale(locale, context);
}

export function searchIndexingMeta(
    locale: Pick<SeoLocale, "urlSegment">,
    globalNoIndex: boolean,
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): string {
    if (globalNoIndex || profileRequiresGlobalNoIndex(context)) return '<meta name="robots" content="noindex, nofollow">';
    return (
        LARGE_IMAGE_PREVIEW_META +
        (localeNeedsYandexNoIndex(locale, context) ? '<meta name="yandex" content="noindex">' : "")
    );
}

export function mirrorRootLocaleSegment(context: SeoDeploymentContext = resolveSeoDeploymentContext()): string {
    if (!context.mirror) throw new Error("mirror root locale requested without SEO_MIRROR_CONFIG");
    return context.mirror.rootLocaleSegment;
}

export function profileOwnsCanonicalUrl(
    url: string,
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): boolean {
    const origin = currentSiteOrigin(context);
    return url === origin || url.startsWith(`${origin}/`);
}
