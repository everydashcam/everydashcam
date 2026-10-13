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
// Model claims and instructions follow the recording evidence in the project.
// Public copy stays focused on the visitor's job:
// open a folder, review the trip and export a clip. Parser evidence and fixture
// status belong in docs/gps-format-coverage.md, not on this SEO surface.
//
// JSON-LD per page: BreadcrumbList (Home > Cameras > <Vendor>). Model lists
// stay within the checked recording scope; an empty list is valid when no
// precise model has been established. Playback alone does not establish GPS.
//
// Adding a new vendor: promote it in SUPPORTED_BRANDS with an explicit locale
// set, then add reviewed localized copy in the camera content modules.

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
import { canonicalLocaleUrl, canonicalOriginForLocale, searchIndexingMeta } from "./deployment-profile.js";
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
import { establishedCameraPages } from "./vendor-pages-established-content.js";

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
    // Every published language carries reviewed camera-specific copy.
    locales: Record<"en" | "ru", VendorLocaleContent> & Partial<Record<Lang, VendorLocaleContent>>;
    features?: readonly FeatureSlug[];
}

// Published vendor content. The support registry owns catalog order and locales.
const VENDORS: VendorContent[] = [...establishedCameraPages, ...cameraPages];

const LANDING_BRANDS_BY_SLUG = new Map(getLandingBrands().map((brand) => [brand.slug, brand] as const));

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
        ogDescription: "everydashcam 支持的所有行车记录仪品牌。选择你的品牌 — 直接在浏览器中打开录像，无需安装。",
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
        modelsHeading: "Checked {vendor} recordings",
        recordingsHeading: "{vendor} recordings",
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
        modelsHeading: "Проверенные записи {vendor}",
        recordingsHeading: "Записи {vendor}",
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
        modelsHeading: "Geprüfte {vendor}-Aufnahmen",
        recordingsHeading: "{vendor}-Aufnahmen",
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
        notListedText:
            "Deine Dashcam nicht dabei? Schick uns eine Beispielaufnahme — damit können wir neue Formate unterstützen.",
        notListedCta: "Deine Dashcam hinzufügen",
    },
    es: {
        reassurance: "Reproductor gratuito en el navegador. Las grabaciones se quedan en tu dispositivo.",
        backToPlayer: "← Volver al reproductor",
        breadcrumbHome: "Inicio",
        breadcrumbCameras: "Cámaras",
        modelsHeading: "Grabaciones {vendor} comprobadas",
        recordingsHeading: "Grabaciones {vendor}",
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
        notListedText:
            "¿No ves tu cámara? Envíanos una muestra — añadimos compatibilidad a partir de grabaciones reales.",
        notListedCta: "Añade tu cámara de coche",
    },
    fr: {
        reassurance: "Lecteur gratuit dans le navigateur. Les enregistrements restent sur ton appareil.",
        backToPlayer: "← Retour au lecteur",
        breadcrumbHome: "Accueil",
        breadcrumbCameras: "Caméras",
        modelsHeading: "Enregistrements {vendor} vérifiés",
        recordingsHeading: "Enregistrements {vendor}",
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
        notListedText:
            "Tu ne vois pas ta dashcam ? Envoie-nous un exemple — on ajoute la prise en charge à partir de vrais enregistrements.",
        notListedCta: "Ajouter ta dashcam",
    },
    pl: {
        reassurance: "Bezpłatny odtwarzacz w przeglądarce. Nagrania zostają na twoim urządzeniu.",
        backToPlayer: "← Wróć do odtwarzacza",
        breadcrumbHome: "Start",
        breadcrumbCameras: "Kamery",
        modelsHeading: "Sprawdzone nagrania {vendor}",
        recordingsHeading: "Nagrania {vendor}",
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
        notListedText:
            "Nie widzisz swojego wideorejestratora? Wyślij nam próbkę — dodajemy obsługę na podstawie prawdziwych nagrań.",
        notListedCta: "Dodaj swój wideorejestrator",
    },
    pt: {
        reassurance: "Player gratuito no navegador. As gravações ficam no seu dispositivo.",
        backToPlayer: "← Voltar ao player",
        breadcrumbHome: "Início",
        breadcrumbCameras: "Câmeras",
        modelsHeading: "Gravações {vendor} verificadas",
        recordingsHeading: "Gravações {vendor}",
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
        modelsHeading: "已验证的 {vendor} 录像",
        recordingsHeading: "{vendor} 录像",
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
        modelsHeading: "確認済みの {vendor} 録画",
        recordingsHeading: "{vendor} の録画",
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
        notListedText:
            "お使いのカメラが見当たりませんか？録画のサンプルをお送りください — 実際の録画をもとに対応を追加しています。",
        notListedCta: "ドライブレコーダーを追加",
    },
    ko: {
        reassurance: "무료 브라우저 플레이어예요. 녹화는 내 기기에만 보관돼요.",
        backToPlayer: "← 플레이어로 돌아가기",
        breadcrumbHome: "홈",
        breadcrumbCameras: "블랙박스",
        modelsHeading: "확인한 {vendor} 녹화",
        recordingsHeading: "{vendor} 녹화",
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
    recordingsHeading: string;
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

// Missing translations must not silently become brand-swapped generic pages.
function resolveVendorContent(vendor: VendorContent, lang: Lang): VendorLocaleContent {
    const content = vendor.locales[lang];
    if (!content) {
        throw new Error(`vendor-pages: missing reviewed copy for ${vendor.slug}/${lang}`);
    }
    return content;
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
        getHreflangCodes(loc).map((code) => `<link rel="alternate" hreflang="${code}" href="${makeUrl(loc)}">`),
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
    const languageLinks = renderSeoLanguageLinks(
        lang,
        (locale) => `/${locale.urlSegment}/cameras/${vendor.slug}/`,
        vendorLocales,
    );

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
<h2 class="vp-h2">${escapeText((vendor.models.length ? labels.modelsHeading : labels.recordingsHeading).replace("{vendor}", v))}</h2>
${vendor.models.length ? `<ul class="vp-models">${vendor.models.map((m) => `<li>${escapeText(m)}</li>`).join("\n")}</ul>` : ""}
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
                const targetLocale =
                    vendor && isVendorAvailableInLang(vendor, lang) ? seoLocale : getDefaultSeoLocale();
                return {
                    "@type": "ListItem",
                    position: idx + 1,
                    url: vendor
                        ? canonicalLocaleUrl(targetLocale, `cameras/${vendor.slug}/`)
                        : `${url}#${cameraCatalogAnchor(brand)}`,
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
        return renderCameraBrandCard(brand, lang, { english: englishHref });
    }
    return renderCameraBrandCard(brand, lang, { local: `${pathPrefix}/cameras/${vendor.slug}/` });
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
        const lines: string[] = ["vendor-pages: SUPPORTED_BRANDS and VENDORS are out of sync"];
        if (missingVendors.length > 0) {
            lines.push(`  in SUPPORTED_BRANDS but missing in VENDORS: ${missingVendors.join(", ")}`);
        }
        if (extraVendors.length > 0) {
            lines.push(`  in VENDORS but missing in SUPPORTED_BRANDS: ${extraVendors.join(", ")}`);
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
                    body =
                        result.kind === "index"
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
export type VendorRouteMatch = { kind: "index"; lang: Lang } | { kind: "vendor"; lang: Lang; vendor: VendorContent };

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
                getHreflangCodes(loc).map((code) => [code, canonicalLocaleUrl(loc, `cameras/${vendor.slug}/`)]),
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
