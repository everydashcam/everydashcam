import {
    getDefaultSeoLocale,
    getHreflangCodes,
    getIndexableSeoLocales,
    type SeoLocale,
} from "../src/i18n/seo-config.js";
import {
    PRIMARY_SITE_ORIGIN,
    canonicalLocaleUrl,
    resolveSeoDeploymentContext,
    type SeoDeploymentContext,
    usesRegionalSeo,
} from "./deployment-profile.js";
import { escapeAttr } from "./html-utils.js";

export interface SeoAlternates {
    alternates: Record<string, string>;
    xDefaultUrl: string;
}

/** One route's complete search graph, restricted to its published translations. */
export function buildSeoAlternates(
    tail = "",
    locales: readonly SeoLocale[] = getIndexableSeoLocales(),
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): SeoAlternates {
    const defaultLocale = getDefaultSeoLocale();
    if (!locales.some((locale) => locale.lang === defaultLocale.lang)) {
        throw new Error("seo-alternates: translations must include the default locale");
    }
    const cleanTail = tail.replace(/^\/+/, "");
    const regional = usesRegionalSeo(context);
    const alternates: Record<string, string> = {};
    const claimedCodes = new Set<string>();
    const add = (code: string, url: string) => {
        const normalized = code.toLowerCase();
        if (claimedCodes.has(normalized)) throw new Error(`seo-alternates: duplicate hreflang code ${code}`);
        claimedCodes.add(normalized);
        alternates[code] = url;
    };
    for (const locale of locales) {
        const path = `/${locale.urlSegment}/${cleanTail}`;
        const primaryUrl = regional ? `${PRIMARY_SITE_ORIGIN}${path}` : canonicalLocaleUrl(locale, cleanTail, context);
        for (const code of getHreflangCodes(locale)) add(code, primaryUrl);
        if (regional) {
            const code = context.mirror?.regionalHreflangs?.[locale.urlSegment];
            if (!code) throw new Error(`seo-alternates: missing regional hreflang for ${locale.urlSegment}`);
            add(code, `${context.mirror!.origin}${path}`);
        }
    }
    return {
        alternates,
        xDefaultUrl: regional
            ? `${PRIMARY_SITE_ORIGIN}/${defaultLocale.urlSegment}/${cleanTail}`
            : canonicalLocaleUrl(defaultLocale, cleanTail, context),
    };
}

export function renderSeoAlternates(
    tail = "",
    locales: readonly SeoLocale[] = getIndexableSeoLocales(),
    context: SeoDeploymentContext = resolveSeoDeploymentContext(),
): string {
    const { alternates, xDefaultUrl } = buildSeoAlternates(tail, locales, context);
    return Object.entries({ ...alternates, "x-default": xDefaultUrl })
        .map(([code, url]) => `<link rel="alternate" hreflang="${escapeAttr(code)}" href="${escapeAttr(url)}">`)
        .join("\n");
}
