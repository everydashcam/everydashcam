import { renderMarketingHead, renderMarketingFooter } from "./marketing-chrome.js";
// Use-case ("how to do X") landing pages. Each targets a high-intent search
// task that the homepage's generic "dashcam player" framing buries: combining
// a dashcam's cameras into one video, and burning a speed/GPS/map overlay onto
// the export. Static HTML at /<lang>/<slug>/ for all 10 locales - the same
// machinery as vendor-pages.ts / alternative-pages.ts (see those files'
// headers for the prerender / dev-middleware / sitemap rationale), one concern
// per plugin.
//
// These are NOT competitor pages, so they do not live under /alternatives/ and
// carry no comparison table. They describe a capability everydashcam genuinely
// has (verified in src/transcode/compose.ts, text-overlay.ts, map-overlay.ts)
// and are honest about its limits (the overlay needs embedded GPS - speed,
// coords, map, time, heading, distance and the G-force read are all derived
// from it, never from a separate sensor).
//
// English + Russian copy is hand-written inline below. The 10 community locales
// live in ./feature-pages-content.ts (machine-translated, parity-enforced by
// assertFeatureLocaleParity) - same split as alternative-pages.ts.
//
// Adding a use-case page: append to FEATURE_PAGES with en+ru, add the 10
// community translations to feature-pages-content.ts, rebuild. Sitemap,
// hreflang, llms.txt and the dev middleware pick it up automatically.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { buildSeoAlternates, renderSeoAlternates } from "./seo-alternates.js";
import type { Lang } from "../src/i18n/index.js";
import { getDefaultSeoLocale, getIndexableSeoLocales, getSeoLocaleByLang } from "../src/i18n/seo-config.js";
import { canonicalLocaleUrl, canonicalOriginForLocale } from "./deployment-profile.js";
import { COMMUNITY_FEATURE_CONTENT, COMMUNITY_FEATURE_LABELS } from "./feature-pages-content.js";
import { escapeText, stringifyJsonLd } from "./html-utils.js";
import type { SeoBuildOptions } from "./seo-prerender.js";
import { renderBreadcrumbs, renderSeoLanguageLinks } from "./seo-navigation.js";
// Shared page chrome - reused from vendor-pages.ts rather than duplicated
// (CLAUDE.md: abstractions against duplicates), exactly like alternative-pages.
import { BRAND_MARK_HTML, buildOgLocaleAlternatesHtml, pathPrefixFor } from "./vendor-pages.js";

// Slugs of the use-case pages. The slug is intentionally general (not
// "front-and-rear", not "speed-gps") so it survives the feature growing:
// merge already handles any channel count; the overlay set will expand. The
// exact-match search phrases ("combine front and rear", "split screen",
// "add speed overlay") live in the H1 / body / FAQ, not the URL.
export type FeatureSlug =
    | "combine-dashcam-cameras-into-one-video"
    | "add-data-overlay-to-dashcam-video"
    | "blur-license-plate-in-dashcam-video";

// Q/A pair, plain text - the template HTML-escapes on output.
interface FeatureFaqItem {
    q: string;
    a: string;
}

// One named capability in the "what you can do" list (a layout, an overlay).
interface FeatureOption {
    name: string;
    desc: string;
}

// Per-locale content for one use-case page. Genuinely different per page, so
// community locales get a full translation, not a templated stub - see
// feature-pages-content.ts.
export interface FeatureLocaleContent {
    title: string; // <title>, long form
    metaDescription: string; // target <=160 chars, hard cap ~200
    ogTitle: string; // target <=60 chars
    ogDescription: string; // ~150 chars
    h1: string;
    lead: string; // subtitle paragraph under h1
    breadcrumbName: string; // short label for the breadcrumb + cross-links
    introHeading: string;
    introBody: string; // first intro paragraph
    introBody2: string; // second intro paragraph (privacy / local)
    optionsHeading: string;
    options: FeatureOption[]; // layouts / overlay types (parity: same length as en)
    howHeading: string;
    howSteps: string[]; // step-by-step (parity: same length as en)
    brandsHeading: string;
    brandsBody: string; // the multi-vendor / manufacturer-gap angle
    noteHeading: string; // honesty callout heading
    noteBody: string; // limits stated plainly (GPS needed, re-encode)
    faqHeading: string;
    faq: FeatureFaqItem[]; // 3-6 items (parity: same length as en)
    ctaPrimary: string;
}

// Static, locale-agnostic identity for one page.
export interface FeaturePage {
    slug: FeatureSlug;
    // Hand-written en + ru. Community locales resolved from COMMUNITY_FEATURE_CONTENT.
    locales: Partial<Record<Lang, FeatureLocaleContent>>;
}

// ---- content (en + ru hand-written; 10 community locales in content file) ----

