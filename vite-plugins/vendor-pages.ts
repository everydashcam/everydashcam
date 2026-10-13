// Vendor landing pages for the top dashcam brands - every SUPPORTED_BRANDS
// entry with hasLandingPage=true (see supported-brands.ts for the source of
// truth). Each gets static HTML at /<lang>/cameras/<slug>/ for its explicit
// set of useful, reviewed locales. Purpose: capture long-tail SERP traffic
// like "70mai player online", "blackvue dashcam viewer" etc., where the
// main /, /ru/ landing pages have to fight on the generic "dashcam player"
// term with no brand specificity.
//
// Each page is a lightweight content document (~5-10KB HTML, no JS app
// bundle, no map / chart / player) - the goal is fast TTFB / LCP on first
// crawler visit and a clean Core Web Vitals score. Clicking the CTA takes
// the user to / (or /ru/) where the full app loads. The shared brand
// styles live in public/vendor-page.css.
//
// Vendor-specific facts combine public model lineups with recording behavior
// implemented by the app. Public copy stays focused on the visitor's job:
// open a folder, review the trip and export a clip. Parser evidence and fixture
// status belong in docs/gps-format-coverage.md, not on this SEO surface.
//
// JSON-LD per page: BreadcrumbList (Home > Cameras > <Vendor>). Model lists
// target the product families people search for; the copy keeps the honest
// user-facing boundary that video opens locally while GPS depends on the data
// stored by the camera.
//
// Adding a new vendor: promote it in SUPPORTED_BRANDS with an explicit locale
// set, then append the matching content block to VENDORS.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { BRAND_DISCLAIMER } from "../src/i18n/brand-disclaimer.js";
import type { Lang } from "../src/i18n/index.js";
import {
    REPO_URL,
    buildHreflangAlternatesMap,
    getDefaultSeoLocale,
    getHreflangCodes,
    getIndexableSeoLocales,
    getSeoLocaleByLang,
    type SeoLocale,
} from "../src/i18n/seo-config.js";
import {
    canonicalLocaleUrl,
    canonicalOriginForLocale,
    searchIndexingMeta,
} from "./deployment-profile.js";
import { escapeAttr, escapeText, stringifyJsonLd } from "./html-utils.js";
import { renderHubCta } from "./hub-cta.js";
import { cameraCatalogAnchor, renderCameraBrandCard } from "./camera-catalog.js";
import type { SeoBuildOptions } from "./seo-prerender.js";
import { renderBreadcrumbs, renderSeoLanguageLinks } from "./seo-navigation.js";

export const BRAND_MARK_HTML = `<span class="edc-mark" role="img" aria-label="everydashcam"><span class="edc-mark__drums" aria-hidden="true"><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">E</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">V</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">E</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">R</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">Y</span></span></span></span><span class="edc-mark__word" aria-hidden="true">DASHCAM</span></span>`;

// VendorSlug + SUPPORTED_BRANDS live in supported-brands.ts as the single
// SEO inventory. We use the slug type here as the discriminator on
// VendorContent and the getLandingBrands() list to cross-check that every
// landing brand has a matching VendorContent block (assertVendorListsAligned).
import { getLandingBrands, SUPPORTED_BRANDS, type VendorSlug } from "./supported-brands.js";

import { renderFeatureLinksHtml } from "./feature-links.js";
import type { FeatureSlug } from "./feature-pages.js";
import { cameraPages } from "./vendor-pages-content.js";

// Per-locale content for one vendor.
export interface VendorLocaleContent {
    // <title> - long form, ≤70 chars ideally.
    title: string;
    // <meta name="description"> - ≤155 chars.
    metaDescription: string;
    // Short OG title (≤60 chars), separate from meta to fit unfurl cards.
    ogTitle: string;
    // OG description ~150 chars - punchier than meta description.
    ogDescription: string;
    // <h1> on the page.
    h1: string;
    // Subtitle paragraph under h1, 1-2 sentences.
    lead: string;
    // Primary CTA button text ("Open recordings folder").
    ctaPrimary: string;
    // Compatibility note under the models list.
    modelsCompat: string;
    // Camera-specific instructions shown before the opening steps.
    formatIntro: string;
}

// Camera-specific recording guidance and localized marketing copy.
export interface VendorContent {
    slug: VendorSlug;
    // Display name shown in titles, headings, breadcrumbs.
    displayName: string;
    // Search-relevant model families covered by this vendor page.
    models: string[];
    // File names and folders used by established community translations.
    format?: {
        sdLayout: string; // "/Normal/, /Event/, /Parking/"
        filenamePattern: string; // example filename
    };
    // Hand-written per-locale content. The renderer can fall back to
    // VENDOR_TEMPLATES for established community pages; new locale rollouts
    // should carry reviewed direct copy before entering the published set.
    locales: Record<"en" | "ru", VendorLocaleContent> & Partial<Record<Lang, VendorLocaleContent>>;
    features?: readonly FeatureSlug[];
}

