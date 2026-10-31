import type { Lang } from "../src/i18n/index.js";
import type { DocumentSlug } from "./document-pages.js";

// Metadata summarizes the existing articles; legal terms stay in their source.
export const DOCUMENT_DESCRIPTIONS: Record<DocumentSlug, Record<Lang, string>> = {
    privacy: {
        en: "everydashcam privacy policy: how recordings are handled, analytics and crash reporting, data retention and your rights under GDPR / CCPA.",
        ru: "Политика конфиденциальности everydashcam: обработка записей, аналитика и отчёты о сбоях, хранение данных и твои права по GDPR / CCPA.",
        de: "Datenschutzerklärung von everydashcam: Umgang mit Aufnahmen, Analysen und Absturzberichten, Datenspeicherung und deine Rechte nach DSGVO / CCPA.",
        es: "Política de privacidad de everydashcam: grabaciones, análisis e informes de fallos, conservación de datos y tus derechos según el RGPD / CCPA.",
        fr: "Politique de confidentialité d’everydashcam : enregistrements, statistiques et rapports de plantage, conservation des données et droits RGPD / CCPA.",
        ja: "everydashcam のプライバシーポリシー：録画の取り扱い、アクセス解析とクラッシュレポート、データの保存、GDPR / CCPA に基づく権利。",
        ko: "everydashcam 개인정보 처리방침: 녹화 파일 처리, 분석 및 오류 보고, 데이터 보관과 GDPR / CCPA에 따른 권리.",
        pl: "Polityka prywatności everydashcam: przetwarzanie nagrań, analityka i raporty awarii, przechowywanie danych oraz prawa wynikające z RODO / CCPA.",
        pt: "Política de privacidade do everydashcam: gravações, análises e relatórios de falhas, retenção de dados e seus direitos segundo o GDPR / CCPA.",
        zh: "everydashcam 隐私政策：录像处理、统计分析与崩溃报告、数据保留，以及你依据 GDPR / CCPA 享有的权利。",
    },
    terms: {
        en: "everydashcam terms of use: a free dashcam viewer in your browser, provided as is. Your recordings stay on your device and remain yours.",
        ru: "Условия использования everydashcam: бесплатный просмотр записей регистратора в браузере без гарантий. Записи остаются на твоём устройстве и принадлежат тебе.",
        de: "Nutzungsbedingungen von everydashcam: kostenlose Dashcam-Wiedergabe im Browser, ohne Gewährleistung. Deine Aufnahmen bleiben auf deinem Gerät und gehören dir.",
        es: "Condiciones de uso de everydashcam: visor gratuito de grabaciones en el navegador, sin garantías. Tus grabaciones se quedan en tu dispositivo y siguen siendo tuyas.",
        fr: "Conditions d’utilisation d’everydashcam : lecteur gratuit dans le navigateur, sans garantie. Tes enregistrements restent sur ton appareil et t’appartiennent.",
        ja: "everydashcam の利用規約：ブラウザで使える無料のドライブレコーダー再生アプリ。現状のまま提供され、録画はあなたのデバイスに残り、あなたのものです。",
        ko: "everydashcam 이용약관: 브라우저에서 무료로 사용하는 블랙박스 뷰어를 보증 없이 제공합니다. 녹화 파일은 기기에 남으며 소유권도 사용자에게 있습니다.",
        pl: "Warunki korzystania z everydashcam: bezpłatny odtwarzacz nagrań w przeglądarce, bez gwarancji. Nagrania zostają na twoim urządzeniu i należą do ciebie.",
        pt: "Termos de uso do everydashcam: visualizador gratuito de gravações no navegador, sem garantia. Suas gravações ficam no seu dispositivo e continuam sendo suas.",
        zh: "everydashcam 使用条款：免费的浏览器行车记录仪播放器，按现状提供，不附带保证。录像保留在你的设备上，所有权仍归你。",
    },
    "add-my-camera": {
        en: "Help me add support for your dashcam: send the file list from your memory card and original recordings, exactly as the camera saved them.",
        ru: "Помоги добавить поддержку твоего регистратора: пришли список файлов с карты памяти и оригинальные записи в том виде, как их сохранила камера.",
        de: "Hilf mir, deine Dashcam zu unterstützen: Sende die Dateiliste deiner Speicherkarte und Originalaufnahmen, genau so, wie die Kamera sie gespeichert hat.",
        es: "Ayúdame a añadir tu cámara: envía la lista de archivos de la tarjeta y grabaciones originales, tal como las guardó la cámara.",
        fr: "Aide-moi à prendre en charge ta caméra : envoie la liste des fichiers de ta carte mémoire et les enregistrements originaux, tels que la caméra les a sauvegardés.",
        ja: "あなたのドライブレコーダーへの対応にご協力ください。メモリーカードのファイル一覧と、カメラが保存したままの元の録画を送ってください。",
        ko: "사용 중인 블랙박스를 지원할 수 있도록 도와주세요. 메모리 카드의 파일 목록과 카메라가 저장한 그대로의 원본 녹화 파일을 보내주세요.",
        pl: "Pomóż mi dodać obsługę twojej kamery: wyślij listę plików z karty pamięci i oryginalne nagrania, dokładnie tak, jak zapisała je kamera.",
        pt: "Ajude a adicionar suporte à sua câmera: envie a lista de arquivos do cartão de memória e gravações originais, exatamente como a câmera as salvou.",
        zh: "帮助我支持你的行车记录仪：请发送存储卡中的文件列表和原始录像，保持摄像头保存时的原样。",
    },
};