const FEATURE_PAGES: FeaturePage[] = [
    {
        slug: "combine-dashcam-cameras-into-one-video",
        locales: {
            en: {
                title: "Combine Dashcam Cameras Into One Video — Free, In Your Browser | everydashcam",
                metaDescription:
                    "Combine front, rear and cabin dashcam cameras into one video — side by side, grid or picture-in-picture. Free, in your browser, nothing uploaded. Works with 70mai, BlackVue, Viofo and more.",
                ogTitle: "Combine dashcam cameras into one video — free",
                ogDescription:
                    "Lay front, rear and cabin into one video — side by side, grid or picture-in-picture. Free, in your browser, nothing uploaded.",
                h1: "Combine your dashcam cameras into one video",
                lead: "Most dashcams save each camera as its own file — front in one, rear in another, the cabin in a third. everydashcam lays them into a single video: side by side, in a grid, or one large with the rest as picture-in-picture. It runs in your browser, so nothing is uploaded, and it reads 70mai, BlackVue, Viofo, Garmin, Vantrue and dozens more — not just one brand.",
                breadcrumbName: "Combine cameras into one video",
                introHeading: "One file instead of three",
                introBody:
                    "Watching a front clip and a rear clip for the same minute means juggling windows. Combined into one video, they become a single file you can share, submit as evidence, or keep — every camera in the same frame, in sync.",
                introBody2:
                    "everydashcam does this without uploading your recordings. Your recordings are read and combined locally, in the browser tab, and the finished video is saved straight to your computer.",
                optionsHeading: "Layouts",
                options: [
                    {
                        name: "Side by side",
                        desc: "Two cameras next to each other — a side-by-side split screen with front and rear at equal size.",
                    },
                    { name: "Stacked", desc: "Two cameras one above the other, for tall screens or portrait clips." },
                    {
                        name: "Grid",
                        desc: "Up to four cameras in a 2×2 grid — front, rear, cabin and a side camera together.",
                    },
                    {
                        name: "Picture-in-picture",
                        desc: "One camera fills the frame; the others sit in small rounded insets you can move and resize.",
                    },
                    {
                        name: "Asymmetric split",
                        desc: "One camera on one half, two stacked on the other — a main view plus two extras.",
                    },
                ],
                howHeading: "How to combine your cameras",
                howSteps: [
                    "Plug the SD card into your computer and drop the whole folder onto everydashcam.app.",
                    "Open the trip — front, rear and cabin line up automatically on one timeline.",
                    "Open export, pick a layout (side by side, grid or picture-in-picture), and choose the range to save.",
                    "Save — the combined video is written straight to your computer, with the GPS track inside.",
                ],
                brandsHeading: "Front and rear in one file — even when the camera app won't",
                brandsBody:
                    "Manufacturer apps usually stop short here: they play front and rear together but export each camera as its own file, not one combined clip. everydashcam is a free dashcam player that reads BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin and more — and writes the combined video their apps leave out. Same drive, every camera, one file.",
                noteHeading: "Good to know",
                noteBody:
                    "Combining re-encodes the video, so it isn't instant — a long range takes a little time. For the smoothest export, use Chrome, Edge or another Chromium browser on a computer. This stitches cameras into one frame; joining a drive's short clips end to end into one continuous file happens automatically when you pick a range.",
                faqHeading: "FAQ",
                faq: [
                    {
                        q: "Can I combine front and rear dashcam video into one file?",
                        a: "Yes. Open the trip, choose a side-by-side, stacked or picture-in-picture layout, pick the range, and save. The front and rear cameras are written into one video, in sync, with the GPS track inside the file.",
                    },
                    {
                        q: "Does it work with three cameras (front, rear and cabin)?",
                        a: "Yes. Use the 2×2 grid or a picture-in-picture layout to put three or four cameras in one video. Front, rear, cabin and a side camera can all share the frame.",
                    },
                    {
                        q: "Is my video uploaded anywhere?",
                        a: "No. Your recordings are read and combined locally in your browser, and the finished file is saved straight to your computer.",
                    },
                    {
                        q: "Which dashcams does it support?",
                        a: "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro and many more — anything that writes standard .mp4, .mov or .ts files. If your camera isn't read yet, send a sample to feedback@everydashcam.app and I'll add it.",
                    },
                    {
                        q: "Is it free?",
                        a: "Yes — free, no sign-up, nothing to install. Open the page, drop your folder, combine and save.",
                    },
                ],
                ctaPrimary: "Open your recordings",
            },
            ru: {
                title: "Склеить камеры регистратора в одно видео — бесплатно, в браузере | everydashcam",
                metaDescription:
                    "Склей переднюю, заднюю и салонную камеры регистратора в одно видео — рядом, сеткой или в режиме «картинка в картинке». Бесплатно, в браузере, ничего не загружается. 70mai, BlackVue, Viofo и другие.",
                ogTitle: "Склеить камеры регистратора в одно видео — бесплатно",
                ogDescription:
                    "Объедини видео с передней, задней и салонной камер — рядом, сеткой или в режиме «картинка в картинке». Бесплатно, в браузере, ничего не загружается.",
                h1: "Склей камеры регистратора в одно видео",
                lead: "Большинство регистраторов пишут каждую камеру в свой файл — передняя в одном, задняя в другом, салонная в третьем. everydashcam складывает их в одно видео: рядом, сеткой или одну крупно, а остальные в режиме «картинка в картинке». Всё работает в браузере, без загрузки записей на сервер. Поддерживаются 70mai, BlackVue, Viofo, Garmin, Vantrue и десятки других — не один бренд.",
                breadcrumbName: "Склейка камер в одно видео",
                introHeading: "Один файл вместо трёх",
                introBody:
                    "Смотреть ролик с передней и ролик с задней за одну и ту же минуту — жонглировать окнами. Склеенные в одно видео, они становятся единым файлом, который можно отправить, приложить как доказательство или сохранить — все камеры в одном кадре и синхронно.",
                introBody2:
                    "everydashcam объединяет видео без загрузки записей на сервер. Записи читаются и склеиваются локально, прямо во вкладке браузера, а готовое видео сохраняется сразу на твой компьютер.",
                optionsHeading: "Раскладки",
                options: [
                    {
                        name: "Рядом",
                        desc: "Две камеры бок о бок — раздельный экран с передней и задней одного размера.",
                    },
                    {
                        name: "Стопкой",
                        desc: "Две камеры одна над другой — для высоких экранов или вертикальных роликов.",
                    },
                    {
                        name: "Сетка",
                        desc: "До четырёх камер сеткой 2×2 — передняя, задняя, салонная и боковая вместе.",
                    },
                    {
                        name: "Картинка в картинке",
                        desc: "Одна камера на весь кадр, остальные — в маленьких скруглённых вставках, которые можно перемещать и изменять по размеру.",
                    },
                    {
                        name: "Несимметрично",
                        desc: "Одна камера занимает половину кадра, две другие расположены одна над другой на второй половине.",
                    },
                ],
                howHeading: "Как склеить камеры",
                howSteps: [
                    "Вставь SD-карту в компьютер и перетащи всю папку на everydashcam.app.",
                    "Открой поездку — передняя, задняя и салонная камеры автоматически синхронизируются на одной шкале времени.",
                    "Открой экспорт, выбери раскладку (рядом, сеткой или в режиме «картинка в картинке») и отметь диапазон для сохранения.",
                    "Сохрани — склеенное видео запишется сразу на компьютер, с GPS-треком внутри.",
                ],
                brandsHeading: "Передняя и задняя в одном файле — даже когда родное приложение не умеет",
                brandsBody:
                    "Родные приложения обычно на этом останавливаются: показывают переднюю и заднюю вместе, но экспортируют каждую камеру своим файлом, а не одним склеенным роликом. everydashcam — бесплатный плеер регистратора: читает BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin и другие и пишет то склеенное видео, которого в их приложениях нет. Та же поездка, все камеры, один файл.",
                noteHeading: "Полезно знать",
                noteBody:
                    "Склейка перекодирует видео, так что это не мгновенно — длинный диапазон займёт время. Для экспорта удобнее всего использовать Chrome, Edge или другой браузер на Chromium на компьютере. Это склейка камер в один кадр; а соединение коротких роликов поездки встык в один непрерывный файл происходит само, когда ты выбираешь диапазон.",
                faqHeading: "Частые вопросы",
                faq: [
                    {
                        q: "Можно склеить видео с передней и задней камеры в один файл?",
                        a: "Да. Открой поездку, выбери раскладку рядом, стопкой или в режиме «картинка в картинке», отметь диапазон и сохрани. Передняя и задняя запишутся в одно видео, синхронно, с GPS-треком внутри файла.",
                    },
                    {
                        q: "Работает с тремя камерами (передняя, задняя, салон)?",
                        a: "Да. Возьми сетку 2×2 или режим «картинка в картинке», чтобы собрать три-четыре камеры в одно видео. Передняя, задняя, салонная и боковая камеры могут быть в одном кадре.",
                    },
                    {
                        q: "Моё видео куда-то загружается?",
                        a: "Нет. Записи читаются и склеиваются локально в браузере, а готовый файл сохраняется сразу на компьютер.",
                    },
                    {
                        q: "Какие регистраторы поддерживаются?",
                        a: "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro и многие другие — всё, что пишет стандартные .mp4, .mov или .ts. Если записи твоей камеры пока не открываются, пришли пример на feedback@everydashcam.app — он поможет добавить поддержку.",
                    },
                    {
                        q: "Это бесплатно?",
                        a: "Да — бесплатно, без регистрации, ставить ничего не надо. Открой страницу, перетащи папку, склей и сохрани.",
                    },
                ],
                ctaPrimary: "Открыть свои записи",
            },
        },
    },
    {
        slug: "add-data-overlay-to-dashcam-video",
        locales: {
            en: {
                title: "Add a Data Overlay to Dashcam Video — Speed, GPS & Map | everydashcam",
                metaDescription:
                    "Burn speed, GPS coordinates and a moving map onto your dashcam video — free, in your browser, nothing uploaded. Works when your footage has GPS. 70mai, BlackVue, Viofo and more.",
                ogTitle: "Add speed, GPS & map overlay to dashcam video",
                ogDescription:
                    "Burn speed, coordinates and a moving map onto the exported video — free, in your browser, nothing uploaded.",
                h1: "Add a speed, GPS and map overlay to your dashcam video",
                lead: "everydashcam can burn your speed, GPS coordinates and a moving mini-map straight onto the exported video — clean readouts baked into the picture, not a separate app. It runs in your browser, nothing is uploaded, and it works with the GPS your dashcam already recorded.",
                breadcrumbName: "Add a data overlay",
                introHeading: "Speed and location, baked into the picture",
                introBody:
                    "A dashcam clip on its own doesn't show how fast you were going or where you were. everydashcam reads the GPS your camera saved and draws it onto the exported video: a speed readout, your coordinates, and a small map that moves with the route. The data is part of the picture, so it stays visible wherever the file is played — no special player needed.",
                introBody2:
                    "Everything happens in your browser. Your recordings are read locally and the overlay is rendered on your device; the finished video is saved straight to your computer.",
                optionsHeading: "What you can overlay",
                options: [
                    { name: "Speed", desc: "A clean speed readout in km/h or mph, drawn in the corner you choose." },
                    { name: "Coordinates", desc: "Your GPS latitude and longitude, updated as the route moves." },
                    {
                        name: "Moving map",
                        desc: "A small map that follows the route — drag it where you want, set how much it zooms.",
                    },
                    { name: "Watermark", desc: "An optional small mark in a corner of the frame." },
                ],
                howHeading: "How to add the overlay",
                howSteps: [
                    "Drop the SD-card folder onto everydashcam.app and open the trip.",
                    "Open export and turn on the overlays you want — speed, coordinates, the moving map.",
                    "Drag each one where it should sit and pick the range to save.",
                    "Save — the overlay is rendered onto the video and written straight to your computer.",
                ],
                brandsHeading: "Free, in the browser, for dashcam footage",
                brandsBody:
                    "Burning speed and a map onto video is usually the job of paid desktop tools built for action cameras. everydashcam does the dashcam version for free, in a browser tab: it reads the GPS from 70mai, BlackVue, Viofo, Garmin, Vantrue and more, and draws speed, coordinates and a moving map onto the export — no install, no account, nothing uploaded.",
                noteHeading: "Good to know",
                noteBody:
                    "The overlay needs GPS in your footage — if a recording has no GPS track, there's nothing to draw. Beyond speed, coordinates and the moving map, it can also show the time, your heading, distance travelled and a G-force read — all worked out from the same GPS, not a separate sensor. Rendering re-encodes the video, so a long range takes a little time; Chrome, Edge or another Chromium browser on a computer is smoothest.",
                faqHeading: "FAQ",
                faq: [
                    {
                        q: "How do I add a speed overlay to a dashcam video?",
                        a: "Open the trip, go to export, and turn on the speed overlay. everydashcam reads the GPS your camera recorded and burns a speed readout (km/h or mph) onto the exported video. You can place it in any corner.",
                    },
                    {
                        q: "Can I show GPS coordinates and a map on the video?",
                        a: "Yes. Alongside speed you can overlay your latitude and longitude and a small moving map that follows the route. Drag each one where you want it and set how much the map zooms.",
                    },
                    {
                        q: "Does it need GPS in the recording?",
                        a: "Yes. The overlay is drawn from the GPS your dashcam saved. If a clip has no GPS track, there's nothing to overlay — the video still exports, just without speed, coordinates or the map.",
                    },
                    {
                        q: "Is my video uploaded?",
                        a: "No. The overlay is rendered locally in your browser and the finished video is saved straight to your computer.",
                    },
                    {
                        q: "Can it also show time, heading or G-force?",
                        a: "Yes. Alongside speed, coordinates and the map you can add the time, a compass heading, distance travelled and a G-force readout. The G-force is worked out from your GPS — how your speed and direction change — not from a separate sensor, so it needs GPS in the footage like the rest.",
                    },
                ],
                ctaPrimary: "Open your recordings",
            },
            ru: {
                title: "Наложить данные на видео регистратора — скорость, GPS и карта | everydashcam",
                metaDescription:
                    "Наложи скорость, GPS-координаты и движущуюся карту на видео с регистратора — бесплатно, в браузере, ничего не загружается. Работает, если в записи есть GPS. 70mai, BlackVue, Viofo и другие.",
                ogTitle: "Наложить скорость, GPS и карту на видео регистратора",
                ogDescription:
                    "Впиши скорость, координаты и движущуюся карту прямо в экспортируемое видео — бесплатно, в браузере, ничего не загружается.",
                h1: "Наложи скорость, GPS и карту на видео с регистратора",
                lead: "everydashcam может вписать скорость, GPS-координаты и движущуюся мини-карту прямо в экспортируемое видео — аккуратные значения в самой картинке, без отдельной программы. Всё работает в браузере, без загрузки записей на сервер, с GPS-данными, которые сохранил регистратор.",
                breadcrumbName: "Наложить данные на видео",
                introHeading: "Скорость и место — прямо в картинке",
                introBody:
                    "Сам по себе ролик с регистратора не показывает, как быстро ты ехал и где был. everydashcam читает GPS, который сохранила камера, и рисует его на экспортируемом видео: показ скорости, твои координаты и маленькую карту, которая движется по маршруту. Данные становятся частью картинки и остаются видны где угодно — особый плеер не нужен.",
                introBody2:
                    "Всё происходит в браузере. Записи читаются локально, оверлей рисуется на твоём устройстве, а готовое видео сохраняется сразу на компьютер.",
                optionsHeading: "Что можно наложить",
                options: [
                    { name: "Скорость", desc: "Аккуратный показ скорости в км/ч или mph в выбранном углу кадра." },
                    { name: "Координаты", desc: "Твои GPS-широта и долгота, обновляются по ходу маршрута." },
                    {
                        name: "Движущаяся карта",
                        desc: "Маленькая карта, которая следует за маршрутом — перетащи куда нужно, задай масштаб.",
                    },
                    { name: "Водяной знак", desc: "Небольшая отметка в углу кадра по желанию." },
                ],
                howHeading: "Как наложить данные",
                howSteps: [
                    "Перетащи папку с SD-карты на everydashcam.app и открой поездку.",
                    "Открой экспорт и включи нужные оверлеи — скорость, координаты, движущуюся карту.",
                    "Перетащи каждый туда, где он должен быть, и отметь диапазон для сохранения.",
                    "Сохрани — оверлей впишется в видео и запишется сразу на компьютер.",
                ],
                brandsHeading: "Бесплатно, в браузере, для записей регистратора",
                brandsBody:
                    "Вписать скорость и карту в видео обычно умеют платные десктопные программы для экшен-камер. everydashcam делает версию для регистратора бесплатно, прямо во вкладке браузера: читает GPS из 70mai, BlackVue, Viofo, Garmin, Vantrue и других и рисует скорость, координаты и движущуюся карту на экспорте — без установки, без аккаунта, ничего не загружается.",
                noteHeading: "Полезно знать",
                noteBody:
                    "Оверлею нужен GPS в записи — если у ролика нет GPS-трека, рисовать нечего. Кроме скорости, координат и движущейся карты он умеет показывать время, направление, пройденную дистанцию и перегрузку (G) — всё это считается из того же GPS, а не с отдельного датчика. Рендер перекодирует видео, так что длинный диапазон займёт время; для экспорта удобнее всего использовать Chrome, Edge или другой браузер на Chromium на компьютере.",
                faqHeading: "Частые вопросы",
                faq: [
                    {
                        q: "Как наложить скорость на видео с регистратора?",
                        a: "Открой поездку, зайди в экспорт и включи оверлей скорости. everydashcam читает GPS, записанный камерой, и впишет показ скорости (км/ч или mph) в экспортируемое видео. Разместить показания можно в любом углу.",
                    },
                    {
                        q: "Можно показать координаты и карту на видео?",
                        a: "Да. Кроме скорости можно наложить широту и долготу и маленькую движущуюся карту по маршруту. Перетащи каждый элемент куда нужно и задай масштаб карты.",
                    },
                    {
                        q: "Нужен ли GPS в записи?",
                        a: "Да. Оверлей рисуется из GPS, который сохранил регистратор. Если у ролика нет GPS-трека, накладывать нечего — видео всё равно экспортируется, просто без скорости, координат и карты.",
                    },
                    {
                        q: "Моё видео загружается?",
                        a: "Нет. Оверлей рисуется локально в браузере, а готовое видео сохраняется сразу на компьютер.",
                    },
                    {
                        q: "А время, направление или перегрузку показать можно?",
                        a: "Да. Кроме скорости, координат и карты можно добавить время, направление по компасу, пройденную дистанцию и перегрузку (G). Перегрузка считается из GPS — по тому, как меняются скорость и направление, — а не с отдельного датчика, так что ей, как и остальному, нужен GPS в записи.",
                    },
                ],
                ctaPrimary: "Открыть свои записи",
            },
        },
    },
    {
        slug: "blur-license-plate-in-dashcam-video",
        locales: {
            en: {
                title: "Blur License Plates & Faces in Dashcam Video — Free, In Your Browser | everydashcam",
                metaDescription:
                    "Blur or pixelate license plates and faces in dashcam video before sharing — free, in your browser, nothing uploaded. The cover follows the object automatically and is burned into the saved file.",
                ogTitle: "Blur plates & faces in dashcam video — free",
                ogDescription:
                    "Pixelate a plate or a face, let the cover follow it automatically, save the clip — free, in your browser, nothing uploaded.",
                h1: "Blur license plates and faces in your dashcam video",
                lead: "Posting dashcam footage usually means showing someone's license plate — or a passer-by's face — to the whole internet. everydashcam covers them before you share: draw a box over the plate or face, let it follow the object as it moves, and save the clip with the cover burned into the picture. It runs in your browser, so the video never leaves your device.",
                breadcrumbName: "Blur plates & faces",
                introHeading: "Share the incident, not the bystanders",
                introBody:
                    "An insurance claim, a police report, a clip for a forum — the incident matters, the identities around it don't. A burned-in cover keeps other drivers' plates and pedestrians' faces out of it: the pixels themselves are replaced, so there is no hidden layer to peel back in the saved file.",
                introBody2:
                    "everydashcam processes your video locally, so the original recording stays on your device. The covering happens right in the browser tab, and the finished video is saved straight to your computer.",
                optionsHeading: "What you can do",
                options: [
                    {
                        name: "Pixelate",
                        desc: "A coarse mosaic over the area — the recommended cover: clearly deliberate and hard to undo.",
                    },
                    { name: "Solid cover", desc: "An opaque fill that hides the area completely." },
                    {
                        name: "Soft blur",
                        desc: "A gentle blur — looks the nicest but hides the least; use it for cosmetics, not privacy.",
                    },
                    {
                        name: "Follow the object",
                        desc: "Mark a plate or a face once and the cover tracks it through the clip — correct it by hand at any moment.",
                    },
                    {
                        name: "Fixed zone",
                        desc: "Pin a cover to one spot for a time range — for your own plate, a reflection, or a screen in the cabin.",
                    },
                ],
                howHeading: "How to blur a plate or a face",
                howSteps: [
                    "Plug the SD card into your computer and drop the whole folder onto everydashcam.app.",
                    "Open the trip, open export, and pick the range you want to save.",
                    "Add a blur zone over the plate or face — let it follow the object, or pin it in place and set its time range by hand.",
                    "Save — the cover is rendered into the video and the file is written straight to your computer.",
                ],
                brandsHeading: "Works with footage from any dashcam",
                brandsBody:
                    "Blurring a plate is usually the job of a video editor with a tracking plugin — a heavyweight tool for a 30-second clip. everydashcam does it on the same page you watch your trips: it reads recordings from 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase and dozens more, and the cover is drawn over the picture itself — so it works the same no matter which camera wrote the file.",
                noteHeading: "Good to know",
                noteBody:
                    "Automatic follow downloads a small helper the first time you use it (it asks first) and works offline after that. It tracks one object per zone and can lose it in hard cases — glare, darkness, fast motion — so give the result a quick look before sharing; you can always move the box by hand. Saving re-encodes the video, and the editor is fullest in Chrome, Edge or another Chromium browser on a computer. For real privacy prefer pixelate or the solid cover — the soft blur is the weakest of the three.",
                faqHeading: "FAQ",
                faq: [
                    {
                        q: "How do I blur a license plate in dashcam footage?",
                        a: "Open the trip, open export, and draw a blur zone over the plate. The cover can follow the car automatically as it moves through the frame. Pick the range, save — the blur is burned into the saved video.",
                    },
                    {
                        q: "Can the blur follow a moving car automatically?",
                        a: "Yes. Mark the plate or face once and the cover tracks it as it moves. If it drifts or loses the object, you'll see it in the preview — move the box by hand at any moment, your corrections take priority.",
                    },
                    {
                        q: "Can the blur be removed from the saved video?",
                        a: "The cover is rendered into the pixels of the saved file — there is no separate layer to switch off. Pixelate and the solid cover are hard to undo; the soft blur is the weakest of the three, so prefer the other two for privacy.",
                    },
                    {
                        q: "Is my video uploaded for the blurring?",
                        a: "No. The recording is read locally, the following runs on your device, and the finished video is saved straight to your computer.",
                    },
                    {
                        q: "Is it free?",
                        a: "Yes — free, no sign-up, nothing to install. Open the page, drop your folder, blur and save.",
                    },
                ],
                ctaPrimary: "Open your recordings",
            },
            ru: {
                title: "Замазать номер машины на видео с регистратора — онлайн, бесплатно | everydashcam",
                metaDescription:
                    "Замажь или запиксели номера машин и лица на видео с регистратора онлайн, перед отправкой — бесплатно, в браузере, ничего не загружается. Плашка сама следит за объектом в движении и впечатывается в файл.",
                ogTitle: "Замазать номер машины на видео — онлайн, бесплатно",
                ogDescription:
                    "Запиксели номер или лицо, плашка сама проследит за ним, сохрани ролик — бесплатно, в браузере, ничего не загружается.",
                h1: "Замажь номера машин и лица на видео с регистратора",
                lead: "Выложить запись с регистратора обычно значит показать чей-то номер — или лицо прохожего — всему интернету. everydashcam закрывает их до отправки: нарисуй рамку поверх номера или лица, дай ей проследить за объектом в движении и сохрани ролик — плашка впечатана в картинку. Всё в браузере, так что видео не покидает твоё устройство.",
                breadcrumbName: "Замазать номера и лица",
                introHeading: "Покажи происшествие, а не случайных людей",
                introBody:
                    "Страховая, заявление в полицию, ролик на форум — важно происшествие, а не личности вокруг. Впечатанная плашка убирает из кадра чужие номера и лица пешеходов: заменяются сами пиксели, так что в сохранённом файле нет скрытого слоя, который можно снять.",
                introBody2:
                    "everydashcam обрабатывает видео локально, поэтому исходная запись остаётся на твоём устройстве. Замазывание происходит прямо во вкладке браузера, а готовое видео сохраняется сразу на компьютер.",
                optionsHeading: "Что можно сделать",
                options: [
                    {
                        name: "Пиксели",
                        desc: "Крупная мозаика поверх области — рекомендуемый вариант: явно намеренный и трудно обратимый.",
                    },
                    { name: "Сплошная заливка", desc: "Непрозрачная плашка, закрывающая область целиком." },
                    {
                        name: "Лёгкое размытие",
                        desc: "Мягкое размытие — для визуального эффекта; оно скрывает детали хуже остальных вариантов и не подходит для защиты личных данных.",
                    },
                    {
                        name: "Слежение за объектом",
                        desc: "Отметь номер или лицо один раз — плашка проследит за ним на протяжении ролика; в любой момент можно поправить вручную.",
                    },
                    {
                        name: "Фиксированная зона",
                        desc: "Закрепи плашку на одном месте на отрезок времени — для своего номера, отражения или экрана в салоне.",
                    },
                ],
                howHeading: "Как замазать номер или лицо",
                howSteps: [
                    "Вставь SD-карту в компьютер и перетащи всю папку на everydashcam.app.",
                    "Открой поездку, открой экспорт и отметь диапазон для сохранения.",
                    "Добавь зону поверх номера или лица — дай ей проследить за объектом или закрепи на месте и задай время руками.",
                    "Сохрани — плашка впишется в видео, и файл запишется сразу на компьютер.",
                ],
                brandsHeading: "Работает с записями любого регистратора",
                brandsBody:
                    "Замазать номер — обычно задача видеоредактора с плагином трекинга, тяжёлая артиллерия ради 30-секундного ролика. everydashcam делает это на той же странице, где ты смотришь поездки: читает записи 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase и десятков других, а плашка рисуется поверх самой картинки — так что ей всё равно, какая камера писала файл.",
                noteHeading: "Полезно знать",
                noteBody:
                    "Автослежение при первом использовании скачивает небольшой вспомогательный файл (спросив разрешения) и дальше работает офлайн. Оно ведёт один объект на зону и может потерять его в сложных случаях — блики, темнота, быстрое движение, — так что перед отправкой быстро проверь результат; рамку всегда можно подвинуть руками. Сохранение перекодирует видео, а полнее всего редактор работает в Chrome, Edge или другом браузере на Chromium на компьютере. Для настоящей приватности выбирай пиксели или заливку — лёгкое размытие слабее всех.",
                faqHeading: "Частые вопросы",
                faq: [
                    {
                        q: "Как замазать номер машины на записи регистратора?",
                        a: "Открой поездку, зайди в экспорт и нарисуй зону поверх номера. Плашка может сама следовать за машиной по кадру. Отметь диапазон, сохрани — замазка впечатана в сохранённое видео.",
                    },
                    {
                        q: "Плашка может сама следить за движущейся машиной?",
                        a: "Да. Отметь номер или лицо один раз — плашка проследит за ним в движении. Если она съедет или потеряет объект, это видно в предпросмотре — в любой момент подвинь рамку руками, твои правки имеют приоритет.",
                    },
                    {
                        q: "Можно ли снять замазку с сохранённого видео?",
                        a: "Плашка вписана в сами пиксели сохранённого файла — отдельного слоя, который можно выключить, нет. Мозаику и сплошную заливку трудно убрать; лёгкое размытие — самое слабое из трёх, для приватности выбирай первые два.",
                    },
                    {
                        q: "Моё видео куда-то загружается для замазывания?",
                        a: "Нет. Запись читается локально, слежение работает на твоём устройстве, а готовое видео сохраняется сразу на компьютер.",
                    },
                    {
                        q: "Это бесплатно?",
                        a: "Да — бесплатно, без регистрации, ставить ничего не надо. Открой страницу, перетащи папку, замажь и сохрани.",
                    },
                ],
                ctaPrimary: "Открыть свои записи",
            },
        },
    },
];