// Published vendor content. The support registry owns catalog order and locales.
const VENDORS: VendorContent[] = [
    {
        slug: "70mai",
        displayName: "70mai",
        models: [
            "A810 / A810S",
            "A800 / A800S",
            "A510",
            "M500",
            "Omni / X200",
            "X800 / T800",
            "Pro / Pro Plus+",
        ],
        format: {
            sdLayout: "/Normal/, /Event/, /Lapse/ (+ Front/Back/Interior subfolders on multi-channel models)",
            filenamePattern: "NO20240821-180010-000123.mp4",
        },
        locales: {
            en: {
                title: "70mai Dashcam Player — A810, A800S, A510, Omni | everydashcam",
                metaDescription:
                    "Open 70mai A810, A800S, A510, M500, Omni and X800 recordings in your browser. GPS map, speed chart and synchronized cameras. No upload or install.",
                ogTitle: "70mai Player Online — A810, A800S, A510, Omni",
                ogDescription:
                    "Free online player for 70mai dashcam recordings. GPS map, speed chart and synchronized cameras. Works in any modern browser, nothing uploaded.",
                h1: "70mai Dashcam Player Online — play recordings in your browser",
                lead: "Open 70mai recordings from the SD card to watch the trip and its cameras together. Follow the route and speed when GPS was saved, then keep the part you need.",
                ctaPrimary: "Open 70mai recordings folder",
                modelsCompat: "Covers common current and recent 70mai recording layouts. Standard MP4 video opens locally; GPS and camera grouping depend on the metadata written by the model.",
                formatIntro:
                    "Open the whole card, including any GPSData*.txt files. Some 70mai models store the route in these separate files; others keep it inside the video. Keep the original front, rear and cabin filenames.",
            },
            ru: {
                title: "Плеер 70mai — A810, A800S, A510, Omni | everydashcam",
                metaDescription:
                    "Открывай записи 70mai A810, A800S, A510, M500, Omni и X800 в браузере. Карта GPS, график скорости и синхронные камеры. Без загрузки и установки.",
                ogTitle: "Плеер 70mai онлайн — A810, A800S, A510, Omni",
                ogDescription:
                    "Онлайн-плеер для записей с видеорегистратора 70mai. Карта GPS, график скорости и синхронный просмотр камер. Работает в любом современном браузере, ничего никуда не загружается.",
                h1: "Плеер 70mai онлайн — записи в браузере, без установки",
                lead: "Открой записи 70mai с SD-карты и смотри поездку со всех камер. Если сохранился GPS, рядом будут маршрут и скорость; нужный фрагмент можно сохранить.",
                ctaPrimary: "Открыть папку с записями 70mai",
                modelsCompat: "Поддерживает распространённые форматы актуальных и недавних моделей 70mai. Обычное MP4-видео открывается локально; GPS и группировка камер зависят от данных конкретной модели.",
                formatIntro:
                    "Открой карту целиком, включая файлы GPSData*.txt, если они есть. Одни модели 70mai сохраняют маршрут в этих отдельных файлах, другие — внутри видео. Сохрани исходные имена записей передней, задней и салонной камер.",
            },
        },
    },
    {
        slug: "viofo",
        displayName: "Viofo",
        models: [
            "A119 / A119 V3 / A119 Mini 2",
            "A129 Plus / Pro Duo",
            "A139 / A139 Pro",
            "A229 Plus / Pro",
            "A329 / A329S",
            "T130",
        ],
        format: {
            sdLayout: "/Movie/, /Movie_Parking/, /Photo/",
            filenamePattern: "2024_0821_180010_062F.MP4",
        },
        locales: {
            en: {
                title: "Viofo Dashcam Player — A119, A229, A329, T130 | everydashcam",
                metaDescription:
                    "Open Viofo A119, A129, A139, A229, A329 and T130 recordings in your browser. GPS map, speed chart and multi-camera playback. No upload or install.",
                ogTitle: "Viofo Player Online — A119, A229, A329, T130",
                ogDescription:
                    "Free online player for Viofo dashcam recordings. GPS map, speed chart and synchronized cameras. Works in any modern browser, nothing uploaded.",
                h1: "Viofo Dashcam Player Online — play recordings in your browser",
                lead: "Watch Viofo front, rear and interior recordings together in your browser. Review the trip with a route and speed when the recording contains GPS, then save a clip.",
                ctaPrimary: "Open Viofo recordings folder",
                modelsCompat: "Covers the common Viofo MP4 and TS recording layouts. Standard video opens locally; the GPS map and automatic camera sync depend on the data stored by the camera.",
                formatIntro:
                    "Open the original recording folder, including MP4 or TS videos. Keep the F, R or I endings in filenames: they identify the camera views, so a trip can include more than the front camera.",
            },
            ru: {
                title: "Плеер Viofo — A119, A229, A329, T130 | everydashcam",
                metaDescription:
                    "Открывай записи Viofo A119, A129, A139, A229, A329 и T130 в браузере. Карта GPS, график скорости и несколько камер. Без загрузки и установки.",
                ogTitle: "Плеер Viofo онлайн — A119, A229, A329, T130",
                ogDescription:
                    "Онлайн-плеер для записей с видеорегистратора Viofo. Карта GPS, график скорости и синхронный просмотр камер. Работает в любом современном браузере.",
                h1: "Плеер Viofo онлайн — записи в браузере, без установки",
                lead: "Смотри записи передней, задней и салонной камер Viofo вместе в браузере. Если в записи есть GPS, рядом будут маршрут и скорость. Нужный фрагмент можно сохранить.",
                ctaPrimary: "Открыть папку с записями Viofo",
                modelsCompat: "Поддерживает распространённые форматы записей Viofo в MP4 и TS. Обычное видео открывается локально; карта GPS и синхронизация камер зависят от данных в записи.",
                formatIntro:
                    "Открой исходную папку с записями MP4 или TS. Сохрани окончания F, R или I в именах файлов: они обозначают ракурсы, чтобы поездка включала не только переднюю камеру.",
            },
        },
    },
    {
        slug: "blackvue",
        displayName: "BlackVue",
        models: [
            "DR970X / DR970X Plus",
            "DR900X / DR900X Plus",
            "DR770X / DR770X Plus",
            "DR750X / DR750X Plus",
            "DR590X",
            "DR550 / DR650 (legacy)",
        ],
        format: {
            sdLayout: "/BlackVue/Record/, /BlackVue/Event/, /BlackVue/Parking/, /BlackVue/Manual/",
            filenamePattern: "20240821_180010_NF.mp4 (Normal Front)",
        },
        locales: {
            en: {
                title: "BlackVue Player — DR970X, DR900X, DR770X | everydashcam",
                metaDescription:
                    "Open BlackVue DR970X, DR900X, DR770X, DR750X and legacy DR-series recordings in your browser. GPS map, speed chart and front/rear playback.",
                ogTitle: "BlackVue Player Online — DR970X, DR900X, DR770X",
                ogDescription:
                    "Free online player for BlackVue dashcam recordings. GPS map, speed chart, front+rear in sync. Works in any browser, no BlackVue Cloud account needed.",
                h1: "BlackVue Dashcam Player Online — play recordings in your browser",
                lead: "Review BlackVue front and rear recordings together, with the route and speed when GPS is available. Watch and save a clip without installing BlackVue Viewer or creating a Cloud account.",
                ctaPrimary: "Open BlackVue recordings folder",
                modelsCompat: "Covers modern BlackVue X-series recordings with embedded GPS and older DR-series layouts that keep GPS in matching sidecar files.",
                formatIntro:
                    "Open the BlackVue recording folder with its .gps and .3gf files, if present. Older DR-series recordings use these companion files; modern X-series recordings can keep GPS inside the video.",
            },
            ru: {
                title: "Плеер BlackVue — DR970X, DR900X, DR770X | everydashcam",
                metaDescription:
                    "Открывай записи BlackVue DR970X, DR900X, DR770X, DR750X и старых DR-серий в браузере. Карта GPS, график скорости и передняя и задняя камеры.",
                ogTitle: "Плеер BlackVue онлайн — DR970X, DR900X, DR770X",
                ogDescription:
                    "Онлайн-плеер для записей с BlackVue. Карта GPS, график скорости, передняя и задняя камеры синхронно. Работает в любом браузере, без аккаунта BlackVue Cloud.",
                h1: "Плеер BlackVue онлайн — записи в браузере, без BlackVue Viewer",
                lead: "Смотри передние и задние записи BlackVue вместе с маршрутом и скоростью, если есть GPS. Просмотр и сохранение фрагмента доступны без установки BlackVue Viewer и аккаунта Cloud.",
                ctaPrimary: "Открыть папку с записями BlackVue",
                modelsCompat: "Поддерживает современные записи BlackVue X-серии со встроенным GPS и старые форматы DR-серии, где GPS лежит в парных служебных файлах.",
                formatIntro:
                    "Открой папку записей BlackVue вместе с файлами .gps и .3gf, если они есть. Старые записи DR-серии используют эти дополнительные файлы; современные записи X-серии могут хранить GPS внутри видео.",
            },
        },
    },
    {
        slug: "gopro",
        displayName: "GoPro",
        models: [
            "HERO6 / HERO7 / HERO8",
            "HERO9 / HERO10 / HERO11",
            "HERO13 Black",
            "MAX",
        ],
        format: {
            sdLayout: "/DCIM/100GOPRO/",
            filenamePattern: "GH010001.MP4",
        },
        locales: {
            en: {
                title: "GoPro HERO and MAX video player with GPS | everydashcam",
                metaDescription:
                    "Watch GoPro HERO and MAX originals with a route map when GPS was recorded. Review the trip and save clips locally in your browser.",
                ogTitle: "GoPro HERO and MAX video player",
                ogDescription:
                    "Open original GoPro recordings, follow the GPS route when available, and save a clip. Video stays on your device.",
                h1: "GoPro player — watch HERO and MAX recordings",
                lead: "Review GoPro HERO and MAX recordings alongside the route and speed when GPS was recorded. Open the originals in your browser and save the part of the trip you want to share.",
                ctaPrimary: "Open GoPro recordings folder",
                modelsCompat: "GPS availability depends on the camera generation and recording settings. Video can play without GPS; the map needs compatible GPS data saved in the original file.",
                formatIntro:
                    "Open the original MP4 folder from the GoPro card and keep all numbered parts of a long recording. Edited or downloaded copies can lose GPS even when the picture looks unchanged.",
            },
            ru: {
                title: "Плеер GoPro HERO и MAX с GPS-картой | everydashcam",
                metaDescription:
                    "Смотри исходные записи GoPro HERO и MAX с картой, если записан GPS. Просматривай поездки и сохраняй фрагменты локально в браузере.",
                ogTitle: "Плеер видео GoPro HERO и MAX",
                ogDescription:
                    "Открой исходные записи GoPro, посмотри маршрут при наличии GPS и сохрани фрагмент. Видео остаётся на устройстве.",
                h1: "Плеер GoPro — записи HERO и MAX",
                lead: "Смотри записи GoPro HERO и MAX рядом с маршрутом и скоростью, если записан GPS. Открой оригиналы в браузере и сохрани участок поездки, которым хочешь поделиться.",
                ctaPrimary: "Открыть папку с записями GoPro",
                modelsCompat: "Наличие GPS зависит от поколения камеры и настроек записи. Видео воспроизводится и без GPS; для карты нужны совместимые GPS-данные в исходном файле.",
                formatIntro:
                    "Открой папку с исходными MP4 с карты GoPro и сохрани все пронумерованные части длинной записи. Изменённые или скачанные копии могут потерять GPS, даже если изображение выглядит так же.",
            },
        },
    },
    {
        slug: "garmin",
        displayName: "Garmin",
        models: [
            "Dash Cam X310 / X210 / X110",
            "Dash Cam Mini 3",
            "Dash Cam Live",
            "Dash Cam 67W / 57 / 47",
            "Dash Cam Mini 2",
            "Dash Cam Tandem",
        ],
        format: {
            sdLayout: "/Garmin/, /DCIM/",
            filenamePattern: "20240821-180010.mp4",
        },
        locales: {
            en: {
                title: "Garmin Dash Cam Player — X310, X210, Mini 3 | everydashcam",
                metaDescription:
                    "Open Garmin Dash Cam X310, X210, X110, Mini 3, Live and recent recordings in your browser. Local playback, GPS map, speed chart and clip export.",
                ogTitle: "Garmin Dash Cam Player — X310, X210, Mini 3",
                ogDescription:
                    "Open Garmin Dash Cam recordings in your browser. Local playback, GPS map, speed chart and clip export without Garmin software.",
                h1: "Garmin Dash Cam player — open recordings in your browser",
                lead: "Open recordings from a Garmin Dash Cam directly from the SD card. Play video, review the route and speed when GPS is present, then trim and export a clip. No Garmin Drive or Garmin Express install, upload or account.",
                ctaPrimary: "Open Garmin recordings folder",
                modelsCompat: "Covers the current X-series and Mini 3 lineup plus common recent Garmin Dash Cam generations. Standard MP4 video opens locally; GPS availability depends on the telemetry stored in the recording.",
                formatIntro:
                    "Open the Garmin or DCIM recording folder from the card. Keep original filenames and neighbouring clips; the map uses GPS stored in compatible recordings, not a route downloaded from Garmin Drive.",
            },
            ru: {
                title: "Плеер Garmin Dash Cam — X310, X210, Mini 3 | everydashcam",
                metaDescription:
                    "Открывай записи Garmin Dash Cam X310, X210, X110, Mini 3, Live и недавних моделей в браузере. Карта GPS, скорость, обрезка и экспорт.",
                ogTitle: "Плеер Garmin Dash Cam — X310, X210, Mini 3",
                ogDescription:
                    "Открывай записи Garmin Dash Cam в браузере. Локальное воспроизведение, карта GPS, график скорости и экспорт без программ Garmin.",
                h1: "Плеер Garmin Dash Cam — записи прямо в браузере",
                lead: "Открывай записи Garmin Dash Cam прямо с SD-карты. Смотри видео, маршрут и скорость, когда в записи есть GPS, затем обрезай и экспортируй клип. Без Garmin Drive, Garmin Express, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями Garmin",
                modelsCompat: "Поддерживает актуальную X-серию и Mini 3, а также распространённые недавние поколения Garmin Dash Cam. Обычное MP4-видео открывается локально; наличие GPS зависит от телеметрии в записи.",
                formatIntro:
                    "Открой папку Garmin или DCIM с карты. Сохрани исходные имена и соседние ролики: карта использует GPS из совместимых записей, а не маршрут, скачанный из Garmin Drive.",
            },
        },
    },
    {
        slug: "vantrue",
        displayName: "Vantrue",
        models: [
            "N2 Pro / N2X",
            "N4 / N4 Pro",
            "N5 / N5 Pro",
            "E1 / E2 / E3",
            "S1 / S1 Pro",
            "X4S",
        ],
        format: {
            sdLayout: "/Normal/, /Event/, /Parking/ (front/rear/interior split on multi-channel models)",
            filenamePattern: "20240821_180010_0001_N_A.MP4",
        },
        locales: {
            en: {
                title: "Vantrue Player & Editor — N4, N5, E3, N2X | everydashcam",
                metaDescription:
                    "Open Vantrue N4, N5, E3, N2X, S1 and X4S recordings in your browser. GPS map, synchronized cameras, trim and export. No upload or install.",
                ogTitle: "Vantrue Player & Editor Online — N4, N5, E3, N2X",
                ogDescription:
                    "Free online player and editor for Vantrue dashcam recordings. GPS map, speed chart, trim and export. Works in any modern browser, nothing uploaded.",
                h1: "Vantrue Dashcam Player & Editor Online — play and trim in your browser",
                lead: "Watch Vantrue front, rear and cabin recordings together. Follow the route when GPS is present and save the part you need, without the Vantrue Cam app.",
                ctaPrimary: "Open Vantrue recordings folder",
                modelsCompat:
                    "Covers common Vantrue recording layouts used across the N, E, S and X series. Models without GPS still play locally, just without a route on the map.",
                formatIntro:
                    "Open the whole recording folder and preserve the camera letters in filenames. They distinguish front, rear and cabin views; copying only one camera leaves the other views out of the trip.",
            },
            ru: {
                title: "Плеер Vantrue — N4, N5, E3, N2X | everydashcam",
                metaDescription:
                    "Открывай записи Vantrue N4, N5, E3, N2X, S1 и X4S в браузере. Карта GPS, синхронные камеры, обрезка и экспорт. Без загрузки и установки.",
                ogTitle: "Плеер Vantrue онлайн — N4, N5, E3, N2X",
                ogDescription:
                    "Онлайн-плеер и редактор для записей с Vantrue. Карта GPS, график скорости, обрезка и экспорт. Работает в любом современном браузере, ничего не загружается.",
                h1: "Плеер и редактор Vantrue онлайн — смотри и режь в браузере",
                lead: "Смотри записи передней, задней и салонной камер Vantrue вместе. Если есть GPS, рядом появится маршрут. Сохрани нужный фрагмент без приложения Vantrue Cam.",
                ctaPrimary: "Открыть папку с записями Vantrue",
                modelsCompat:
                    "Поддерживает распространённые форматы Vantrue серий N, E, S и X. Модели без GPS тоже воспроизводятся локально — просто без маршрута на карте.",
                formatIntro:
                    "Открой папку с записями целиком и сохрани буквы камер в именах файлов. Они различают передний, задний и салонный ракурсы; при копировании одной камеры остальные виды не попадут в поездку.",
            },
        },
    },
    {
        slug: "thinkware",
        displayName: "Thinkware",
        models: [
            "F200 / F200 Pro",
            "F750 / F770 / F800 Pro",
            "F70 / F790",
            "Q800 Pro / Q1000",
            "U1000 / U3000",
            "X1000",
        ],
        format: {
            sdLayout: "/cont_rec/, /evt_rec/, /park_rec/, /manual_rec/",
            filenamePattern: "REC_20210101_120000_F.mp4",
        },
        locales: {
            en: {
                title: "Thinkware Player — F800, Q1000, U3000 | everydashcam",
                metaDescription:
                    "Open Thinkware F200, F800, Q800/Q1000, U1000/U3000 and X1000 recordings in your browser. GPS map, front/rear playback, trim and export.",
                ogTitle: "Thinkware Player Online — F800, Q1000, U3000",
                ogDescription:
                    "Free online player and editor for Thinkware dashcam recordings. GPS map, speed chart, trim and export. Works in any modern browser, nothing uploaded.",
                h1: "Thinkware Dashcam Player & Editor Online — play and trim in your browser",
                lead: "Review Thinkware front and rear recordings together, then save the part you need. Compatible GPS from the front recording adds a shared route and speed chart to the trip.",
                ctaPrimary: "Open Thinkware recordings folder",
                modelsCompat:
                    "Covers common Thinkware F, Q, U and X-series recording layouts. Models without GPS still play locally, just without a route on the map.",
                formatIntro:
                    "Open the whole card, including continuous, event, parking and manual recording folders. Keep both F and R files: supported layouts carry the GPS in the front recording, even when you are watching the rear view.",
            },
            ru: {
                title: "Плеер Thinkware — F800, Q1000, U3000 | everydashcam",
                metaDescription:
                    "Открывай записи Thinkware F200, F800, Q800/Q1000, U1000/U3000 и X1000 в браузере. Карта GPS, передняя и задняя камеры, обрезка и экспорт.",
                ogTitle: "Плеер Thinkware онлайн — F800, Q1000, U3000",
                ogDescription:
                    "Онлайн-плеер и редактор для записей с Thinkware. Карта GPS, график скорости, обрезка и экспорт. Работает в любом современном браузере, ничего не загружается.",
                h1: "Плеер и редактор Thinkware онлайн — смотри и режь в браузере",
                lead: "Смотри передние и задние записи Thinkware вместе и сохраняй нужные фрагменты. Совместимый GPS из передней записи добавляет к поездке общий маршрут и график скорости.",
                ctaPrimary: "Открыть папку с записями Thinkware",
                modelsCompat:
                    "Поддерживает распространённые форматы Thinkware серий F, Q, U и X. Модели без GPS тоже воспроизводятся локально — просто без маршрута на карте.",
                formatIntro:
                    "Открой карту целиком, включая папки обычных записей, событий, парковки и ручного сохранения. Сохрани файлы F и R: в поддерживаемых форматах GPS находится в передней записи и используется также при просмотре задней камеры.",
            },
        },
    },
    {
        slug: "nextbase",
        displayName: "Nextbase",
        models: [
            "122 / 222",
            "322GW / 422GW / 522GW",
            "622GW",
            "512GW",
            "Series 2 Rear Camera Modules",
        ],
        format: {
            sdLayout: "/DCIM/, /PROTECTED/",
            filenamePattern: "240821_180010_001_FH.MP4",
        },
        locales: {
            en: {
                title: "Nextbase Dash Cam Player — 322GW, 522GW, 622GW | everydashcam",
                metaDescription:
                    "Open Nextbase 322GW, 422GW, 522GW, 622GW and other recordings in your browser. GPS map, front/rear playback, trim and export. No upload.",
                ogTitle: "Nextbase Dash Cam Player — 322GW, 522GW, 622GW",
                ogDescription:
                    "Open Nextbase recordings from the SD card, review front and rear cameras with GPS, then trim and export a clip. Nothing is uploaded.",
                h1: "Nextbase dash cam player — open recordings in your browser",
                lead: "Open Nextbase recordings straight from the SD card on a PC or Mac. Review front and rear cameras, see the route and speed when GPS is present, then trim and export the part you need. No MyNextbase Player install, upload or account.",
                ctaPrimary: "Open Nextbase recordings folder",
                modelsCompat:
                    "Covers common Nextbase recording layouts across the Series 2 range and recent generations. Standard video opens locally; the map and camera pairing depend on what the model saved.",
                formatIntro:
                    "Nextbase cameras split a drive into short MP4 recordings and mark the camera and quality in each filename. everydashcam joins the matching files into trips and keeps front, rear, map and speed on one timeline.",
            },
            ru: {
                title: "Плеер Nextbase — 322GW, 522GW, 622GW | everydashcam",
                metaDescription:
                    "Открывай записи Nextbase 322GW, 422GW, 522GW, 622GW и других моделей в браузере. Карта GPS, передняя и задняя камеры, обрезка и экспорт.",
                ogTitle: "Плеер Nextbase — 322GW, 522GW, 622GW",
                ogDescription:
                    "Открывай записи Nextbase с SD-карты, смотри переднюю и заднюю камеры с GPS, обрезай и экспортируй нужный фрагмент. Без загрузки на сервер.",
                h1: "Плеер Nextbase — записи с регистратора прямо в браузере",
                lead: "Открывай записи Nextbase прямо с SD-карты на ПК или Mac. Смотри переднюю и заднюю камеры, маршрут и скорость, когда в записи есть GPS, затем обрезай и экспортируй нужный фрагмент. Без MyNextbase Player, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями Nextbase",
                modelsCompat:
                    "Поддерживает распространённые форматы Nextbase Series 2 и недавних поколений. Обычное видео открывается локально; карта и объединение камер зависят от данных конкретной модели.",
                formatIntro:
                    "Nextbase делит поездку на короткие MP4-записи и отмечает камеру и качество в имени файла. everydashcam собирает парные записи в поездки и держит переднюю и заднюю камеры, карту и скорость на одной шкале времени.",
            },
            de: {
                title: "Nextbase Dashcam-Player — 322GW, 522GW, 622GW | everydashcam",
                metaDescription:
                    "Öffne Aufnahmen von Nextbase 322GW, 422GW, 522GW und 622GW im Browser. GPS-Karte, Front und Heck, Zuschneiden und Export ohne Upload.",
                ogTitle: "Nextbase Player — 322GW, 522GW, 622GW",
                ogDescription:
                    "Nextbase-Aufnahmen direkt von der SD-Karte öffnen, Front und Heck mit GPS prüfen und den wichtigen Ausschnitt exportieren.",
                h1: "Nextbase Dashcam-Player — Aufnahmen direkt im Browser öffnen",
                lead: "Öffne Nextbase-Aufnahmen direkt von der SD-Karte auf PC oder Mac. Prüfe Front- und Heckkamera, Route und Geschwindigkeit, wenn GPS gespeichert ist, und exportiere anschließend den wichtigen Ausschnitt. Ohne MyNextbase Player, Upload oder Konto.",
                ctaPrimary: "Nextbase-Aufnahmen öffnen",
                modelsCompat:
                    "Deckt gängige Aufnahmearten der Nextbase Series 2 und neuerer Generationen ab. Normale Videos lassen sich lokal öffnen; Karte und Kamerazuordnung hängen von den gespeicherten Daten ab.",
                formatIntro:
                    "Nextbase teilt eine Fahrt in kurze MP4-Aufnahmen und kennzeichnet Kamera und Qualität im Dateinamen. everydashcam setzt passende Dateien zu Fahrten zusammen und hält Front, Heck, Karte und Tempo auf einer Zeitleiste.",
            },
            fr: {
                title: "Lecteur Nextbase — 322GW, 522GW, 622GW | everydashcam",
                metaDescription:
                    "Ouvre les vidéos Nextbase 322GW, 422GW, 522GW et 622GW dans le navigateur. Carte GPS, avant/arrière, découpe et export, sans envoi.",
                ogTitle: "Lecteur Nextbase — 322GW, 522GW, 622GW",
                ogDescription:
                    "Ouvre les vidéos Nextbase depuis la carte SD, vérifie les vues avant et arrière avec le GPS, puis exporte le passage utile.",
                h1: "Lecteur Nextbase — ouvre tes enregistrements dans le navigateur",
                lead: "Ouvre les enregistrements Nextbase directement depuis la carte SD sur PC ou Mac. Regarde les caméras avant et arrière, le trajet et la vitesse lorsque le GPS est présent, puis découpe et exporte le passage utile. Sans installer MyNextbase Player, sans envoi ni compte.",
                ctaPrimary: "Ouvrir les enregistrements Nextbase",
                modelsCompat:
                    "Couvre les formats courants de la gamme Nextbase Series 2 et des générations récentes. La vidéo s’ouvre localement ; la carte et l’association des caméras dépendent des données enregistrées.",
                formatIntro:
                    "Les caméras Nextbase découpent le trajet en courtes vidéos MP4 et indiquent la caméra et la qualité dans le nom du fichier. everydashcam regroupe les fichiers correspondants et synchronise l’avant, l’arrière, la carte et la vitesse.",
            },
            pl: {
                title: "Odtwarzacz Nextbase — 322GW, 522GW, 622GW | everydashcam",
                metaDescription:
                    "Otwieraj nagrania Nextbase 322GW, 422GW, 522GW i 622GW w przeglądarce. Mapa GPS, przód i tył, przycinanie i eksport bez wysyłania.",
                ogTitle: "Odtwarzacz Nextbase — 322GW, 522GW, 622GW",
                ogDescription:
                    "Otwórz nagrania Nextbase z karty SD, sprawdź przód i tył z GPS, a potem przytnij i wyeksportuj potrzebny fragment.",
                h1: "Odtwarzacz Nextbase — nagrania prosto w przeglądarce",
                lead: "Otwieraj nagrania Nextbase bezpośrednio z karty SD na PC lub Macu. Oglądaj przód i tył, trasę oraz prędkość, gdy zapisano GPS, a potem przytnij i wyeksportuj potrzebny fragment. Bez MyNextbase Player, wysyłania plików i konta.",
                ctaPrimary: "Otwórz folder z nagraniami Nextbase",
                modelsCompat:
                    "Obsługuje popularne układy nagrań Nextbase Series 2 i nowszych generacji. Zwykłe wideo otwiera się lokalnie; mapa i łączenie kamer zależą od danych zapisanych przez model.",
                formatIntro:
                    "Nextbase dzieli przejazd na krótkie nagrania MP4 i oznacza kamerę oraz jakość w nazwie pliku. everydashcam łączy pasujące pliki w przejazdy i synchronizuje przód, tył, mapę i prędkość.",
            },
        },
    },
    {
        slug: "redtiger",
        displayName: "REDTIGER",
        models: ["F7NP / F7N", "F7NP-4K", "F9 / F9 4K", "F17 / F17 Elite", "F77"],
        format: {
            sdLayout: "/Movie_F/, /Movie_R/, /Event_F/, /Event_R/, /Parking_F/, /Parking_R/",
            filenamePattern: "20260825093511_001359F.MP4",
        },
        locales: {
            en: {
                title: "REDTIGER Dash Cam Player — F7NP, F9, F17 | everydashcam",
                metaDescription:
                    "Open REDTIGER F7NP, F9, F17 and F77 recordings in your browser. Front/rear playback, GPS map, speed chart, trim and export. No upload.",
                ogTitle: "REDTIGER Player — F7NP, F9, F17",
                ogDescription:
                    "Open REDTIGER front and rear recordings with GPS in your browser, then trim and export the clip you need. Nothing is uploaded.",
                h1: "REDTIGER dash cam player — watch recordings in your browser",
                lead: "Open REDTIGER recordings directly from the SD card on a PC or Mac. Watch front and rear cameras together, review the route and speed when GPS is present, then trim and export a clip. No REDTIGER Player install, upload or account.",
                ctaPrimary: "Open REDTIGER recordings folder",
                modelsCompat:
                    "Covers common REDTIGER recording layouts across the F7, F9, F17 and F77 families. Video opens locally; GPS and automatic camera pairing depend on the model and recording settings.",
                formatIntro:
                    "REDTIGER cameras keep front, rear, event and parking recordings in separate folders. everydashcam reads the whole card, joins matching views into trips and shows the route when GPS was saved.",
            },
            ru: {
                title: "Плеер REDTIGER — F7NP, F9, F17 | everydashcam",
                metaDescription:
                    "Открывай записи REDTIGER F7NP, F9, F17 и F77 в браузере. Передняя и задняя камеры, карта GPS, скорость, обрезка и экспорт. Без загрузки.",
                ogTitle: "Плеер REDTIGER — F7NP, F9, F17",
                ogDescription:
                    "Открывай записи передней и задней камер REDTIGER с GPS в браузере, обрезай и экспортируй нужный фрагмент. Ничего не загружается.",
                h1: "Плеер REDTIGER — записи с регистратора в браузере",
                lead: "Открывай записи REDTIGER прямо с SD-карты на ПК или Mac. Смотри переднюю и заднюю камеры вместе, проверяй маршрут и скорость, когда в записи есть GPS, затем обрезай и экспортируй нужный фрагмент. Без REDTIGER Player, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями REDTIGER",
                modelsCompat:
                    "Поддерживает распространённые форматы семейств REDTIGER F7, F9, F17 и F77. Видео открывается локально; GPS и автоматическое объединение камер зависят от модели и настроек записи.",
                formatIntro:
                    "REDTIGER раскладывает записи передней и задней камер, событий и парковки по отдельным папкам. everydashcam читает всю карту, объединяет совпадающие виды в поездки и показывает маршрут, когда GPS сохранён.",
            },
            de: {
                title: "REDTIGER Dashcam-Player — F7NP, F9, F17 | everydashcam",
                metaDescription:
                    "Öffne REDTIGER F7NP-, F9-, F17- und F77-Aufnahmen im Browser. Front und Heck, GPS-Karte, Tempo, Zuschneiden und Export ohne Upload.",
                ogTitle: "REDTIGER Player — F7NP, F9, F17",
                ogDescription:
                    "REDTIGER-Aufnahmen von Front und Heck mit GPS im Browser öffnen und den wichtigen Ausschnitt exportieren. Kein Upload.",
                h1: "REDTIGER Dashcam-Player — Aufnahmen im Browser ansehen",
                lead: "Öffne REDTIGER-Aufnahmen direkt von der SD-Karte auf PC oder Mac. Sieh dir Front- und Heckkamera gemeinsam an, prüfe Route und Geschwindigkeit bei vorhandenem GPS und exportiere den wichtigen Ausschnitt. Ohne REDTIGER Player, Upload oder Konto.",
                ctaPrimary: "REDTIGER-Aufnahmen öffnen",
                modelsCompat:
                    "Deckt gängige Aufnahmearten der REDTIGER-Familien F7, F9, F17 und F77 ab. Videos öffnen lokal; GPS und automatische Kamerazuordnung hängen von Modell und Einstellungen ab.",
                formatIntro:
                    "REDTIGER legt Front-, Heck-, Ereignis- und Parkaufnahmen in getrennten Ordnern ab. everydashcam liest die ganze Karte, verbindet passende Ansichten zu Fahrten und zeigt die Route, wenn GPS gespeichert wurde.",
            },
            es: {
                title: "Reproductor REDTIGER — F7NP, F9, F17 | everydashcam",
                metaDescription:
                    "Abre grabaciones REDTIGER F7NP, F9, F17 y F77 en el navegador. Cámaras delantera y trasera, mapa GPS, recorte y exportación sin subir archivos.",
                ogTitle: "Reproductor REDTIGER — F7NP, F9, F17",
                ogDescription:
                    "Abre las cámaras delantera y trasera de REDTIGER con GPS, recorta y exporta el fragmento que necesitas. Sin subir nada.",
                h1: "Reproductor REDTIGER — mira tus grabaciones en el navegador",
                lead: "Abre las grabaciones REDTIGER directamente desde la tarjeta SD en PC o Mac. Mira juntas las cámaras delantera y trasera, revisa la ruta y la velocidad cuando haya GPS y exporta el fragmento que necesites. Sin instalar REDTIGER Player, subir archivos ni crear una cuenta.",
                ctaPrimary: "Abrir grabaciones REDTIGER",
                modelsCompat:
                    "Cubre los formatos habituales de las familias REDTIGER F7, F9, F17 y F77. El vídeo se abre localmente; el GPS y la unión automática de cámaras dependen del modelo y los ajustes.",
                formatIntro:
                    "REDTIGER separa las grabaciones delanteras, traseras, de eventos y de aparcamiento en distintas carpetas. everydashcam lee toda la tarjeta, une las vistas de un mismo viaje y muestra la ruta cuando se guardó el GPS.",
            },
        },
    },
    {
        slug: "navitel",
        displayName: "NAVITEL",
        models: [
            "R600 / R600 GPS",
            "R700 GPS Dual",
            "R1000",
            "RS-series",
            "MR-series",
        ],
        format: {
            sdLayout: "/DCIM/, /Movie/, /Event/",
            filenamePattern: "FILE201104-163014-000429F.mov",
        },
        locales: {
            en: {
                title: "NAVITEL DVR Player Online — R600, R700, RS series | everydashcam",
                metaDescription:
                    "Open NAVITEL R600, R700, R1000 and RS-series recordings in your browser. GPS map, speed chart, front/rear playback, trim and export.",
                ogTitle: "NAVITEL DVR Player Online — R600, R700, RS series",
                ogDescription:
                    "Open NAVITEL dash cam recordings with GPS in your browser. Review the trip, trim the useful part and export it without installing software.",
                h1: "NAVITEL DVR player — open recordings in your browser",
                lead: "Open NAVITEL dash cam recordings directly from the SD card. Review front and rear cameras, the route and speed when GPS is present, then trim and export a clip. Works on PC and Mac without installing NAVITEL DVR Player, uploading files or creating an account.",
                ctaPrimary: "Open NAVITEL recordings folder",
                modelsCompat:
                    "Covers common NAVITEL R, RS and MR recording layouts. Standard video opens locally; the map appears when the camera saved compatible GPS data with the recording.",
                formatIntro:
                    "NAVITEL cameras can record MP4, MOV or TS files and may keep GPS inside the video or in a matching NMEA file. Open the whole card so everydashcam can keep the cameras, route and speed together.",
            },
            ru: {
                title: "NAVITEL DVR Player онлайн — R600, R700, серии RS | everydashcam",
                metaDescription:
                    "Открывай записи NAVITEL R600, R700, R1000 и серии RS в браузере. Карта GPS, скорость, передняя и задняя камеры, обрезка и экспорт.",
                ogTitle: "NAVITEL DVR Player онлайн — R600, R700, серии RS",
                ogDescription:
                    "Открывай записи NAVITEL с GPS в браузере, проверяй поездку, обрезай нужный фрагмент и экспортируй без установки программ.",
                h1: "Плеер NAVITEL — записи с регистратора прямо в браузере",
                lead: "Открывай записи NAVITEL прямо с SD-карты. Смотри переднюю и заднюю камеры, маршрут и скорость, когда в записи есть GPS, затем обрезай и экспортируй нужный фрагмент. Работает на ПК и Mac без NAVITEL DVR Player, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями NAVITEL",
                modelsCompat:
                    "Поддерживает распространённые форматы NAVITEL серий R, RS и MR. Обычное видео открывается локально; карта появляется, когда регистратор сохранил совместимые GPS-данные рядом с записью.",
                formatIntro:
                    "NAVITEL может писать MP4, MOV или TS и хранить GPS внутри видео либо в парном файле NMEA. Открывай всю карту памяти, чтобы everydashcam держал камеры, маршрут и скорость вместе.",
            },
            pl: {
                title: "NAVITEL DVR Player online — R600, R700, seria RS | everydashcam",
                metaDescription:
                    "Otwieraj nagrania NAVITEL R600, R700, R1000 i serii RS w przeglądarce. Mapa GPS, prędkość, przód i tył, przycinanie oraz eksport.",
                ogTitle: "NAVITEL DVR Player online — R600, R700, seria RS",
                ogDescription:
                    "Otwórz nagrania NAVITEL z GPS w przeglądarce, sprawdź przejazd, przytnij potrzebny fragment i wyeksportuj go bez instalowania programu.",
                h1: "Odtwarzacz NAVITEL — nagrania prosto w przeglądarce",
                lead: "Otwieraj nagrania NAVITEL bezpośrednio z karty SD. Oglądaj przód i tył, trasę oraz prędkość, gdy zapisano GPS, a następnie przytnij i wyeksportuj potrzebny fragment. Działa na PC i Macu bez NAVITEL DVR Player, wysyłania plików i konta.",
                ctaPrimary: "Otwórz folder z nagraniami NAVITEL",
                modelsCompat:
                    "Obsługuje popularne układy nagrań serii NAVITEL R, RS i MR. Zwykłe wideo otwiera się lokalnie; mapa pojawia się, gdy kamera zapisała zgodne dane GPS razem z nagraniem.",
                formatIntro:
                    "NAVITEL może zapisywać pliki MP4, MOV lub TS, a dane GPS trzymać w filmie albo w pasującym pliku NMEA. Otwórz całą kartę, aby everydashcam połączył kamery, trasę i prędkość.",
            },
        },
    },
    {
        slug: "mio",
        displayName: "Mio MiVue",
        models: [
            "MiVue 985W / 985WD",
            "MiVue 955WD Pro / 956WD",
            "MiVue 903WD Pro",
            "MiVue 945W",
            "MiVue 803W Pro / 803WD Pro",
            "MiVue 7 / 8 / 9 series",
        ],
        format: {
            sdLayout: "/Normal/, /Event/, /Parking/ (+ F/R folders on dual-camera models)",
            filenamePattern: "FILE260819-071804F.mp4",
        },
        locales: {
            en: {
                title: "Mio MiVue Player — 985, 955, 903, 945 | everydashcam",
                metaDescription:
                    "Open Mio MiVue 985, 955, 956, 903 and other recordings in your browser. GPS map, speed, front/rear playback, trim and export. No upload.",
                ogTitle: "Mio MiVue Player — 985, 955, 903, 945",
                ogDescription:
                    "Open Mio MiVue recordings and GPS files in your browser. Review front and rear cameras, trim a clip and export it without an install.",
                h1: "Mio MiVue player — open recordings in your browser",
                lead: "Open Mio MiVue recordings straight from the SD card. Review front and rear cameras, the GPS route and speed, then trim and export the part you need. No Mio MiVue Manager install, upload or account.",
                ctaPrimary: "Open Mio MiVue recordings folder",
                modelsCompat:
                    "Covers common Mio MiVue recording layouts across recent 9-series and earlier generations. Standard video opens locally; keep matching NMEA files beside the recordings when your model saves them.",
                formatIntro:
                    "Mio MiVue cameras organize normal, event and parking recordings in separate folders. GPS models may save a matching NMEA file beside each video. Open the whole folder so everydashcam can join the trip, cameras and map correctly.",
            },
            ru: {
                title: "Плеер Mio MiVue — 985, 955, 903, 945 | everydashcam",
                metaDescription:
                    "Открывай записи Mio MiVue 985, 955, 956, 903 и других моделей в браузере. Карта GPS, скорость, передняя и задняя камеры, обрезка и экспорт.",
                ogTitle: "Плеер Mio MiVue — 985, 955, 903, 945",
                ogDescription:
                    "Открывай записи Mio MiVue и файлы GPS в браузере, смотри переднюю и заднюю камеры, обрезай и экспортируй нужный фрагмент без установки.",
                h1: "Плеер Mio MiVue — записи прямо в браузере",
                lead: "Открывай записи Mio MiVue прямо с SD-карты. Смотри переднюю и заднюю камеры, маршрут GPS и скорость, затем обрезай и экспортируй нужный фрагмент. Без Mio MiVue Manager, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями Mio MiVue",
                modelsCompat:
                    "Поддерживает распространённые форматы новых Mio MiVue серии 9 и предыдущих поколений. Обычное видео открывается локально; если модель создаёт парные файлы NMEA, оставляй их рядом с записями.",
                formatIntro:
                    "Mio MiVue раскладывает обычные, событийные и парковочные записи по отдельным папкам. Модели с GPS могут сохранять рядом с видео парный файл NMEA. Открывай всю папку, чтобы everydashcam правильно собрал поездку, камеры и карту.",
            },
            de: {
                title: "Mio MiVue Dashcam-Player — 985, 955, 903 | everydashcam",
                metaDescription:
                    "Öffne Aufnahmen von Mio MiVue 985, 955, 956 und 903 im Browser. GPS-Karte, Tempo, Front und Heck, Zuschneiden und Export ohne Upload.",
                ogTitle: "Mio MiVue Player — 985, 955, 903, 945",
                ogDescription:
                    "Mio-MiVue-Aufnahmen samt GPS-Dateien im Browser öffnen, Front und Heck prüfen und den wichtigen Ausschnitt ohne Installation exportieren.",
                h1: "Mio MiVue Player — Aufnahmen direkt im Browser öffnen",
                lead: "Öffne Mio-MiVue-Aufnahmen direkt von der SD-Karte. Prüfe Front und Heck, GPS-Route und Geschwindigkeit und exportiere anschließend den wichtigen Ausschnitt. Ohne Mio MiVue Manager, Upload oder Konto.",
                ctaPrimary: "Mio-MiVue-Aufnahmen öffnen",
                modelsCompat:
                    "Deckt gängige Aufnahmearten neuer Mio-MiVue-Modelle der 9er-Serie und früherer Generationen ab. Normale Videos lassen sich lokal öffnen; passende NMEA-Dateien sollten neben den Aufnahmen bleiben.",
                formatIntro:
                    "Mio MiVue sortiert normale, Ereignis- und Parkaufnahmen in getrennte Ordner. GPS-Modelle können zu jedem Video eine passende NMEA-Datei speichern. Öffne den ganzen Ordner, damit everydashcam Fahrt, Kameras und Karte richtig zusammensetzt.",
            },
            fr: {
                title: "Lecteur Mio MiVue — 985, 955, 903, 945 | everydashcam",
                metaDescription:
                    "Ouvre les vidéos Mio MiVue 985, 955, 956 et 903 dans le navigateur. Carte GPS, vitesse, vues avant/arrière, découpe et export sans envoi.",
                ogTitle: "Lecteur Mio MiVue — 985, 955, 903, 945",
                ogDescription:
                    "Ouvre les vidéos Mio MiVue et leurs fichiers GPS, vérifie l’avant et l’arrière, puis exporte le passage utile sans installation.",
                h1: "Lecteur Mio MiVue — ouvre tes vidéos dans le navigateur",
                lead: "Ouvre les enregistrements Mio MiVue directement depuis la carte SD. Regarde les caméras avant et arrière, le trajet GPS et la vitesse, puis découpe et exporte le passage utile. Sans Mio MiVue Manager, sans envoi ni compte.",
                ctaPrimary: "Ouvrir les enregistrements Mio MiVue",
                modelsCompat:
                    "Couvre les formats courants des Mio MiVue récents de série 9 et des générations précédentes. La vidéo s’ouvre localement ; garde les fichiers NMEA associés à côté des enregistrements.",
                formatIntro:
                    "Mio MiVue range les enregistrements normaux, événementiels et de stationnement dans des dossiers séparés. Les modèles GPS peuvent créer un fichier NMEA associé à chaque vidéo. Ouvre le dossier entier pour que everydashcam assemble correctement le trajet, les caméras et la carte.",
            },
            pl: {
                title: "Odtwarzacz Mio MiVue — 985, 955, 903, 945 | everydashcam",
                metaDescription:
                    "Otwieraj nagrania Mio MiVue 985, 955, 956 i 903 w przeglądarce. Mapa GPS, prędkość, przód i tył, przycinanie oraz eksport bez wysyłania.",
                ogTitle: "Odtwarzacz Mio MiVue — 985, 955, 903, 945",
                ogDescription:
                    "Otwórz nagrania Mio MiVue z plikami GPS, sprawdź przód i tył, a potem wyeksportuj potrzebny fragment bez instalowania programu.",
                h1: "Odtwarzacz Mio MiVue — nagrania w przeglądarce",
                lead: "Otwieraj nagrania Mio MiVue bezpośrednio z karty SD. Oglądaj przód i tył, trasę GPS oraz prędkość, a następnie przytnij i wyeksportuj potrzebny fragment. Bez Mio MiVue Manager, wysyłania plików i konta.",
                ctaPrimary: "Otwórz folder z nagraniami Mio MiVue",
                modelsCompat:
                    "Obsługuje popularne układy nagrań nowych Mio MiVue serii 9 i wcześniejszych generacji. Zwykłe wideo otwiera się lokalnie; pasujące pliki NMEA zostaw obok nagrań.",
                formatIntro:
                    "Mio MiVue rozdziela nagrania zwykłe, zdarzenia i parkingowe do osobnych folderów. Modele GPS mogą zapisywać obok filmu pasujący plik NMEA. Otwórz cały folder, aby everydashcam prawidłowo połączył przejazd, kamery i mapę.",
            },
        },
    },
    {
        slug: "navman",
        displayName: "Navman MiVue",
        models: [
            "MiVue True 4K / True 4K DC",
            "MiVue 170 / 270 Safety",
            "MiVue 930 Dual Camera",
            "MiVue 100 / 110 / 160 GPS Tag",
            "MiVue 300",
            "MiVue 150 Safety and earlier series",
        ],
        format: {
            sdLayout: "/Normal/, /Event/, /Parking/ (+ F/R folders on dual-camera models)",
            filenamePattern: "FILE260819-071804F.mp4",
        },
        locales: {
            en: {
                title: "Navman MiVue Player — True 4K, 270, 930 | everydashcam",
                metaDescription:
                    "Open Navman MiVue True 4K, 270, 930 and other recordings in your browser. GPS map, speed, front/rear playback, trim and export.",
                ogTitle: "Navman MiVue Player — True 4K, 270, 930",
                ogDescription:
                    "Open Navman MiVue recordings from the SD card, review the trip with GPS, then trim and export the part you need. Nothing is uploaded.",
                h1: "Navman MiVue player — view dash cam recordings in your browser",
                lead: "Open Navman MiVue recordings straight from the SD card on a PC or Mac. Review front and rear cameras, the route and speed when GPS is present, then trim and export a clip. No Navman MiVue Manager install, upload or account.",
                ctaPrimary: "Open Navman MiVue recordings folder",
                modelsCompat:
                    "Covers common Navman MiVue layouts used by current Australian and New Zealand models and earlier series. Standard video opens locally; the map and camera pairing depend on the data saved by the model.",
                formatIntro:
                    "Navman MiVue cameras split normal, event and parking recordings into separate folders, with paired front and rear files on dual-camera models. Open the whole card so everydashcam can keep each trip, both cameras and available GPS together.",
            },
            ru: {
                title: "Плеер Navman MiVue — True 4K, 270, 930 | everydashcam",
                metaDescription:
                    "Открывай записи Navman MiVue True 4K, 270, 930 и других моделей в браузере. Карта GPS, скорость, передняя и задняя камеры, обрезка и экспорт.",
                ogTitle: "Плеер Navman MiVue — True 4K, 270, 930",
                ogDescription:
                    "Открывай записи Navman MiVue с SD-карты, проверяй поездку с GPS, обрезай и экспортируй нужный фрагмент. Ничего не загружается.",
                h1: "Плеер Navman MiVue — записи с регистратора в браузере",
                lead: "Открывай записи Navman MiVue прямо с SD-карты на ПК или Mac. Смотри переднюю и заднюю камеры, маршрут и скорость, когда в записи есть GPS, затем обрезай и экспортируй нужный фрагмент. Без Navman MiVue Manager, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями Navman MiVue",
                modelsCompat:
                    "Поддерживает распространённые форматы актуальных моделей Navman MiVue для Австралии и Новой Зеландии и предыдущих серий. Обычное видео открывается локально; карта и объединение камер зависят от данных модели.",
                formatIntro:
                    "Navman MiVue раскладывает обычные, событийные и парковочные записи по отдельным папкам, а в моделях с двумя камерами сохраняет парные файлы передней и задней камер. Открывай всю карту памяти, чтобы everydashcam держал поездку, обе камеры и доступный GPS вместе.",
            },
        },
    },
    {
        slug: "fitcamx",
        displayName: "FITCAMX",
        features: ["blur-license-plate-in-dashcam-video", "combine-dashcam-cameras-into-one-video"],
        models: [
            "Toyota / Lexus systems",
            "Volvo / Polestar systems",
            "BMW / MINI systems",
            "Audi / Volkswagen systems",
            "Ford / RAM / GMC systems",
            "Honda / Mazda / Nissan systems",
        ],
        format: {
            sdLayout: "/Movie/, /Movie_E/, /EMR/, /EMR_E/",
            filenamePattern: "20260807191037_000922AAE.MP4",
        },
        locales: {
            en: {
                title: "FITCAMX Dash Cam Player for PC & Mac | everydashcam",
                metaDescription:
                    "Open FITCAMX front and rear recordings in your browser on PC or Mac. Trips stay grouped, with trim and export. No phone app or upload.",
                ogTitle: "FITCAMX Dash Cam Player for PC & Mac",
                ogDescription:
                    "Open FITCAMX recordings from the SD card, keep front and rear views together, then trim and export a clip. No phone app or upload.",
                h1: "FITCAMX dash cam player — watch recordings on PC or Mac",
                lead: "Open FITCAMX recordings directly from the SD card in your browser. everydashcam keeps front and rear cameras together, separates normal and saved events, and lets you trim and export the part you need. No phone app, cable transfer, upload or account.",
                ctaPrimary: "Open FITCAMX recordings folder",
                modelsCompat:
                    "Covers common FITCAMX TS and MP4 layouts used across vehicle-specific front and front/rear systems. Many models do not record GPS, so video playback and camera grouping remain available without a map.",
                formatIntro:
                    "FITCAMX cameras usually separate ordinary and saved recordings into Movie and EMR folders, with rear-camera files in matching folders. Open the whole card so everydashcam can keep each drive and both views together.",
            },
            ru: {
                title: "Плеер FITCAMX для ПК и Mac | everydashcam",
                metaDescription:
                    "Открывай записи передней и задней камер FITCAMX в браузере на ПК или Mac. Поездки остаются вместе, есть обрезка и экспорт. Без приложения.",
                ogTitle: "Плеер FITCAMX для ПК и Mac",
                ogDescription:
                    "Открывай записи FITCAMX с SD-карты, смотри переднюю и заднюю камеры вместе, обрезай и экспортируй нужный фрагмент. Без приложения и загрузки.",
                h1: "Плеер FITCAMX — записи с регистратора на ПК или Mac",
                lead: "Открывай записи FITCAMX прямо с SD-карты в браузере. everydashcam держит переднюю и заднюю камеры вместе, отделяет обычные записи от сохранённых событий и позволяет обрезать и экспортировать нужный фрагмент. Без приложения на телефоне, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями FITCAMX",
                modelsCompat:
                    "Поддерживает распространённые форматы FITCAMX в TS и MP4 для штатных систем с одной или двумя камерами. Многие модели не записывают GPS, поэтому видео и группировка камер работают без карты.",
                formatIntro:
                    "FITCAMX обычно раскладывает обычные и сохранённые записи по папкам Movie и EMR, а заднюю камеру — по парным папкам. Открывай всю карту памяти, чтобы everydashcam держал поездку и оба вида вместе.",
            },
            de: {
                title: "FITCAMX Dashcam-Player für PC & Mac | everydashcam",
                metaDescription:
                    "Öffne FITCAMX-Aufnahmen von Front und Heck im Browser auf PC oder Mac. Fahrten bleiben gruppiert, mit Zuschneiden und Export ohne App.",
                ogTitle: "FITCAMX Dashcam-Player für PC & Mac",
                ogDescription:
                    "FITCAMX-Aufnahmen von der SD-Karte öffnen, Front und Heck zusammenhalten und den wichtigen Ausschnitt ohne App exportieren.",
                h1: "FITCAMX Dashcam-Player — Aufnahmen auf PC oder Mac ansehen",
                lead: "Öffne FITCAMX-Aufnahmen direkt von der SD-Karte im Browser. everydashcam hält Front und Heck zusammen, trennt normale Aufnahmen von gespeicherten Ereignissen und exportiert den wichtigen Ausschnitt. Ohne Handy-App, Upload oder Konto.",
                ctaPrimary: "FITCAMX-Aufnahmen öffnen",
                modelsCompat:
                    "Deckt gängige FITCAMX-Formate in TS und MP4 für fahrzeugspezifische Systeme mit einer oder zwei Kameras ab. Viele Modelle speichern kein GPS; Video und Kamerazuordnung funktionieren dann ohne Karte.",
                formatIntro:
                    "FITCAMX sortiert normale und gespeicherte Aufnahmen meist in Movie- und EMR-Ordner, Heckaufnahmen liegen in den entsprechenden Ordnern. Öffne die ganze Karte, damit everydashcam jede Fahrt und beide Ansichten zusammenhält.",
            },
            pl: {
                title: "Odtwarzacz FITCAMX na PC i Mac | everydashcam",
                metaDescription:
                    "Otwieraj nagrania FITCAMX z przodu i z tyłu w przeglądarce na PC lub Macu. Obie kamery, przycinanie i eksport bez aplikacji.",
                ogTitle: "Odtwarzacz FITCAMX na PC i Mac",
                ogDescription:
                    "Otwórz nagrania FITCAMX z karty SD, oglądaj przód i tył razem, a potem przytnij i wyeksportuj fragment bez aplikacji.",
                h1: "Odtwarzacz FITCAMX — nagrania na PC lub Macu",
                lead: "Otwieraj nagrania FITCAMX bezpośrednio z karty SD w przeglądarce. everydashcam łączy nagrania z przodu i z tyłu, oddziela zwykłe nagrania od zapisanych zdarzeń oraz pozwala przyciąć i wyeksportować potrzebny fragment. Bez aplikacji w telefonie, wysyłania plików i konta.",
                ctaPrimary: "Otwórz folder z nagraniami FITCAMX",
                modelsCompat:
                    "Obsługuje popularne układy FITCAMX w TS i MP4 dla samochodowych systemów z jedną lub dwiema kamerami. Wiele modeli nie zapisuje GPS, więc filmy i łączenie kamer działają bez mapy.",
                formatIntro:
                    "FITCAMX zwykle rozdziela zwykłe i zapisane nagrania do folderów Movie i EMR, a tylną kamerę do pasujących folderów. Otwórz całą kartę, aby everydashcam zebrał każdy przejazd i oba widoki razem.",
            },
        },
    },
    ...cameraPages,
];

