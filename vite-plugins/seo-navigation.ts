import type { Lang } from "../src/i18n/index.js";
import { LANGS } from "../src/i18n/languages.js";
import { getIndexableSeoLocales, type SeoLocale } from "../src/i18n/seo-config.js";
import { escapeAttr, escapeText, stringifyJsonLd } from "./html-utils.js";

const NAVIGATION_LABELS: Record<Lang, { breadcrumbs: string; languages: string }> = {
    en: { breadcrumbs: "Breadcrumbs", languages: "Languages" },
    ru: { breadcrumbs: "Путь к странице", languages: "Языки" },
    de: { breadcrumbs: "Seitennavigation", languages: "Sprachen" },
    es: { breadcrumbs: "Ruta de navegación", languages: "Idiomas" },
    fr: { breadcrumbs: "Fil d’Ariane", languages: "Langues" },
    ja: { breadcrumbs: "パンくずリスト", languages: "言語" },
    ko: { breadcrumbs: "현재 위치", languages: "언어" },
    pl: { breadcrumbs: "Ścieżka nawigacji", languages: "Języki" },
    pt: { breadcrumbs: "Caminho de navegação", languages: "Idiomas" },
    zh: { breadcrumbs: "面包屑导航", languages: "语言" },
};

export function getLanguageNavigationLabel(lang: Lang): string {
    return NAVIGATION_LABELS[lang].languages;
}

export interface SeoBreadcrumb {
    name: string;
    url: string;
}

// Visible navigation and search markup share the same names and hierarchy.
// Local navigation stays on the visitor's host, including mirrors.
export function renderBreadcrumbs(lang: Lang, items: readonly SeoBreadcrumb[]): { html: string; jsonLd: string } {
    const html = `<nav class="vp-breadcrumbs" aria-label="${escapeAttr(NAVIGATION_LABELS[lang].breadcrumbs)}">
<ol>
${items
    .map((item, index) => {
        const label = escapeText(item.name);
        return index === items.length - 1
            ? `<li><span aria-current="page">${label}</span></li>`
            : `<li><a href="${escapeAttr(new URL(item.url).pathname)}">${label}</a></li>`;
    })
    .join("\n")}
</ol>
</nav>`;
    const jsonLd = stringifyJsonLd({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: item.name,
            item: item.url,
        })),
    });
    return { html, jsonLd };
}

export function renderSeoLanguageLinks(
    lang: Lang,
    makePath: (locale: SeoLocale) => string,
    locales: readonly SeoLocale[] = getIndexableSeoLocales(),
): string {
    return `<nav class="vp-languages" aria-label="${escapeAttr(getLanguageNavigationLabel(lang))}">
<ul>
${LANGS.flatMap(({ code, endonym }) => {
    const locale = locales.find((candidate) => candidate.lang === code);
    if (!locale) return [];
    const current = locale.lang === lang ? ' aria-current="page"' : "";
    return [
        `<li><a href="${escapeAttr(makePath(locale))}" hreflang="${locale.hreflang}" lang="${locale.hreflang}"${current}>${escapeText(endonym)}</a></li>`,
    ];
}).join("\n")}
</ul>
</nav>`;
}
