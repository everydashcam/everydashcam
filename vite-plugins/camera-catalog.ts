import type { Lang } from "../src/i18n/index.js";
import { escapeAttr, escapeText } from "./html-utils.js";
import type { RecordingCaveat, SupportedBrand } from "./supported-brands.js";

interface CatalogCopy extends Record<RecordingCaveat, string> {
    gps: string;
    video: string;
    readEnglish: string;
}

const COPY: Record<Lang, CatalogCopy> = {
    en: {
        readEnglish: "Read in English",
        gps: "Video and GPS",
        video: "Video playback",
        optionalGps: "GPS receiver required.",
        exportedRecording: "Video and GPS in exported recordings",
    },
    ru: {
        readEnglish: "Подробнее на английском",
        gps: "Видео и GPS",
        video: "Воспроизведение видео",
        optionalGps: "Нужен GPS-приёмник.",
        exportedRecording: "Видео и GPS в экспортированных записях",
    },
    de: {
        readEnglish: "Mehr auf Englisch",
        gps: "Video und GPS",
        video: "Videowiedergabe",
        optionalGps: "GPS-Empfänger erforderlich.",
        exportedRecording: "Video und GPS in exportierten Aufnahmen",
    },
    es: {
        readEnglish: "Más información en inglés",
        gps: "Vídeo y GPS",
        video: "Reproducción de vídeo",
        optionalGps: "Requiere receptor GPS.",
        exportedRecording: "Vídeo y GPS en grabaciones exportadas",
    },
    fr: {
        readEnglish: "En savoir plus en anglais",
        gps: "Vidéo et GPS",
        video: "Lecture vidéo",
        optionalGps: "Récepteur GPS nécessaire.",
        exportedRecording: "Vidéo et GPS dans les enregistrements exportés",
    },
    pl: {
        readEnglish: "Więcej po angielsku",
        gps: "Wideo i GPS",
        video: "Odtwarzanie wideo",
        optionalGps: "Wymagany odbiornik GPS.",
        exportedRecording: "Wideo i GPS w wyeksportowanych nagraniach",
    },
    pt: {
        readEnglish: "Saiba mais em inglês",
        gps: "Vídeo e GPS",
        video: "Reprodução de vídeo",
        optionalGps: "Requer receptor GPS.",
        exportedRecording: "Vídeo e GPS em gravações exportadas",
    },
    zh: {
        readEnglish: "查看英文详情",
        gps: "视频和 GPS",
        video: "视频播放",
        optionalGps: "需要 GPS 接收器。",
        exportedRecording: "视频及导出录像中的 GPS",
    },
    ja: {
        readEnglish: "英語で詳しく見る",
        gps: "動画と GPS",
        video: "動画再生",
        optionalGps: "GPS 受信機が必要です。",
        exportedRecording: "動画と書き出した録画の GPS",
    },
    ko: {
        readEnglish: "영어로 자세히 보기",
        gps: "영상 및 GPS",
        video: "영상 재생",
        optionalGps: "GPS 수신기가 필요해요.",
        exportedRecording: "영상 및 내보낸 녹화의 GPS",
    },
};

export function cameraCatalogAnchor(brand: SupportedBrand): string {
    return `camera-${brand.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function renderCameraBrandCard(
    brand: SupportedBrand,
    lang: Lang,
    models?: readonly string[],
    englishHref?: string,
): string {
    const copy = COPY[lang];
    const samples = brand.gpsSamples ?? brand.videoSamples ?? models;
    const status =
        brand.recordingCaveat === "exportedRecording"
            ? copy.exportedRecording
            : brand.gpsSamples
              ? copy.gps
              : copy.video;
    return `<li id="${escapeAttr(cameraCatalogAnchor(brand))}"><div class="vp-vendor-card">
<span class="vp-vendor-card-name">${escapeText(brand.displayName)}</span>
${samples?.length ? `<span class="vp-vendor-card-hint">${escapeText(samples.join(" · "))}</span>` : ""}
<span class="vp-vendor-card-hint">${escapeText(status)}</span>
${brand.recordingCaveat === "optionalGps" ? `<span class="vp-vendor-card-hint">${escapeText(copy.optionalGps)}</span>` : ""}
${englishHref ? `<a class="vp-catalog-english" href="${escapeAttr(englishHref)}" hreflang="en">${escapeText(copy.readEnglish)} →</a>` : ""}
</div></li>`;
}