const LANDING_BRANDS_BY_SLUG = new Map(
    getLandingBrands().map((brand) => [brand.slug, brand] as const),
);

function getVendorLangs(vendor: VendorContent): readonly Lang[] {
    const brand = LANDING_BRANDS_BY_SLUG.get(vendor.slug);
    if (!brand) {
        throw new Error(`vendor-pages: vendor "${vendor.slug}" is missing from SUPPORTED_BRANDS`);
    }
    return brand.locales;
}

function isVendorAvailableInLang(vendor: VendorContent, lang: Lang): boolean {
    return getVendorLangs(vendor).includes(lang);
}

function getVendorSeoLocales(vendor: VendorContent): SeoLocale[] {
    const publishedLangs = new Set(getVendorLangs(vendor));
    return getIndexableSeoLocales().filter((locale) => publishedLangs.has(locale.lang));
}

function getVendorsForLang(lang: Lang): VendorContent[] {
    return VENDORS.filter((vendor) => isVendorAvailableInLang(vendor, lang));
}

// Index page copy. /cameras/ is a section landing - lists every vendor
// page with short blurbs. Exists primarily to make the BreadcrumbList
// item URL on each vendor page (Home > Cameras > Vendor) resolve to 200
// instead of a SPA-fallback - Google's rich-results test rejects breadcrumbs
// whose middle item is a soft-404. The page also captures broader queries
// like "supported dashcam brands player" by its own right.
interface IndexLocale {
    title: string;
    metaDescription: string;
    ogTitle: string;
    ogDescription: string;
    h1: string;
    lead: string;
}

