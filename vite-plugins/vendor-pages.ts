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

// Per-locale content for one vendor.
interface VendorLocaleContent {
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
    // Intro paragraph for the "How <vendor> stores recordings" section.
    formatIntro: string;
}

// Vendor static facts (technical, no translation needed) + per-locale prose.
interface VendorContent {
    slug: VendorSlug;
    // Display name shown in titles, headings, breadcrumbs.
    displayName: string;
    // Search-relevant model families covered by this vendor page.
    models: string[];
    // Technical facts for the format section. Plain strings, locale-agnostic
    // (container/codec names don't translate).
    format: {
        container: string; // "MP4", "MPEG-TS"
        codec: string; // "H.264 / H.265"
        gpsStorage: string; // short label, e.g. "Embedded 'mkbx' box"
        sdLayout: string; // "/Normal/, /Event/, /Parking/"
        filenamePattern: string; // example filename
    };
    // Hand-written per-locale content. The renderer can fall back to
    // VENDOR_TEMPLATES for established community pages; new locale rollouts
    // should carry reviewed direct copy before entering the published set.
    locales: Partial<Record<Lang, VendorLocaleContent>>;
}

// Vendor data. Order matches VENDOR_SLUGS - both define the sitemap order
// and the "Other supported brands" cross-link order on each page.
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
            container: "MP4",
            codec: "H.264",
            gpsStorage: "Embedded in the MP4 or stored in a GPSData*.txt log, depending on model",
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
                lead: "Open recordings from 70mai dashcams directly in your browser, on any PC or Mac — no Android emulator, no 70mai app. See the GPS route, speed and G-force chart, plus synchronized front, rear and cabin cameras. No upload, no account.",
                ctaPrimary: "Open 70mai recordings folder",
                modelsCompat: "Covers common current and recent 70mai recording layouts. Standard MP4 video opens locally; GPS and camera grouping depend on the metadata written by the model.",
                formatIntro:
                    "70mai cameras record MP4 video and, depending on the generation, keep GPS inside the video or in a GPSData*.txt log on the SD card. everydashcam reads both layouts, groups front, rear and cabin files by time and shows the route when GPS is present.",
            },
            ru: {
                title: "Плеер 70mai — A810, A800S, A510, Omni | everydashcam",
                metaDescription:
                    "Открывай записи 70mai A810, A800S, A510, M500, Omni и X800 в браузере. Карта GPS, график скорости и синхронные камеры. Без загрузки и установки.",
                ogTitle: "Плеер 70mai онлайн — A810, A800S, A510, Omni",
                ogDescription:
                    "Онлайн-плеер для записей с видеорегистратора 70mai. Карта GPS, график скорости и синхронный просмотр камер. Работает в любом современном браузере, ничего никуда не загружается.",
                h1: "Плеер 70mai онлайн — записи в браузере, без установки",
                lead: "Открывай записи с видеорегистраторов 70mai прямо в браузере на любом ПК или Mac — без Android-эмулятора и приложения 70mai. Смотри маршрут GPS, график скорости и перегрузок, а также переднюю, заднюю и салонную камеры синхронно. Без загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями 70mai",
                modelsCompat: "Поддерживает распространённые форматы актуальных и недавних моделей 70mai. Обычное MP4-видео открывается локально; GPS и группировка камер зависят от данных конкретной модели.",
                formatIntro:
                    "Регистраторы 70mai пишут MP4-видео, а GPS в зависимости от поколения хранят внутри файла или в логе GPSData*.txt на SD-карте. everydashcam читает оба варианта, группирует записи передней, задней и салонной камер по времени и показывает маршрут, когда GPS есть в записи.",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "Embedded freeGPS blocks (Novatek chipset)",
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
                lead: "Open recordings from Viofo dashcams directly in your browser. See the synchronized GPS route, speed and G-force chart, plus front, rear and interior cameras together. Free, no upload, no install.",
                ctaPrimary: "Open Viofo recordings folder",
                modelsCompat: "Covers the common Viofo MP4 and TS recording layouts. Standard video opens locally; the GPS map and automatic camera sync depend on the data stored by the camera.",
                formatIntro:
                    "Viofo cameras record H.264 or H.265 video in MP4, with some models also offering TS mode. GPS is stored with the recording, while filename suffixes identify front, rear and interior channels. everydashcam uses those details to assemble a trip and keep the cameras, map and charts in sync.",
            },
            ru: {
                title: "Плеер Viofo — A119, A229, A329, T130 | everydashcam",
                metaDescription:
                    "Открывай записи Viofo A119, A129, A139, A229, A329 и T130 в браузере. Карта GPS, график скорости и несколько камер. Без загрузки и установки.",
                ogTitle: "Плеер Viofo онлайн — A119, A229, A329, T130",
                ogDescription:
                    "Онлайн-плеер для записей с видеорегистратора Viofo. Карта GPS, график скорости и синхронный просмотр камер. Работает в любом современном браузере.",
                h1: "Плеер Viofo онлайн — записи в браузере, без установки",
                lead: "Открывай записи с видеорегистраторов Viofo прямо в браузере. Смотри синхронный маршрут GPS, график скорости и перегрузок, а также переднюю, заднюю и салонную камеры одновременно. Бесплатно, без загрузки и установки.",
                ctaPrimary: "Открыть папку с записями Viofo",
                modelsCompat: "Поддерживает распространённые форматы записей Viofo в MP4 и TS. Обычное видео открывается локально; карта GPS и синхронизация камер зависят от данных в записи.",
                formatIntro:
                    "Viofo пишет H.264 или H.265 в MP4, а некоторые модели умеют записывать и в TS. GPS хранится вместе с записью, а суффиксы имён обозначают переднюю, заднюю и салонную камеры. everydashcam по этим данным собирает поездку и синхронизирует камеры, карту и графики.",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "NMEA inside custom 'free' box (newer X-series) or .gps sidecar (legacy)",
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
                lead: "Open BlackVue DR-series recordings directly in your browser. See the synchronized GPS route, speed and G-force chart, plus front and rear cameras together. No BlackVue Viewer install or BlackVue Cloud account.",
                ctaPrimary: "Open BlackVue recordings folder",
                modelsCompat: "Covers modern BlackVue X-series recordings with embedded GPS and older DR-series layouts that keep GPS in matching sidecar files.",
                formatIntro:
                    "Modern BlackVue X-series cameras keep GPS inside the MP4, while older DR-series models use matching .gps and .3gf files. Their filenames carry the recording mode and camera channel. everydashcam reads both generations and groups front and rear recordings by time.",
            },
            ru: {
                title: "Плеер BlackVue — DR970X, DR900X, DR770X | everydashcam",
                metaDescription:
                    "Открывай записи BlackVue DR970X, DR900X, DR770X, DR750X и старых DR-серий в браузере. Карта GPS, график скорости и передняя и задняя камеры.",
                ogTitle: "Плеер BlackVue онлайн — DR970X, DR900X, DR770X",
                ogDescription:
                    "Онлайн-плеер для записей с BlackVue. Карта GPS, график скорости, передняя и задняя камеры синхронно. Работает в любом браузере, без аккаунта BlackVue Cloud.",
                h1: "Плеер BlackVue онлайн — записи в браузере, без BlackVue Viewer",
                lead: "Открывай записи BlackVue DR-серии прямо в браузере. Смотри синхронный маршрут GPS, график скорости и перегрузок, а также переднюю и заднюю камеры одновременно. Без BlackVue Viewer и аккаунта BlackVue Cloud.",
                ctaPrimary: "Открыть папку с записями BlackVue",
                modelsCompat: "Поддерживает современные записи BlackVue X-серии со встроенным GPS и старые форматы DR-серии, где GPS лежит в парных служебных файлах.",
                formatIntro:
                    "Современные BlackVue X-серии хранят GPS внутри MP4, а старые DR-серии — в парных файлах .gps и .3gf. В имени записи зашиты режим и канал камеры. everydashcam читает оба поколения и группирует записи передней и задней камер по времени.",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "GPMF metadata track (gpmd)",
            sdLayout: "/DCIM/100GOPRO/",
            filenamePattern: "GH010001.MP4",
        },
        locales: {
            en: {
                title: "GoPro GPS Video Player — HERO, MAX and GPMF | everydashcam",
                metaDescription:
                    "Open GoPro HERO and MAX recordings with GPMF telemetry in your browser. GPS map, speed and G-force charts, trim and export. No upload or install.",
                ogTitle: "GoPro GPS Video Player — HERO, MAX and GPMF",
                ogDescription:
                    "Free online player for GoPro recordings with GPMF GPS. Map, speed and G-force chart from the gpmd track. Works in any modern browser.",
                h1: "GoPro GPS video player — open GPMF recordings in your browser",
                lead: "Open GoPro HERO and MAX recordings directly in your browser. The GPMF (gpmd) metadata track gives you GPS, speed, altitude and 3-axis acceleration — everydashcam renders all of it on a synchronized map and chart.",
                ctaPrimary: "Open GoPro recordings folder",
                modelsCompat: "GoPro telemetry varies by generation and recording settings. Standard video opens locally; the map and charts appear when the file contains compatible GPMF GPS data.",
                formatIntro:
                    "GoPro stores camera telemetry in a GPMF metadata track inside the MP4. Depending on the model and settings, it can include GPS, speed, altitude and acceleration. everydashcam reads that data locally and keeps the video, map and charts on the same timeline.",
            },
            ru: {
                title: "GPS-плеер GoPro — HERO, MAX и GPMF | everydashcam",
                metaDescription:
                    "Открывай записи GoPro HERO и MAX с телеметрией GPMF в браузере. Карта GPS, скорость, перегрузки, обрезка и экспорт. Без загрузки и установки.",
                ogTitle: "GPS-плеер GoPro — HERO, MAX и GPMF",
                ogDescription:
                    "Онлайн-плеер для записей GoPro с GPMF GPS. Карта, скорость и перегрузки из данных gpmd. Работает в любом современном браузере.",
                h1: "Плеер GoPro онлайн — записи с GPMF прямо в браузере",
                lead: "Открывай записи GoPro HERO и MAX прямо в браузере. Из метатрека GPMF (gpmd) everydashcam достаёт GPS, скорость, высоту и данные трёхосевого акселерометра — и рисует всё это на синхронной карте и графике.",
                ctaPrimary: "Открыть папку с записями GoPro",
                modelsCompat: "Состав телеметрии GoPro зависит от поколения и настроек записи. Обычное видео открывается локально; карта и графики появляются, когда в файле есть совместимые GPS-данные GPMF.",
                formatIntro:
                    "GoPro хранит телеметрию камеры в метатреке GPMF внутри MP4. В зависимости от модели и настроек там могут быть GPS, скорость, высота и ускорение. everydashcam читает эти данные локально и держит видео, карту и графики на одной шкале времени.",
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
            container: "MP4",
            codec: "H.264",
            gpsStorage: "Embedded telemetry track (PNDM on compatible recordings)",
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
                    "Garmin Dash Cam records MP4 video and can store location and speed in an embedded telemetry track. everydashcam reads the files locally, groups recordings into trips and uses compatible GPS data for the synchronized map and speed chart.",
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
                    "Garmin Dash Cam пишет MP4-видео и может хранить координаты и скорость во встроенном треке телеметрии. everydashcam читает файлы локально, группирует записи в поездки и использует совместимые GPS-данные для синхронной карты и графика скорости.",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "Embedded freeGPS blocks (Novatek chipset, NMEA-style payload)",
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
                lead: "Open Vantrue recordings directly in your browser. See the synchronized GPS route, speed and G-force charts and camera channels, then trim and export without the Vantrue Cam app, uploads or an account.",
                ctaPrimary: "Open Vantrue recordings folder",
                modelsCompat:
                    "Covers common Vantrue recording layouts used across the N, E, S and X series. Models without GPS still play locally, just without a route on the map.",
                formatIntro:
                    "Vantrue cameras record H.264 or H.265 video in MP4 and commonly keep GPS inside the video file. Channel markers in the filenames distinguish front, rear and cabin views. everydashcam uses them to group each drive and keep the cameras, map and charts together.",
            },
            ru: {
                title: "Плеер Vantrue — N4, N5, E3, N2X | everydashcam",
                metaDescription:
                    "Открывай записи Vantrue N4, N5, E3, N2X, S1 и X4S в браузере. Карта GPS, синхронные камеры, обрезка и экспорт. Без загрузки и установки.",
                ogTitle: "Плеер Vantrue онлайн — N4, N5, E3, N2X",
                ogDescription:
                    "Онлайн-плеер и редактор для записей с Vantrue. Карта GPS, график скорости, обрезка и экспорт. Работает в любом современном браузере, ничего не загружается.",
                h1: "Плеер и редактор Vantrue онлайн — смотри и режь в браузере",
                lead: "Открывай записи Vantrue прямо в браузере. Смотри синхронный маршрут GPS, графики скорости и перегрузок и несколько камер одновременно, затем обрезай и экспортируй без Vantrue Cam, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями Vantrue",
                modelsCompat:
                    "Поддерживает распространённые форматы Vantrue серий N, E, S и X. Модели без GPS тоже воспроизводятся локально — просто без маршрута на карте.",
                formatIntro:
                    "Vantrue пишет H.264 или H.265 в MP4 и обычно хранит GPS прямо внутри видео. Метки в именах файлов обозначают переднюю, заднюю и салонную камеры. everydashcam по ним собирает поездку и синхронизирует камеры, карту и графики.",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "NMEA-RMC sentences in a subtitle (sbtl) track",
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
                lead: "Open recordings from Thinkware dashcams directly in your browser. Synchronized GPS track, speed and G-force chart, front and rear playback, plus trim and export. No Thinkware Dashcam Viewer install, no upload, no account.",
                ctaPrimary: "Open Thinkware recordings folder",
                modelsCompat:
                    "Covers common Thinkware F, Q, U and X-series recording layouts. Models without GPS still play locally, just without a route on the map.",
                formatIntro:
                    "Thinkware cameras store GPS with the MP4 recording and use F/R filename markers for front and rear channels. Recordings are split into continuous, event, parking and manual folders. everydashcam groups the matching files into one trip and applies the shared route to both views.",
            },
            ru: {
                title: "Плеер Thinkware — F800, Q1000, U3000 | everydashcam",
                metaDescription:
                    "Открывай записи Thinkware F200, F800, Q800/Q1000, U1000/U3000 и X1000 в браузере. Карта GPS, передняя и задняя камеры, обрезка и экспорт.",
                ogTitle: "Плеер Thinkware онлайн — F800, Q1000, U3000",
                ogDescription:
                    "Онлайн-плеер и редактор для записей с Thinkware. Карта GPS, график скорости, обрезка и экспорт. Работает в любом современном браузере, ничего не загружается.",
                h1: "Плеер и редактор Thinkware онлайн — смотри и режь в браузере",
                lead: "Открывай записи с видеорегистраторов Thinkware прямо в браузере. Смотри синхронный маршрут GPS, график скорости и перегрузок, а также переднюю и заднюю камеры. Обрезай и экспортируй без Thinkware Dashcam Viewer, загрузки на сервер и аккаунта.",
                ctaPrimary: "Открыть папку с записями Thinkware",
                modelsCompat:
                    "Поддерживает распространённые форматы Thinkware серий F, Q, U и X. Модели без GPS тоже воспроизводятся локально — просто без маршрута на карте.",
                formatIntro:
                    "Thinkware хранит GPS вместе с MP4 и использует метки F/R в именах файлов с передней и задней камер. Записи разложены по папкам обычного, событийного, парковочного и ручного режимов. everydashcam объединяет парные файлы в поездку и применяет общий маршрут к обеим камерам.",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "Built into the recording on GPS models",
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
            container: "MP4",
            codec: "H.264 / H.265",
            gpsStorage: "Built into the recording on compatible models",
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
            container: "MP4 / MOV / TS",
            codec: "H.264 / H.265",
            gpsStorage: "Inside the recording or in a matching .NMEA file, depending on model",
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
            container: "MP4 / MOV",
            codec: "H.264 / H.265",
            gpsStorage: "A matching .NMEA file on compatible GPS models",
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
            container: "MP4 / MOV",
            codec: "H.264 / H.265",
            gpsStorage: "A matching .NMEA file on compatible GPS models",
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
        models: [
            "Toyota / Lexus systems",
            "Volvo / Polestar systems",
            "BMW / MINI systems",
            "Audi / Volkswagen systems",
            "Ford / RAM / GMC systems",
            "Honda / Mazda / Nissan systems",
        ],
        format: {
            container: "TS / MP4",
            codec: "H.264 / H.265",
            gpsStorage: "GPS depends on the model; many recordings contain video only",
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
    cardHintPrefix: string;
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
        cardHintPrefix: "Format:",
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
        cardHintPrefix: "Формат:",
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
        cardHintPrefix: "Format:",
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
        cardHintPrefix: "Formato:",
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
        cardHintPrefix: "Format :",
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
        cardHintPrefix: "Format:",
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
        cardHintPrefix: "Formato:",
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
        cardHintPrefix: "格式:",
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
        cardHintPrefix: "形式:",
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
        cardHintPrefix: "형식:",
    },
};

// Shared section labels - per locale, NOT per vendor. {vendor} is substituted
// at template time with the displayName. Keeps vendor data lean - we don't
// repeat the same section headings for every vendor.
const SHARED_LABELS: Record<Lang, SharedLabels> = {
    en: {
        backToPlayer: "← Back to player",
        breadcrumbHome: "Home",
        breadcrumbCameras: "Cameras",
        modelsHeading: "Supported {vendor} models",
        formatHeading: "How {vendor} stores recordings",
        formatFactsHeading: "Format facts",
        formatLabelContainer: "Container",
        formatLabelCodec: "Video codec",
        formatLabelGps: "GPS storage",
        formatLabelLayout: "Folder layout on SD",
        formatLabelFilename: "Filename pattern",
        howHeading: "Playing {vendor} recordings in everydashcam",
        howSteps: [
            "Take the SD card out of the dashcam, plug it into your computer.",
            "Open everydashcam.app in any modern browser.",
            "Drag the whole SD-card folder onto the page — it'll detect, group and play.",
        ],
        howSecondaryCta: "Try it now",
        otherVendorsHeading: "Other supported brands",
        footerPrivacy: "Privacy policy",
        footerTerms: "Terms of use",
        footerHome: "everydashcam.app",
        notListedText: "Don't see your camera? Send us a sample — we add support from real recordings.",
        notListedCta: "Add your dashcam",
    },
    ru: {
        backToPlayer: "← К плееру",
        breadcrumbHome: "Главная",
        breadcrumbCameras: "Регистраторы",
        modelsHeading: "Поддерживаемые модели {vendor}",
        formatHeading: "Как {vendor} хранит записи",
        formatFactsHeading: "О формате записи",
        formatLabelContainer: "Контейнер",
        formatLabelCodec: "Кодек видео",
        formatLabelGps: "Где хранятся GPS-данные",
        formatLabelLayout: "Структура папок на SD-карте",
        formatLabelFilename: "Шаблон имени файла",
        howHeading: "Как открыть записи {vendor} в everydashcam",
        howSteps: [
            "Достань SD-карту из регистратора, вставь в компьютер.",
            "Открой everydashcam.app в любом современном браузере.",
            "Перетащи всю папку с SD-карты на страницу — она сама всё разберёт и проиграет.",
        ],
        howSecondaryCta: "Попробовать",
        otherVendorsHeading: "Другие поддерживаемые бренды",
        footerPrivacy: "Политика конфиденциальности",
        footerTerms: "Условия использования",
        footerHome: "everydashcam.app",
        notListedText: "Не нашёл свой регистратор? Пришли пример — мы добавляем поддержку по реальным записям.",
        notListedCta: "Добавить свой регистратор",
    },
    de: {
        backToPlayer: "← Zurück zum Player",
        breadcrumbHome: "Start",
        breadcrumbCameras: "Kameras",
        modelsHeading: "Unterstützte {vendor}-Modelle",
        formatHeading: "Wie {vendor} Aufnahmen speichert",
        formatFactsHeading: "Format-Fakten",
        formatLabelContainer: "Container",
        formatLabelCodec: "Video-Codec",
        formatLabelGps: "GPS-Speicherung",
        formatLabelLayout: "Ordnerstruktur auf SD",
        formatLabelFilename: "Dateinamenschema",
        howHeading: "{vendor}-Aufnahmen in everydashcam abspielen",
        howSteps: [
            "Nimm die SD-Karte aus der Dashcam und stecke sie in deinen Computer.",
            "Öffne everydashcam.app in einem modernen Browser.",
            "Ziehe den gesamten SD-Karten-Ordner auf die Seite — sie erkennt, gruppiert und spielt ab.",
        ],
        howSecondaryCta: "Jetzt ausprobieren",
        otherVendorsHeading: "Weitere unterstützte Marken",
        footerPrivacy: "Datenschutzerklärung",
        footerTerms: "Nutzungsbedingungen",
        footerHome: "everydashcam.app",
        notListedText: "Deine Dashcam nicht dabei? Schick uns eine Beispielaufnahme — damit können wir neue Formate unterstützen.",
        notListedCta: "Deine Dashcam hinzufügen",
    },
    es: {
        backToPlayer: "← Volver al reproductor",
        breadcrumbHome: "Inicio",
        breadcrumbCameras: "Cámaras",
        modelsHeading: "Modelos {vendor} compatibles",
        formatHeading: "Cómo {vendor} guarda las grabaciones",
        formatFactsHeading: "Datos del formato",
        formatLabelContainer: "Contenedor",
        formatLabelCodec: "Códec de vídeo",
        formatLabelGps: "Almacenamiento GPS",
        formatLabelLayout: "Estructura en la SD",
        formatLabelFilename: "Patrón de nombre de archivo",
        howHeading: "Reproducir grabaciones de {vendor} en everydashcam",
        howSteps: [
            "Saca la tarjeta SD de la dashcam y conéctala al ordenador.",
            "Abre everydashcam.app en cualquier navegador moderno.",
            "Arrastra toda la carpeta de la SD a la página — detecta, agrupa y reproduce.",
        ],
        howSecondaryCta: "Pruébalo ya",
        otherVendorsHeading: "Otras marcas compatibles",
        footerPrivacy: "Política de privacidad",
        footerTerms: "Términos de uso",
        footerHome: "everydashcam.app",
        notListedText: "¿No ves tu cámara? Envíanos una muestra — añadimos compatibilidad a partir de grabaciones reales.",
        notListedCta: "Añade tu cámara de coche",
    },
    fr: {
        backToPlayer: "← Retour au lecteur",
        breadcrumbHome: "Accueil",
        breadcrumbCameras: "Caméras",
        modelsHeading: "Modèles {vendor} compatibles",
        formatHeading: "Comment {vendor} stocke les enregistrements",
        formatFactsHeading: "Détails du format",
        formatLabelContainer: "Conteneur",
        formatLabelCodec: "Codec vidéo",
        formatLabelGps: "Stockage GPS",
        formatLabelLayout: "Structure des dossiers sur la SD",
        formatLabelFilename: "Modèle de nom de fichier",
        howHeading: "Lire les enregistrements {vendor} dans everydashcam",
        howSteps: [
            "Sors la carte SD de la dashcam et branche-la sur ton ordinateur.",
            "Ouvre everydashcam.app dans n'importe quel navigateur moderne.",
            "Glisse tout le dossier de la carte SD sur la page — elle détecte, regroupe et lit.",
        ],
        howSecondaryCta: "Essayer maintenant",
        otherVendorsHeading: "Autres marques prises en charge",
        footerPrivacy: "Politique de confidentialité",
        footerTerms: "Conditions d'utilisation",
        footerHome: "everydashcam.app",
        notListedText: "Tu ne vois pas ta dashcam ? Envoie-nous un exemple — on ajoute la prise en charge à partir de vrais enregistrements.",
        notListedCta: "Ajouter ta dashcam",
    },
    pl: {
        backToPlayer: "← Wróć do odtwarzacza",
        breadcrumbHome: "Start",
        breadcrumbCameras: "Kamery",
        modelsHeading: "Obsługiwane modele {vendor}",
        formatHeading: "Jak {vendor} zapisuje nagrania",
        formatFactsHeading: "Informacje o formacie",
        formatLabelContainer: "Kontener",
        formatLabelCodec: "Kodek wideo",
        formatLabelGps: "Zapis GPS",
        formatLabelLayout: "Struktura folderów na SD",
        formatLabelFilename: "Wzorzec nazwy pliku",
        howHeading: "Odtwarzanie nagrań {vendor} w everydashcam",
        howSteps: [
            "Wyjmij kartę SD z wideorejestratora i podłącz do komputera.",
            "Otwórz everydashcam.app w dowolnej nowoczesnej przeglądarce.",
            "Przeciągnij cały folder karty SD na stronę — sama wykryje, pogrupuje i odtworzy.",
        ],
        howSecondaryCta: "Wypróbuj teraz",
        otherVendorsHeading: "Inne obsługiwane marki",
        footerPrivacy: "Polityka prywatności",
        footerTerms: "Warunki korzystania",
        footerHome: "everydashcam.app",
        notListedText: "Nie widzisz swojego wideorejestratora? Wyślij nam próbkę — dodajemy obsługę na podstawie prawdziwych nagrań.",
        notListedCta: "Dodaj swój wideorejestrator",
    },
    pt: {
        backToPlayer: "← Voltar ao player",
        breadcrumbHome: "Início",
        breadcrumbCameras: "Câmeras",
        modelsHeading: "Modelos {vendor} compatíveis",
        formatHeading: "Como a {vendor} armazena as gravações",
        formatFactsHeading: "Dados do formato",
        formatLabelContainer: "Contêiner",
        formatLabelCodec: "Codec de vídeo",
        formatLabelGps: "Armazenamento do GPS",
        formatLabelLayout: "Estrutura na SD",
        formatLabelFilename: "Padrão de nome de arquivo",
        howHeading: "Reproduzir gravações da {vendor} no everydashcam",
        howSteps: [
            "Tire o cartão SD da dashcam e conecte ao computador.",
            "Abra o everydashcam.app em qualquer navegador moderno.",
            "Arraste a pasta inteira do cartão SD para a página — ela detecta, agrupa e reproduz.",
        ],
        howSecondaryCta: "Experimente agora",
        otherVendorsHeading: "Outras marcas compatíveis",
        footerPrivacy: "Política de privacidade",
        footerTerms: "Termos de uso",
        footerHome: "everydashcam.app",
        notListedText: "Não encontrou sua câmera? Envie uma amostra — adicionamos suporte a partir de gravações reais.",
        notListedCta: "Adicione sua dashcam",
    },
    zh: {
        backToPlayer: "← 返回播放器",
        breadcrumbHome: "首页",
        breadcrumbCameras: "记录仪",
        modelsHeading: "支持的 {vendor} 型号",
        formatHeading: "{vendor} 如何存储录像",
        formatFactsHeading: "格式信息",
        formatLabelContainer: "容器",
        formatLabelCodec: "视频编码",
        formatLabelGps: "GPS 存储",
        formatLabelLayout: "SD 卡目录结构",
        formatLabelFilename: "文件名规则",
        howHeading: "在 everydashcam 中播放 {vendor} 录像",
        howSteps: [
            "把 SD 卡从记录仪取出，插入电脑。",
            "在任意现代浏览器中打开 everydashcam.app。",
            "把整个 SD 卡文件夹拖到页面上 — 自动识别、分组并播放。",
        ],
        howSecondaryCta: "立即试用",
        otherVendorsHeading: "其他支持的品牌",
        footerPrivacy: "隐私政策",
        footerTerms: "使用条款",
        footerHome: "everydashcam.app",
        notListedText: "没看到你的行车记录仪？请发给我们一段样例 — 我们会根据真实录像添加支持。",
        notListedCta: "添加你的行车记录仪",
    },
    ja: {
        backToPlayer: "← プレーヤーに戻る",
        breadcrumbHome: "ホーム",
        breadcrumbCameras: "ドラレコ",
        modelsHeading: "対応する {vendor} モデル",
        formatHeading: "{vendor} の録画保存方式",
        formatFactsHeading: "フォーマット情報",
        formatLabelContainer: "コンテナ",
        formatLabelCodec: "映像コーデック",
        formatLabelGps: "GPS 保存形式",
        formatLabelLayout: "SD カードのフォルダ構成",
        formatLabelFilename: "ファイル名パターン",
        howHeading: "{vendor} の録画を everydashcam で再生する",
        howSteps: [
            "ドライブレコーダーから SD カードを取り出してパソコンに接続します。",
            "モダンブラウザで everydashcam.app を開きます。",
            "SD カードのフォルダ全体をページにドラッグすると、自動で認識・グループ化して再生されます。",
        ],
        howSecondaryCta: "今すぐ試す",
        otherVendorsHeading: "対応している他のブランド",
        footerPrivacy: "プライバシーポリシー",
        footerTerms: "利用規約",
        footerHome: "everydashcam.app",
        notListedText: "お使いのカメラが見当たりませんか？録画のサンプルをお送りください — 実際の録画をもとに対応を追加しています。",
        notListedCta: "ドライブレコーダーを追加",
    },
    ko: {
        backToPlayer: "← 플레이어로 돌아가기",
        breadcrumbHome: "홈",
        breadcrumbCameras: "블랙박스",
        modelsHeading: "지원되는 {vendor} 모델",
        formatHeading: "{vendor}는 녹화를 어떻게 저장하나요",
        formatFactsHeading: "포맷 정보",
        formatLabelContainer: "컨테이너",
        formatLabelCodec: "비디오 코덱",
        formatLabelGps: "GPS 저장 방식",
        formatLabelLayout: "SD 카드 폴더 구조",
        formatLabelFilename: "파일명 패턴",
        howHeading: "everydashcam에서 {vendor} 녹화 재생하기",
        howSteps: [
            "블랙박스에서 SD 카드를 빼서 컴퓨터에 연결하세요.",
            "최신 브라우저에서 everydashcam.app을 여세요.",
            "SD 카드 폴더 전체를 페이지로 끌어다 놓으면 — 자동으로 인식·그룹화하고 재생해요.",
        ],
        howSecondaryCta: "지금 사용해보기",
        otherVendorsHeading: "지원하는 다른 브랜드",
        footerPrivacy: "개인정보 처리방침",
        footerTerms: "이용약관",
        footerHome: "everydashcam.app",
        notListedText: "찾는 블랙박스가 없나요? 녹화 샘플을 보내 주세요 — 실제 녹화를 바탕으로 지원을 추가해요.",
        notListedCta: "내 블랙박스 추가하기",
    },
};

interface SharedLabels {
    backToPlayer: string;
    breadcrumbHome: string;
    breadcrumbCameras: string;
    modelsHeading: string;
    formatHeading: string;
    formatFactsHeading: string;
    formatLabelContainer: string;
    formatLabelCodec: string;
    formatLabelGps: string;
    formatLabelLayout: string;
    formatLabelFilename: string;
    howHeading: string;
    howSteps: [string, string, string];
    howSecondaryCta: string;
    otherVendorsHeading: string;
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
// format facts (vendor-agnostic technical strings) and the standard "how to use"
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
        lead: "Öffne Aufzeichnungen deiner {vendor}-Kamera direkt im Browser. Enthält die Aufnahme GPS, zeigt everydashcam Strecke, Geschwindigkeit und G-Kräfte und exportiert Clips. Kein {vendor}-App-Setup, kein Upload, kein Konto.",
        ctaPrimary: "{vendor}-Aufnahmen öffnen",
        modelsCompat:
            "Aufnahmeformate können je nach Modell und Firmware variieren. Standardvideos lassen sich lokal öffnen; GPS und automatische Gruppierung hängen von den gespeicherten Kameradaten ab.",
        formatIntro:
            "Kameras von {vendor} nehmen {codec}-Video in {container}-Dateien auf. Die Aufnahmen folgen dem Namensschema {filename} und werden auf der SD-Karte in die Ordner {layout} einsortiert. Zieh den gesamten SD-Karten-Ordner auf die Seite — everydashcam gruppiert die Dateien zu Fahrten und zeigt vorhandene GPS-Daten auf der Karte.",
    },
    es: {
        title: "Reproductor {vendor} | everydashcam",
        metaDescription:
            "Abre grabaciones {vendor} en el navegador. Si incluyen GPS, verás la ruta y la velocidad. Sin subir archivos ni instalar.",
        ogTitle: "Reproductor {vendor} online",
        ogDescription:
            "Reproductor local para grabaciones {vendor}. Mapa GPS, velocidad y exportación de clips cuando la grabación incluye GPS.",
        h1: "Reproductor {vendor} online — grabaciones en el navegador",
        lead: "Abre las grabaciones de tu cámara {vendor} directamente en el navegador. Si incluyen GPS, everydashcam muestra la ruta, la velocidad y la fuerza G, y permite exportar clips. Sin instalar la app de {vendor}, subir archivos ni crear una cuenta.",
        ctaPrimary: "Abrir grabaciones de {vendor}",
        modelsCompat:
            "El formato puede variar según el modelo y el firmware. El vídeo estándar se abre localmente; el GPS y la agrupación dependen de los datos guardados por la cámara.",
        formatIntro:
            "Las cámaras {vendor} graban vídeo {codec} en archivos {container}. Las grabaciones siguen el patrón de nombre {filename} y se ordenan en las carpetas {layout} de la tarjeta SD. Arrastra la carpeta entera a la página: everydashcam agrupa los archivos en trayectos y muestra en el mapa los datos GPS disponibles.",
    },
    fr: {
        title: "Lecteur {vendor} | everydashcam",
        metaDescription:
            "Ouvre les vidéos {vendor} dans le navigateur. Si elles contiennent des données GPS, vois le trajet et la vitesse. Sans téléversement ni installation.",
        ogTitle: "Lecteur {vendor} en ligne",
        ogDescription:
            "Lecteur local pour les enregistrements {vendor}. Carte GPS, vitesse et export de clips lorsque la vidéo contient des données GPS.",
        h1: "Lecteur {vendor} en ligne — enregistrements dans le navigateur",
        lead: "Ouvre les enregistrements de ta caméra {vendor} directement dans le navigateur. S'ils contiennent des données GPS, everydashcam affiche le trajet, la vitesse et la force G, puis exporte des clips. Sans installer l'app {vendor}, téléverser les fichiers ni créer un compte.",
        ctaPrimary: "Ouvrir les enregistrements {vendor}",
        modelsCompat:
            "Le format peut varier selon le modèle et le firmware. La vidéo standard s'ouvre localement ; le GPS et le regroupement dépendent des données enregistrées par la caméra.",
        formatIntro:
            "Les caméras {vendor} enregistrent de la vidéo {codec} dans des fichiers {container}. Les enregistrements suivent le modèle de nom {filename} et sont rangés dans les dossiers {layout} sur la carte SD. Glisse le dossier complet sur la page : everydashcam regroupe les fichiers en trajets et affiche les données GPS disponibles sur la carte.",
    },
    pl: {
        title: "Odtwarzacz {vendor} | everydashcam",
        metaDescription:
            "Otwórz nagrania {vendor} w przeglądarce. Jeśli zawierają GPS, zobaczysz trasę i prędkość. Bez wysyłania i instalacji.",
        ogTitle: "Odtwarzacz {vendor} online",
        ogDescription:
            "Lokalny odtwarzacz nagrań {vendor}. Mapa GPS, prędkość i eksport klipów, gdy nagranie zawiera GPS.",
        h1: "Odtwarzacz {vendor} online — nagrania w przeglądarce",
        lead: "Otwórz nagrania z kamery {vendor} prosto w przeglądarce. Jeśli zawierają GPS, everydashcam pokaże trasę, prędkość i przeciążenia oraz pozwoli wyeksportować klip. Bez instalowania aplikacji {vendor}, wysyłania plików i konta.",
        ctaPrimary: "Otwórz nagrania {vendor}",
        modelsCompat:
            "Format może się różnić zależnie od modelu i firmware'u. Standardowe wideo otwiera się lokalnie; GPS i grupowanie zależą od danych zapisanych przez kamerę.",
        formatIntro:
            "Kamery {vendor} nagrywają obraz w kodeku {codec} do plików {container}. Nagrania mają nazwy według wzorca {filename} i są posortowane do folderów {layout} na karcie SD. Przeciągnij cały folder na stronę — everydashcam pogrupuje pliki w przejazdy i pokaże dostępne dane GPS na mapie.",
    },
    pt: {
        title: "Player {vendor} | everydashcam",
        metaDescription:
            "Abra gravações {vendor} no navegador. Se tiverem GPS, veja o trajeto e a velocidade. Sem upload ou instalação.",
        ogTitle: "Player {vendor} online",
        ogDescription:
            "Player local para gravações {vendor}. Mapa GPS, velocidade e exportação de clipes quando a gravação tem GPS.",
        h1: "Player {vendor} online — gravações no navegador",
        lead: "Abra as gravações da sua câmera {vendor} direto no navegador. Se tiverem GPS, o everydashcam mostra o trajeto, a velocidade e a força G e exporta clipes. Sem instalar o app da {vendor}, fazer upload ou criar conta.",
        ctaPrimary: "Abrir gravações da {vendor}",
        modelsCompat:
            "O formato pode variar conforme o modelo e o firmware. O vídeo padrão abre localmente; GPS e agrupamento dependem dos dados gravados pela câmera.",
        formatIntro:
            "As câmeras da {vendor} gravam vídeo em {codec} dentro de arquivos {container}. As gravações seguem o padrão de nome {filename} e ficam organizadas nas pastas {layout} do cartão SD. Arraste a pasta inteira para a página — o everydashcam agrupa os arquivos em viagens e mostra no mapa os dados GPS disponíveis.",
    },
    zh: {
        title: "{vendor} GPS 视频播放器 | everydashcam",
        metaDescription:
            "在浏览器中打开 {vendor} 摄像机录像。如果录像包含 GPS，即可查看路线和速度。无需上传或安装。",
        ogTitle: "{vendor} 在线播放器",
        ogDescription:
            "本地播放 {vendor} 录像。录像包含 GPS 时，可查看地图、速度并导出片段。",
        h1: "{vendor} 在线播放器 — 录像在浏览器中播放",
        lead: "直接在浏览器中打开 {vendor} 摄像机录像。如果录像包含 GPS，everydashcam 会显示路线、速度和 G 力，并可导出片段。无需安装 {vendor} 应用、上传文件或注册账号。",
        ctaPrimary: "打开 {vendor} 录像",
        modelsCompat:
            "录像格式可能因型号和固件而异。标准视频会在本地打开；GPS 和自动分组取决于摄像机保存的数据。",
        formatIntro:
            "{vendor} 摄像机以 {container} 文件录制 {codec} 视频。录像按 {filename} 命名规则命名，并在 SD 卡上归入 {layout} 文件夹。把整个文件夹拖到页面上，everydashcam 会按行程分组文件，并在地图上显示可用的 GPS 数据。",
    },
    ja: {
        title: "{vendor} GPS動画プレーヤー | everydashcam",
        metaDescription:
            "{vendor} カメラの録画をブラウザで再生。録画に GPS が含まれていれば、ルートと速度を表示します。アップロードもインストールも不要です。",
        ogTitle: "{vendor} オンラインプレーヤー",
        ogDescription:
            "{vendor} 録画をローカル再生。GPS が含まれていれば、地図、速度、クリップ書き出しを利用できます。",
        h1: "{vendor} オンラインプレーヤー — 録画をブラウザで再生",
        lead: "{vendor} カメラの録画をブラウザで直接開けます。録画に GPS が含まれていれば、everydashcam がルート、速度、G フォースを表示し、クリップを書き出します。{vendor} 純正アプリのインストール、アップロード、アカウント登録は不要です。",
        ctaPrimary: "{vendor} の録画を開く",
        modelsCompat:
            "録画形式はモデルやファームウェアで異なる場合があります。標準動画はローカルで開き、GPS と自動グループ化はカメラが保存したデータに応じて利用できます。",
        formatIntro:
            "{vendor} のカメラは {codec} の映像を {container} ファイルで録画します。録画ファイルは {filename} という命名パターンに従い、SD カード上では {layout} のフォルダに振り分けられます。フォルダ全体をページにドラッグすると、everydashcam が走行ごとにまとめ、利用できる GPS データを地図に表示します。",
    },
    ko: {
        title: "{vendor} GPS 영상 플레이어 | everydashcam",
        metaDescription:
            "{vendor} 카메라 영상을 브라우저에서 재생하세요. 영상에 GPS가 있으면 경로와 속도를 보여줘요. 업로드나 설치가 필요 없어요.",
        ogTitle: "{vendor} 온라인 플레이어",
        ogDescription:
            "{vendor} 녹화를 로컬로 재생해요. GPS가 있으면 지도, 속도, 클립 내보내기를 사용할 수 있어요.",
        h1: "{vendor} 온라인 플레이어 — 브라우저에서 녹화 재생",
        lead: "{vendor} 카메라 영상을 브라우저에서 바로 열어보세요. 영상에 GPS가 있으면 everydashcam가 경로, 속도, G-포스를 표시하고 클립을 내보내요. {vendor} 전용 앱 설치, 업로드, 회원가입이 필요 없어요.",
        ctaPrimary: "{vendor} 녹화 열기",
        modelsCompat:
            "녹화 형식은 모델과 펌웨어에 따라 달라질 수 있어요. 표준 영상은 로컬에서 열리며 GPS와 자동 그룹화는 카메라가 저장한 데이터에 따라 제공돼요.",
        formatIntro:
            "{vendor} 카메라는 {codec} 영상을 {container} 파일로 녹화해요. 녹화 파일은 {filename} 이름 규칙을 따르고, SD 카드의 {layout} 폴더로 정리돼요. 폴더 전체를 페이지로 드래그하면 everydashcam가 주행별로 묶고 사용 가능한 GPS 데이터를 지도에 보여줘요.",
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
    // formatIntro weaves the vendor's actual format facts into the prose so each
    // vendor's community page differs materially, not just by brand name
    // (anti-doorway). filename/layout are injected prose-cleaned: their trailing
    // English parenthetical (e.g. "(Normal Front)", "(+ Front/Back/...)") is
    // stripped so it doesn't sit untranslated inside a German/Japanese sentence -
    // the full annotated value still shows in the format-facts <dl>.
    const proseSafe = (s: string): string => s.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const sub = (s: string): string =>
        s
            .replaceAll("{vendor}", v)
            .replaceAll("{codec}", vendor.format.codec)
            .replaceAll("{container}", vendor.format.container)
            .replaceAll("{filename}", proseSafe(vendor.format.filenamePattern))
            .replaceAll("{layout}", proseSafe(vendor.format.sdLayout));
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
    const otherVendors = getVendorsForLang(lang).filter((v) => v.slug !== vendor.slug);
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

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.modelsHeading.replace("{vendor}", v))}</h2>
<ul class="vp-models">
${vendor.models.map((m) => `<li>${escapeText(m)}</li>`).join("\n")}
</ul>
<p class="vp-note">${escapeText(content.modelsCompat)}</p>
<p class="vp-note">${escapeText(BRAND_DISCLAIMER[lang])} <a href="/terms">${escapeText(labels.footerTerms)}</a></p>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.formatHeading.replace("{vendor}", v))}</h2>
<p>${escapeText(content.formatIntro)}</p>
<dl class="vp-facts">
<dt>${escapeText(labels.formatLabelContainer)}</dt><dd>${escapeText(vendor.format.container)}</dd>
<dt>${escapeText(labels.formatLabelCodec)}</dt><dd>${escapeText(vendor.format.codec)}</dd>
<dt>${escapeText(labels.formatLabelGps)}</dt><dd>${escapeText(vendor.format.gpsStorage)}</dd>
<dt>${escapeText(labels.formatLabelLayout)}</dt><dd><code>${escapeText(vendor.format.sdLayout)}</code></dd>
<dt>${escapeText(labels.formatLabelFilename)}</dt><dd><code>${escapeText(vendor.format.filenamePattern)}</code></dd>
</dl>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(labels.howHeading.replace("{vendor}", v))}</h2>
<ol class="vp-steps">
${labels.howSteps.map((step) => `<li>${escapeText(step)}</li>`).join("\n")}
</ol>
<a href="${ctaHref}" class="vp-cta vp-cta--secondary">${escapeText(labels.howSecondaryCta)}</a>
</section>

