import { renderMarketingHead, renderMarketingFooter } from "./marketing-chrome.js";
// Competitor "alternative-to" landing pages. Each targets the navigational
// search demand of a named dashcam tool (Dashcam Viewer, CamGeoPlayer or
// Telemetry Overlay) and offers everydashcam as a free, in-browser alternative. Static HTML at
// /<lang>/alternatives/<slug>/ plus an /<lang>/alternatives/ hub - the same
// machinery as vendor-pages.ts (see that file's header for the prerender /
// dev-middleware / sitemap rationale), one concern per plugin.
//
// These are SEO landing pages: each targets the navigational search demand of a
// named dashcam tool and presents everydashcam as a maintained, in-browser
// alternative. Tone is a fair, factual comparison, not a hit piece - every page
// carries a "when the other tool is still the better pick" callout, and every
// comparative claim is verified against public sources before it ships. False
// statements about a named competitor are a legal and SEO risk, so the bar is
// VERIFIED-only: stick to checkable product facts (supported platforms,
// last-updated year, feature presence) and do not make claims about individuals.
//
// English + Russian copy is hand-written inline below. The 8 community locales
// live in ./alternative-pages-content.ts (machine-translated, parity-enforced by
// assertAltLocaleParity) to keep this file readable - same split as
// vendor-pages.ts.
//
// Adding a competitor: append to ALTERNATIVES with en+ru locales, add the 8
// community translations to alternative-pages-content.ts, rebuild. Sitemap,
// hreflang, redirects, llms.txt and the dev middleware pick it up automatically.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { buildSeoAlternates, renderSeoAlternates } from "./seo-alternates.js";
import type { Lang } from "../src/i18n/index.js";
import { getDefaultSeoLocale, getIndexableSeoLocales, getSeoLocaleByLang } from "../src/i18n/seo-config.js";
import { canonicalLocaleUrl, canonicalOriginForLocale } from "./deployment-profile.js";
import { COMMUNITY_ALT_CONTENT, COMMUNITY_ALT_INDEX, COMMUNITY_ALT_LABELS } from "./alternative-pages-content.js";
import { renderFeatureLinksHtml } from "./feature-links.js";
import { escapeAttr, escapeText, stringifyJsonLd } from "./html-utils.js";
import { renderHubCta } from "./hub-cta.js";
import type { SeoBuildOptions } from "./seo-prerender.js";
import { renderBreadcrumbs, renderSeoLanguageLinks } from "./seo-navigation.js";
// Shared page chrome - one source, reused from vendor-pages.ts rather than
// duplicated (CLAUDE.md: abstractions against duplicates).
import { BRAND_MARK_HTML, buildOgLocaleAlternatesHtml, pathPrefixFor } from "./vendor-pages.js";

// Slugs of the competitor pages. Drives VendorContent-style discrimination and
// the dev/route matcher. Order = sitemap order + "other tools" cross-link order.
// Two viewer comparisons and one overlay-editor comparison remain. The latter
// is a different category, so the copy explicitly concedes its production and
// gauge depth instead of presenting the products as interchangeable.
export type AltSlug = "dashcam-viewer" | "camgeoplayer" | "telemetry-overlay";

// A comparison-table cell. `mark` renders the ✓ / ✕ / ~ glyph (CSS
// .alt-yes/.alt-no/.alt-partial); `note` is the short localized text after it.
type CompareMark = "yes" | "no" | "partial";
interface CompareCell {
    mark: CompareMark;
    note: string;
}

// One comparison-table row: a localized dimension label, the everydashcam cell and
// the competitor cell. Rows are authored per competitor so each page emphasizes
// the dimensions that actually differ.
interface CompareRow {
    dimension: string;
    us: CompareCell;
    them: CompareCell;
}

// Per-locale content for one competitor page. Genuinely different per competitor
// (the stories don't overlap), so community locales get a full translation, not
// a templated stub - see alternative-pages-content.ts.
export interface AltLocaleContent {
    title: string; // <title>, long form
    metaDescription: string; // target <=155 chars, hard cap ~200 - longer gets truncated in SERPs
    ogTitle: string; // target <=60 chars (hand-written en/ru hold it; translations may run longer)
    ogDescription: string; // ~150 chars
    h1: string;
    lead: string; // subtitle paragraph under h1
    cardHint: string; // one-line summary shown on the /alternatives/ hub card
    whatItIs: string; // honest description of the competitor (1-2 short paras)
    comparisonIntro: string; // one sentence before the table
    compareRows: CompareRow[];
    whenStayTitle: string; // "when <competitor> is still the better pick"
    whenStay: string;
    ctaPrimary: string;
}

// Static, locale-agnostic facts for one competitor.
export interface Competitor {
    slug: AltSlug;
    displayName: string;
    // Courtesy outbound link to the product's own site (rel=nofollow).
    officialUrl: string;
    // Hand-written en + ru. Community locales resolved from COMMUNITY_ALT_CONTENT.
    locales: Partial<Record<Lang, AltLocaleContent>>;
}