const INDEX_LOCALES: Record<Lang, IndexLocale> = {
    en: {
        title: "Supported dashcam brands | everydashcam",
        metaDescription:
            "All dashcam brands supported by everydashcam - 70mai, Viofo, BlackVue, GoPro, Garmin and more. Open recordings in your browser, no install, no upload.",
        ogTitle: "Supported dashcam brands — play recordings online",
        ogDescription:
            "All dashcam brands supported by everydashcam. Pick yours - open recordings in your browser, no install needed.",
        h1: "Supported dashcam brands",
        lead: "everydashcam plays recordings from these brands directly in your browser. Pick yours for compatible model families and recording details. No install, upload or account.",
    },
    ru: {
        title: "Поддерживаемые регистраторы | everydashcam",
        metaDescription:
            "Все регистраторы, которые поддерживает everydashcam - 70mai, Viofo, BlackVue, GoPro, Garmin и другие. Открой записи в браузере, без установки и без загрузки.",
        ogTitle: "Поддерживаемые регистраторы — записи в браузере",
        ogDescription:
            "Все регистраторы, которые поддерживает everydashcam. Выбери свой и узнай подробности — записи в браузере, без установки.",
        h1: "Поддерживаемые регистраторы",
        lead: "everydashcam воспроизводит записи этих марок прямо в браузере. Выбери свою, чтобы узнать о совместимых моделях и форматах записей. Без установки, загрузки и аккаунта.",
    },
    de: {
        title: "Unterstützte Dashcam-Marken | everydashcam",
        metaDescription:
            "Alle Dashcam-Marken, die everydashcam unterstützt - 70mai, Viofo, BlackVue, GoPro, Garmin und mehr. Aufnahmen im Browser öffnen, keine Installation, kein Upload.",
        ogTitle: "Unterstützte Dashcam-Marken — Aufnahmen online abspielen",
        ogDescription:
            "Alle von everydashcam unterstützten Dashcam-Marken. Wähle deine - Aufnahmen direkt im Browser, ohne Installation.",
        h1: "Unterstützte Dashcam-Marken",
        lead: "everydashcam spielt Aufnahmen dieser Marken direkt im Browser ab. Wähle deine für kompatible Modellreihen und Aufnahmedetails. Keine Installation, kein Upload, kein Konto.",
    },
    es: {
        title: "Marcas de dashcam compatibles | everydashcam",
        metaDescription:
            "Marcas compatibles con everydashcam: 70mai, Viofo, BlackVue, GoPro, Garmin y más. Abre grabaciones en el navegador, sin instalar ni subir archivos.",
        ogTitle: "Marcas de dashcam compatibles — reproducir online",
        ogDescription:
            "Todas las marcas de dashcam compatibles con everydashcam. Elige la tuya - abre las grabaciones directamente en el navegador.",
        h1: "Marcas de dashcam compatibles",
        lead: "everydashcam reproduce grabaciones de estas marcas directamente en el navegador. Elige la tuya para ver familias de modelos compatibles y detalles de grabación. Sin instalar, subir archivos ni crear una cuenta.",
    },
    fr: {
        title: "Marques de dashcam compatibles | everydashcam",
        metaDescription:
            "Marques prises en charge par everydashcam : 70mai, Viofo, BlackVue, GoPro, Garmin et plus. Lis les vidéos dans le navigateur, sans installation ni envoi.",
        ogTitle: "Marques de dashcam prises en charge — lecture en ligne",
        ogDescription:
            "Toutes les marques de dashcam prises en charge par everydashcam. Choisis la tienne - ouvre les enregistrements directement dans le navigateur.",
        h1: "Marques de dashcam prises en charge",
        lead: "everydashcam lit les enregistrements de ces marques directement dans le navigateur. Choisis la tienne pour voir les gammes compatibles et les détails d'enregistrement. Sans installation, téléversement ni compte.",
    },
    pl: {
        title: "Obsługiwane marki wideorejestratorów | everydashcam",
        metaDescription:
            "Marki obsługiwane przez everydashcam: 70mai, Viofo, BlackVue, GoPro, Garmin i inne. Otwórz nagrania w przeglądarce, bez instalacji i wysyłania.",
        ogTitle: "Obsługiwane marki wideorejestratorów — odtwarzanie online",
        ogDescription:
            "Wszystkie obsługiwane przez everydashcam marki wideorejestratorów. Wybierz swoją - otwórz nagrania w przeglądarce, bez instalacji.",
        h1: "Obsługiwane marki wideorejestratorów",
        lead: "everydashcam odtwarza nagrania z tych marek prosto w przeglądarce. Wybierz swoją, aby zobaczyć zgodne rodziny modeli i szczegóły nagrań. Bez instalacji, wysyłania plików i konta.",
    },
    pt: {
        title: "Marcas de dashcam compatíveis | everydashcam",
        metaDescription:
            "Marcas suportadas pelo everydashcam: 70mai, Viofo, BlackVue, GoPro, Garmin e outras. Abra as gravações no navegador, sem instalar nem enviar arquivos.",
        ogTitle: "Marcas de dashcam compatíveis — reproduzir online",
        ogDescription:
            "Todas as marcas de dashcam suportadas pelo everydashcam. Escolha a sua - abra as gravações direto no navegador, sem instalação.",
        h1: "Marcas de dashcam compatíveis",
        lead: "O everydashcam reproduz gravações dessas marcas direto no navegador. Escolha a sua para ver famílias de modelos compatíveis e detalhes das gravações. Sem instalação, upload ou conta.",
    },
    zh: {
        title: "支持的行车记录仪品牌 | everydashcam",
        metaDescription:
            "everydashcam 支持的所有行车记录仪品牌 — 70mai、Viofo、BlackVue、GoPro、Garmin 及更多。直接在浏览器中打开录像，无需安装，无需上传。",
        ogTitle: "支持的行车记录仪品牌 — 在线播放",
        ogDescription:
            "everydashcam 支持的所有行车记录仪品牌。选择你的品牌 — 直接在浏览器中打开录像，无需安装。",
        h1: "支持的行车记录仪品牌",
        lead: "everydashcam 直接在浏览器中播放这些品牌的录像。选择品牌即可查看兼容的型号系列和录像详情。无需安装、上传或账号。",
    },
    ja: {
        title: "対応ドライブレコーダーブランド | everydashcam",
        metaDescription:
            "everydashcam が対応している全ドライブレコーダーブランド - 70mai、Viofo、BlackVue、GoPro、Garmin など。録画ファイルをブラウザでそのまま再生、インストールもアップロードも不要です。",
        ogTitle: "対応ドライブレコーダーブランド — オンライン再生",
        ogDescription:
            "everydashcam が対応している全ブランド。あなたのブランドを選んで、録画ファイルをブラウザでそのまま再生。インストール不要。",
        h1: "対応ドライブレコーダーブランド",
        lead: "everydashcam はこれらのブランドの録画をブラウザで直接再生します。ブランドを選ぶと、対応するモデルシリーズと録画の詳細を確認できます。インストール、アップロード、アカウント登録は不要です。",
    },
    ko: {
        title: "지원되는 블랙박스 브랜드 | everydashcam",
        metaDescription:
            "everydashcam가 지원하는 모든 블랙박스 브랜드 - 70mai, Viofo, BlackVue, GoPro, Garmin 등. 녹화 파일을 브라우저에서 바로 열 수 있어요. 설치 없이, 업로드 없이.",
        ogTitle: "지원되는 블랙박스 브랜드 — 온라인 재생",
        ogDescription:
            "everydashcam가 지원하는 모든 블랙박스 브랜드. 본인의 브랜드를 선택해서 녹화를 브라우저에서 바로 재생하세요.",
        h1: "지원되는 블랙박스 브랜드",
        lead: "everydashcam는 이 브랜드들의 녹화를 브라우저에서 바로 재생해요. 브랜드를 골라 호환되는 모델 제품군과 녹화 정보를 살펴보세요. 설치, 업로드, 가입이 필요 없어요.",
    },
};