// ---- shared chrome labels (en + ru inline; 10 community in content file) ----

export interface FeatureSharedLabels {
    backToPlayer: string;
    breadcrumbHome: string;
    ctaSecondary: string; // button under the how-to steps
    relatedHeading: string; // "Related" aside heading
    camerasLink: string; // link text to /cameras/
    alternativesLink: string; // link text to /alternatives/
    footerPrivacy: string;
    footerTerms: string;
    footerHome: string;
}

const SHARED_LABELS: Partial<Record<Lang, FeatureSharedLabels>> = {
    en: {
        backToPlayer: "← Back to player",
        breadcrumbHome: "Home",
        ctaSecondary: "Try it now",
        relatedHeading: "Related",
        camerasLink: "Supported cameras",
        alternativesLink: "Compare with other tools",
        footerPrivacy: "Privacy policy",
        footerTerms: "Terms of use",
        footerHome: "everydashcam.app",
    },
    ru: {
        backToPlayer: "← К плееру",
        breadcrumbHome: "Главная",
        ctaSecondary: "Попробовать",
        relatedHeading: "Ещё по теме",
        camerasLink: "Поддерживаемые камеры",
        alternativesLink: "Сравнение с другими программами",
        footerPrivacy: "Политика конфиденциальности",
        footerTerms: "Условия использования",
        footerHome: "everydashcam.app",
    },
};