// everydashcam's own capabilities are constant; we still phrase the "us" cell per
// competitor so the framing fits that page's story. Verified against public
// product documentation and repository capabilities - no overclaiming.
const ALTERNATIVES: Competitor[] = [
    {
        slug: "dashcam-viewer",
        displayName: "Dashcam Viewer",
        officialUrl: "https://dashcamviewer.com/",
        locales: {
            en: {
                title: "Dashcam Viewer alternative — free browser viewer | everydashcam",
                metaDescription:
                    "A free Dashcam Viewer alternative in your browser — no install. GPS map, speed chart, synchronized cameras and local-only processing.",
                ogTitle: "Free Dashcam Viewer alternative — in your browser",
                ogDescription:
                    "Dashcam Viewer is a mature desktop app. everydashcam is the free, no-install browser alternative for everyday dashcam review.",
                h1: "A free Dashcam Viewer alternative — in your browser, nothing to install",
                lead: "Dashcam Viewer by Earthshine is a polished cross-brand desktop player with free and paid plans. everydashcam covers the everyday review workflow for free in your browser: open the SD card, see the trip on a GPS map with speed and G-force charts, play multiple cameras in sync and trim a clip. No install, account or upload.",
                cardHint: "Mature desktop viewer; we cover everyday review in the browser",
                whatItIs:
                    "Dashcam Viewer by Earthshine Software is an actively maintained Windows and macOS app with Free, Plus and Pro plans. It supports a broad catalogue of dashcam models, synchronized video, an OpenStreetMap route map, detailed plots such as speed, distance, altitude and satellite count, and multi-format GPS export. It is the deeper desktop analysis tool; everydashcam focuses on quick local review without installing an app.",
                comparisonIntro:
                    "Dashcam Viewer goes deeper on forensic detail. Here's where a free browser tool has the edge for everyday viewing.",
                compareRows: [
                    {
                        dimension: "Price",
                        us: { mark: "yes", note: "Free" },
                        them: { mark: "partial", note: "Free plan; paid Plus and Pro plans" },
                    },
                    {
                        dimension: "How you run it",
                        us: { mark: "yes", note: "In the browser — nothing to install" },
                        them: { mark: "partial", note: "Native desktop app" },
                    },
                    {
                        dimension: "Platforms",
                        us: { mark: "yes", note: "Windows, Mac, Linux, mobile" },
                        them: { mark: "partial", note: "Windows & macOS desktop" },
                    },
                    {
                        dimension: "GPS map",
                        us: { mark: "yes", note: "Interactive route map" },
                        them: { mark: "yes", note: "OpenStreetMap route map" },
                    },
                    {
                        dimension: "Cameras at once",
                        us: { mark: "yes", note: "Multi-camera layouts" },
                        them: { mark: "partial", note: "Up to two cameras" },
                    },
                    {
                        dimension: "Cameras supported",
                        us: {
                            mark: "partial",
                            note: "70mai, Viofo, BlackVue, GoPro, Garmin, Vantrue, Thinkware + more",
                        },
                        them: { mark: "yes", note: "Very wide catalogue" },
                    },
                    {
                        dimension: "Trim & export with GPS",
                        us: { mark: "yes", note: "Yes" },
                        them: { mark: "yes", note: "Yes" },
                    },
                    {
                        dimension: "Nothing uploaded",
                        us: { mark: "yes", note: "Local-only" },
                        them: { mark: "yes", note: "Local-only" },
                    },
                ],
                whenStayTitle: "When Dashcam Viewer is the better fit",
                whenStay:
                    "If you want the widest camera coverage, deep forensic detail — altitude, satellite count, HDOP, reverse-geocoded geotags — or a dedicated desktop app you can run offline without a browser, Dashcam Viewer earns its price. It's actively maintained and supports many brands everydashcam doesn't yet. everydashcam aims at the common case: free, instant, in the browser.",
                ctaPrimary: "Open your recordings",
            },
            ru: {
                title: "Альтернатива Dashcam Viewer — бесплатно в браузере | everydashcam",
                metaDescription:
                    "Бесплатная альтернатива Dashcam Viewer в браузере: карта GPS, график скорости, синхронные камеры и локальная обработка без установки.",
                ogTitle: "Бесплатная альтернатива Dashcam Viewer — в браузере",
                ogDescription:
                    "Dashcam Viewer — зрелая программа для компьютера. everydashcam — бесплатная браузерная альтернатива для повседневного просмотра.",
                h1: "Бесплатная альтернатива Dashcam Viewer — в браузере, без установки",
                lead: "Dashcam Viewer от Earthshine — хорошо сделанный мультибрендовый плеер для Windows и macOS с бесплатным и платными тарифами. everydashcam бесплатно закрывает повседневный просмотр в браузере: открой SD-карту, посмотри маршрут и графики скорости и перегрузок, синхронно включи несколько камер и вырежи фрагмент. Без установки, аккаунта и загрузки файлов на сервер.",
                cardHint: "Зрелый десктопный плеер; мы закрываем быстрый просмотр в браузере",
                whatItIs:
                    "Dashcam Viewer от Earthshine Software — активно поддерживаемое приложение для Windows и macOS с тарифами Free, Plus и Pro. Оно работает с широким каталогом регистраторов, синхронизирует видео, показывает маршрут на OpenStreetMap и подробные графики скорости, дистанции, высоты и числа спутников, а также экспортирует GPS в нескольких форматах. Это инструмент для более подробного анализа на компьютере; everydashcam сосредоточен на быстром локальном просмотре без установки.",
                comparisonIntro:
                    "Dashcam Viewer глубже в криминалистических деталях. Вот где у бесплатного браузерного инструмента преимущество для повседневного просмотра.",
                compareRows: [
                    {
                        dimension: "Цена",
                        us: { mark: "yes", note: "Бесплатно" },
                        them: { mark: "partial", note: "Тариф Free; платные Plus и Pro" },
                    },
                    {
                        dimension: "Как запускается",
                        us: { mark: "yes", note: "В браузере — ставить ничего не надо" },
                        them: { mark: "partial", note: "Нативное десктоп-приложение" },
                    },
                    {
                        dimension: "Платформы",
                        us: { mark: "yes", note: "Windows, Mac, Linux, мобильный" },
                        them: { mark: "partial", note: "Десктоп Windows и macOS" },
                    },
                    {
                        dimension: "Карта GPS",
                        us: { mark: "yes", note: "Интерактивная карта маршрута" },
                        them: { mark: "yes", note: "Карта маршрута OpenStreetMap" },
                    },
                    {
                        dimension: "Камер одновременно",
                        us: { mark: "yes", note: "Раскладки для нескольких камер" },
                        them: { mark: "partial", note: "До двух камер" },
                    },
                    {
                        dimension: "Поддержка камер",
                        us: {
                            mark: "partial",
                            note: "70mai, Viofo, BlackVue, GoPro, Garmin, Vantrue, Thinkware и другие",
                        },
                        them: { mark: "yes", note: "Очень широкий каталог" },
                    },
                    {
                        dimension: "Обрезка и экспорт с GPS",
                        us: { mark: "yes", note: "Да" },
                        them: { mark: "yes", note: "Да" },
                    },
                    {
                        dimension: "Ничего не загружается",
                        us: { mark: "yes", note: "Только локально" },
                        them: { mark: "yes", note: "Только локально" },
                    },
                ],
                whenStayTitle: "Когда Dashcam Viewer подходит лучше",
                whenStay:
                    "Если нужен самый широкий охват камер, подробный анализ данных — высота, число спутников, HDOP, геометки с обратным геокодингом — или отдельное десктоп-приложение, которое работает офлайн без браузера, Dashcam Viewer отрабатывает свою цену. Его активно поддерживают, и он берёт много брендов, которых у everydashcam пока нет. everydashcam подходит для повседневного просмотра: бесплатно, сразу, в браузере.",
                ctaPrimary: "Открыть свои записи",
            },
        },
    },
    {
        slug: "camgeoplayer",
        displayName: "CamGeoPlayer",
        officialUrl: "https://yash.info/camgeoplayer/",
        locales: {
            en: {
                title: "CamGeoPlayer alternative — free browser viewer | everydashcam",
                metaDescription:
                    "Free CamGeoPlayer alternative in your browser — no .NET or install. GPS map, speed chart, synchronized cameras and clip export.",
                ogTitle: "Free CamGeoPlayer alternative — in your browser",
                ogDescription:
                    "CamGeoPlayer is a free indie Windows viewer that shows your dashcam GPS on a map. everydashcam does that in the browser — plus a speed chart and clip export.",
                h1: "A free CamGeoPlayer alternative — in your browser, and it does more",
                lead: "CamGeoPlayer is a free Windows app that reads GPS from dashcam videos and plots the route on a map. everydashcam does that in your browser and adds speed and G-force charts, synchronized cameras, automatic trip grouping and clip export with GPS retained. CamGeoPlayer remains a focused offline viewer; everydashcam covers a broader review workflow without a download.",
                cardHint: "Free Windows GPS viewer; we add charts, sync and export",
                whatItIs:
                    "CamGeoPlayer is a free Windows app that requires .NET 4.8. It queues videos, plays them in sequence, extracts embedded GPS with ExifTool and draws the journey on an OpenStreetMap map using Leaflet. There is no installer: the official download is a zip that you unpack and run. Its official page lists Beta 1.1, dated January 30, 2024.",
                comparisonIntro:
                    "Both are free and both read your GPS onto a map. Here's what everydashcam adds — and where it's simpler to run.",
                compareRows: [
                    { dimension: "Price", us: { mark: "yes", note: "Free" }, them: { mark: "yes", note: "Free" } },
                    {
                        dimension: "Runs on Mac, Linux & mobile",
                        us: { mark: "yes", note: "Any modern browser" },
                        them: { mark: "no", note: "Windows-only (needs .NET)" },
                    },
                    {
                        dimension: "Nothing to download or install",
                        us: { mark: "yes", note: "Opens in the browser" },
                        them: { mark: "partial", note: "Download a zip, unpack and run" },
                    },
                    {
                        dimension: "Latest listed release",
                        us: { mark: "yes", note: "Actively developed" },
                        them: { mark: "partial", note: "Beta 1.1 (January 2024)" },
                    },
                    {
                        dimension: "GPS route on a map",
                        us: { mark: "yes", note: "Live, synchronized" },
                        them: { mark: "yes", note: "Leaflet + OpenStreetMap" },
                    },
                    {
                        dimension: "Speed & G-force chart",
                        us: { mark: "yes", note: "Yes" },
                        them: { mark: "no", note: "Map only" },
                    },
                    {
                        dimension: "Front/rear/interior in sync",
                        us: { mark: "yes", note: "Multi-camera layouts" },
                        them: { mark: "no", note: "Plays one video at a time" },
                    },
                    {
                        dimension: "Trim & export a clip with GPS",
                        us: { mark: "yes", note: "Yes" },
                        them: { mark: "no", note: "Viewer only" },
                    },
                ],
                whenStayTitle: "When CamGeoPlayer is a fine choice",
                whenStay:
                    "CamGeoPlayer is a focused, free tool that runs locally after you unpack it. If you use Windows and only need sequential video playback beside a GPS route, it covers that job without an account. everydashcam adds cross-platform access, charts, synchronized cameras, automatic trip grouping and clip export.",
                ctaPrimary: "Open your recordings",
            },
            ru: {
                title: "Альтернатива CamGeoPlayer — бесплатно в браузере | everydashcam",
                metaDescription:
                    "Бесплатная альтернатива CamGeoPlayer в браузере: карта GPS, график скорости, синхронные камеры и экспорт клипа. Без .NET и установки.",
                ogTitle: "Бесплатная альтернатива CamGeoPlayer — в браузере",
                ogDescription:
                    "CamGeoPlayer — бесплатный плеер для Windows от независимого разработчика, показывающий GPS регистратора на карте. everydashcam делает это в браузере — плюс график скорости и экспорт клипа.",
                h1: "Бесплатная альтернатива CamGeoPlayer — больше возможностей прямо в браузере",
                lead: "CamGeoPlayer — бесплатная программа для Windows, которая читает GPS из видео регистратора и рисует маршрут на карте. everydashcam делает это прямо в браузере и добавляет графики скорости и перегрузок, синхронный просмотр камер, автоматическую группировку записей в поездки и экспорт клипа с GPS. CamGeoPlayer остаётся локальным плеером для одной задачи; everydashcam закрывает более широкий сценарий просмотра без скачивания программы.",
                cardHint: "Бесплатный плеер с GPS для Windows; у нас ещё графики, синхронизация и экспорт",
                whatItIs:
                    "CamGeoPlayer — бесплатная программа для Windows, которой нужен .NET 4.8. Она ставит видео в очередь, проигрывает их по порядку, извлекает встроенный GPS через ExifTool и рисует маршрут на OpenStreetMap с помощью Leaflet. Установщика нет: официальный zip нужно распаковать и запустить. На сайте проекта последней указана Beta 1.1 от 30 января 2024 года.",
                comparisonIntro:
                    "Оба приложения бесплатны и показывают GPS-маршрут на карте. Вот что everydashcam добавляет — и где его проще запустить.",
                compareRows: [
                    {
                        dimension: "Цена",
                        us: { mark: "yes", note: "Бесплатно" },
                        them: { mark: "yes", note: "Бесплатно" },
                    },
                    {
                        dimension: "Работает на Mac, Linux и мобильном",
                        us: { mark: "yes", note: "Любой современный браузер" },
                        them: { mark: "no", note: "Только Windows (нужен .NET)" },
                    },
                    {
                        dimension: "Ничего не качать и не ставить",
                        us: { mark: "yes", note: "Открывается в браузере" },
                        them: { mark: "partial", note: "Скачать zip, распаковать и запустить" },
                    },
                    {
                        dimension: "Последняя указанная версия",
                        us: { mark: "yes", note: "Активно развивается" },
                        them: { mark: "partial", note: "Beta 1.1 (январь 2024)" },
                    },
                    {
                        dimension: "Маршрут GPS на карте",
                        us: { mark: "yes", note: "Живой, синхронно" },
                        them: { mark: "yes", note: "Leaflet + OpenStreetMap" },
                    },
                    {
                        dimension: "График скорости и перегрузок",
                        us: { mark: "yes", note: "Да" },
                        them: { mark: "no", note: "Только карта" },
                    },
                    {
                        dimension: "Передняя, задняя и салонная камеры синхронно",
                        us: { mark: "yes", note: "Раскладки для нескольких камер" },
                        them: { mark: "no", note: "Проигрывает по одному видео за раз" },
                    },
                    {
                        dimension: "Обрезать и сохранить кусок с GPS",
                        us: { mark: "yes", note: "Да" },
                        them: { mark: "no", note: "Только просмотр" },
                    },
                ],
                whenStayTitle: "Когда CamGeoPlayer — нормальный выбор",
                whenStay:
                    "CamGeoPlayer — бесплатный локальный инструмент для одной задачи. Если у тебя Windows и нужен последовательный просмотр видео рядом с маршрутом GPS, после распаковки он справляется без аккаунта. everydashcam добавляет работу на разных платформах, графики, синхронизацию камер, автоматическую группировку поездок и экспорт клипов.",
                ctaPrimary: "Открыть свои записи",
            },
        },
    },
    {
        slug: "telemetry-overlay",
        displayName: "Telemetry Overlay",
        officialUrl: "https://goprotelemetryextractor.com/telemetry-overlay-gps-video-sensors",
        locales: {
            en: {
                title: "Telemetry Overlay alternative for dashcam video | everydashcam",
                metaDescription:
                    "Review dashcam GPS and export a simple speed/map overlay in your browser. A free alternative for quick jobs, with no install or upload.",
                ogTitle: "Free Telemetry Overlay alternative for dashcam footage",
                ogDescription:
                    "Telemetry Overlay is a paid desktop overlay tool. For dashcam footage, everydashcam reads the GPS and burns a speed/map overlay free, in your browser.",
                h1: "A free, in-browser alternative to Telemetry Overlay — for dashcam footage",
                lead: "Telemetry Overlay is a powerful, paid desktop tool for burning gauges onto action-cam video. If your footage is from a dashcam and you just want to see the route, speed and G-force — and maybe burn a simple speed-and-map overlay — everydashcam does that free, in your browser, reading the GPS straight off the card. No license, no install. For deep gauge production, Telemetry Overlay is still the more capable tool.",
                cardHint: "Paid desktop overlay tool; we read dashcam GPS free in the browser",
                whatItIs:
                    "Telemetry Overlay by Goprotelemetryextractor is a paid desktop app for Windows, macOS and Linux. It combines video with telemetry from action cameras and external files such as GPX, FIT and NMEA, offers hundreds of customizable gauges, and exports a rendered result. The official trial lasts three days and adds a watermark. It is a production tool for building overlays; everydashcam is an interactive viewer and simple clip exporter.",
                comparisonIntro:
                    "Telemetry Overlay goes deeper on gauges. Here's where a free browser tool has the edge for dashcam footage specifically.",
                compareRows: [
                    {
                        dimension: "Price",
                        us: { mark: "yes", note: "Free" },
                        them: { mark: "no", note: "Paid, one-time license (watermarked trial)" },
                    },
                    {
                        dimension: "How you run it",
                        us: { mark: "yes", note: "In the browser — nothing to install" },
                        them: { mark: "no", note: "Desktop install (Windows/Mac/Linux)" },
                    },
                    {
                        dimension: "Speed & GPS overlay + export",
                        us: { mark: "yes", note: "Speed, coordinates, mini-map" },
                        them: { mark: "yes", note: "Deep gauge library" },
                    },
                    {
                        dimension: "Gauge depth & extra sensors",
                        us: { mark: "partial", note: "Speed, GPS, G-force" },
                        them: { mark: "yes", note: "Hundreds of gauges, many sources" },
                    },
                ],
                whenStayTitle: "When Telemetry Overlay is the better tool",
                whenStay:
                    "Telemetry Overlay is the better tool when you want to produce a polished overlay video — it has a far deeper gauge library, supports action cameras (GoPro, DJI, Insta360) and many external data formats (GPX, FIT, NMEA), and exports broadcast-grade formats (ProRes, alpha PNG). everydashcam's overlay is deliberately simple: speed, coordinates and a mini-map burned onto your dashcam clip. For action-cam gauge production, Telemetry Overlay (a paid, installed tool) is the right choice; for free, instant dashcam review and a basic overlay in the browser, everydashcam fits.",
                ctaPrimary: "Open your recordings",
            },
            ru: {
                title: "Альтернатива Telemetry Overlay для регистратора | everydashcam",
                metaDescription:
                    "Просматривай GPS регистратора и добавляй простой оверлей скорости и карты в браузере. Бесплатно, без установки и загрузки.",
                ogTitle: "Бесплатная альтернатива Telemetry Overlay для регистратора",
                ogDescription:
                    "Telemetry Overlay — платная десктоп-программа для оверлеев. Для записей регистратора everydashcam читает GPS и наносит оверлей скорости/карты бесплатно, в браузере.",
                h1: "Бесплатная браузерная альтернатива Telemetry Overlay — для записей регистратора",
                lead: "Telemetry Overlay — мощная платная программа для компьютера, которая добавляет показания датчиков на видео с экшн-камер. Если у тебя запись с видеорегистратора и нужно увидеть маршрут, скорость и перегрузки или добавить на видео скорость и карту, everydashcam сделает это бесплатно прямо в браузере, прочитав GPS с карты памяти. Без лицензии и установки. Для сложной работы с данными датчиков Telemetry Overlay всё же мощнее.",
                cardHint: "Платная десктоп-программа оверлеев; мы читаем GPS регистратора бесплатно в браузере",
                whatItIs:
                    "Telemetry Overlay от Goprotelemetryextractor — платное приложение для Windows, macOS и Linux. Оно совмещает видео с телеметрией экшн-камер и внешними файлами GPX, FIT и NMEA, предлагает сотни настраиваемых индикаторов и экспортирует готовое видео. Официальная пробная версия работает три дня и добавляет водяной знак. Это инструмент для создания видео с наложенными данными; everydashcam — интерактивный плеер с простым экспортом фрагментов.",
                comparisonIntro:
                    "Telemetry Overlay предлагает больше индикаторов и настроек. Вот где у бесплатного браузерного инструмента преимущество именно для записей регистратора.",
                compareRows: [
                    {
                        dimension: "Цена",
                        us: { mark: "yes", note: "Бесплатно" },
                        them: { mark: "no", note: "Платно, разовая лицензия (пробная версия с водяным знаком)" },
                    },
                    {
                        dimension: "Как запускается",
                        us: { mark: "yes", note: "В браузере — ставить ничего не надо" },
                        them: { mark: "no", note: "Установка на десктоп (Windows/Mac/Linux)" },
                    },
                    {
                        dimension: "Оверлей скорости/GPS + экспорт",
                        us: { mark: "yes", note: "Скорость, координаты, мини-карта" },
                        them: { mark: "yes", note: "Большая библиотека индикаторов" },
                    },
                    {
                        dimension: "Настройка индикаторов и дополнительные датчики",
                        us: { mark: "partial", note: "Скорость, GPS, перегрузки" },
                        them: { mark: "yes", note: "Сотни индикаторов, много источников данных" },
                    },
                ],
                whenStayTitle: "Когда Telemetry Overlay — лучший выбор",
                whenStay:
                    "Telemetry Overlay лучше, когда нужно подготовить тщательно оформленное видео с наложенными данными: у него гораздо более широкая библиотека индикаторов, поддержка экшн-камер (GoPro, DJI, Insta360) и множества внешних форматов данных (GPX, FIT, NMEA), и экспорт в вещательные форматы (ProRes, alpha-PNG). Оверлей everydashcam намеренно простой: скорость, координаты и мини-карта поверх клипа с регистратора. Для создания видео с показаниями датчиков экшн-камеры Telemetry Overlay (платный, устанавливаемый) — верный выбор; для бесплатного быстрого просмотра записей регистратора и простого оверлея в браузере подходит everydashcam.",
                ctaPrimary: "Открыть свои записи",
            },
        },
    },
];