// Shared section labels - per locale, NOT per vendor. {vendor} is substituted
// at template time with the displayName. Keeps vendor data lean - we don't
// repeat the same section headings for every vendor.
const SHARED_LABELS: Record<Lang, SharedLabels> = {
    en: {
        reassurance: "Free browser player. Recordings stay on your device.",
        backToPlayer: "← Back to player",
        breadcrumbHome: "Home",
        breadcrumbCameras: "Cameras",
        modelsHeading: "Supported {vendor} models",
        howHeading: "Playing {vendor} recordings in everydashcam",
        howSteps: [
            "Take the SD card out of the dashcam, plug it into your computer.",
            "Open everydashcam.app in any modern browser.",
            "Drag the whole SD-card folder onto the page — it'll detect, group and play.",
        ],
        howSecondaryCta: "Try it now",
        footerPrivacy: "Privacy policy",
        footerTerms: "Terms of use",
        footerHome: "everydashcam.app",
        notListedText: "Don't see your camera? Send us a sample — we add support from real recordings.",
        notListedCta: "Add your dashcam",
    },
    ru: {
        reassurance: "Бесплатный плеер в браузере. Записи остаются на устройстве.",
        backToPlayer: "← К плееру",
        breadcrumbHome: "Главная",
        breadcrumbCameras: "Регистраторы",
        modelsHeading: "Поддерживаемые модели {vendor}",
        howHeading: "Как открыть записи {vendor} в everydashcam",
        howSteps: [
            "Достань SD-карту из регистратора, вставь в компьютер.",
            "Открой everydashcam.app в любом современном браузере.",
            "Перетащи всю папку с SD-карты на страницу — она сама всё разберёт и проиграет.",
        ],
        howSecondaryCta: "Попробовать",
        footerPrivacy: "Политика конфиденциальности",
        footerTerms: "Условия использования",
        footerHome: "everydashcam.app",
        notListedText: "Не нашёл свой регистратор? Пришли пример — мы добавляем поддержку по реальным записям.",
        notListedCta: "Добавить свой регистратор",
    },
    de: {
        reassurance: "Kostenloser Browser-Player. Aufnahmen bleiben auf deinem Gerät.",
        backToPlayer: "← Zurück zum Player",
        breadcrumbHome: "Start",
        breadcrumbCameras: "Kameras",
        modelsHeading: "Unterstützte {vendor}-Modelle",
        howHeading: "{vendor}-Aufnahmen in everydashcam abspielen",
        howSteps: [
            "Nimm die SD-Karte aus der Dashcam und stecke sie in deinen Computer.",
            "Öffne everydashcam.app in einem modernen Browser.",
            "Ziehe den gesamten SD-Karten-Ordner auf die Seite — sie erkennt, gruppiert und spielt ab.",
        ],
        howSecondaryCta: "Jetzt ausprobieren",
        footerPrivacy: "Datenschutzerklärung",
        footerTerms: "Nutzungsbedingungen",
        footerHome: "everydashcam.app",
        notListedText: "Deine Dashcam nicht dabei? Schick uns eine Beispielaufnahme — damit können wir neue Formate unterstützen.",
        notListedCta: "Deine Dashcam hinzufügen",
    },
    es: {
        reassurance: "Reproductor gratuito en el navegador. Las grabaciones se quedan en tu dispositivo.",
        backToPlayer: "← Volver al reproductor",
        breadcrumbHome: "Inicio",
        breadcrumbCameras: "Cámaras",
        modelsHeading: "Modelos {vendor} compatibles",
        howHeading: "Reproducir grabaciones de {vendor} en everydashcam",
        howSteps: [
            "Saca la tarjeta SD de la dashcam y conéctala al ordenador.",
            "Abre everydashcam.app en cualquier navegador moderno.",
            "Arrastra toda la carpeta de la SD a la página — detecta, agrupa y reproduce.",
        ],
        howSecondaryCta: "Pruébalo ya",
        footerPrivacy: "Política de privacidad",
        footerTerms: "Términos de uso",
        footerHome: "everydashcam.app",
        notListedText: "¿No ves tu cámara? Envíanos una muestra — añadimos compatibilidad a partir de grabaciones reales.",
        notListedCta: "Añade tu cámara de coche",
    },
    fr: {
        reassurance: "Lecteur gratuit dans le navigateur. Les enregistrements restent sur ton appareil.",
        backToPlayer: "← Retour au lecteur",
        breadcrumbHome: "Accueil",
        breadcrumbCameras: "Caméras",
        modelsHeading: "Modèles {vendor} compatibles",
        howHeading: "Lire les enregistrements {vendor} dans everydashcam",
        howSteps: [
            "Sors la carte SD de la dashcam et branche-la sur ton ordinateur.",
            "Ouvre everydashcam.app dans n'importe quel navigateur moderne.",
            "Glisse tout le dossier de la carte SD sur la page — elle détecte, regroupe et lit.",
        ],
        howSecondaryCta: "Essayer maintenant",
        footerPrivacy: "Politique de confidentialité",
        footerTerms: "Conditions d'utilisation",
        footerHome: "everydashcam.app",
        notListedText: "Tu ne vois pas ta dashcam ? Envoie-nous un exemple — on ajoute la prise en charge à partir de vrais enregistrements.",
        notListedCta: "Ajouter ta dashcam",
    },
    pl: {
        reassurance: "Bezpłatny odtwarzacz w przeglądarce. Nagrania zostają na twoim urządzeniu.",
        backToPlayer: "← Wróć do odtwarzacza",
        breadcrumbHome: "Start",
        breadcrumbCameras: "Kamery",
        modelsHeading: "Obsługiwane modele {vendor}",
        howHeading: "Odtwarzanie nagrań {vendor} w everydashcam",
        howSteps: [
            "Wyjmij kartę SD z wideorejestratora i podłącz do komputera.",
            "Otwórz everydashcam.app w dowolnej nowoczesnej przeglądarce.",
            "Przeciągnij cały folder karty SD na stronę — sama wykryje, pogrupuje i odtworzy.",
        ],
        howSecondaryCta: "Wypróbuj teraz",
        footerPrivacy: "Polityka prywatności",
        footerTerms: "Warunki korzystania",
        footerHome: "everydashcam.app",
        notListedText: "Nie widzisz swojego wideorejestratora? Wyślij nam próbkę — dodajemy obsługę na podstawie prawdziwych nagrań.",
        notListedCta: "Dodaj swój wideorejestrator",
    },
    pt: {
        reassurance: "Player gratuito no navegador. As gravações ficam no seu dispositivo.",
        backToPlayer: "← Voltar ao player",
        breadcrumbHome: "Início",
        breadcrumbCameras: "Câmeras",
        modelsHeading: "Modelos {vendor} compatíveis",
        howHeading: "Reproduzir gravações da {vendor} no everydashcam",
        howSteps: [
            "Tire o cartão SD da dashcam e conecte ao computador.",
            "Abra o everydashcam.app em qualquer navegador moderno.",
            "Arraste a pasta inteira do cartão SD para a página — ela detecta, agrupa e reproduz.",
        ],
        howSecondaryCta: "Experimente agora",
        footerPrivacy: "Política de privacidade",
        footerTerms: "Termos de uso",
        footerHome: "everydashcam.app",
        notListedText: "Não encontrou sua câmera? Envie uma amostra — adicionamos suporte a partir de gravações reais.",
        notListedCta: "Adicione sua dashcam",
    },
    zh: {
        reassurance: "免费的浏览器播放器。录像保留在你的设备上。",
        backToPlayer: "← 返回播放器",
        breadcrumbHome: "首页",
        breadcrumbCameras: "记录仪",
        modelsHeading: "支持的 {vendor} 型号",
        howHeading: "在 everydashcam 中播放 {vendor} 录像",
        howSteps: [
            "把 SD 卡从记录仪取出，插入电脑。",
            "在任意现代浏览器中打开 everydashcam.app。",
            "把整个 SD 卡文件夹拖到页面上 — 自动识别、分组并播放。",
        ],
        howSecondaryCta: "立即试用",
        footerPrivacy: "隐私政策",
        footerTerms: "使用条款",
        footerHome: "everydashcam.app",
        notListedText: "没看到你的行车记录仪？请发给我们一段样例 — 我们会根据真实录像添加支持。",
        notListedCta: "添加你的行车记录仪",
    },
    ja: {
        reassurance: "無料のブラウザプレーヤー。録画は端末内に残ります。",
        backToPlayer: "← プレーヤーに戻る",
        breadcrumbHome: "ホーム",
        breadcrumbCameras: "ドラレコ",
        modelsHeading: "対応する {vendor} モデル",
        howHeading: "{vendor} の録画を everydashcam で再生する",
        howSteps: [
            "ドライブレコーダーから SD カードを取り出してパソコンに接続します。",
            "モダンブラウザで everydashcam.app を開きます。",
            "SD カードのフォルダ全体をページにドラッグすると、自動で認識・グループ化して再生されます。",
        ],
        howSecondaryCta: "今すぐ試す",
        footerPrivacy: "プライバシーポリシー",
        footerTerms: "利用規約",
        footerHome: "everydashcam.app",
        notListedText: "お使いのカメラが見当たりませんか？録画のサンプルをお送りください — 実際の録画をもとに対応を追加しています。",
        notListedCta: "ドライブレコーダーを追加",
    },
    ko: {
        reassurance: "무료 브라우저 플레이어예요. 녹화는 내 기기에만 보관돼요.",
        backToPlayer: "← 플레이어로 돌아가기",
        breadcrumbHome: "홈",
        breadcrumbCameras: "블랙박스",
        modelsHeading: "지원되는 {vendor} 모델",
        howHeading: "everydashcam에서 {vendor} 녹화 재생하기",
        howSteps: [
            "블랙박스에서 SD 카드를 빼서 컴퓨터에 연결하세요.",
            "최신 브라우저에서 everydashcam.app을 여세요.",
            "SD 카드 폴더 전체를 페이지로 끌어다 놓으면 — 자동으로 인식·그룹화하고 재생해요.",
        ],
        howSecondaryCta: "지금 사용해보기",
        footerPrivacy: "개인정보 처리방침",
        footerTerms: "이용약관",
        footerHome: "everydashcam.app",
        notListedText: "찾는 블랙박스가 없나요? 녹화 샘플을 보내 주세요 — 실제 녹화를 바탕으로 지원을 추가해요.",
        notListedCta: "내 블랙박스 추가하기",
    },
};

