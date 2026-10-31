import { REPO_URL, type SeoLocale } from "../src/i18n/seo-config.js";
import { searchIndexingMeta } from "./deployment-profile.js";
import { escapeAttr, escapeText } from "./html-utils.js";

interface MarketingHeadOptions {
    seoLocale: SeoLocale;
    noIndex?: boolean;
    content: { title: string; metaDescription: string; ogTitle: string; ogDescription: string };
    url: string;
    hreflangBlock: string;
    ogImageUrl: string;
    ogLocaleAlternatesBlock: string;
    structuredData: string;
}

/** Page families supply content and their alternate graph; shared chrome owns escaping. */
export function renderMarketingHead({
    seoLocale,
    noIndex,
    content,
    url,
    hreflangBlock,
    ogImageUrl,
    ogLocaleAlternatesBlock,
    structuredData,
}: MarketingHeadOptions): string {
    return `<head>
${searchIndexingMeta(seoLocale, Boolean(noIndex))}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeText(content.title)}</title>
<meta name="description" content="${escapeAttr(content.metaDescription)}">
<meta http-equiv="content-language" content="${seoLocale.contentLanguage}">
<link rel="canonical" href="${url}">
${hreflangBlock}
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="everydashcam">
<meta property="og:title" content="${escapeAttr(content.ogTitle)}">
<meta property="og:description" content="${escapeAttr(content.ogDescription)}">
<meta property="og:image" content="${ogImageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:locale" content="${seoLocale.ogLocale}">
${ogLocaleAlternatesBlock}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(content.ogTitle)}">
<meta name="twitter:description" content="${escapeAttr(content.ogDescription)}">
<meta name="twitter:image" content="${ogImageUrl}">
<link rel="icon" type="image/vnd.microsoft.icon" href="/favicon.ico" sizes="16x16 32x32">
<link rel="icon" type="image/png" href="/favicon-192.png" sizes="192x192">
<link rel="icon" type="image/svg+xml" href="/favicon.svg" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/vendor-page.css">
<link rel="stylesheet" href="/brand-mark.css">
${structuredData}
</head>`;
}

interface MarketingFooterOptions {
    seoLocale: SeoLocale;
    localHome: string;
    languageLinks: string;
    labels: { footerPrivacy: string; footerTerms: string; footerHome: string };
    disclaimer?: string;
}

export function renderMarketingFooter({
    seoLocale,
    localHome,
    languageLinks,
    labels,
    disclaimer,
}: MarketingFooterOptions): string {
    const links = `<a href="/${seoLocale.urlSegment}/privacy/">${escapeText(labels.footerPrivacy)}</a>
<span>·</span>
<a href="/${seoLocale.urlSegment}/terms/">${escapeText(labels.footerTerms)}</a>
<span>·</span>
<a href="${localHome}">${escapeText(labels.footerHome)}</a>
<span>·</span>
<a href="${REPO_URL}">GitHub</a>`;
    return `<footer class="vp-footer">
${languageLinks}
${
    disclaimer === undefined
        ? links
        : `<p class="vp-disclaimer">${escapeText(disclaimer)}</p>
<div class="vp-footer-links">
${links}
</div>`
}
</footer>`;
}