// Per-locale chrome labels (section headings, breadcrumbs, etc.). {name} is
// substituted with the competitor displayName at render time. en + ru inline;
// the 8 community locales merge in from COMMUNITY_ALT_LABELS.
export interface AltSharedLabels {
    backToPlayer: string;
    breadcrumbHome: string;
    breadcrumbAlternatives: string;
    whatItIsHeading: string; // "What is {name}?"
    comparisonHeading: string; // "{name} vs everydashcam"
    compareColUs: string; // header for the everydashcam column
    officialSiteLabel: string; // outbound-link label
    howHeading: string;
    howSteps: [string, string, string];
    howSecondaryCta: string;
    otherToolsHeading: string;
    camerasLink: string; // link text to the /cameras/ hub
    footerPrivacy: string;
    footerTerms: string;
    footerHome: string;
}

const SHARED_LABELS: Partial<Record<Lang, AltSharedLabels>> = {
    en: {
        backToPlayer: "← Back to player",
        breadcrumbHome: "Home",
        breadcrumbAlternatives: "Alternatives",
        whatItIsHeading: "What is {name}?",
        comparisonHeading: "{name} vs everydashcam",
        compareColUs: "everydashcam",
        officialSiteLabel: "Official site ↗",
        howHeading: "Switching to everydashcam",
        howSteps: [
            "Take the SD card out of the dashcam and plug it into your computer.",
            "Open everydashcam.app in any modern browser.",
            "Drag the whole SD-card folder onto the page — it detects, groups and plays.",
        ],
        howSecondaryCta: "Try it now",
        otherToolsHeading: "Other tools everydashcam replaces",
        camerasLink: "Supported cameras",
        footerPrivacy: "Privacy policy",
        footerTerms: "Terms of use",
        footerHome: "everydashcam.app",
    },
    ru: {
        backToPlayer: "← К плееру",
        breadcrumbHome: "Главная",
        breadcrumbAlternatives: "Альтернативы",
        whatItIsHeading: "Что такое {name}?",
        comparisonHeading: "{name} против everydashcam",
        compareColUs: "everydashcam",
        officialSiteLabel: "Официальный сайт ↗",
        howHeading: "Переход на everydashcam",
        howSteps: [
            "Достань SD-карту из регистратора и вставь в компьютер.",
            "Открой everydashcam.app в любом современном браузере.",
            "Перетащи всю папку с SD-карты на страницу — она сама всё разберёт и проиграет.",
        ],
        howSecondaryCta: "Попробовать",
        otherToolsHeading: "Другие программы, которые заменяет everydashcam",
        camerasLink: "Поддерживаемые камеры",
        footerPrivacy: "Политика конфиденциальности",
        footerTerms: "Условия использования",
        footerHome: "everydashcam.app",
    },
};