interface SharedLabels {
    reassurance: string;
    backToPlayer: string;
    breadcrumbHome: string;
    breadcrumbCameras: string;
    modelsHeading: string;
    howHeading: string;
    howSteps: [string, string, string];
    howSecondaryCta: string;
    // "Not listed?" invitation into /add-my-camera - a coverage gap is a reason
    // to get in touch, never a dead end (voice.md).
    notListedText: string;
    notListedCta: string;
    footerPrivacy: string;
    footerTerms: string;
    footerHome: string;
}

// Generic, vendor-agnostic templates for the 8 community locales that don't
// have hand-written vendor-specific copy. Each template has {vendor} placeholders
// the renderer substitutes with displayName. The page has title, meta, og:*,
// h1, lead, a model-family list,
// camera-specific folder guidance and the standard "how to use"
// steps from SHARED_LABELS.
interface VendorTemplate {
    title: string;
    metaDescription: string;
    ogTitle: string;
    ogDescription: string;
    h1: string;
    lead: string;
    ctaPrimary: string;
    modelsCompat: string;
    formatIntro: string;
}

const VENDOR_TEMPLATES: Partial<Record<Lang, VendorTemplate>> = {
    de: {
        title: "{vendor} Video- und GPS-Player | everydashcam",
        metaDescription:
            "Öffne {vendor}-Kameraaufnahmen im Browser. Mit GPS in der Aufnahme siehst du Route und Tempo-Diagramm. Kein Upload, keine Installation.",
        ogTitle: "{vendor} Video- und GPS-Player Online",
        ogDescription:
            "Lokaler Browser-Player für {vendor}-Aufnahmen. GPS-Karte, Tempo-Diagramm und Clip-Export, wenn die Aufnahme GPS enthält.",
        h1: "{vendor} Video- und GPS-Player — Aufnahmen im Browser",
        lead: "Öffne {vendor}-Aufnahmen direkt im Browser. Mit GPS in der Aufnahme siehst du Route und Geschwindigkeit neben dem Video und kannst den gewünschten Ausschnitt speichern.",
        ctaPrimary: "{vendor}-Aufnahmen öffnen",
        modelsCompat:
            "Aufnahmeformate können je nach Modell und Firmware variieren. Standardvideos lassen sich lokal öffnen; GPS und automatische Gruppierung hängen von den gespeicherten Kameradaten ab.",
        formatIntro:
            "Öffne den gesamten Ordner der Speicherkarte, einschließlich {layout}. Lass Dateinamen wie {filename} unverändert, damit zusammengehörige Aufnahmen als Fahrt erkannt werden.",
    },
    es: {
        title: "Reproductor {vendor} | everydashcam",
        metaDescription:
            "Abre grabaciones {vendor} en el navegador. Si incluyen GPS, verás la ruta y la velocidad. Sin subir archivos ni instalar.",
        ogTitle: "Reproductor {vendor} online",
        ogDescription:
            "Reproductor local para grabaciones {vendor}. Mapa GPS, velocidad y exportación de clips cuando la grabación incluye GPS.",
        h1: "Reproductor {vendor} online — grabaciones en el navegador",
        lead: "Abre grabaciones {vendor} directamente en el navegador. Si incluyen GPS, verás la ruta y la velocidad junto al vídeo y podrás guardar el fragmento que necesites.",
        ctaPrimary: "Abrir grabaciones de {vendor}",
        modelsCompat:
            "El formato puede variar según el modelo y el firmware. El vídeo estándar se abre localmente; el GPS y la agrupación dependen de los datos guardados por la cámara.",
        formatIntro:
            "Abre la carpeta completa de la tarjeta, incluidas las carpetas {layout}. Conserva los nombres, como {filename}, para mantener juntas las grabaciones del trayecto.",
    },
    fr: {
        title: "Lecteur {vendor} | everydashcam",
        metaDescription:
            "Ouvre les vidéos {vendor} dans le navigateur. Si elles contiennent des données GPS, vois le trajet et la vitesse. Sans téléversement ni installation.",
        ogTitle: "Lecteur {vendor} en ligne",
        ogDescription:
            "Lecteur local pour les enregistrements {vendor}. Carte GPS, vitesse et export de clips lorsque la vidéo contient des données GPS.",
        h1: "Lecteur {vendor} en ligne — enregistrements dans le navigateur",
        lead: "Ouvre les enregistrements {vendor} dans ton navigateur. Avec du GPS dans la vidéo, tu peux suivre le trajet et la vitesse, puis enregistrer le passage voulu.",
        ctaPrimary: "Ouvrir les enregistrements {vendor}",
        modelsCompat:
            "Le format peut varier selon le modèle et le firmware. La vidéo standard s'ouvre localement ; le GPS et le regroupement dépendent des données enregistrées par la caméra.",
        formatIntro:
            "Ouvre le dossier complet de la carte, y compris {layout}. Garde les noms comme {filename} pour que les enregistrements du même trajet restent ensemble.",
    },
    pl: {
        title: "Odtwarzacz {vendor} | everydashcam",
        metaDescription:
            "Otwórz nagrania {vendor} w przeglądarce. Jeśli zawierają GPS, zobaczysz trasę i prędkość. Bez wysyłania i instalacji.",
        ogTitle: "Odtwarzacz {vendor} online",
        ogDescription:
            "Lokalny odtwarzacz nagrań {vendor}. Mapa GPS, prędkość i eksport klipów, gdy nagranie zawiera GPS.",
        h1: "Odtwarzacz {vendor} online — nagrania w przeglądarce",
        lead: "Otwórz nagrania {vendor} bezpośrednio w przeglądarce. Jeśli zawierają GPS, zobaczysz trasę i prędkość obok filmu i zapiszesz wybrany fragment.",
        ctaPrimary: "Otwórz nagrania {vendor}",
        modelsCompat:
            "Format może się różnić zależnie od modelu i firmware'u. Standardowe wideo otwiera się lokalnie; GPS i grupowanie zależą od danych zapisanych przez kamerę.",
        formatIntro:
            "Otwórz cały folder karty pamięci, razem z {layout}. Zachowaj nazwy takie jak {filename}, aby nagrania z tego samego przejazdu pozostały razem.",
    },
    pt: {
        title: "Player {vendor} | everydashcam",
        metaDescription:
            "Abra gravações {vendor} no navegador. Se tiverem GPS, veja o trajeto e a velocidade. Sem upload ou instalação.",
        ogTitle: "Player {vendor} online",
        ogDescription:
            "Player local para gravações {vendor}. Mapa GPS, velocidade e exportação de clipes quando a gravação tem GPS.",
        h1: "Player {vendor} online — gravações no navegador",
        lead: "Abra as gravações da {vendor} direto no navegador. Se houver GPS na gravação, veja o trajeto e a velocidade junto do vídeo e salve o trecho que precisar.",
        ctaPrimary: "Abrir gravações da {vendor}",
        modelsCompat:
            "O formato pode variar conforme o modelo e o firmware. O vídeo padrão abre localmente; GPS e agrupamento dependem dos dados gravados pela câmera.",
        formatIntro:
            "Abra a pasta inteira do cartão, incluindo {layout}. Mantenha nomes como {filename} para reunir as gravações da mesma viagem.",
    },
    zh: {
        title: "{vendor} GPS 视频播放器 | everydashcam",
        metaDescription:
            "在浏览器中打开 {vendor} 摄像机录像。如果录像包含 GPS，即可查看路线和速度。无需上传或安装。",
        ogTitle: "{vendor} 在线播放器",
        ogDescription:
            "本地播放 {vendor} 录像。录像包含 GPS 时，可查看地图、速度并导出片段。",
        h1: "{vendor} 在线播放器 — 录像在浏览器中播放",
        lead: "直接在浏览器中打开 {vendor} 录像。如果录像包含 GPS，即可在视频旁查看路线和速度，并保存需要的片段。",
        ctaPrimary: "打开 {vendor} 录像",
        modelsCompat:
            "录像格式可能因型号和固件而异。标准视频会在本地打开；GPS 和自动分组取决于摄像机保存的数据。",
        formatIntro:
            "打开存储卡的整个文件夹，包括 {layout}。保留 {filename} 这样的原始文件名，以便将同一行程的录像放在一起。",
    },
    ja: {
        title: "{vendor} GPS動画プレーヤー | everydashcam",
        metaDescription:
            "{vendor} カメラの録画をブラウザで再生。録画に GPS が含まれていれば、ルートと速度を表示します。アップロードもインストールも不要です。",
        ogTitle: "{vendor} オンラインプレーヤー",
        ogDescription:
            "{vendor} 録画をローカル再生。GPS が含まれていれば、地図、速度、クリップ書き出しを利用できます。",
        h1: "{vendor} オンラインプレーヤー — 録画をブラウザで再生",
        lead: "{vendor} の録画をブラウザーで直接開けます。録画に GPS が含まれていれば、動画とともにルートや速度を確認し、必要な部分を保存できます。",
        ctaPrimary: "{vendor} の録画を開く",
        modelsCompat:
            "録画形式はモデルやファームウェアで異なる場合があります。標準動画はローカルで開き、GPS と自動グループ化はカメラが保存したデータに応じて利用できます。",
        formatIntro:
            "{layout} を含むメモリーカードのフォルダー全体を開いてください。{filename} のような元のファイル名を残すと、同じ走行の録画をまとめられます。",
    },
    ko: {
        title: "{vendor} GPS 영상 플레이어 | everydashcam",
        metaDescription:
            "{vendor} 카메라 영상을 브라우저에서 재생하세요. 영상에 GPS가 있으면 경로와 속도를 보여줘요. 업로드나 설치가 필요 없어요.",
        ogTitle: "{vendor} 온라인 플레이어",
        ogDescription:
            "{vendor} 녹화를 로컬로 재생해요. GPS가 있으면 지도, 속도, 클립 내보내기를 사용할 수 있어요.",
        h1: "{vendor} 온라인 플레이어 — 브라우저에서 녹화 재생",
        lead: "{vendor} 녹화를 브라우저에서 바로 열어 보세요. 녹화에 GPS가 있으면 영상과 함께 경로와 속도를 확인하고 필요한 부분을 저장할 수 있어요.",
        ctaPrimary: "{vendor} 녹화 열기",
        modelsCompat:
            "녹화 형식은 모델과 펌웨어에 따라 달라질 수 있어요. 표준 영상은 로컬에서 열리며 GPS와 자동 그룹화는 카메라가 저장한 데이터에 따라 제공돼요.",
        formatIntro:
            "{layout} 폴더를 포함해 메모리 카드의 전체 폴더를 열어 주세요. {filename} 같은 원래 파일명을 유지하면 같은 주행의 녹화를 함께 볼 수 있어요.",
    },
};