// Non-affiliation disclaimer - the brandsBody names third-party cameras
// (BlackVue, Viofo, ...) nominatively. Mirrors ALT_DISCLAIMER in
// alternative-pages.ts (kept inline, all 10 locales, must never silently
// fall back). NOT legal advice; wording is conservative.
const FEATURE_DISCLAIMER: Record<Lang, string> = {
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

// ----- resolution helpers (hand-written en/ru, community fallback, then en) -----

function resolveFeatureContent(page: FeaturePage, lang: Lang): FeatureLocaleContent {
    const direct = page.locales[lang];
    if (direct) return direct;
    const community = COMMUNITY_FEATURE_CONTENT[page.slug]?.[lang];
    if (community) return community;
    // EN is the guaranteed baseline; falling back keeps the dev server from
    // crashing on a missing translation. The build path is gated by
    // assertFeatureLocaleParity, so a real release never ships this fallback.
    const en = page.locales.en;
    if (!en) throw new Error(`feature-pages: page "${page.slug}" missing en content`);
    return en;
}

function resolveLabels(lang: Lang): FeatureSharedLabels {
    return SHARED_LABELS[lang] ?? COMMUNITY_FEATURE_LABELS[lang] ?? (SHARED_LABELS.en as FeatureSharedLabels);
}

// ---- rendering ----

export function renderFeaturePage(page: FeaturePage, lang: Lang, options: SeoBuildOptions): string {
    const seoLocale = getSeoLocaleByLang(lang);
    if (!seoLocale) throw new Error(`feature-pages: lang "${lang}" not in SEO_LOCALES`);

    const content = resolveFeatureContent(page, lang);
    const labels = resolveLabels(lang);
    const pathPrefix = pathPrefixFor(lang);

    const localHome = `${pathPrefix}/`;
    const url = canonicalLocaleUrl(seoLocale, `${page.slug}/`);
    const homeUrl = canonicalLocaleUrl(seoLocale);
    const ctaHref = `${pathPrefix}/`;
    const ogImageUrl = `${canonicalOriginForLocale(seoLocale)}/${seoLocale.ogImage}`;

    // Cross-link to the OTHER feature page, labelled by its localized breadcrumbName.
    const otherPages = FEATURE_PAGES.filter((p) => p.slug !== page.slug).map((p) => ({
        slug: p.slug,
        name: resolveFeatureContent(p, lang).breadcrumbName,
    }));

    const hreflangBlock = renderSeoAlternates(`${page.slug}/`);
    const ogLocaleAlternatesBlock = buildOgLocaleAlternatesHtml(lang);
    const languageLinks = renderSeoLanguageLinks(lang, (locale) => `/${locale.urlSegment}/${page.slug}/`);

    const breadcrumb = renderBreadcrumbs(lang, [
        { name: labels.breadcrumbHome, url: homeUrl },
        { name: content.breadcrumbName, url },
    ]);

    // Mirrors the visible steps; Google no longer offers HowTo rich results.
    const howTo = {
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: content.h1,
        step: content.howSteps.map((text, i) => ({
            "@type": "HowToStep",
            position: i + 1,
            text,
        })),
    };

    const hasFaq = content.faq.length > 0;
    const faqJsonLd = hasFaq
        ? `<script type="application/ld+json">${stringifyJsonLd({
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: content.faq.map((item) => ({
                  "@type": "Question",
                  name: item.q,
                  acceptedAnswer: { "@type": "Answer", text: item.a },
              })),
          })}</script>`
        : "";

    const faqSectionHtml = hasFaq
        ? `<section class="vp-section">
<h2 class="vp-h2">${escapeText(content.faqHeading)}</h2>
${content.faq
    .map(
        (item) => `<details class="vp-faq">
<summary>${escapeText(item.q)}</summary>
<p>${escapeText(item.a)}</p>
</details>`,
    )
    .join("\n")}
</section>`
        : "";

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
<script type="application/ld+json">${stringifyJsonLd(howTo)}</script>
${faqJsonLd}`,
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
<a href="${ctaHref}" class="vp-cta">${escapeText(content.ctaPrimary)}</a>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(content.introHeading)}</h2>
<p>${escapeText(content.introBody)}</p>
<p>${escapeText(content.introBody2)}</p>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(content.optionsHeading)}</h2>
<ul class="vp-feature-list">
${content.options
    .map((opt) => `<li><strong>${escapeText(opt.name)}</strong> — ${escapeText(opt.desc)}</li>`)
    .join("\n")}
</ul>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(content.howHeading)}</h2>
<ol class="vp-steps">
${content.howSteps.map((step) => `<li>${escapeText(step)}</li>`).join("\n")}
</ol>
<a href="${ctaHref}" class="vp-cta vp-cta--secondary">${escapeText(labels.ctaSecondary)}</a>
</section>

<section class="vp-section">
<h2 class="vp-h2">${escapeText(content.brandsHeading)}</h2>
<p>${escapeText(content.brandsBody)}</p>
</section>

<div class="alt-when">
<div class="alt-when-title">${escapeText(content.noteHeading)}</div>
<p>${escapeText(content.noteBody)}</p>
</div>

${faqSectionHtml}
</article>

<aside class="vp-other-vendors">
<h3 class="vp-h3">${escapeText(labels.relatedHeading)}</h3>
<ul>
${otherPages.map((other) => `<li><a href="${pathPrefix}/${other.slug}/">${escapeText(other.name)}</a></li>`).join("\n")}
<li><a href="${pathPrefix}/cameras/">${escapeText(labels.camerasLink)}</a></li>
<li><a href="${pathPrefix}/alternatives/">${escapeText(labels.alternativesLink)}</a></li>
</ul>
</aside>
</main>

${renderMarketingFooter({ seoLocale, localHome, languageLinks, labels, disclaimer: FEATURE_DISCLAIMER[lang] })}
</body>
</html>
`;
}

// ---- parity (build-time gate, mirrors assertAltLocaleParity) ----

// Throws if any indexable locale is missing content/labels for any page, or if
// a translated page's list lengths (options / howSteps / faq) diverge from the
// English source - a divergence would render a structurally different page per
// locale (and break the JSON-LD parity Google expects).
export function assertFeatureLocaleParity(): void {
    const problems: string[] = [];
    for (const loc of getIndexableSeoLocales()) {
        const lang = loc.lang;
        if (!SHARED_LABELS[lang] && !COMMUNITY_FEATURE_LABELS[lang]) {
            problems.push(`labels: missing locale "${lang}"`);
        }
        for (const page of FEATURE_PAGES) {
            const en = page.locales.en;
            if (!en) {
                problems.push(`page "${page.slug}": missing en source`);
                continue;
            }
            const resolved = page.locales[lang] ?? COMMUNITY_FEATURE_CONTENT[page.slug]?.[lang];
            if (!resolved) {
                problems.push(`page "${page.slug}": missing locale "${lang}"`);
                continue;
            }
            if (resolved.options.length !== en.options.length) {
                problems.push(
                    `page "${page.slug}" [${lang}]: options length ${resolved.options.length} != en ${en.options.length}`,
                );
            }
            if (resolved.howSteps.length !== en.howSteps.length) {
                problems.push(
                    `page "${page.slug}" [${lang}]: howSteps length ${resolved.howSteps.length} != en ${en.howSteps.length}`,
                );
            }
            if (resolved.faq.length !== en.faq.length) {
                problems.push(
                    `page "${page.slug}" [${lang}]: faq length ${resolved.faq.length} != en ${en.faq.length}`,
                );
            }
        }
    }
    if (problems.length > 0) {
        throw new Error(`feature-pages locale parity failed:\n  ${problems.join("\n  ")}`);
    }
}

// ---- dev route matching ----

export type FeatureRouteMatch = { lang: Lang; page: FeaturePage };

export function matchFeatureRoute(path: string): FeatureRouteMatch | null {
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return null;

    let lang: Lang = "en";
    let i = 0;
    const maybeLocale = getIndexableSeoLocales().find((l) => l.urlSegment === segments[0]);
    if (maybeLocale) {
        lang = maybeLocale.lang;
        i = 1;
    }

    if (i !== segments.length - 1) return null;
    const slug = segments[i];
    const page = FEATURE_PAGES.find((p) => p.slug === slug);
    if (!page) return null;
    return { lang, page };
}

// ----- sitemap entries (consumed by seo-prerender.ts sitemapPlugin) -----

interface FeatureSitemapEntry {
    loc: string;
    changefreq: string;
    priority: string;
    alternates: Record<string, string>;
    xDefaultUrl: string;
    lastmod?: string;
}

// Sitemap entries for each feature page, per locale. Mirrors
// getAlternativeSitemapEntries: per-page alternates point at that page's own
// locale siblings, x-default at the English variant.
export function getFeatureSitemapEntries(): FeatureSitemapEntry[] {
    const entries: FeatureSitemapEntry[] = [];
    const indexable = getIndexableSeoLocales();
    const defaultLang = getDefaultSeoLocale().lang;
    // Locale and feature content shares monolithic source files. Their mtimes
    // cannot identify which URL changed, so omit lastmod rather than publish
    // a site-wide false freshness signal.

    for (const page of FEATURE_PAGES) {
        const graph = buildSeoAlternates(`${page.slug}/`);
        for (const loc of indexable) {
            entries.push({
                loc: canonicalLocaleUrl(loc, `${page.slug}/`),
                changefreq: "monthly",
                priority: loc.lang === defaultLang ? "0.7" : "0.6",
                ...graph,
            });
        }
    }
    return entries;
}

// Exported for llms-txt.ts: slug + English breadcrumb name, in render order.
export function getFeatureListings(): Array<{ slug: FeatureSlug; name: string }> {
    return FEATURE_PAGES.map((p) => ({
        slug: p.slug,
        name: (p.locales.en as FeatureLocaleContent).breadcrumbName,
    }));
}

// ----- vite plugin -----

export function featurePagesPlugin(options: SeoBuildOptions = {}): Plugin {
    let isBuild = false;
    return {
        name: "everydashcam-feature-pages",
        configResolved(config) {
            isBuild = config.command === "build";
        },
        closeBundle() {
            if (!isBuild) return;
            assertFeatureLocaleParity();
            const distDir = resolve(process.cwd(), "dist");
            for (const seoLocale of getIndexableSeoLocales()) {
                const lang = seoLocale.lang;
                for (const page of FEATURE_PAGES) {
                    const targetDir = resolve(distDir, `${seoLocale.urlSegment}/${page.slug}`);
                    mkdirSync(targetDir, { recursive: true });
                    writeFileSync(resolve(targetDir, "index.html"), renderFeaturePage(page, lang, options));
                }
            }
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const rawUrl = req.url ?? "/";
                const pathOnly = rawUrl.split("?")[0] ?? "/";
                const match = matchFeatureRoute(pathOnly);
                if (!match) {
                    next();
                    return;
                }
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderFeaturePage(match.page, match.lang, options));
            });
        },
    };
}