// Trademark / non-affiliation disclaimer shown in the footer of every
// alternative page. Competitor pages name third-party brands; this is the
// standard nominative-fair-use safeguard against an "implied affiliation"
// claim (it does not make a false claim about a competitor - that risk is
// handled by the VERIFIED-only content). Kept here (all 10 locales inline)
// rather than in the generated content file - it's one short string and
// must never silently fall back. NOT legal advice; wording is conservative.
const ALT_DISCLAIMER: Record<Lang, string> = {
    en: "All product names are trademarks of their respective owners. everydashcam is independent and not affiliated with, endorsed by or sponsored by them.",
    ru: "Все названия продуктов — товарные знаки их владельцев. everydashcam независим, не связан с ними, не одобрен и не спонсируется ими.",
    de: "Alle Produktnamen sind Marken ihrer jeweiligen Inhaber. everydashcam ist unabhängig und steht in keiner Verbindung zu ihnen, wird von ihnen weder unterstützt noch gesponsert.",
    es: "Todos los nombres de productos son marcas comerciales de sus respectivos propietarios. everydashcam es independiente y no está afiliado a ellos ni cuenta con su respaldo o patrocinio.",
    fr: "Tous les noms de produits sont des marques de leurs propriétaires respectifs. everydashcam est indépendant et n'est ni affilié à eux, ni approuvé ou sponsorisé par eux.",
    ja: "すべての製品名は各所有者の商標です。everydashcam は独立したサービスであり、これらと提携しておらず、推奨やスポンサーを受けてもいません。",
    ko: "모든 제품 이름은 해당 소유자의 상표입니다. everydashcam는 독립적인 서비스이며 이들과 제휴하거나 보증·후원을 받지 않습니다.",
    pl: "Wszystkie nazwy produktów są znakami towarowymi ich właścicieli. everydashcam jest niezależny i nie jest z nimi powiązany ani przez nich wspierany czy sponsorowany.",
    pt: "Todos os nomes de produtos são marcas registradas de seus respectivos proprietários. O everydashcam é independente e não é afiliado a eles nem possui seu endosso ou patrocínio.",
    zh: "所有产品名称均为其各自所有者的商标。everydashcam 是独立服务，与它们无关联，也未获得其认可或赞助。",
};