// Resolve the per-locale vendor content. Returns the hand-written copy for
// en/ru when present, otherwise instantiates VENDOR_TEMPLATES[lang] with
// the vendor displayName substituted into {vendor} placeholders. Throws if
// neither source is available - that means SEO_LOCALES has a locale that we
// can't render, a build-time bug we want to surface loudly.
function resolveVendorContent(vendor: VendorContent, lang: Lang): VendorLocaleContent {
    const direct = vendor.locales[lang];
    if (direct) return direct;
    const template = VENDOR_TEMPLATES[lang];
    if (!template) {
        throw new Error(`vendor-pages: no localized content or template for lang="${lang}" vendor="${vendor.slug}"`);
    }
    const v = vendor.displayName;
    // A published community page must retain camera-specific opening guidance.
    if (!vendor.format) throw new Error(`vendor-pages: missing recording guidance for ${vendor.slug}/${lang}`);
    const format = vendor.format;
    const proseSafe = (s: string): string => s.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const sub = (s: string): string =>
        s
            .replaceAll("{vendor}", v)
            .replaceAll("{filename}", proseSafe(format.filenamePattern))
            .replaceAll("{layout}", proseSafe(format.sdLayout));
    const templated: VendorLocaleContent = {
        title: sub(template.title),
        metaDescription: sub(template.metaDescription),
        ogTitle: sub(template.ogTitle),
        ogDescription: sub(template.ogDescription),
        h1: sub(template.h1),
        lead: sub(template.lead),
        ctaPrimary: sub(template.ctaPrimary),
        modelsCompat: sub(template.modelsCompat),
        formatIntro: sub(template.formatIntro),
    };
    return templated;
}

// Path segment for the locale's URL prefix. "/<segment>" for every locale
// since the / root migration (English moved from "" to "en"). Centralized
// so all url-building stays consistent with seo-config.ts.
export function pathPrefixFor(lang: Lang): string {
    const loc = getSeoLocaleByLang(lang);
    if (!loc) throw new Error(`vendor-pages: lang "${lang}" not in SEO_LOCALES`);
    if (loc.urlSegment === "") {
        throw new Error(
            `vendor-pages: locale "${lang}" has empty urlSegment - every locale must live under /<segment>/`,
        );
    }
    return `/${loc.urlSegment}`;
}

// Build the full hreflang link block for a given page (homepage of the
// /cameras/ section or a specific vendor page). makeUrl is called once per
// indexable locale to produce that locale's URL for THIS page. x-default
// for sub-pages (not the site root) targets the English variant of the same
// page - there is no page-specific neutral landing.
export function buildHreflangLinksHtml(
    makeUrl: (loc: SeoLocale) => string,
    locales: readonly SeoLocale[] = getIndexableSeoLocales(),
): string {
    const defaultLocale = getDefaultSeoLocale();
    if (!locales.some((locale) => locale.lang === defaultLocale.lang)) {
        throw new Error("vendor-pages: hreflang set must include the default locale");
    }
    const lines = locales.flatMap((loc) =>
        getHreflangCodes(loc).map(
            (code) => `<link rel="alternate" hreflang="${code}" href="${makeUrl(loc)}">`,
        ),
    );
    lines.push(`<link rel="alternate" hreflang="x-default" href="${makeUrl(defaultLocale)}">`);
    return lines.join("\n");
}

// og:locale:alternate meta tags for every locale OTHER than the page's own
// (Facebook / OG spec says og:locale lists self, og:locale:alternate lists
// the others).
export function buildOgLocaleAlternatesHtml(
    selfLang: Lang,
    locales: readonly SeoLocale[] = getIndexableSeoLocales(),
): string {
    return locales
        .filter((loc) => loc.lang !== selfLang)
        .map((loc) => `<meta property="og:locale:alternate" content="${loc.ogLocale}">`)
        .join("\n");
}

// Build the static HTML for one vendor page. Inlines BreadcrumbList JSON-LD
// and one tight HTML body. Loads
// /vendor-page.css for styling. No JS app bundle.
export function renderVendorPage(vendor: VendorContent, lang: Lang, options: SeoBuildOptions): string {
    const seoLocale = getSeoLocaleByLang(lang);
    if (!seoLocale) throw new Error(`vendor-pages: lang "${lang}" not in SEO_LOCALES`);
    if (!isVendorAvailableInLang(vendor, lang)) {
        throw new Error(`vendor-pages: ${vendor.slug} is not published in lang="${lang}"`);
    }

    const content = resolveVendorContent(vendor, lang);
    const labels = SHARED_LABELS[lang];
    const pathPrefix = pathPrefixFor(lang);

    const localHome = `${pathPrefix}/`;
    const url = canonicalLocaleUrl(seoLocale, `cameras/${vendor.slug}/`);
    const homeUrl = canonicalLocaleUrl(seoLocale);
    const camerasUrl = canonicalLocaleUrl(seoLocale, "cameras/");
    const ctaHref = `${pathPrefix}/?vendor=${vendor.slug}`;
    const vendorLocales = getVendorSeoLocales(vendor);
    const ogImageUrl = `${canonicalOriginForLocale(seoLocale)}/${seoLocale.ogImage}`;

    const hreflangBlock = buildHreflangLinksHtml(
        (loc) => canonicalLocaleUrl(loc, `cameras/${vendor.slug}/`),
        vendorLocales,
    );
    const ogLocaleAlternatesBlock = buildOgLocaleAlternatesHtml(lang, vendorLocales);
    const languageLinks = renderSeoLanguageLinks(lang, (locale) => `/${locale.urlSegment}/cameras/${vendor.slug}/`, vendorLocales);

    const breadcrumb = renderBreadcrumbs(lang, [
        { name: labels.breadcrumbHome, url: homeUrl },
        { name: labels.breadcrumbCameras, url: camerasUrl },
        { name: vendor.displayName, url },
    ]);

    const v = vendor.displayName;

    return `<!doctype html>
<html lang="${lang}">
<head>
${searchIndexingMeta(seoLocale, Boolean(options.noIndex))}
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
<script type="application/ld+json">${breadcrumb.jsonLd}</script>
</head>
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
<p class="vp-reassurance">${escapeText(labels.reassurance)}</p>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.modelsHeading.replace("{vendor}", v))}</h2>
<ul class="vp-models">
${vendor.models.map((m) => `<li>${escapeText(m)}</li>`).join("\n")}
</ul>
<p class="vp-note">${escapeText(content.modelsCompat)}</p>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.howHeading.replace("{vendor}", v))}</h2>
<p>${escapeText(content.formatIntro)}</p>
<ol class="vp-steps">
${labels.howSteps.map((step) => `<li>${escapeText(step)}</li>`).join("\n")}
</ol>
<a href="${ctaHref}" class="vp-cta vp-cta--secondary">${escapeText(labels.howSecondaryCta)}</a>
</section>

${renderFeatureLinksHtml(lang, pathPrefix, vendor.features)}
</article>

<aside class="vp-other-vendors">
<a href="${pathPrefix}/cameras/">${escapeText(INDEX_LOCALES[lang].h1)} →</a>
<p class="vp-not-listed">${escapeText(labels.notListedText)} <a href="/add-my-camera">${escapeText(labels.notListedCta)}</a></p>
<p class="vp-note">${escapeText(BRAND_DISCLAIMER[lang])} <a href="/terms">${escapeText(labels.footerTerms)}</a></p>
</aside>
</main>

<footer class="vp-footer">
${languageLinks}
<a href="/privacy">${escapeText(labels.footerPrivacy)}</a>
<span>·</span>
<a href="/terms">${escapeText(labels.footerTerms)}</a>
<span>·</span>
<a href="${homeUrl}">${escapeText(labels.footerHome)}</a>
<span>·</span>
<a href="${REPO_URL}">GitHub</a>
</footer>
</body>
</html>
`;
}

