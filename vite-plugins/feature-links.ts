// Cross-links from the vendor and alternatives pages to the three use-case
// feature pages. Search engines infer a page's relative importance from the
// number of internal links pointing at it and use anchor text to understand
// the target, so the feature pages - the deepest content on the site - are
// linked from every vendor and alternatives page with a descriptive anchor
// rather than reachable only from the landing page.
//
// Depends only on Lang and html-utils: vendor-pages and alternative-pages
// both import this module (and feature-pages imports vendor-pages), so any
// heavier import here would close a cycle.

import type { Lang } from "../src/i18n/index.js";
import type { FeatureSlug } from "./feature-pages.js";
import { escapeText } from "./html-utils.js";

interface FeatureLinksBlock {
    heading: string;
    // Anchor per feature page, keyed by the page's URL slug.
    links: Record<FeatureSlug, string>;
}

const FEATURE_LINKS: Record<Lang, FeatureLinksBlock> = {
    en: {
        heading: "Do more with your recordings",
        links: {
            "combine-dashcam-cameras-into-one-video": "Combine front and rear cameras into one video",
            "blur-license-plate-in-dashcam-video": "Blur license plates and faces before sharing",
            "add-data-overlay-to-dashcam-video": "Add a speed and GPS overlay to the video",
        },
    },
    ru: {
        heading: "Что ещё можно сделать с записями",
        links: {
            "combine-dashcam-cameras-into-one-video": "Склеить камеры регистратора в одно видео",
            "blur-license-plate-in-dashcam-video": "Замазать номера машин и лица перед отправкой",
            "add-data-overlay-to-dashcam-video": "Наложить скорость и GPS на видео",
        },
    },
    de: {
        heading: "Mehr aus deinen Aufnahmen machen",
        links: {
            "combine-dashcam-cameras-into-one-video": "Front- und Heckkamera in einem Video vereinen",
            "blur-license-plate-in-dashcam-video": "Kennzeichen und Gesichter vor dem Teilen verpixeln",
            "add-data-overlay-to-dashcam-video": "Geschwindigkeit und GPS als Overlay aufs Video legen",
        },
    },
    es: {
        heading: "Haz más con tus grabaciones",
        links: {
            "combine-dashcam-cameras-into-one-video": "Combina las cámaras frontal y trasera en un solo vídeo",
            "blur-license-plate-in-dashcam-video": "Difumina matrículas y caras antes de compartir",
            "add-data-overlay-to-dashcam-video": "Añade velocidad y GPS al vídeo",
        },
    },
    fr: {
        heading: "Fais plus avec tes enregistrements",
        links: {
            "combine-dashcam-cameras-into-one-video": "Réunir les caméras avant et arrière en une seule vidéo",
            "blur-license-plate-in-dashcam-video": "Flouter les plaques et les visages avant de partager",
            "add-data-overlay-to-dashcam-video": "Incruster la vitesse et le GPS sur la vidéo",
        },
    },
    ja: {
        heading: "録画をもっと活用する",
        links: {
            "combine-dashcam-cameras-into-one-video": "前後のカメラを1本の動画にまとめる",
            "blur-license-plate-in-dashcam-video": "共有前にナンバーと顔をぼかす",
            "add-data-overlay-to-dashcam-video": "速度と GPS を動画に重ねて表示する",
        },
    },
    ko: {
        heading: "녹화 영상으로 더 많은 것을 해보세요",
        links: {
            "combine-dashcam-cameras-into-one-video": "전방·후방 카메라를 하나의 영상으로 합치기",
            "blur-license-plate-in-dashcam-video": "공유 전에 번호판과 얼굴 가리기",
            "add-data-overlay-to-dashcam-video": "속도와 GPS를 영상 위에 표시하기",
        },
    },
    pl: {
        heading: "Zrób więcej ze swoimi nagraniami",
        links: {
            "combine-dashcam-cameras-into-one-video": "Połącz kamerę przednią i tylną w jedno wideo",
            "blur-license-plate-in-dashcam-video": "Zamaż tablice rejestracyjne i twarze przed udostępnieniem",
            "add-data-overlay-to-dashcam-video": "Nałóż prędkość i GPS na wideo",
        },
    },
    pt: {
        heading: "Faça mais com suas gravações",
        links: {
            "combine-dashcam-cameras-into-one-video": "Combine as câmeras frontal e traseira em um só vídeo",
            "blur-license-plate-in-dashcam-video": "Desfoque placas e rostos antes de compartilhar",
            "add-data-overlay-to-dashcam-video": "Adicione velocidade e GPS ao vídeo",
        },
    },
    zh: {
        heading: "用录像做更多事",
        links: {
            "combine-dashcam-cameras-into-one-video": "把前后摄像头合并成一个视频",
            "blur-license-plate-in-dashcam-video": "分享前把车牌和人脸打码",
            "add-data-overlay-to-dashcam-video": "把速度和 GPS 叠加到视频上",
        },
    },
};

// Renders the feature-links section for one page. pathPrefix is the locale's
// URL prefix ("/en", "/de", ...) as produced by pathPrefixFor().
export function renderFeatureLinksHtml(lang: Lang, pathPrefix: string, selected?: readonly FeatureSlug[]): string {
    const block = FEATURE_LINKS[lang];
    const items = (Object.entries(block.links) as [FeatureSlug, string][])
        .filter(([slug]) => !selected || selected.includes(slug))
        .map(([slug, label]) => `<li><a href="${pathPrefix}/${slug}/">${escapeText(label)}</a></li>`)
        .join("\n");
    return `<section class="vp-section">
<h2 class="vp-h2">${escapeText(block.heading)}</h2>
<ul class="vp-feature-links">
${items}
</ul>
</section>`;
}