// /alternatives/ hub index copy.
export interface AltIndexLocale {
    title: string;
    metaDescription: string;
    ogTitle: string;
    ogDescription: string;
    h1: string;
    lead: string;
}

const INDEX_LOCALES: Partial<Record<Lang, AltIndexLocale>> = {
    en: {
        title: "Free alternatives to dashcam viewers — in your browser | everydashcam",
        metaDescription:
            "Compare everydashcam with Dashcam Viewer, CamGeoPlayer and Telemetry Overlay — GPS map, speed chart, no install.",
        ogTitle: "Free in-browser alternative to dashcam viewers",
        ogDescription:
            "See how everydashcam compares with Dashcam Viewer, CamGeoPlayer and Telemetry Overlay — free and in your browser.",
        h1: "Free, in-browser alternatives to popular dashcam tools",
        lead: "Switching from another dashcam viewer? everydashcam plays your recordings in the browser — free, nothing to install — with a synchronized GPS map, a speed and G-force chart, and multi-camera playback. Here's how it compares to the tools people use today.",
    },
    ru: {
        title: "Бесплатные альтернативы плеерам регистратора — в браузере | everydashcam",
        metaDescription:
            "Сравни everydashcam с Dashcam Viewer, CamGeoPlayer и Telemetry Overlay: карта GPS, график скорости и работа без установки.",
        ogTitle: "Бесплатная альтернатива плеерам регистратора в браузере",
        ogDescription:
            "Сравни everydashcam с Dashcam Viewer, CamGeoPlayer и Telemetry Overlay — бесплатно и прямо в браузере.",
        h1: "Бесплатные альтернативы популярным программам для регистратора",
        lead: "Переходишь с другого плеера для видеорегистратора? everydashcam показывает записи прямо в браузере — бесплатно и без установки — вместе с синхронной картой GPS, графиком скорости и перегрузок и несколькими камерами. Вот как он выглядит рядом с популярными программами.",
    },
};