// The catalog lists every supported brand and links to its localized page,
// or explicitly to English when a translation has not been published.
// Same chrome as vendor pages (header, footer, vendor-page.css). Loads no JS
// app bundle.
export function renderCamerasIndexPage(lang: Lang, options: SeoBuildOptions): string {
    const seoLocale = getSeoLocaleByLang(lang);
    if (!seoLocale) throw new Error(`vendor-pages: lang "${lang}" not in SEO_LOCALES`);

    const content = INDEX_LOCALES[lang];
    const labels = SHARED_LABELS[lang];
    const pathPrefix = pathPrefixFor(lang);
    const localHome = `${pathPrefix}/`;
    const url = canonicalLocaleUrl(seoLocale, "cameras/");
    const homeUrl = canonicalLocaleUrl(seoLocale);
    const ogImageUrl = `${canonicalOriginForLocale(seoLocale)}/${seoLocale.ogImage}`;
    const vendorsByName = new Map(VENDORS.map((vendor) => [vendor.displayName, vendor]));

    const hreflangBlock = buildHreflangLinksHtml((loc) => {
        return canonicalLocaleUrl(loc, "cameras/");
    });
    const ogLocaleAlternatesBlock = buildOgLocaleAlternatesHtml(lang);
    const languageLinks = renderSeoLanguageLinks(lang, (locale) => `/${locale.urlSegment}/cameras/`);

    const breadcrumb = renderBreadcrumbs(lang, [
        { name: labels.breadcrumbHome, url: homeUrl },
        { name: labels.breadcrumbCameras, url },
    ]);
    // The collection mirrors the localized cards visible on this hub.
    const collection = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: content.h1,
        description: content.lead,
        url,
        inLanguage: seoLocale.contentLanguage,
        mainEntity: {
            "@type": "ItemList",
            numberOfItems: SUPPORTED_BRANDS.length,
            itemListElement: SUPPORTED_BRANDS.map((brand, idx) => {
                const vendor = vendorsByName.get(brand.displayName);
                const targetLocale = vendor && isVendorAvailableInLang(vendor, lang) ? seoLocale : getDefaultSeoLocale();
                return {
                    "@type": "ListItem",
                    position: idx + 1,
                    url: vendor ? canonicalLocaleUrl(targetLocale, `cameras/${vendor.slug}/`) : `${url}#${cameraCatalogAnchor(brand)}`,
                    name: brand.displayName,
                };
            }),
        },
    };

    return `<!doctype html>
<html lang="${lang}">
<head>
${searchIndexingMeta(seoLocale, Boolean(options.noIndex))}
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
<script type="application/ld+json">${breadcrumb.jsonLd}</script>
<script type="application/ld+json">${stringifyJsonLd(collection)}</script>
</head>
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
${SUPPORTED_BRANDS.map((brand) => {
    const vendor = vendorsByName.get(brand.displayName);
    if (!vendor || !isVendorAvailableInLang(vendor, lang)) {
        const englishHref = vendor ? `/en/cameras/${vendor.slug}/` : undefined;
        return renderCameraBrandCard(brand, lang, vendor?.models.slice(0, 2), englishHref);
    }
    return `<li id="${cameraCatalogAnchor(brand)}"><a class="vp-vendor-card" href="${pathPrefix}/cameras/${vendor.slug}/">
<span class="vp-vendor-card-name">${escapeText(vendor.displayName)}</span>
<span class="vp-vendor-card-hint">${vendor.models.slice(0, 2).map(escapeText).join(" · ")}</span>
</a></li>`;
}).join("\n")}
</ul>
<p class="vp-not-listed">${escapeText(labels.notListedText)} <a href="/add-my-camera">${escapeText(labels.notListedCta)}</a></p>
<p class="vp-note">${escapeText(BRAND_DISCLAIMER[lang])} <a href="/terms">${escapeText(labels.footerTerms)}</a></p>
${renderHubCta(lang, pathPrefix)}
</article>
</main>
<footer class="vp-footer">
${languageLinks}
<a href="/privacy">${escapeText(labels.footerPrivacy)}</a>
<span>·</span>
<a href="/terms">${escapeText(labels.footerTerms)}</a>
<span>·</span>
<a href="${homeUrl}">${escapeText(labels.footerHome)}</a>
<span>·</span>
<a href="${REPO_URL}">GitHub</a>
</footer>
</body>
</html>
`;
}

// Fail the build if SUPPORTED_BRANDS and VENDORS have drifted - every brand
// with hasLandingPage=true must have a matching VendorContent block here,
// and every VendorContent block must correspond to a landing brand. Without
// this check, a mismatched entry would silently produce JSON-LD that
// promises a vendor page that doesn't exist, or a vendor page with no
// SUPPORTED_BRANDS metadata.
function assertVendorListsAligned(): void {
    const landingBrands = getLandingBrands();
    const landingSlugs = new Set(landingBrands.map((b) => b.slug));
    const vendorSlugs = new Set(VENDORS.map((v) => v.slug));
    const missingVendors: string[] = [];
    for (const slug of landingSlugs) {
        if (!vendorSlugs.has(slug)) missingVendors.push(slug);
    }
    const extraVendors: string[] = [];
    for (const slug of vendorSlugs) {
        if (!landingSlugs.has(slug)) extraVendors.push(slug);
    }
    if (missingVendors.length > 0 || extraVendors.length > 0) {
        const lines: string[] = [
            "vendor-pages: SUPPORTED_BRANDS and VENDORS are out of sync",
        ];
        if (missingVendors.length > 0) {
            lines.push(
                `  in SUPPORTED_BRANDS but missing in VENDORS: ${missingVendors.join(", ")}`,
            );
        }
        if (extraVendors.length > 0) {
            lines.push(
                `  in VENDORS but missing in SUPPORTED_BRANDS: ${extraVendors.join(", ")}`,
            );
        }
        throw new Error(lines.join("\n"));
    }

    const indexableLangs = new Set(getIndexableSeoLocales().map((locale) => locale.lang));
    const vendorBySlug = new Map(VENDORS.map((vendor) => [vendor.slug, vendor] as const));
    for (const brand of landingBrands) {
        const uniqueLocales = new Set(brand.locales);
        if (uniqueLocales.size !== brand.locales.length) {
            throw new Error(`vendor-pages: duplicate locale configured for ${brand.slug}`);
        }
        if (!uniqueLocales.has("en") || !uniqueLocales.has("ru")) {
            throw new Error(`vendor-pages: ${brand.slug} must ship in English and Russian`);
        }
        for (const lang of uniqueLocales) {
            if (!indexableLangs.has(lang)) {
                throw new Error(`vendor-pages: ${brand.slug} uses non-indexable locale "${lang}"`);
            }
        }
        const vendor = vendorBySlug.get(brand.slug);
        if (vendor && vendor.displayName !== brand.displayName) {
            throw new Error(
                `vendor-pages: displayName mismatch for ${brand.slug}: "${brand.displayName}" vs "${vendor.displayName}"`,
            );
        }
    }
}

export function vendorPagesPlugin(options: SeoBuildOptions = {}): Plugin {
    // No apply restriction - we both render to disk during build and serve
    // the same pages from a dev middleware so /cameras/<vendor>/ doesn't
    // fall through to the SPA index.html in `npm run dev`. That makes the
    // build guard below necessary: Vite's dev PluginContainer.close() also
    // invokes closeBundle, and without it a Ctrl-C of the dev server would
    // silently write vendor pages into dist/.
    let isBuild = false;
    return {
        name: "everydashcam-vendor-pages",
        configResolved(config) {
            isBuild = config.command === "build";
        },
        closeBundle() {
            if (!isBuild) return;
            assertVendorListsAligned();
            const distDir = resolve(process.cwd(), "dist");
            for (const seoLocale of getIndexableSeoLocales()) {
                const lang = seoLocale.lang;
                // Every locale has a non-empty urlSegment now - /en/cameras/,
                // /de/cameras/, etc. The legacy /cameras/* paths (without a
                // locale prefix) are 301-redirected at the edge via _redirects.
                const prefix = `${seoLocale.urlSegment}/`;
                // /cameras/ section index - hub for vendor pages, makes the
                // middle breadcrumb item resolve to 200.
                const indexDir = resolve(distDir, `${prefix}cameras`);
                mkdirSync(indexDir, { recursive: true });
                writeFileSync(resolve(indexDir, "index.html"), renderCamerasIndexPage(lang, options));
                // Per-vendor pages under that index.
                for (const vendor of getVendorsForLang(lang)) {
                    const targetDir = resolve(distDir, `${prefix}cameras/${vendor.slug}`);
                    mkdirSync(targetDir, { recursive: true });
                    writeFileSync(resolve(targetDir, "index.html"), renderVendorPage(vendor, lang, options));
                }
            }
        },
        configureServer(server) {
            // Dev middleware: render vendor pages on the fly so the same URLs
            // that work in production also work under `npm run dev`. Without
            // this, /cameras/70mai/ falls through to the SPA index.html and
            // the user sees the landing page instead of the vendor page.
            //
            // We render plain static HTML (no vite-client / HMR injection
            // because vendor pages don't run the app bundle). If the user
            // edits a translation in vendor-pages.ts, vite restart picks it up.
            server.middlewares.use((req, res, next) => {
                if (req.method !== "GET" && req.method !== "HEAD") return next();
                const rawUrl = req.url ?? "/";
                const pathOnly = rawUrl.split(/[?#]/, 1)[0] ?? "/";
                const result = matchVendorRoute(pathOnly);
                if (!result) return next();

                let body: string;
                try {
                    body = result.kind === "index"
                        ? renderCamerasIndexPage(result.lang, options)
                        : renderVendorPage(result.vendor, result.lang, options);
                } catch (err) {
                    // Don't crash the dev server on a render error - log and
                    // fall through to SPA fallback so the user can fix it.
                    server.config.logger.error(
                        `[vendor-pages] failed to render ${pathOnly}: ${err instanceof Error ? err.message : String(err)}`,
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

// Result of matching a request path against the vendor-pages URL space.
// "index" → /cameras/ section index for that locale.
// "vendor" → /cameras/<slug>/ page for a specific vendor.
// Exported for tests; the dev middleware uses it internally.
export type VendorRouteMatch =
    | { kind: "index"; lang: Lang }
    | { kind: "vendor"; lang: Lang; vendor: VendorContent };

export function matchVendorRoute(path: string): VendorRouteMatch | null {
    // Tokenize. /cameras/70mai/ → ["cameras", "70mai"];
    // /de/cameras/ → ["de", "cameras"]; /de/cameras/70mai/ → ["de", "cameras", "70mai"].
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return null;

    // Optional leading locale segment. If the first segment matches a known
    // locale URL prefix, consume it; otherwise assume default (en) and start
    // matching from segment 0.
    let lang: Lang = "en";
    let i = 0;
    const maybeLocale = getIndexableSeoLocales().find((l) => l.urlSegment === segments[0]);
    if (maybeLocale) {
        lang = maybeLocale.lang;
        i = 1;
    }

    // The next segment must be "cameras". Otherwise it's not our URL space.
    if (segments[i] !== "cameras") return null;
    i++;

    if (i === segments.length) {
        // /<lang>/cameras/ or /cameras/ - section index.
        return { kind: "index", lang };
    }
    if (i === segments.length - 1) {
        // /<lang>/cameras/<slug>/ - vendor page. Find the vendor by slug.
        const slug = segments[i];
        const vendor = VENDORS.find((v) => v.slug === slug);
        if (!vendor || !isVendorAvailableInLang(vendor, lang)) return null;
        return { kind: "vendor", lang, vendor };
    }
    // Deeper path - not part of vendor-pages URL space.
    return null;
}

interface VendorSitemapEntry {
    loc: string;
    changefreq: string;
    priority: string;
    alternates: Record<string, string>;
    // Required because the sitemap builder enforces an explicit x-default
    // for any entry with alternates. For sub-pages we use the English variant
    // (no page-specific neutral landing exists for /cameras/ or vendor pages).
    xDefaultUrl: string;
    // Mirrors SitemapEntry.lastmod in seo-prerender.ts - git mtime of the
    // source files that produce this URL. Omitted (undefined) when the
    // file isn't git-tracked, so the sitemap builder skips <lastmod>
    // rather than emitting a fake one.
    lastmod?: string;
}

// Sitemap entries for the vendor pages. Exported so the SEO sitemap plugin
// can include them next to the homepage entries. Each entry's alternates
// point at the LOCALE-SPECIFIC siblings of THAT specific page (so a vendor
// page's translation set is its own per-locale siblings, not site roots).
// x-default for sub-pages targets the English variant - no separate neutral
// landing exists for these paths.
export function getVendorSitemapEntries(): VendorSitemapEntry[] {
    const entries: VendorSitemapEntry[] = [];
    const indexable = getIndexableSeoLocales();
    const defaultLang = getDefaultSeoLocale().lang;
    const defaultLocale = getDefaultSeoLocale();

    // Locale and vendor content shares monolithic source files. Their mtimes
    // cannot identify which URL changed, so omit lastmod rather than publish
    // a site-wide false freshness signal.

    // /cameras/ section index alternates: every locale's /cameras/ page.
    const indexAlternates = buildHreflangAlternatesMap((loc) => canonicalLocaleUrl(loc, "cameras/"));
    const indexXDefault = canonicalLocaleUrl(defaultLocale, "cameras/");
    for (const loc of indexable) {
        entries.push({
            loc: canonicalLocaleUrl(loc, "cameras/"),
            changefreq: "monthly",
            priority: loc.lang === defaultLang ? "0.8" : "0.7",
            alternates: indexAlternates,
            xDefaultUrl: indexXDefault,
        });
    }

    // Individual vendor pages: one entry per vendor and configured locale.
    // Each vendor has its own partial alternates graph, containing only pages
    // that actually exist for that brand.
    for (const vendor of VENDORS) {
        const vendorLocales = getVendorSeoLocales(vendor);
        const vendorAlternates = Object.fromEntries(
            vendorLocales.flatMap((loc) =>
                getHreflangCodes(loc).map((code) => [
                    code,
                    canonicalLocaleUrl(loc, `cameras/${vendor.slug}/`),
                ]),
            ),
        );
        const vendorXDefault = canonicalLocaleUrl(defaultLocale, `cameras/${vendor.slug}/`);
        for (const loc of vendorLocales) {
            entries.push({
                loc: canonicalLocaleUrl(loc, `cameras/${vendor.slug}/`),
                changefreq: "monthly",
                priority: loc.lang === defaultLang ? "0.7" : "0.6",
                alternates: vendorAlternates,
                xDefaultUrl: vendorXDefault,
            });
        }
    }
    return entries;
}