${renderFeatureLinksHtml(lang, pathPrefix)}
</article>

<aside class="vp-other-vendors">
<h3 class="vp-h3">${escapeText(labels.otherVendorsHeading)}</h3>
<ul>
${otherVendors
    .map(
        (other) => `<li><a href="${pathPrefix}/cameras/${other.slug}/">${escapeText(other.displayName)}</a></li>`,
    )
    .join("\n")}
</ul>
<p class="vp-not-listed">${escapeText(labels.notListedText)} <a href="/add-my-camera">${escapeText(labels.notListedCta)}</a></p>
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

// Build the /cameras/ section index page. The hub lists only the vendor pages
// published in its language, so every card resolves to a real localized page.
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
    const localeVendors = getVendorsForLang(lang);
    const linkedVendors = new Map(localeVendors.map((vendor) => [vendor.displayName, vendor]));

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
                const vendor = linkedVendors.get(brand.displayName);
                return {
                    "@type": "ListItem",
                    position: idx + 1,
                    url: vendor ? canonicalLocaleUrl(seoLocale, `cameras/${vendor.slug}/`) : `${url}#${cameraCatalogAnchor(brand)}`,
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
    const vendor = linkedVendors.get(brand.displayName);
    if (!vendor) {
        const models = VENDORS.find((candidate) => candidate.displayName === brand.displayName)?.models.slice(0, 2);
        return renderCameraBrandCard(brand, lang, models);
    }
    return `<li><a class="vp-vendor-card" href="${pathPrefix}/cameras/${vendor.slug}/">
<span class="vp-vendor-card-name">${escapeText(vendor.displayName)}</span>
<span class="vp-vendor-card-hint">${vendor.models.slice(0, 2).map(escapeText).join(" · ")}</span>
<span class="vp-vendor-card-hint">${escapeText(content.cardHintPrefix)} ${escapeText(vendor.format.container)}</span>
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