// ----- resolution helpers (hand-written en/ru, community fallback, then en) -----

function resolveAltContent(competitor: Competitor, lang: Lang): AltLocaleContent {
    const direct = competitor.locales[lang];
    if (direct) return direct;
    const community = COMMUNITY_ALT_CONTENT[competitor.slug]?.[lang];
    if (community) return community;
    // EN is the guaranteed baseline; falling back to it keeps a missing
    // translation from crashing the dev server (the build path is gated by
    // assertAltLocaleParity instead, which fails loudly).
    const en = competitor.locales.en;
    if (!en) throw new Error(`alternative-pages: competitor "${competitor.slug}" has no en content`);
    return en;
}

function resolveLabels(lang: Lang): AltSharedLabels {
    return SHARED_LABELS[lang] ?? COMMUNITY_ALT_LABELS[lang] ?? SHARED_LABELS.en!;
}

function resolveIndexLocale(lang: Lang): AltIndexLocale {
    return INDEX_LOCALES[lang] ?? COMMUNITY_ALT_INDEX[lang] ?? INDEX_LOCALES.en!;
}

// ----- rendering -----

const COMPARE_MARK_CLASS: Record<CompareMark, string> = {
    yes: "alt-yes",
    no: "alt-no",
    partial: "alt-partial",
};

function renderCompareCell(cell: CompareCell, columnClass: string): string {
    return `<td class="${columnClass}"><span class="${COMPARE_MARK_CLASS[cell.mark]}">${escapeText(cell.note)}</span></td>`;
}

function renderComparisonTable(content: AltLocaleContent, labels: AltSharedLabels, competitorName: string): string {
    const rows = content.compareRows
        .map(
            (row) => `<tr>
<th scope="row">${escapeText(row.dimension)}</th>
${renderCompareCell(row.us, "alt-col-us")}
${renderCompareCell(row.them, "alt-col-them")}
</tr>`,
        )
        .join("\n");
    return `<div class="alt-compare-wrap" role="region" aria-labelledby="comparison-heading" tabindex="0">
<table class="alt-compare">
<thead>
<tr>
<th scope="col"></th>
<th scope="col" class="alt-col-us">${escapeText(labels.compareColUs)}</th>
<th scope="col" class="alt-col-them">${escapeText(competitorName)}</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
}

export function renderAlternativePage(competitor: Competitor, lang: Lang, options: SeoBuildOptions): string {
    const seoLocale = getSeoLocaleByLang(lang);
    if (!seoLocale) throw new Error(`alternative-pages: lang "${lang}" not in SEO_LOCALES`);

    const content = resolveAltContent(competitor, lang);
    const labels = resolveLabels(lang);
    const pathPrefix = pathPrefixFor(lang);
    const name = competitor.displayName;

    const localHome = `${pathPrefix}/`;
    const url = canonicalLocaleUrl(seoLocale, `alternatives/${competitor.slug}/`);
    const homeUrl = canonicalLocaleUrl(seoLocale);
    const alternativesUrl = canonicalLocaleUrl(seoLocale, "alternatives/");
    const ctaHref = `${pathPrefix}/`;
    const otherTools = ALTERNATIVES.filter((c) => c.slug !== competitor.slug);
    const ogImageUrl = `${canonicalOriginForLocale(seoLocale)}/${seoLocale.ogImage}`;

    const hreflangBlock = renderSeoAlternates(`alternatives/${competitor.slug}/`);
    const ogLocaleAlternatesBlock = buildOgLocaleAlternatesHtml(lang);
    const languageLinks = renderSeoLanguageLinks(
        lang,
        (locale) => `/${locale.urlSegment}/alternatives/${competitor.slug}/`,
    );

    const breadcrumb = renderBreadcrumbs(lang, [
        { name: labels.breadcrumbHome, url: homeUrl },
        { name: labels.breadcrumbAlternatives, url: alternativesUrl },
        { name, url },
    ]);

    return `<!doctype html>
<html lang="${lang}">
${renderMarketingHead({ seoLocale, noIndex: options.noIndex, content, url, hreflangBlock, ogImageUrl, ogLocaleAlternatesBlock, structuredData: `<script type="application/ld+json">${breadcrumb.jsonLd}</script>` })}
<body>
<header class="vp-header">
<a href="${localHome}" class="vp-brand" aria-label="everydashcam">
${BRAND_MARK_HTML}
</a>
<a href="${localHome}" class="vp-back">${escapeText(labels.backToPlayer)}</a>
</header>
<main class="vp-main">
${breadcrumb.html}
<article>
<h1 class="vp-h1">${escapeText(content.h1)}</h1>
<p class="vp-lead">${escapeText(content.lead)}</p>
<a href="${ctaHref}" class="vp-cta">${escapeText(content.ctaPrimary)}</a>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.whatItIsHeading.replace("{name}", name))}</h2>
<p>${escapeText(content.whatItIs)}</p>
<p><a href="${escapeAttr(competitor.officialUrl)}" rel="noopener" target="_blank">${escapeText(labels.officialSiteLabel)}</a></p>
</section>

<section class="vp-section">
<h2 id="comparison-heading" class="vp-h2">${escapeText(labels.comparisonHeading.replace("{name}", name))}</h2>
<p>${escapeText(content.comparisonIntro)}</p>
${renderComparisonTable(content, labels, name)}
<div class="alt-when">
<div class="alt-when-title">${escapeText(content.whenStayTitle)}</div>
<p>${escapeText(content.whenStay)}</p>
</div>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.howHeading)}</h2>
<ol class="vp-steps">
${labels.howSteps.map((step) => `<li>${escapeText(step)}</li>`).join("\n")}
</ol>
<a href="${ctaHref}" class="vp-cta vp-cta--secondary">${escapeText(labels.howSecondaryCta)}</a>
</section>

${renderFeatureLinksHtml(lang, pathPrefix)}
</article>

<aside class="vp-other-vendors">
<h3 class="vp-h3">${escapeText(labels.otherToolsHeading)}</h3>
<ul>
${otherTools
    .map((other) => `<li><a href="${pathPrefix}/alternatives/${other.slug}/">${escapeText(other.displayName)}</a></li>`)
    .join("\n")}
<li><a href="${pathPrefix}/cameras/">${escapeText(labels.camerasLink)}</a></li>
</ul>
</aside>
</main>

${renderMarketingFooter({ seoLocale, localHome, languageLinks, labels, disclaimer: ALT_DISCLAIMER[lang] })}
</body>
</html>
`;
}

export function renderAlternativesIndexPage(lang: Lang, options: SeoBuildOptions): string {
    const seoLocale = getSeoLocaleByLang(lang);
    if (!seoLocale) throw new Error(`alternative-pages: lang "${lang}" not in SEO_LOCALES`);

    const content = resolveIndexLocale(lang);
    const labels = resolveLabels(lang);
    const pathPrefix = pathPrefixFor(lang);
    const localHome = `${pathPrefix}/`;
    const url = canonicalLocaleUrl(seoLocale, "alternatives/");
    const homeUrl = canonicalLocaleUrl(seoLocale);
    const ogImageUrl = `${canonicalOriginForLocale(seoLocale)}/${seoLocale.ogImage}`;

    const hreflangBlock = renderSeoAlternates("alternatives/");
    const ogLocaleAlternatesBlock = buildOgLocaleAlternatesHtml(lang);
    const languageLinks = renderSeoLanguageLinks(lang, (locale) => `/${locale.urlSegment}/alternatives/`);

    const breadcrumb = renderBreadcrumbs(lang, [
        { name: labels.breadcrumbHome, url: homeUrl },
        { name: labels.breadcrumbAlternatives, url },
    ]);
    const collection = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: content.h1,
        description: content.lead,
        url,
        inLanguage: seoLocale.contentLanguage,
        mainEntity: {
            "@type": "ItemList",
            numberOfItems: ALTERNATIVES.length,
            itemListElement: ALTERNATIVES.map((c, idx) => ({
                "@type": "ListItem",
                position: idx + 1,
                url: canonicalLocaleUrl(seoLocale, `alternatives/${c.slug}/`),
                name: c.displayName,
            })),
        },
    };

    const cards = ALTERNATIVES.map((c) => {
        const cardHint = resolveAltContent(c, lang).cardHint;
        return `<li><a class="vp-vendor-card" href="${pathPrefix}/alternatives/${c.slug}/">
<span class="vp-vendor-card-name">${escapeText(c.displayName)}</span>
<span class="vp-vendor-card-hint">${escapeText(cardHint)}</span>
</a></li>`;
    }).join("\n");

    return `<!doctype html>
<html lang="${lang}">
${renderMarketingHead({
    seoLocale,
    noIndex: options.noIndex,
    content,
    url,
    hreflangBlock,
    ogImageUrl,
    ogLocaleAlternatesBlock,
    structuredData: `<script type="application/ld+json">${breadcrumb.jsonLd}</script>
<script type="application/ld+json">${stringifyJsonLd(collection)}</script>`,
})}
<body>
<header class="vp-header">
<a href="${localHome}" class="vp-brand" aria-label="everydashcam">
${BRAND_MARK_HTML}
</a>
<a href="${localHome}" class="vp-back">${escapeText(labels.backToPlayer)}</a>
</header>
<main class="vp-main">
${breadcrumb.html}
<article>
<h1 class="vp-h1">${escapeText(content.h1)}</h1>
<p class="vp-lead">${escapeText(content.lead)}</p>
<ul class="vp-vendor-grid">
${cards}
</ul>
<p class="vp-note"><a href="${pathPrefix}/cameras/">${escapeText(labels.camerasLink)} →</a></p>
${renderHubCta(lang, pathPrefix)}
</article>
</main>
${renderMarketingFooter({ seoLocale, localHome, languageLinks, labels, disclaimer: ALT_DISCLAIMER[lang] })}
</body>
</html>
`;
}

// ----- build-time integrity asserts -----

// Fail the build if any indexable locale is missing its labels, index copy or a
// competitor's content. Without this, a forgotten translation would silently
// fall back to English under a localized canonical/hreflang - a duplicate-content
// SEO regression that no test would otherwise catch. Same spirit as
// the vendor-page build guards. Exported for a unit test.
export function assertAltLocaleParity(): void {
    const problems: string[] = [];
    for (const loc of getIndexableSeoLocales()) {
        const lang = loc.lang;
        if (!SHARED_LABELS[lang] && !COMMUNITY_ALT_LABELS[lang]) {
            problems.push(`labels: missing locale "${lang}"`);
        }
        if (!INDEX_LOCALES[lang] && !COMMUNITY_ALT_INDEX[lang]) {
            problems.push(`index: missing locale "${lang}"`);
        }
        for (const competitor of ALTERNATIVES) {
            const direct = competitor.locales[lang];
            const community = COMMUNITY_ALT_CONTENT[competitor.slug]?.[lang];
            if (!direct && !community) {
                problems.push(`${competitor.slug}: missing locale "${lang}"`);
                continue;
            }
            const resolved = direct ?? community;
            const enRowsLen = competitor.locales.en?.compareRows.length ?? 0;
            if (resolved && resolved.compareRows.length !== enRowsLen) {
                problems.push(
                    `${competitor.slug}/${lang}: ${resolved.compareRows.length} compare rows, en source has ${enRowsLen}`,
                );
            }
        }
    }
    if (problems.length > 0) {
        throw new Error(`alternative-pages: locale parity broken\n  ${problems.join("\n  ")}`);
    }
}

// ----- vite plugin -----

export function alternativePagesPlugin(options: SeoBuildOptions = {}): Plugin {
    // No apply restriction (the dev middleware below must run under `vite dev`),
    // so closeBundle needs a build guard: Vite's dev PluginContainer.close()
    // also invokes closeBundle, and without it a Ctrl-C of the dev server
    // would silently write alternative pages into dist/.
    let isBuild = false;
    return {
        name: "everydashcam-alternative-pages",
        configResolved(config) {
            isBuild = config.command === "build";
        },
        closeBundle() {
            if (!isBuild) return;
            assertAltLocaleParity();
            const distDir = resolve(process.cwd(), "dist");
            for (const seoLocale of getIndexableSeoLocales()) {
                const lang = seoLocale.lang;
                const prefix = `${seoLocale.urlSegment}/`;
                const indexDir = resolve(distDir, `${prefix}alternatives`);
                mkdirSync(indexDir, { recursive: true });
                writeFileSync(resolve(indexDir, "index.html"), renderAlternativesIndexPage(lang, options));
                for (const competitor of ALTERNATIVES) {
                    const targetDir = resolve(distDir, `${prefix}alternatives/${competitor.slug}`);
                    mkdirSync(targetDir, { recursive: true });
                    writeFileSync(resolve(targetDir, "index.html"), renderAlternativePage(competitor, lang, options));
                }
            }
        },
        configureServer(server) {
            // Same dev middleware shape as vendor-pages: render /alternatives/*
            // on the fly so the URLs work under `npm run dev` instead of falling
            // through to the SPA index.html.
            server.middlewares.use((req, res, next) => {
                if (req.method !== "GET" && req.method !== "HEAD") return next();
                const rawUrl = req.url ?? "/";
                const pathOnly = rawUrl.split(/[?#]/, 1)[0] ?? "/";
                const result = matchAlternativeRoute(pathOnly);
                if (!result) return next();

                let body: string;
                try {
                    body =
                        result.kind === "index"
                            ? renderAlternativesIndexPage(result.lang, options)
                            : renderAlternativePage(result.competitor, result.lang, options);
                } catch (err) {
                    server.config.logger.error(
                        `[alternative-pages] failed to render ${pathOnly}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                    return next();
                }

                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(req.method === "HEAD" ? "" : body);
            });
        },
    };
}

// Result of matching a request path against the alternative-pages URL space.
export type AlternativeRouteMatch =
    | { kind: "index"; lang: Lang }
    | { kind: "competitor"; lang: Lang; competitor: Competitor };

export function matchAlternativeRoute(path: string): AlternativeRouteMatch | null {
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return null;

    let lang: Lang = "en";
    let i = 0;
    const maybeLocale = getIndexableSeoLocales().find((l) => l.urlSegment === segments[0]);
    if (maybeLocale) {
        lang = maybeLocale.lang;
        i = 1;
    }

    if (segments[i] !== "alternatives") return null;
    i++;

    if (i === segments.length) {
        return { kind: "index", lang };
    }
    if (i === segments.length - 1) {
        const slug = segments[i];
        const competitor = ALTERNATIVES.find((c) => c.slug === slug);
        if (!competitor) return null;
        return { kind: "competitor", lang, competitor };
    }
    return null;
}

// ----- sitemap entries (consumed by seo-prerender.ts sitemapPlugin) -----

interface AltSitemapEntry {
    loc: string;
    changefreq: string;
    priority: string;
    alternates: Record<string, string>;
    xDefaultUrl: string;
    lastmod?: string;
}

// Sitemap entries for the /alternatives/ hub + each competitor page, per locale.
// Mirrors getVendorSitemapEntries: per-page alternates point at that page's own
// locale siblings, x-default at the English variant.
export function getAlternativeSitemapEntries(): AltSitemapEntry[] {
    const entries: AltSitemapEntry[] = [];
    const indexable = getIndexableSeoLocales();
    const defaultLang = getDefaultSeoLocale().lang;

    // Locale and competitor content shares monolithic source files. Their
    // mtimes cannot identify which URL changed, so omit lastmod rather than
    // publish a site-wide false freshness signal.

    const indexGraph = buildSeoAlternates("alternatives/");
    for (const loc of indexable) {
        entries.push({
            loc: canonicalLocaleUrl(loc, "alternatives/"),
            changefreq: "monthly",
            priority: loc.lang === defaultLang ? "0.8" : "0.7",
            ...indexGraph,
        });
    }

    for (const competitor of ALTERNATIVES) {
        const compGraph = buildSeoAlternates(`alternatives/${competitor.slug}/`);
        for (const loc of indexable) {
            entries.push({
                loc: canonicalLocaleUrl(loc, `alternatives/${competitor.slug}/`),
                changefreq: "monthly",
                priority: loc.lang === defaultLang ? "0.7" : "0.6",
                ...compGraph,
            });
        }
    }
    return entries;
}

// Exported for the redirects / llms plugins and tests - the canonical competitor
// slug list, in render order.
export function getAlternativeSlugs(): AltSlug[] {
    return ALTERNATIVES.map((c) => c.slug);
}

// Slug + display name for each competitor page, in render order. Used by
// llms-txt.ts to list the "tools everydashcam replaces" with their URLs.
export function getAlternativeListings(): Array<{ slug: AltSlug; displayName: string }> {
    return ALTERNATIVES.map((c) => ({ slug: c.slug, displayName: c.displayName }));
}
