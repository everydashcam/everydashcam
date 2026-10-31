// Machine-translated content for the 8 community locales of the use-case
// feature pages (de, es, fr, ja, ko, pl, pt, zh). English and Russian
// are hand-written inline in feature-pages.ts; this file holds the rest, split
// out to keep that file readable (same pattern as alternative-pages-content.ts).
// Parity with the en/ru source is enforced at build time by
// assertFeatureLocaleParity (every locale present, list lengths match en).
//
// LLM translations are final for community locales (project policy: no
// native-review gate). To re-translate, regenerate and replace the blocks below.

import type { Lang } from "../src/i18n/index.js";
import type { FeatureLocaleContent, FeatureSharedLabels, FeatureSlug } from "./feature-pages.js";

export const COMMUNITY_FEATURE_LABELS: Partial<Record<Lang, FeatureSharedLabels>> = {
    "de": {
        "backToPlayer": "← Zurück zum Player",
        "breadcrumbHome": "Start",
        "ctaSecondary": "Jetzt ausprobieren",
        "relatedHeading": "Passt dazu",
        "camerasLink": "Unterstützte Kameras",
        "alternativesLink": "Mit anderen Tools vergleichen",
        "footerPrivacy": "Datenschutz",
        "footerTerms": "Nutzungsbedingungen",
        "footerHome": "everydashcam.app"
    },
    "es": {
        "backToPlayer": "← Volver al reproductor",
        "breadcrumbHome": "Inicio",
        "ctaSecondary": "Pruébalo ahora",
        "relatedHeading": "Relacionado",
        "camerasLink": "Cámaras compatibles",
        "alternativesLink": "Compara con otras herramientas",
        "footerPrivacy": "Política de privacidad",
        "footerTerms": "Términos de uso",
        "footerHome": "everydashcam.app"
    },
    "fr": {
        "backToPlayer": "← Retour au lecteur",
        "breadcrumbHome": "Accueil",
        "ctaSecondary": "Essayer maintenant",
        "relatedHeading": "À voir aussi",
        "camerasLink": "Caméras compatibles",
        "alternativesLink": "Comparer avec d'autres outils",
        "footerPrivacy": "Politique de confidentialité",
        "footerTerms": "Conditions d'utilisation",
        "footerHome": "everydashcam.app"
    },
    "ja": {
        "backToPlayer": "← プレーヤーに戻る",
        "breadcrumbHome": "ホーム",
        "ctaSecondary": "今すぐ試す",
        "relatedHeading": "関連ページ",
        "camerasLink": "対応カメラ",
        "alternativesLink": "他のツールと比べる",
        "footerPrivacy": "プライバシーポリシー",
        "footerTerms": "利用規約",
        "footerHome": "everydashcam.app"
    },
    "ko": {
        "backToPlayer": "← 플레이어로 돌아가기",
        "breadcrumbHome": "홈",
        "ctaSecondary": "지금 써보기",
        "relatedHeading": "관련 페이지",
        "camerasLink": "지원 카메라",
        "alternativesLink": "다른 도구와 비교하기",
        "footerPrivacy": "개인정보 처리방침",
        "footerTerms": "이용약관",
        "footerHome": "everydashcam.app"
    },
    "pl": {
        "backToPlayer": "← Wróć do odtwarzacza",
        "breadcrumbHome": "Start",
        "ctaSecondary": "Wypróbuj teraz",
        "relatedHeading": "Powiązane",
        "camerasLink": "Obsługiwane kamery",
        "alternativesLink": "Porównaj z innymi narzędziami",
        "footerPrivacy": "Polityka prywatności",
        "footerTerms": "Warunki korzystania",
        "footerHome": "everydashcam.app"
    },
    "pt": {
        "backToPlayer": "← Voltar ao player",
        "breadcrumbHome": "Início",
        "ctaSecondary": "Testar agora",
        "relatedHeading": "Relacionados",
        "camerasLink": "Câmeras compatíveis",
        "alternativesLink": "Comparar com outras ferramentas",
        "footerPrivacy": "Política de privacidade",
        "footerTerms": "Termos de uso",
        "footerHome": "everydashcam.app"
    },
    "zh": {
        "backToPlayer": "← 返回播放器",
        "breadcrumbHome": "首页",
        "ctaSecondary": "立即试试",
        "relatedHeading": "相关内容",
        "camerasLink": "支持的行车记录仪",
        "alternativesLink": "和其他工具对比",
        "footerPrivacy": "隐私政策",
        "footerTerms": "使用条款",
        "footerHome": "everydashcam.app"
    }
};

export const COMMUNITY_FEATURE_CONTENT: Record<FeatureSlug, Partial<Record<Lang, FeatureLocaleContent>>> = {
    "combine-dashcam-cameras-into-one-video": {
        "de": {
            "title": "Dashcam-Kameras in einem Video vereinen — kostenlos, im Browser | everydashcam",
            "metaDescription": "Front-, Heck- und Innenkamera deiner Dashcam in einem Video vereinen — nebeneinander, im Raster oder Bild-in-Bild. Kostenlos, im Browser, nichts wird hochgeladen. Für 70mai, BlackVue, Viofo und mehr.",
            "ogTitle": "Dashcam-Kameras in einem Video vereinen — kostenlos",
            "ogDescription": "Front, Heck und Innenraum in einem Video — nebeneinander, im Raster oder Bild-in-Bild. Kostenlos, im Browser, nichts wird hochgeladen.",
            "h1": "Vereine deine Dashcam-Kameras in einem Video",
            "lead": "Die meisten Dashcams speichern jede Kamera als eigene Datei — Front in der einen, Heck in der nächsten, den Innenraum in einer dritten. everydashcam legt sie in ein einziges Video: nebeneinander, im Raster oder eine groß und der Rest als Bild-in-Bild. Es läuft in deinem Browser, also wird nichts hochgeladen, und es liest 70mai, BlackVue, Viofo, Garmin, Vantrue und Dutzende mehr — nicht nur eine Marke.",
            "breadcrumbName": "Kameras in einem Video vereinen",
            "introHeading": "Eine Datei statt drei",
            "introBody": "Einen Front-Clip und einen Heck-Clip für dieselbe Minute anzusehen heißt, mit Fenstern zu jonglieren. In einem Video vereint, werden sie zu einer einzigen Datei, die du teilen, als Beweismittel einreichen oder behalten kannst — jede Kamera im selben Bild, synchron.",
            "introBody2": "everydashcam macht das, ohne deine Aufnahmen hochzuladen. Deine Aufnahmen werden lokal im Browser-Tab gelesen und vereint, und das fertige Video landet direkt auf deinem Computer.",
            "optionsHeading": "Layouts",
            "options": [
                {
                    "name": "Nebeneinander",
                    "desc": "Zwei Kameras nebeneinander — ein Splitscreen mit Front und Heck in gleicher Größe."
                },
                {
                    "name": "Übereinander",
                    "desc": "Zwei Kameras übereinander, für hohe Bildschirme oder Hochformat-Clips."
                },
                {
                    "name": "Raster",
                    "desc": "Bis zu vier Kameras im 2×2-Raster — Front, Heck, Innenraum und eine Seitenkamera zusammen."
                },
                {
                    "name": "Bild-in-Bild",
                    "desc": "Eine Kamera füllt das Bild; die anderen sitzen in kleinen abgerundeten Einsätzen, die du verschieben und in der Größe ändern kannst."
                },
                {
                    "name": "Asymmetrische Aufteilung",
                    "desc": "Eine Kamera auf der einen Hälfte, zwei übereinander auf der anderen — eine Hauptansicht plus zwei Extras."
                }
            ],
            "howHeading": "So vereinst du deine Kameras",
            "howSteps": [
                "Steck die SD-Karte in deinen Computer und zieh den ganzen Ordner auf everydashcam.app.",
                "Öffne die Fahrt — Front, Heck und Innenraum reihen sich automatisch auf einer Zeitleiste ein.",
                "Öffne den Export, wähl ein Layout (nebeneinander, Raster oder Bild-in-Bild) und den Bereich, den du speichern willst.",
                "Speichern — das vereinte Video wird direkt auf deinen Computer geschrieben, mit dem GPS-Track darin."
            ],
            "brandsHeading": "Front und Heck in einer Datei — auch wenn die Kamera-App das nicht kann",
            "brandsBody": "Hersteller-Apps hören hier meist auf: Sie spielen Front und Heck zusammen ab, exportieren aber jede Kamera als eigene Datei, nicht als einen vereinten Clip. everydashcam ist ein kostenloser Dashcam-Player, der BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin und mehr liest — und das vereinte Video schreibt, das ihre Apps auslassen. Dieselbe Fahrt, jede Kamera, eine Datei.",
            "noteHeading": "Gut zu wissen",
            "noteBody": "Beim Vereinen wird das Video neu kodiert, das geht also nicht im Nu — ein langer Bereich braucht etwas Zeit. Für den flüssigsten Export nimm Chrome, Edge oder einen anderen Chromium-Browser am Computer. Das fügt Kameras in ein Bild zusammen; die kurzen Clips einer Fahrt hintereinander zu einer durchgehenden Datei zu verbinden, passiert automatisch, sobald du einen Bereich wählst.",
            "faqHeading": "Häufige Fragen",
            "faq": [
                {
                    "q": "Kann ich Front- und Heckvideo der Dashcam in einer Datei vereinen?",
                    "a": "Ja. Öffne die Fahrt, wähl ein Layout nebeneinander, übereinander oder als Bild-in-Bild, leg den Bereich fest und speichere. Front- und Heckkamera werden in ein Video geschrieben, synchron, mit dem GPS-Track in der Datei."
                },
                {
                    "q": "Geht das mit drei Kameras (Front, Heck und Innenraum)?",
                    "a": "Ja. Nimm das 2×2-Raster oder ein Bild-in-Bild-Layout, um drei oder vier Kameras in einem Video unterzubringen. Front, Heck, Innenraum und eine Seitenkamera können sich alle das Bild teilen."
                },
                {
                    "q": "Wird mein Video irgendwohin hochgeladen?",
                    "a": "Nein. Deine Aufnahmen werden lokal in deinem Browser gelesen und vereint, und die fertige Datei landet direkt auf deinem Computer."
                },
                {
                    "q": "Welche Dashcams werden unterstützt?",
                    "a": "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro und viele mehr — alles, was normale .mp4-, .mov- oder .ts-Dateien schreibt. Wird deine Kamera noch nicht gelesen, schick ein Beispiel an feedback@everydashcam.app und ich baue sie ein."
                },
                {
                    "q": "Ist es kostenlos?",
                    "a": "Ja — kostenlos, ohne Anmeldung, nichts zu installieren. Seite öffnen, Ordner draufziehen, vereinen und speichern."
                }
            ],
            "ctaPrimary": "Aufnahmen öffnen"
        },
        "es": {
            "title": "Une las cámaras de tu dashcam en un solo vídeo — gratis, en tu navegador | everydashcam",
            "metaDescription": "Une las cámaras frontal, trasera y de cabina de tu dashcam en un solo vídeo — lado a lado, en cuadrícula o imagen en imagen. Gratis, en tu navegador, sin subir nada. 70mai, BlackVue, Viofo y más.",
            "ogTitle": "Une las cámaras de tu dashcam en un solo vídeo — gratis",
            "ogDescription": "Coloca la frontal, la trasera y la de cabina en un solo vídeo — lado a lado, en cuadrícula o imagen en imagen. Gratis, en tu navegador, sin subir nada.",
            "h1": "Une las cámaras de tu dashcam en un solo vídeo",
            "lead": "La mayoría de las dashcams guardan cada cámara en su propio archivo — la frontal en uno, la trasera en otro, la de cabina en un tercero. everydashcam las coloca en un único vídeo: lado a lado, en cuadrícula o una grande con el resto en imagen en imagen. Funciona en tu navegador, así que no se sube nada, y lee 70mai, BlackVue, Viofo, Garmin, Vantrue y muchísimas más — no una sola marca.",
            "breadcrumbName": "Unir cámaras en un solo vídeo",
            "introHeading": "Un archivo en vez de tres",
            "introBody": "Ver un clip de la frontal y otro de la trasera del mismo minuto significa hacer malabares con las ventanas. Unidos en un solo vídeo, se convierten en un único archivo que puedes compartir, presentar como prueba o guardar — con todas las cámaras en el mismo cuadro y sincronizadas.",
            "introBody2": "everydashcam hace esto sin subir tus grabaciones. Tus grabaciones se leen y se unen en local, en la pestaña del navegador, y el vídeo final se guarda directamente en tu ordenador.",
            "optionsHeading": "Disposiciones",
            "options": [
                {
                    "name": "Lado a lado",
                    "desc": "Dos cámaras una junto a la otra — una pantalla dividida con la frontal y la trasera del mismo tamaño."
                },
                {
                    "name": "Apiladas",
                    "desc": "Dos cámaras una encima de la otra, para pantallas verticales o clips en vertical."
                },
                {
                    "name": "Cuadrícula",
                    "desc": "Hasta cuatro cámaras en una cuadrícula 2×2 — frontal, trasera, cabina y una cámara lateral juntas."
                },
                {
                    "name": "Imagen en imagen",
                    "desc": "Una cámara llena el cuadro; las demás van en pequeños recuadros redondeados que puedes mover y redimensionar."
                },
                {
                    "name": "División asimétrica",
                    "desc": "Una cámara en una mitad y dos apiladas en la otra — una vista principal más dos extras."
                }
            ],
            "howHeading": "Cómo unir tus cámaras",
            "howSteps": [
                "Conecta la tarjeta SD a tu ordenador y arrastra toda la carpeta a everydashcam.app.",
                "Abre el viaje — la frontal, la trasera y la de cabina se alinean solas en una misma línea de tiempo.",
                "Abre la exportación, elige una disposición (lado a lado, cuadrícula o imagen en imagen) y selecciona el tramo que quieras guardar.",
                "Guarda — el vídeo combinado se escribe directamente en tu ordenador, con la traza GPS dentro."
            ],
            "brandsHeading": "Frontal y trasera en un archivo — incluso cuando la app de la cámara no puede",
            "brandsBody": "Las apps de los fabricantes suelen quedarse cortas aquí: reproducen la frontal y la trasera juntas, pero exportan cada cámara en su propio archivo, no un único clip combinado. everydashcam es un reproductor de dashcam gratuito que lee BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin y más — y escribe el vídeo combinado que sus apps dejan fuera. El mismo viaje, todas las cámaras, un solo archivo.",
            "noteHeading": "Conviene saberlo",
            "noteBody": "Unir las cámaras recodifica el vídeo, así que no es instantáneo — un tramo largo lleva su tiempo. Para la exportación más fluida, usa Chrome, Edge u otro navegador Chromium en un ordenador. Esto junta las cámaras en un mismo cuadro; encadenar los clips cortos de un viaje uno tras otro en un archivo continuo se hace solo cuando eliges un tramo.",
            "faqHeading": "Preguntas frecuentes",
            "faq": [
                {
                    "q": "¿Puedo unir el vídeo de la cámara frontal y la trasera en un solo archivo?",
                    "a": "Sí. Abre el viaje, elige una disposición lado a lado, apilada o imagen en imagen, selecciona el tramo y guarda. La frontal y la trasera se escriben en un solo vídeo, sincronizadas, con la traza GPS dentro del archivo."
                },
                {
                    "q": "¿Funciona con tres cámaras (frontal, trasera y cabina)?",
                    "a": "Sí. Usa la cuadrícula 2×2 o una disposición de imagen en imagen para poner tres o cuatro cámaras en un solo vídeo. La frontal, la trasera, la de cabina y una lateral pueden compartir el cuadro."
                },
                {
                    "q": "¿Se sube mi vídeo a algún sitio?",
                    "a": "No. Tus grabaciones se leen y se unen en local en tu navegador, y el archivo final se guarda directamente en tu ordenador."
                },
                {
                    "q": "¿Qué dashcams admite?",
                    "a": "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro y muchas más — cualquiera que escriba archivos .mp4, .mov o .ts estándar. Si tu cámara aún no se lee, envía una muestra a feedback@everydashcam.app y la añadiré."
                },
                {
                    "q": "¿Es gratis?",
                    "a": "Sí — gratis, sin registro, sin nada que instalar. Abre la página, suelta tu carpeta, une y guarda."
                }
            ],
            "ctaPrimary": "Abre tus grabaciones"
        },
        "fr": {
            "title": "Réunir les caméras de ta dashcam en une seule vidéo — gratuit, dans ton navigateur | everydashcam",
            "metaDescription": "Réunis les caméras avant, arrière et habitacle en une seule vidéo — côte à côte, en grille ou en incrustation. Gratuit, dans ton navigateur, rien n'est envoyé. Compatible 70mai, BlackVue, Viofo et bien d'autres.",
            "ogTitle": "Réunir les caméras de ta dashcam en une seule vidéo — gratuit",
            "ogDescription": "Réunis l'avant, l'arrière et l'habitacle en une seule vidéo — côte à côte, en grille ou en incrustation. Gratuit, dans ton navigateur, rien n'est envoyé.",
            "h1": "Réunis les caméras de ta dashcam en une seule vidéo",
            "lead": "La plupart des dashcams enregistrent chaque caméra dans son propre fichier — l'avant d'un côté, l'arrière de l'autre, l'habitacle dans un troisième. everydashcam les pose dans une seule vidéo : côte à côte, en grille, ou une grande avec les autres en incrustation. Tout se passe dans ton navigateur, donc rien n'est envoyé, et l'outil lit 70mai, BlackVue, Viofo, Garmin, Vantrue et des dizaines d'autres — pas une seule marque.",
            "breadcrumbName": "Réunir les caméras en une seule vidéo",
            "introHeading": "Un seul fichier au lieu de trois",
            "introBody": "Regarder un clip avant et un clip arrière pour la même minute, c'est jongler entre les fenêtres. Réunis en une seule vidéo, ils deviennent un fichier unique à partager, à fournir comme preuve ou à garder — chaque caméra dans la même image, synchronisée.",
            "introBody2": "everydashcam fait ça sans envoyer tes enregistrements à un serveur. Tes enregistrements sont lus et réunis en local, dans l'onglet du navigateur, et la vidéo finale est enregistrée directement sur ton ordinateur.",
            "optionsHeading": "Dispositions",
            "options": [
                {
                    "name": "Côte à côte",
                    "desc": "Deux caméras l'une à côté de l'autre — un écran partagé avec l'avant et l'arrière à taille égale."
                },
                {
                    "name": "Empilées",
                    "desc": "Deux caméras l'une au-dessus de l'autre, pour les écrans hauts ou les clips en portrait."
                },
                {
                    "name": "Grille",
                    "desc": "Jusqu'à quatre caméras en grille 2×2 — avant, arrière, habitacle et une caméra latérale réunis."
                },
                {
                    "name": "Incrustation",
                    "desc": "Une caméra remplit l'image ; les autres se logent dans de petits encarts arrondis que tu peux déplacer et redimensionner."
                },
                {
                    "name": "Partage asymétrique",
                    "desc": "Une caméra sur une moitié, deux empilées sur l'autre — une vue principale plus deux secondaires."
                }
            ],
            "howHeading": "Comment réunir tes caméras",
            "howSteps": [
                "Branche la carte SD sur ton ordinateur et dépose tout le dossier sur everydashcam.app.",
                "Ouvre le trajet — l'avant, l'arrière et l'habitacle s'alignent automatiquement sur une seule timeline.",
                "Ouvre l'export, choisis une disposition (côte à côte, grille ou incrustation) et sélectionne la plage à enregistrer.",
                "Enregistre — la vidéo combinée est écrite directement sur ton ordinateur, avec le tracé GPS à l'intérieur."
            ],
            "brandsHeading": "L'avant et l'arrière dans un seul fichier — même quand l'appli de la caméra refuse",
            "brandsBody": "Les applis des fabricants s'arrêtent souvent en chemin : elles jouent l'avant et l'arrière ensemble, mais exportent chaque caméra dans son propre fichier, pas un seul clip combiné. everydashcam est un lecteur de dashcam gratuit qui lit BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin et bien d'autres — et écrit la vidéo combinée que leurs applis laissent de côté. Même trajet, toutes les caméras, un seul fichier.",
            "noteHeading": "Bon à savoir",
            "noteBody": "Réunir les caméras réencode la vidéo, donc ce n'est pas instantané — une longue plage prend un peu de temps. Pour l'export le plus fluide, utilise Chrome, Edge ou un autre navigateur Chromium sur un ordinateur. Ici, on assemble les caméras dans une seule image ; bout à bout, les courts clips d'un trajet se mettent à la suite automatiquement en un fichier continu dès que tu choisis une plage.",
            "faqHeading": "FAQ",
            "faq": [
                {
                    "q": "Puis-je réunir les vidéos avant et arrière de ma dashcam en un seul fichier ?",
                    "a": "Oui. Ouvre le trajet, choisis une disposition côte à côte, empilée ou en incrustation, sélectionne la plage et enregistre. Les caméras avant et arrière sont écrites dans une seule vidéo, synchronisées, avec le tracé GPS dans le fichier."
                },
                {
                    "q": "Ça marche avec trois caméras (avant, arrière et habitacle) ?",
                    "a": "Oui. Utilise la grille 2×2 ou une disposition en incrustation pour mettre trois ou quatre caméras dans une seule vidéo. L'avant, l'arrière, l'habitacle et une caméra latérale peuvent tous partager l'image."
                },
                {
                    "q": "Ma vidéo est-elle envoyée quelque part ?",
                    "a": "Non. Tes enregistrements sont lus et réunis en local dans ton navigateur, et le fichier final est enregistré directement sur ton ordinateur."
                },
                {
                    "q": "Quelles dashcams sont compatibles ?",
                    "a": "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro et bien d'autres — tout ce qui écrit des fichiers .mp4, .mov ou .ts standard. Si ta caméra n'est pas encore lue, envoie un échantillon à feedback@everydashcam.app et je l'ajouterai."
                },
                {
                    "q": "Est-ce gratuit ?",
                    "a": "Oui — gratuit, sans inscription, rien à installer. Ouvre la page, dépose ton dossier, réunis et enregistre."
                }
            ],
            "ctaPrimary": "Ouvrir tes enregistrements"
        },
        "ja": {
            "title": "ドラレコの映像を1本の動画にまとめる — 無料、ブラウザだけで | everydashcam",
            "metaDescription": "前方・後方・車内カメラの映像を1本の動画にまとめます。左右並べ、グリッド、ピクチャーインピクチャー。無料、ブラウザだけで、どこにもアップロードしません。70mai、BlackVue、Viofoなど多数のカメラに対応。",
            "ogTitle": "ドラレコの映像を1本の動画にまとめる — 無料",
            "ogDescription": "前方・後方・車内の映像を1本の動画に。左右並べ、グリッド、ピクチャーインピクチャー。無料、ブラウザだけで、どこにもアップロードしません。",
            "h1": "ドラレコの複数カメラを1本の動画にまとめる",
            "lead": "多くのドラレコは、カメラごとに別々のファイルで保存します。前方は前方、後方は後方、車内はまた別、という具合です。everydashcamなら、それを1本の動画にまとめられます。左右に並べる、グリッドにする、1つを大きく表示して残りをピクチャーインピクチャーにする、と自由自在。ブラウザの中で動くのでどこにもアップロードされず、しかも70mai、BlackVue、Viofo、Garmin、Vantrueをはじめ数十種類のカメラを読み込めます。1ブランド専用ではありません。",
            "breadcrumbName": "カメラ映像を1本の動画にまとめる",
            "introHeading": "3本ではなく1本のファイルに",
            "introBody": "同じ時間帯の前方クリップと後方クリップを見るには、ウィンドウをいくつも切り替えなければなりません。1本の動画にまとめれば、共有したり、証拠として提出したり、そのまま保存したりできる1つのファイルになります。すべてのカメラが同じフレームの中で、ぴったり同期して収まります。",
            "introBody2": "everydashcamは録画をアップロードせずにこの処理を行います。映像はブラウザのタブ内でローカルに読み込まれてまとめられ、できあがった動画はそのままお使いのパソコンに保存されます。",
            "optionsHeading": "レイアウト",
            "options": [
                {
                    "name": "左右に並べる",
                    "desc": "2つのカメラを横並びに。前方と後方を同じ大きさで並べる分割画面です。"
                },
                {
                    "name": "上下に並べる",
                    "desc": "2つのカメラを上下に。縦長の画面や縦向きのクリップに向いています。"
                },
                {
                    "name": "グリッド",
                    "desc": "最大4つのカメラを2×2のグリッドに。前方・後方・車内・側方を一度にまとめて表示します。"
                },
                {
                    "name": "ピクチャーインピクチャー",
                    "desc": "1つのカメラをフレーム全体に表示し、残りは角丸の小窓に。位置やサイズは自由に動かせます。"
                },
                {
                    "name": "左右非対称の分割",
                    "desc": "片側に1つのカメラ、もう片側に2つを上下に。メイン映像にサブ2本を添える形です。"
                }
            ],
            "howHeading": "カメラ映像をまとめる手順",
            "howSteps": [
                "SDカードをパソコンに挿し、フォルダごとeverydashcam.appにドロップします。",
                "ドライブを開くと、前方・後方・車内が自動で1つのタイムラインに揃います。",
                "書き出しを開き、レイアウト（左右並べ、グリッド、ピクチャーインピクチャー）を選んで、保存する範囲を決めます。",
                "保存すると、まとめた動画がGPS情報入りで、そのままパソコンに書き出されます。"
            ],
            "brandsHeading": "純正アプリではできない、前方と後方を1本に",
            "brandsBody": "メーカーのアプリは、たいていここで止まってしまいます。前方と後方を一緒に再生はできても、書き出すとカメラごとに別ファイルになり、まとめた1本のクリップにはなりません。everydashcamは無料のドラレコプレーヤーで、BlackVue、Viofo、70mai、Vantrue、Thinkware、Garminなどを読み込み、純正アプリが作らないまとめ動画を書き出します。同じドライブ、すべてのカメラ、1本のファイルに。",
            "noteHeading": "知っておきたいこと",
            "noteBody": "まとめる処理では動画を再エンコードするので、すぐには終わりません。長い範囲には少し時間がかかります。いちばんスムーズに書き出すなら、パソコンでChrome、Edge、その他のChromium系ブラウザをお使いください。これは複数のカメラを1つのフレームに合成する機能です。ドライブの短いクリップを順につないで1本の連続したファイルにする処理は、範囲を選んだときに自動で行われます。",
            "faqHeading": "よくある質問",
            "faq": [
                {
                    "q": "前方と後方のドラレコ映像を1本のファイルにまとめられますか？",
                    "a": "はい。ドライブを開き、左右並べ・上下並べ・ピクチャーインピクチャーのいずれかのレイアウトを選び、範囲を決めて保存します。前方と後方のカメラが、同期した状態で、GPS情報をファイル内に含んだ1本の動画として書き出されます。"
                },
                {
                    "q": "3つのカメラ（前方・後方・車内）でも使えますか？",
                    "a": "はい。2×2のグリッドかピクチャーインピクチャーのレイアウトを使えば、3つや4つのカメラを1本の動画に収められます。前方・後方・車内・側方のカメラを、すべて同じフレームに並べられます。"
                },
                {
                    "q": "映像はどこかにアップロードされますか？",
                    "a": "いいえ。映像はブラウザの中でローカルに読み込まれてまとめられ、できあがったファイルはそのままパソコンに保存されます。"
                },
                {
                    "q": "どのドラレコに対応していますか？",
                    "a": "70mai、BlackVue、Viofo、Garmin、Vantrue、Thinkware、GoProなど多数に対応しています。標準的な.mp4、.mov、.tsファイルで保存するカメラなら使えます。お使いのカメラがまだ読み込めない場合は、サンプルをfeedback@everydashcam.appまでお送りください。対応を追加します。"
                },
                {
                    "q": "無料ですか？",
                    "a": "はい。無料で、登録もインストールも不要です。ページを開いてフォルダをドロップし、まとめて保存するだけです。"
                }
            ],
            "ctaPrimary": "映像を開く"
        },
        "ko": {
            "title": "블랙박스 여러 카메라를 영상 하나로 합치기 — 브라우저에서 무료로 | everydashcam",
            "metaDescription": "전방, 후방, 실내 블랙박스 카메라를 영상 하나로 — 나란히, 격자, 화면 속 화면. 브라우저에서 무료, 업로드 없음. 70mai, BlackVue, Viofo 등 지원.",
            "ogTitle": "블랙박스 카메라를 영상 하나로 — 무료",
            "ogDescription": "전방, 후방, 실내를 영상 하나에 — 나란히, 격자, 화면 속 화면. 브라우저에서 무료, 업로드 없음.",
            "h1": "블랙박스 카메라를 영상 하나로 합쳐요",
            "lead": "대부분의 블랙박스는 카메라마다 파일을 따로 저장해요 — 전방은 이 파일에, 후방은 저 파일에, 실내는 또 다른 파일에. everydashcam는 이걸 영상 하나로 담아줘요: 나란히, 격자로, 또는 하나를 크게 두고 나머지를 화면 속 화면으로요. 브라우저에서 돌아가니까 아무것도 업로드되지 않고, 70mai, BlackVue, Viofo, Garmin, Vantrue를 비롯한 수십 종을 읽어요 — 한 브랜드만 되는 게 아니에요.",
            "breadcrumbName": "카메라를 영상 하나로 합치기",
            "introHeading": "세 개 대신 파일 하나",
            "introBody": "같은 시간대의 전방 클립과 후방 클립을 같이 보려면 창을 이리저리 옮겨야 하죠. 영상 하나로 합치면 공유하거나, 증거로 제출하거나, 보관하기 좋은 파일 하나가 돼요 — 모든 카메라가 같은 화면 안에, 딱 맞춰진 채로요.",
            "introBody2": "everydashcam는 녹화 영상을 업로드하지 않고 이 작업을 해요. 영상은 브라우저 탭 안에서 직접 읽히고 합쳐지며, 완성된 영상은 곧바로 컴퓨터에 저장돼요.",
            "optionsHeading": "배치 방식",
            "options": [
                {
                    "name": "나란히",
                    "desc": "카메라 두 개를 옆으로 나란히 — 전방과 후방을 같은 크기로 놓는 분할 화면이에요."
                },
                {
                    "name": "위아래로",
                    "desc": "카메라 두 개를 위아래로 — 세로 화면이나 세로 클립에 딱 맞아요."
                },
                {
                    "name": "격자",
                    "desc": "최대 네 개를 2×2 격자로 — 전방, 후방, 실내, 측면 카메라를 한 번에요."
                },
                {
                    "name": "화면 속 화면",
                    "desc": "한 카메라가 화면을 채우고, 나머지는 작은 둥근 창으로 들어가요 — 위치와 크기를 바꿀 수 있어요."
                },
                {
                    "name": "비대칭 분할",
                    "desc": "한쪽에 카메라 하나, 다른 쪽에 두 개를 위아래로 — 메인 화면 하나에 보조 두 개요."
                }
            ],
            "howHeading": "카메라 합치는 방법",
            "howSteps": [
                "SD 카드를 컴퓨터에 꽂고 폴더 전체를 everydashcam.app에 끌어다 놓아요.",
                "주행을 열면 전방, 후방, 실내가 하나의 타임라인에 자동으로 맞춰져요.",
                "내보내기를 열고 배치를 골라요 (나란히, 격자, 화면 속 화면), 저장할 구간을 정해요.",
                "저장하면 합쳐진 영상이 GPS 트랙까지 담긴 채로 곧바로 컴퓨터에 저장돼요."
            ],
            "brandsHeading": "전방과 후방을 파일 하나로 — 카메라 앱이 못 해줄 때도요",
            "brandsBody": "제조사 앱은 여기서 멈추는 경우가 많아요. 전방과 후방을 같이 재생은 해도 내보낼 땐 카메라마다 파일이 따로 나오고, 합친 클립 하나로는 안 돼요. everydashcam는 무료 블랙박스 플레이어로, BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin 등을 읽어서 제조사 앱이 빼놓은 합친 영상을 만들어줘요. 같은 주행, 모든 카메라, 파일 하나로요.",
            "noteHeading": "알아두면 좋아요",
            "noteBody": "합치기는 영상을 다시 인코딩하기 때문에 바로 끝나지 않아요 — 긴 구간은 시간이 조금 걸려요. 가장 매끄럽게 내보내려면 컴퓨터에서 Chrome, Edge나 다른 Chromium 브라우저를 쓰세요. 이건 카메라들을 한 화면에 붙이는 거예요. 주행 중 짧은 클립들을 이어 붙여 끊김 없는 파일 하나로 만드는 건 구간을 고르면 알아서 돼요.",
            "faqHeading": "자주 묻는 질문",
            "faq": [
                {
                    "q": "전방과 후방 블랙박스 영상을 파일 하나로 합칠 수 있나요?",
                    "a": "네. 주행을 열고 나란히, 위아래, 또는 화면 속 화면 배치를 고른 뒤 구간을 정하고 저장하면 돼요. 전방과 후방 카메라가 싱크가 맞춰진 채로 영상 하나에 담기고, GPS 트랙도 파일 안에 들어가요."
                },
                {
                    "q": "카메라 세 개(전방, 후방, 실내)도 되나요?",
                    "a": "네. 2×2 격자나 화면 속 화면 배치를 쓰면 카메라 세 개나 네 개를 영상 하나에 담을 수 있어요. 전방, 후방, 실내, 측면 카메라가 모두 같은 화면을 나눠 쓸 수 있어요."
                },
                {
                    "q": "제 영상이 어딘가로 업로드되나요?",
                    "a": "아니요. 영상은 브라우저 안에서 직접 읽히고 합쳐지며, 완성된 파일은 곧바로 컴퓨터에 저장돼요."
                },
                {
                    "q": "어떤 블랙박스를 지원하나요?",
                    "a": "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro를 비롯해 훨씬 많아요 — 표준 .mp4, .mov, .ts 파일을 저장하는 거라면 다 돼요. 아직 안 읽히는 카메라라면 feedback@everydashcam.app으로 샘플을 보내주세요, 추가할게요."
                },
                {
                    "q": "무료인가요?",
                    "a": "네 — 무료에, 가입도 없고, 설치할 것도 없어요. 페이지를 열고, 폴더를 끌어다 놓고, 합쳐서 저장하면 끝이에요."
                }
            ],
            "ctaPrimary": "내 영상 열기"
        },
        "pl": {
            "title": "Połącz kamery wideorejestratora w jedno wideo — za darmo, w przeglądarce | everydashcam",
            "metaDescription": "Połącz kamerę przednią, tylną i kabinową w jedno wideo — obok siebie, w siatce lub jako obraz w obrazie. Za darmo, w przeglądarce, nic nie wysyłasz. Działa z 70mai, BlackVue, Viofo i więcej.",
            "ogTitle": "Połącz kamery wideorejestratora w jedno wideo — za darmo",
            "ogDescription": "Ułóż obraz z przodu, tyłu i kabiny w jednym wideo — obok siebie, w siatce lub jako obraz w obrazie. Za darmo, w przeglądarce, nic nie wysyłasz.",
            "h1": "Połącz kamery wideorejestratora w jedno wideo",
            "lead": "Większość wideorejestratorów zapisuje każdą kamerę w osobnym pliku — przód w jednym, tył w drugim, kabinę w trzecim. everydashcam układa je w jedno wideo: obok siebie, w siatce albo jeden duży obraz, a reszta jako obraz w obrazie. Działa w przeglądarce, więc nic nie jest wysyłane, a odczytuje 70mai, BlackVue, Viofo, Garmin, Vantrue i dziesiątki innych — nie tylko jedną markę.",
            "breadcrumbName": "Połącz kamery w jedno wideo",
            "introHeading": "Jeden plik zamiast trzech",
            "introBody": "Oglądanie nagrania z przodu i z tyłu na tę samą minutę to żonglerka oknami. Połączone w jedno wideo stają się jednym plikiem, który udostępnisz, złożysz jako dowód albo zachowasz — z każdą kamerą w tym samym kadrze, zsynchronizowaną.",
            "introBody2": "everydashcam robi to bez wysyłania twoich nagrań na serwer. Twoje nagrania są odczytywane i łączone lokalnie, w karcie przeglądarki, a gotowe wideo zapisuje się prosto na twój komputer.",
            "optionsHeading": "Układy",
            "options": [
                {
                    "name": "Obok siebie",
                    "desc": "Dwie kamery jedna obok drugiej — podzielony ekran z przodem i tyłem w tym samym rozmiarze."
                },
                {
                    "name": "Jedna nad drugą",
                    "desc": "Dwie kamery ułożone pionowo — do wysokich ekranów lub nagrań w pionie."
                },
                {
                    "name": "Siatka",
                    "desc": "Do czterech kamer w siatce 2×2 — przód, tył, kabina i kamera boczna razem."
                },
                {
                    "name": "Obraz w obrazie",
                    "desc": "Jedna kamera wypełnia kadr; pozostałe siedzą w małych zaokrąglonych okienkach, które przesuniesz i zmienisz im rozmiar."
                },
                {
                    "name": "Podział asymetryczny",
                    "desc": "Jedna kamera na jednej połowie, dwie ułożone pionowo na drugiej — widok główny plus dwa dodatkowe."
                }
            ],
            "howHeading": "Jak połączyć swoje kamery",
            "howSteps": [
                "Włóż kartę SD do komputera i przeciągnij cały folder na everydashcam.app.",
                "Otwórz przejazd — przód, tył i kabina ustawiają się automatycznie na jednej osi czasu.",
                "Otwórz eksport, wybierz układ (obok siebie, w siatce lub jako obraz w obrazie) i zaznacz zakres do zapisania.",
                "Zapisz — połączone wideo trafia prosto na twój komputer, razem z trasą GPS w środku."
            ],
            "brandsHeading": "Przód i tył w jednym pliku — nawet gdy aplikacja kamery tego nie potrafi",
            "brandsBody": "Aplikacje producentów często się tu zatrzymują: odtwarzają przód i tył razem, ale eksportują każdą kamerę do osobnego pliku, a nie jednego połączonego nagrania. everydashcam to darmowy odtwarzacz wideorejestratora, który odczytuje BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin i więcej — i zapisuje połączone wideo, którego ich aplikacje nie potrafią zrobić. Ta sama jazda, wszystkie kamery, jeden plik.",
            "noteHeading": "Warto wiedzieć",
            "noteBody": "Łączenie ponownie koduje wideo, więc nie jest natychmiastowe — dłuższy zakres zajmie chwilę. Dla najpłynniejszego eksportu użyj Chrome, Edge lub innej przeglądarki Chromium na komputerze. To zszywa kamery w jeden kadr; sklejanie krótkich nagrań z przejazdu jedno za drugim w jeden ciągły plik dzieje się automatycznie, gdy zaznaczasz zakres.",
            "faqHeading": "Najczęstsze pytania",
            "faq": [
                {
                    "q": "Czy mogę połączyć wideo z przodu i tyłu w jeden plik?",
                    "a": "Tak. Otwórz przejazd, wybierz układ obok siebie, jedna nad drugą lub obraz w obrazie, zaznacz zakres i zapisz. Kamera przednia i tylna zapisują się w jednym wideo, zsynchronizowane, z trasą GPS w pliku."
                },
                {
                    "q": "Czy działa z trzema kamerami (przód, tył i kabina)?",
                    "a": "Tak. Użyj siatki 2×2 lub układu obraz w obrazie, żeby umieścić trzy lub cztery kamery w jednym wideo. Przód, tył, kabina i kamera boczna mogą dzielić ten sam kadr."
                },
                {
                    "q": "Czy moje wideo jest gdzieś wysyłane?",
                    "a": "Nie. Twoje nagrania są odczytywane i łączone lokalnie w przeglądarce, a gotowy plik zapisuje się prosto na twój komputer."
                },
                {
                    "q": "Które wideorejestratory są obsługiwane?",
                    "a": "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro i wiele innych — wszystko, co zapisuje standardowe pliki .mp4, .mov lub .ts. Jeśli twoja kamera nie jest jeszcze odczytywana, wyślij próbkę na feedback@everydashcam.app, a ją dodam."
                },
                {
                    "q": "Czy to za darmo?",
                    "a": "Tak — za darmo, bez rejestracji, nic nie instalujesz. Otwórz stronę, przeciągnij folder, połącz i zapisz."
                }
            ],
            "ctaPrimary": "Otwórz swoje nagrania"
        },
        "pt": {
            "title": "Junte as câmeras da dashcam em um único vídeo — grátis, no seu navegador | everydashcam",
            "metaDescription": "Junte as câmeras frontal, traseira e interna da dashcam em um vídeo só — lado a lado, em grade ou imagem sobre imagem. Grátis, no navegador, nada vai pra nuvem. Funciona com 70mai, BlackVue, Viofo e mais.",
            "ogTitle": "Junte as câmeras da dashcam em um vídeo só — grátis",
            "ogDescription": "Coloque a frontal, a traseira e a interna num vídeo só — lado a lado, em grade ou imagem sobre imagem. Grátis, no navegador, nada vai pra nuvem.",
            "h1": "Junte as câmeras da sua dashcam em um único vídeo",
            "lead": "A maioria das dashcams salva cada câmera num arquivo separado — a frontal num, a traseira noutro, a interna num terceiro. O everydashcam coloca tudo num vídeo só: lado a lado, em grade ou uma grande com as demais em imagem sobre imagem. Ele roda no seu navegador, então nada vai pra nuvem, e lê 70mai, BlackVue, Viofo, Garmin, Vantrue e dezenas de outras — não só uma marca.",
            "breadcrumbName": "Juntar câmeras em um vídeo",
            "introHeading": "Um arquivo no lugar de três",
            "introBody": "Assistir a um clipe da frontal e a um da traseira do mesmo minuto vira um malabarismo de janelas. Juntos num vídeo só, viram um único arquivo pra compartilhar, apresentar como prova ou guardar — com todas as câmeras no mesmo quadro, sincronizadas.",
            "introBody2": "O everydashcam faz isso sem enviar suas gravações a um servidor. Suas gravações são lidas e juntadas localmente, ali na aba do navegador, e o vídeo pronto é salvo direto no seu computador.",
            "optionsHeading": "Disposições",
            "options": [
                {
                    "name": "Lado a lado",
                    "desc": "Duas câmeras uma ao lado da outra — uma tela dividida com a frontal e a traseira do mesmo tamanho."
                },
                {
                    "name": "Empilhadas",
                    "desc": "Duas câmeras uma em cima da outra, pra telas altas ou clipes na vertical."
                },
                {
                    "name": "Grade",
                    "desc": "Até quatro câmeras numa grade 2×2 — frontal, traseira, interna e uma câmera lateral juntas."
                },
                {
                    "name": "Imagem sobre imagem",
                    "desc": "Uma câmera ocupa o quadro inteiro; as outras ficam em pequenos quadrinhos arredondados que você move e redimensiona."
                },
                {
                    "name": "Divisão assimétrica",
                    "desc": "Uma câmera ocupa metade, duas empilhadas na outra — uma visão principal mais dois extras."
                }
            ],
            "howHeading": "Como juntar suas câmeras",
            "howSteps": [
                "Coloque o cartão SD no computador e arraste a pasta inteira pra everydashcam.app.",
                "Abra a viagem — frontal, traseira e interna se alinham sozinhas numa mesma linha do tempo.",
                "Abra a exportação, escolha uma disposição (lado a lado, grade ou imagem sobre imagem) e selecione o trecho pra salvar.",
                "Salve — o vídeo combinado é gravado direto no seu computador, com o trajeto GPS dentro dele."
            ],
            "brandsHeading": "Frontal e traseira num arquivo só — mesmo quando o app da câmera não deixa",
            "brandsBody": "Os apps dos fabricantes costumam parar por aqui: tocam a frontal e a traseira juntas, mas exportam cada câmera num arquivo próprio, não um único clipe combinado. O everydashcam é um player de dashcam gratuito que lê BlackVue, Viofo, 70mai, Vantrue, Thinkware, Garmin e outras — e grava o vídeo combinado que os apps deles deixam de fora. Mesma viagem, todas as câmeras, um arquivo só.",
            "noteHeading": "Bom saber",
            "noteBody": "Juntar recodifica o vídeo, então não é instantâneo — um trecho longo leva um tempinho. Pra exportar do jeito mais tranquilo, use Chrome, Edge ou outro navegador Chromium num computador. Isso costura as câmeras num mesmo quadro; juntar os clipes curtos de uma viagem em sequência, num arquivo contínuo, acontece automaticamente quando você escolhe um trecho.",
            "faqHeading": "Perguntas frequentes",
            "faq": [
                {
                    "q": "Dá pra juntar o vídeo da frontal e da traseira num arquivo só?",
                    "a": "Dá. Abra a viagem, escolha uma disposição lado a lado, empilhada ou com imagem sobre imagem, selecione o trecho e salve. A frontal e a traseira são gravadas num vídeo só, em sincronia, com o trajeto GPS dentro do arquivo."
                },
                {
                    "q": "Funciona com três câmeras (frontal, traseira e interna)?",
                    "a": "Funciona. Use a grade 2×2 ou uma disposição com imagem sobre imagem pra colocar três ou quatro câmeras num vídeo só. Frontal, traseira, interna e uma câmera lateral podem dividir o mesmo quadro."
                },
                {
                    "q": "Meu vídeo vai pra algum lugar?",
                    "a": "Não. Suas gravações são lidas e juntadas localmente no seu navegador, e o arquivo pronto é salvo direto no seu computador."
                },
                {
                    "q": "Quais dashcams têm suporte?",
                    "a": "70mai, BlackVue, Viofo, Garmin, Vantrue, Thinkware, GoPro e muitas outras — qualquer uma que grave arquivos .mp4, .mov ou .ts padrão. Se a sua câmera ainda não for lida, mande um exemplo pra feedback@everydashcam.app que eu adiciono."
                },
                {
                    "q": "É grátis?",
                    "a": "É — grátis, sem cadastro, nada pra instalar. Abra a página, arraste sua pasta, junte e salve."
                }
            ],
            "ctaPrimary": "Abrir suas gravações"
        },
        "zh": {
            "title": "把行车记录仪的多路摄像头合成一段视频 — 免费，在浏览器里完成 | everydashcam",
            "metaDescription": "把前路、后路、车内摄像头合成一段视频 — 并排、宫格或画中画。免费，在浏览器里完成，不上传。支持 70mai、BlackVue、Viofo 等多种品牌。",
            "ogTitle": "把行车记录仪的多路摄像头合成一段视频 — 免费",
            "ogDescription": "把前路、后路、车内画面拼进一段视频 — 并排、宫格或画中画。免费，在浏览器里完成，不上传。",
            "h1": "把行车记录仪的多路摄像头合成一段视频",
            "lead": "大多数行车记录仪会把每路摄像头单独存一个文件 — 前路一个、后路一个、车内又是一个。everydashcam 把它们拼进同一段视频里：并排、宫格，或者一路放大、其余以画中画显示。整个过程在你的浏览器里跑，所以什么都不会上传，而且它能读 70mai、BlackVue、Viofo、Garmin、Vantrue 等几十种品牌 — 不限于某一家。",
            "breadcrumbName": "把多路摄像头合成一段视频",
            "introHeading": "一个文件，不用三个",
            "introBody": "同一分钟里前路一段、后路一段，要一起看就得在好几个窗口之间来回切。合成一段视频后，它们就变成一个能分享、能当证据提交、也能留存的文件 — 每路画面都在同一帧里，分毫不差地同步。",
            "introBody2": "everydashcam 无需上传录像就能完成这项操作。你的录像在本地、在这个浏览器标签页里被读取和合成，做好的视频直接存到你的电脑上。",
            "optionsHeading": "排布方式",
            "options": [
                {
                    "name": "并排",
                    "desc": "两路画面左右排列 — 前路和后路一样大的分屏。"
                },
                {
                    "name": "上下叠放",
                    "desc": "两路画面一上一下，适合竖屏屏幕或竖版片段。"
                },
                {
                    "name": "宫格",
                    "desc": "最多四路画面拼成 2×2 宫格 — 前路、后路、车内、再加一路侧面摄像头一起显示。"
                },
                {
                    "name": "画中画",
                    "desc": "一路画面铺满整帧；其余几路缩成圆角小窗，可以随意拖动和缩放。"
                },
                {
                    "name": "非对称分屏",
                    "desc": "一路占一半，另一半上下叠两路 — 一个主画面加两个辅助画面。"
                }
            ],
            "howHeading": "怎么把多路摄像头合到一起",
            "howSteps": [
                "把 SD 卡插进电脑，再把整个文件夹拖到 everydashcam.app 上。",
                "打开这趟行程 — 前路、后路、车内会自动对齐到同一条时间轴上。",
                "打开导出，选一种排布（并排、宫格或画中画），再选要保存的区间。",
                "保存 — 合成好的视频直接写到你的电脑上，GPS 轨迹也在里面。"
            ],
            "brandsHeading": "前后画面合进一个文件 — 哪怕记录仪自带的 App 做不到",
            "brandsBody": "厂商的 App 常常到这一步就止步了：能把前后画面一起播，但导出时每路摄像头各存一个文件，拼不成一段合并好的片段。everydashcam 是一款免费的行车记录仪播放器，能读 BlackVue、Viofo、70mai、Vantrue、Thinkware、Garmin 等品牌 — 把它们的 App 做不出的合成视频写出来。同一趟行程，每路画面，一个文件。",
            "noteHeading": "提前说明",
            "noteBody": "合成会重新编码视频，所以不是瞬间完成 — 区间长一点就得花点时间。想要最顺畅的导出，请在电脑上用 Chrome、Edge 或别的 Chromium 浏览器。这里做的是把多路画面拼进同一帧；而把一趟行程里的若干短片段首尾相接拼成一个连续文件，在你选区间时就自动完成了。",
            "faqHeading": "常见问题",
            "faq": [
                {
                    "q": "能把前路和后路的画面合进一个文件吗？",
                    "a": "能。打开行程，选并排、上下叠放或画中画排布，选好区间，保存即可。前路和后路会被写进同一段视频里，画面同步，GPS 轨迹也在文件里。"
                },
                {
                    "q": "三路摄像头（前路、后路、车内）也能用吗？",
                    "a": "能。用 2×2 宫格或画中画排布，就能把三四路画面放进一段视频。前路、后路、车内再加一路侧面摄像头都能同框。"
                },
                {
                    "q": "我的视频会被上传到哪里吗？",
                    "a": "不会。你的录像在本地、在浏览器里被读取和合成，做好的文件直接存到你的电脑上。"
                },
                {
                    "q": "它支持哪些行车记录仪？",
                    "a": "70mai、BlackVue、Viofo、Garmin、Vantrue、Thinkware、GoPro 还有很多 — 只要是写标准 .mp4、.mov 或 .ts 文件的设备都行。如果你的记录仪暂时还读不了，发个样本到 feedback@everydashcam.app，我就加上。"
                },
                {
                    "q": "免费吗？",
                    "a": "免费 — 不用注册，也不用安装。打开页面，拖进文件夹，合成，保存。"
                }
            ],
            "ctaPrimary": "打开你的录像"
        }
    },
    "add-data-overlay-to-dashcam-video": {
        "de": {
            "title": "Daten-Overlay aufs Dashcam-Video legen — Tempo, GPS & Karte | everydashcam",
            "metaDescription": "Tempo, GPS-Koordinaten und eine mitlaufende Karte aufs Dashcam-Video brennen — kostenlos, im Browser, nichts wird hochgeladen. Klappt, wenn deine Aufnahme GPS hat. 70mai, BlackVue, Viofo und mehr.",
            "ogTitle": "Tempo-, GPS- & Karten-Overlay aufs Dashcam-Video",
            "ogDescription": "Tempo, Koordinaten und eine mitlaufende Karte aufs exportierte Video brennen — kostenlos, im Browser, nichts wird hochgeladen.",
            "h1": "Leg ein Tempo-, GPS- und Karten-Overlay auf dein Dashcam-Video",
            "lead": "everydashcam brennt dein Tempo, deine GPS-Koordinaten und eine mitlaufende Mini-Karte direkt aufs exportierte Video — saubere Anzeigen, fest ins Bild eingebacken, keine separate App. Es läuft in deinem Browser, nichts wird hochgeladen, und es nutzt das GPS, das deine Dashcam schon aufgezeichnet hat.",
            "breadcrumbName": "Daten-Overlay hinzufügen",
            "introHeading": "Tempo und Standort, fest ins Bild gebacken",
            "introBody": "Ein Dashcam-Clip allein zeigt nicht, wie schnell du warst oder wo du warst. everydashcam liest das GPS, das deine Kamera gespeichert hat, und zeichnet es aufs exportierte Video: eine Tempo-Anzeige, deine Koordinaten und eine kleine Karte, die mit der Strecke mitläuft. Die Daten sind Teil des Bildes, sie bleiben also sichtbar, egal wo die Datei abgespielt wird — kein spezieller Player nötig.",
            "introBody2": "Alles passiert in deinem Browser. Deine Aufnahmen werden lokal gelesen und das Overlay wird auf deinem Gerät gerendert; das fertige Video landet direkt auf deinem Computer.",
            "optionsHeading": "Was du einblenden kannst",
            "options": [
                {
                    "name": "Tempo",
                    "desc": "Eine saubere Tempo-Anzeige in km/h oder mph, in der Ecke deiner Wahl."
                },
                {
                    "name": "Koordinaten",
                    "desc": "Deine GPS-Breite und -Länge, aktualisiert während die Strecke voranschreitet."
                },
                {
                    "name": "Mitlaufende Karte",
                    "desc": "Eine kleine Karte, die der Strecke folgt — zieh sie hin, wo du willst, und stell ein, wie weit sie zoomt."
                },
                {
                    "name": "Wasserzeichen",
                    "desc": "Eine optionale kleine Markierung in einer Ecke des Bildes."
                }
            ],
            "howHeading": "So fügst du das Overlay hinzu",
            "howSteps": [
                "Zieh den SD-Karten-Ordner auf everydashcam.app und öffne die Fahrt.",
                "Öffne den Export und schalt die Overlays ein, die du willst — Tempo, Koordinaten, die mitlaufende Karte.",
                "Zieh jedes dorthin, wo es sitzen soll, und wähl den Bereich, den du speichern willst.",
                "Speichern — das Overlay wird aufs Video gerendert und direkt auf deinen Computer geschrieben."
            ],
            "brandsHeading": "Kostenlos, im Browser, für Dashcam-Aufnahmen",
            "brandsBody": "Tempo und eine Karte aufs Video zu brennen, ist sonst der Job teurer Desktop-Tools für Action-Kameras. everydashcam macht die Dashcam-Variante kostenlos, in einem Browser-Tab: es liest das GPS von 70mai, BlackVue, Viofo, Garmin, Vantrue und mehr und zeichnet Tempo, Koordinaten und eine mitlaufende Karte auf den Export — keine Installation, kein Konto, nichts wird hochgeladen.",
            "noteHeading": "Gut zu wissen",
            "noteBody": "Das Overlay braucht GPS in deiner Aufnahme — hat eine Aufnahme keinen GPS-Track, gibt es nichts zu zeichnen. Neben Tempo, Koordinaten und der mitlaufenden Karte kann es auch die Uhrzeit, deine Fahrtrichtung, die zurückgelegte Strecke und eine G-Kraft-Anzeige zeigen — alles aus demselben GPS errechnet, nicht von einem separaten Sensor. Beim Rendern wird das Video neu kodiert, ein langer Bereich braucht also etwas Zeit; Chrome, Edge oder ein anderer Chromium-Browser am Computer läuft am flüssigsten.",
            "faqHeading": "Häufige Fragen",
            "faq": [
                {
                    "q": "Wie lege ich ein Tempo-Overlay auf ein Dashcam-Video?",
                    "a": "Öffne die Fahrt, geh zum Export und schalt das Tempo-Overlay ein. everydashcam liest das GPS, das deine Kamera aufgezeichnet hat, und brennt eine Tempo-Anzeige (km/h oder mph) aufs exportierte Video. Du kannst sie in jede Ecke setzen."
                },
                {
                    "q": "Kann ich GPS-Koordinaten und eine Karte im Video zeigen?",
                    "a": "Ja. Neben dem Tempo kannst du deine Breite und Länge sowie eine kleine mitlaufende Karte einblenden, die der Strecke folgt. Zieh jedes dorthin, wo du es haben willst, und stell ein, wie weit die Karte zoomt."
                },
                {
                    "q": "Braucht es GPS in der Aufnahme?",
                    "a": "Ja. Das Overlay entsteht aus dem GPS, das deine Dashcam gespeichert hat. Hat ein Clip keinen GPS-Track, gibt es nichts einzublenden — das Video wird trotzdem exportiert, nur ohne Tempo, Koordinaten oder Karte."
                },
                {
                    "q": "Wird mein Video hochgeladen?",
                    "a": "Nein. Das Overlay wird lokal in deinem Browser gerendert, und das fertige Video landet direkt auf deinem Computer."
                },
                {
                    "q": "Kann es auch Uhrzeit, Fahrtrichtung oder G-Kraft zeigen?",
                    "a": "Ja. Neben Tempo, Koordinaten und der Karte kannst du die Uhrzeit, eine Kompass-Fahrtrichtung, die zurückgelegte Strecke und eine G-Kraft-Anzeige hinzufügen. Die G-Kraft wird aus deinem GPS errechnet — daraus, wie sich Tempo und Richtung ändern — und nicht von einem separaten Sensor, sie braucht also wie alles andere GPS in der Aufnahme."
                }
            ],
            "ctaPrimary": "Aufnahmen öffnen"
        },
        "es": {
            "title": "Añade una capa de datos al vídeo de tu dashcam — velocidad, GPS y mapa | everydashcam",
            "metaDescription": "Graba velocidad, coordenadas GPS y un mapa en movimiento sobre tu vídeo de dashcam — gratis, en tu navegador, sin subir nada. Funciona si tu grabación tiene GPS. 70mai, BlackVue, Viofo y más.",
            "ogTitle": "Añade velocidad, GPS y mapa al vídeo de tu dashcam",
            "ogDescription": "Graba velocidad, coordenadas y un mapa en movimiento sobre el vídeo exportado — gratis, en tu navegador, sin subir nada.",
            "h1": "Añade una capa de velocidad, GPS y mapa a tu vídeo de dashcam",
            "lead": "everydashcam puede grabar tu velocidad, tus coordenadas GPS y un minimapa en movimiento directamente sobre el vídeo exportado — lecturas claras integradas en la imagen, no una app aparte. Funciona en tu navegador, no se sube nada y usa el GPS que tu dashcam ya grabó.",
            "breadcrumbName": "Añadir una capa de datos",
            "introHeading": "Velocidad y ubicación, integradas en la imagen",
            "introBody": "Un clip de dashcam por sí solo no muestra a qué velocidad ibas ni dónde estabas. everydashcam lee el GPS que guardó tu cámara y lo dibuja sobre el vídeo exportado: una lectura de velocidad, tus coordenadas y un pequeño mapa que se mueve con la ruta. Los datos forman parte de la imagen, así que siguen visibles allá donde se reproduzca el archivo — sin necesidad de un reproductor especial.",
            "introBody2": "Todo ocurre en tu navegador. Tus grabaciones se leen en local y la capa se renderiza en tu dispositivo; el vídeo final se guarda directamente en tu ordenador.",
            "optionsHeading": "Qué puedes superponer",
            "options": [
                {
                    "name": "Velocidad",
                    "desc": "Una lectura de velocidad clara en km/h o mph, dibujada en la esquina que elijas."
                },
                {
                    "name": "Coordenadas",
                    "desc": "Tu latitud y longitud GPS, actualizadas a medida que avanza la ruta."
                },
                {
                    "name": "Mapa en movimiento",
                    "desc": "Un pequeño mapa que sigue la ruta — arrástralo donde quieras y ajusta cuánto se acerca."
                },
                {
                    "name": "Marca de agua",
                    "desc": "Una pequeña marca opcional en una esquina del cuadro."
                }
            ],
            "howHeading": "Cómo añadir la capa",
            "howSteps": [
                "Arrastra la carpeta de la tarjeta SD a everydashcam.app y abre el viaje.",
                "Abre la exportación y activa las capas que quieras — velocidad, coordenadas, el mapa en movimiento.",
                "Arrastra cada una a donde debe ir y selecciona el tramo que quieras guardar.",
                "Guarda — la capa se renderiza sobre el vídeo y se escribe directamente en tu ordenador."
            ],
            "brandsHeading": "Gratis, en el navegador, para grabaciones de dashcam",
            "brandsBody": "Grabar la velocidad y un mapa sobre el vídeo suele ser cosa de herramientas de escritorio de pago pensadas para cámaras de acción. everydashcam hace la versión para dashcam gratis, en una pestaña del navegador: lee el GPS de 70mai, BlackVue, Viofo, Garmin, Vantrue y más, y dibuja velocidad, coordenadas y un mapa en movimiento sobre la exportación — sin instalar nada, sin cuenta, sin subir nada.",
            "noteHeading": "Conviene saberlo",
            "noteBody": "La capa necesita GPS en tu grabación — si una grabación no tiene traza GPS, no hay nada que dibujar. Además de la velocidad, las coordenadas y el mapa en movimiento, también puede mostrar la hora, tu rumbo, la distancia recorrida y una lectura de fuerza G — todo calculado a partir del mismo GPS, no de un sensor aparte. Renderizar recodifica el vídeo, así que un tramo largo lleva su tiempo; Chrome, Edge u otro navegador Chromium en un ordenador es lo más fluido.",
            "faqHeading": "Preguntas frecuentes",
            "faq": [
                {
                    "q": "¿Cómo añado una capa de velocidad a un vídeo de dashcam?",
                    "a": "Abre el viaje, ve a la exportación y activa la capa de velocidad. everydashcam lee el GPS que grabó tu cámara y graba una lectura de velocidad (km/h o mph) sobre el vídeo exportado. Puedes colocarla en cualquier esquina."
                },
                {
                    "q": "¿Puedo mostrar coordenadas GPS y un mapa en el vídeo?",
                    "a": "Sí. Junto a la velocidad puedes superponer tu latitud y longitud y un pequeño mapa en movimiento que sigue la ruta. Arrastra cada uno donde quieras y ajusta cuánto se acerca el mapa."
                },
                {
                    "q": "¿Necesita que la grabación tenga GPS?",
                    "a": "Sí. La capa se dibuja a partir del GPS que guardó tu dashcam. Si un clip no tiene traza GPS, no hay nada que superponer — el vídeo se exporta igual, solo que sin velocidad, coordenadas ni mapa."
                },
                {
                    "q": "¿Se sube mi vídeo?",
                    "a": "No. La capa se renderiza en local en tu navegador y el vídeo final se guarda directamente en tu ordenador."
                },
                {
                    "q": "¿También puede mostrar la hora, el rumbo o la fuerza G?",
                    "a": "Sí. Junto a la velocidad, las coordenadas y el mapa puedes añadir la hora, un rumbo de brújula, la distancia recorrida y una lectura de fuerza G. La fuerza G se calcula a partir de tu GPS — de cómo cambian tu velocidad y tu dirección — y no de un sensor aparte, así que necesita GPS en la grabación, igual que el resto."
                }
            ],
            "ctaPrimary": "Abre tus grabaciones"
        },
        "fr": {
            "title": "Ajouter une incrustation de données sur ta vidéo de dashcam — vitesse, GPS et carte | everydashcam",
            "metaDescription": "Incruste la vitesse, les coordonnées GPS et une carte animée sur ta vidéo de dashcam — gratuit, dans ton navigateur, rien n'est envoyé. Marche si ta vidéo contient du GPS. 70mai, BlackVue, Viofo et plus.",
            "ogTitle": "Ajouter la vitesse, le GPS et une carte sur ta vidéo de dashcam",
            "ogDescription": "Incruste la vitesse, les coordonnées et une carte animée sur la vidéo exportée — gratuit, dans ton navigateur, rien n'est envoyé.",
            "h1": "Ajoute la vitesse, le GPS et une carte sur ta vidéo de dashcam",
            "lead": "everydashcam peut incruster ta vitesse, tes coordonnées GPS et une mini-carte animée directement sur la vidéo exportée — des indicateurs nets intégrés à l'image, pas une appli à part. Tout se passe dans ton navigateur, rien n'est envoyé, et ça marche avec le GPS que ta dashcam a déjà enregistré.",
            "breadcrumbName": "Ajouter une incrustation de données",
            "introHeading": "Vitesse et position, intégrées à l'image",
            "introBody": "Un clip de dashcam, seul, ne montre ni ta vitesse ni l'endroit où tu étais. everydashcam lit le GPS que ta caméra a enregistré et le dessine sur la vidéo exportée : un affichage de la vitesse, tes coordonnées et une petite carte qui suit le trajet. Les données font partie de l'image, donc elles restent visibles quel que soit le lecteur — aucun lecteur spécial requis.",
            "introBody2": "Tout se passe dans ton navigateur. Tes enregistrements sont lus en local et l'incrustation est rendue sur ton appareil ; la vidéo finale est enregistrée directement sur ton ordinateur.",
            "optionsHeading": "Ce que tu peux incruster",
            "options": [
                {
                    "name": "Vitesse",
                    "desc": "Un affichage net de la vitesse en km/h ou mph, placé dans le coin de ton choix."
                },
                {
                    "name": "Coordonnées",
                    "desc": "Ta latitude et ta longitude GPS, mises à jour au fil du trajet."
                },
                {
                    "name": "Carte animée",
                    "desc": "Une petite carte qui suit le trajet — place-la où tu veux, règle son niveau de zoom."
                },
                {
                    "name": "Filigrane",
                    "desc": "Une petite marque optionnelle dans un coin de l'image."
                }
            ],
            "howHeading": "Comment ajouter l'incrustation",
            "howSteps": [
                "Dépose le dossier de la carte SD sur everydashcam.app et ouvre le trajet.",
                "Ouvre l'export et active les incrustations que tu veux — vitesse, coordonnées, carte animée.",
                "Fais glisser chacune à sa place et choisis la plage à enregistrer.",
                "Enregistre — l'incrustation est rendue sur la vidéo et écrite directement sur ton ordinateur."
            ],
            "brandsHeading": "Gratuit, dans le navigateur, pour les vidéos de dashcam",
            "brandsBody": "Incruster la vitesse et une carte sur une vidéo, c'est d'habitude le boulot d'outils de bureau payants conçus pour les caméras d'action. everydashcam fait la version dashcam gratuitement, dans un onglet : il lit le GPS des 70mai, BlackVue, Viofo, Garmin, Vantrue et plus, et dessine la vitesse, les coordonnées et une carte animée sur l'export — aucune installation, aucun compte, rien n'est envoyé.",
            "noteHeading": "Bon à savoir",
            "noteBody": "L'incrustation a besoin de GPS dans ta vidéo — si un enregistrement n'a pas de tracé GPS, il n'y a rien à dessiner. Au-delà de la vitesse, des coordonnées et de la carte animée, elle peut aussi afficher l'heure, ton cap, la distance parcourue et une lecture de force G — le tout calculé à partir du même GPS, pas d'un capteur séparé. Le rendu réencode la vidéo, donc une longue plage prend un peu de temps ; Chrome, Edge ou un autre navigateur Chromium sur un ordinateur est le plus fluide.",
            "faqHeading": "FAQ",
            "faq": [
                {
                    "q": "Comment ajouter une incrustation de vitesse sur une vidéo de dashcam ?",
                    "a": "Ouvre le trajet, va dans l'export et active l'incrustation de vitesse. everydashcam lit le GPS que ta caméra a enregistré et incruste un affichage de la vitesse (km/h ou mph) sur la vidéo exportée. Tu peux le placer dans n'importe quel coin."
                },
                {
                    "q": "Puis-je afficher les coordonnées GPS et une carte sur la vidéo ?",
                    "a": "Oui. À côté de la vitesse, tu peux incruster ta latitude et ta longitude ainsi qu'une petite carte animée qui suit le trajet. Fais glisser chacune où tu veux et règle le niveau de zoom de la carte."
                },
                {
                    "q": "Faut-il du GPS dans l'enregistrement ?",
                    "a": "Oui. L'incrustation est dessinée à partir du GPS que ta dashcam a enregistré. Si un clip n'a pas de tracé GPS, il n'y a rien à incruster — la vidéo s'exporte quand même, simplement sans vitesse, coordonnées ni carte."
                },
                {
                    "q": "Ma vidéo est-elle envoyée ?",
                    "a": "Non. L'incrustation est rendue en local dans ton navigateur et la vidéo finale est enregistrée directement sur ton ordinateur."
                },
                {
                    "q": "Peut-elle aussi afficher l'heure, le cap ou la force G ?",
                    "a": "Oui. À côté de la vitesse, des coordonnées et de la carte, tu peux ajouter l'heure, un cap de boussole, la distance parcourue et une lecture de force G. La force G est calculée à partir de ton GPS — d'après l'évolution de ta vitesse et de ta direction — et non d'un capteur séparé, elle a donc besoin de GPS dans la vidéo, comme le reste."
                }
            ],
            "ctaPrimary": "Ouvrir tes enregistrements"
        },
        "ja": {
            "title": "ドラレコ映像にデータを重ねる — 速度・GPS・地図 | everydashcam",
            "metaDescription": "ドラレコ映像に速度・GPS座標・動く地図を焼き込みます。無料、ブラウザだけで、どこにもアップロードしません。映像にGPSが記録されていれば使えます。70mai、BlackVue、Viofoなどに対応。",
            "ogTitle": "ドラレコ映像に速度・GPS・地図を重ねる",
            "ogDescription": "書き出す動画に速度・座標・動く地図を焼き込みます。無料、ブラウザだけで、どこにもアップロードしません。",
            "h1": "ドラレコ映像に速度・GPS・地図のデータを重ねる",
            "lead": "everydashcamは、速度・GPS座標・動くミニ地図を、書き出す動画にそのまま焼き込めます。すっきりした表示が映像に焼き付けられるので、別のアプリは要りません。ブラウザの中で動き、どこにもアップロードされず、ドラレコがすでに記録したGPSを使って動作します。",
            "breadcrumbName": "データを重ねる",
            "introHeading": "速度と位置を、映像に焼き込む",
            "introBody": "ドラレコのクリップ単体では、どれくらいの速度で、どこを走っていたかはわかりません。everydashcamはカメラが保存したGPSを読み取り、書き出す動画に描き込みます。速度表示、座標、そしてルートに合わせて動く小さな地図です。データは映像の一部になるので、どのプレーヤーで再生してもそのまま見えます。専用のプレーヤーは要りません。",
            "introBody2": "すべてブラウザの中で行われます。映像はローカルで読み込まれ、オーバーレイはお使いの端末で描画されます。できあがった動画はそのままパソコンに保存されます。",
            "optionsHeading": "重ねられるもの",
            "options": [
                {
                    "name": "速度",
                    "desc": "km/hまたはmphでのすっきりした速度表示。お好きな角に描き込めます。"
                },
                {
                    "name": "座標",
                    "desc": "GPSの緯度と経度。ルートが進むのに合わせて更新されます。"
                },
                {
                    "name": "動く地図",
                    "desc": "ルートを追う小さな地図。好きな位置にドラッグし、ズームの度合いも設定できます。"
                },
                {
                    "name": "ウォーターマーク",
                    "desc": "フレームの角に入れられる、小さな任意のマークです。"
                }
            ],
            "howHeading": "オーバーレイを重ねる手順",
            "howSteps": [
                "SDカードのフォルダをeverydashcam.appにドロップして、ドライブを開きます。",
                "書き出しを開き、重ねたいものをオンにします。速度・座標・動く地図など。",
                "それぞれを置きたい位置にドラッグし、保存する範囲を選びます。",
                "保存すると、オーバーレイが映像に描画され、そのままパソコンに書き出されます。"
            ],
            "brandsHeading": "無料で、ブラウザの中で、ドラレコ映像のために",
            "brandsBody": "速度や地図を映像に焼き込むのは、ふつうアクションカメラ向けの有料デスクトップツールの仕事です。everydashcamは、そのドラレコ版を無料で、ブラウザのタブの中で行います。70mai、BlackVue、Viofo、Garmin、VantrueなどからGPSを読み取り、速度・座標・動く地図を書き出す動画に描き込みます。インストールもアカウントも不要で、どこにもアップロードしません。",
            "noteHeading": "知っておきたいこと",
            "noteBody": "オーバーレイには映像にGPSが必要です。録画にGPSトラックがなければ、描くものがありません。速度・座標・動く地図のほかに、時刻、進行方位、走行距離、Gフォースの表示も重ねられます。これらはすべて同じGPSから計算され、別のセンサーは使いません。描画では動画を再エンコードするので、長い範囲には少し時間がかかります。パソコンでChrome、Edge、その他のChromium系ブラウザを使うのがいちばんスムーズです。",
            "faqHeading": "よくある質問",
            "faq": [
                {
                    "q": "ドラレコ映像に速度の表示を重ねるにはどうすればいいですか？",
                    "a": "ドライブを開き、書き出しに進んで、速度オーバーレイをオンにします。everydashcamはカメラが記録したGPSを読み取り、速度表示（km/hまたはmph）を書き出す動画に焼き込みます。表示はどの角にも置けます。"
                },
                {
                    "q": "GPS座標や地図を映像に表示できますか？",
                    "a": "はい。速度に加えて、緯度・経度と、ルートを追う小さな動く地図を重ねられます。それぞれを好きな位置にドラッグし、地図のズームの度合いも設定できます。"
                },
                {
                    "q": "録画にGPSが必要ですか？",
                    "a": "はい。オーバーレイは、ドラレコが保存したGPSをもとに描かれます。クリップにGPSトラックがなければ、重ねるものはありません。その場合でも動画は書き出せますが、速度・座標・地図はつきません。"
                },
                {
                    "q": "映像はアップロードされますか？",
                    "a": "いいえ。オーバーレイはブラウザの中でローカルに描画され、できあがった動画はそのままパソコンに保存されます。"
                },
                {
                    "q": "時刻や進行方位、Gフォースも表示できますか？",
                    "a": "はい。速度・座標・地図に加えて、時刻、コンパスの進行方位、走行距離、Gフォースの表示も足せます。GフォースはGPSから — 速度と方向の変化から — 計算され、別のセンサーは使いません。そのため、ほかの表示と同じく映像にGPSが必要です。"
                }
            ],
            "ctaPrimary": "映像を開く"
        },
        "ko": {
            "title": "블랙박스 영상에 데이터 오버레이 넣기 — 속도, GPS, 지도 | everydashcam",
            "metaDescription": "블랙박스 영상에 속도, GPS 좌표, 움직이는 지도를 새겨 넣어요 — 브라우저에서 무료, 업로드 없음. 영상에 GPS가 있을 때 작동해요. 70mai, BlackVue, Viofo 등 지원.",
            "ogTitle": "블랙박스 영상에 속도, GPS, 지도 오버레이 넣기",
            "ogDescription": "내보내는 영상에 속도, 좌표, 움직이는 지도를 새겨 넣어요 — 브라우저에서 무료, 업로드 없음.",
            "h1": "블랙박스 영상에 속도, GPS, 지도 오버레이를 넣어요",
            "lead": "everydashcam는 속도, GPS 좌표, 움직이는 미니 지도를 내보내는 영상에 바로 새겨 넣을 수 있어요 — 깔끔한 표시가 화면에 구워 들어가는 거예요, 별도 앱이 아니라요. 브라우저에서 돌아가고, 아무것도 업로드되지 않으며, 블랙박스가 이미 기록한 GPS로 작동해요.",
            "breadcrumbName": "데이터 오버레이 넣기",
            "introHeading": "속도와 위치가 화면에 새겨져요",
            "introBody": "블랙박스 클립만으로는 얼마나 빨리 달렸는지, 어디였는지 알 수 없어요. everydashcam는 카메라가 저장한 GPS를 읽어서 내보내는 영상에 그려 넣어요: 속도 표시, 좌표, 그리고 경로를 따라 움직이는 작은 지도까지요. 데이터가 화면의 일부라서 어디서 재생하든 그대로 보여요 — 특별한 플레이어가 필요 없어요.",
            "introBody2": "모든 게 브라우저 안에서 일어나요. 영상은 직접 읽히고 오버레이는 기기에서 렌더링되며, 완성된 영상은 곧바로 컴퓨터에 저장돼요.",
            "optionsHeading": "오버레이할 수 있는 것",
            "options": [
                {
                    "name": "속도",
                    "desc": "km/h 또는 mph로 깔끔하게 표시되는 속도 — 원하는 모서리에 그려져요."
                },
                {
                    "name": "좌표",
                    "desc": "GPS 위도와 경도가 경로를 따라 갱신돼요."
                },
                {
                    "name": "움직이는 지도",
                    "desc": "경로를 따라가는 작은 지도 — 원하는 곳으로 끌어다 놓고, 확대 정도를 정하세요."
                },
                {
                    "name": "워터마크",
                    "desc": "화면 모서리에 넣을 수 있는 작은 표시예요 (선택)."
                }
            ],
            "howHeading": "오버레이 넣는 방법",
            "howSteps": [
                "SD 카드 폴더를 everydashcam.app에 끌어다 놓고 주행을 열어요.",
                "내보내기를 열고 원하는 오버레이를 켜요 — 속도, 좌표, 움직이는 지도요.",
                "각각을 있어야 할 자리로 끌어다 놓고 저장할 구간을 골라요.",
                "저장하면 오버레이가 영상에 렌더링되어 곧바로 컴퓨터에 저장돼요."
            ],
            "brandsHeading": "무료로, 브라우저에서, 블랙박스 영상에 맞게",
            "brandsBody": "속도와 지도를 영상에 새겨 넣는 건 보통 액션캠용 유료 데스크톱 도구가 하는 일이에요. everydashcam는 그 블랙박스 버전을 브라우저 탭에서 무료로 해요: 70mai, BlackVue, Viofo, Garmin, Vantrue 등에서 GPS를 읽어 속도, 좌표, 움직이는 지도를 내보내기 영상에 그려요 — 설치도, 계정도, 업로드도 없어요.",
            "noteHeading": "알아두면 좋아요",
            "noteBody": "오버레이는 영상에 GPS가 있어야 해요 — GPS 트랙이 없는 녹화는 그릴 게 없어요. 속도, 좌표, 움직이는 지도 말고도 시간, 진행 방위, 이동 거리, G-포스 표시까지 넣을 수 있어요 — 모두 같은 GPS에서 계산되고, 별도 센서는 쓰지 않아요. 렌더링은 영상을 다시 인코딩하기 때문에 긴 구간은 시간이 조금 걸려요. 컴퓨터에서 Chrome, Edge나 다른 Chromium 브라우저가 가장 매끄러워요.",
            "faqHeading": "자주 묻는 질문",
            "faq": [
                {
                    "q": "블랙박스 영상에 속도 오버레이를 어떻게 넣나요?",
                    "a": "주행을 열고 내보내기로 가서 속도 오버레이를 켜세요. everydashcam가 카메라가 기록한 GPS를 읽어서 속도 표시(km/h 또는 mph)를 내보내는 영상에 새겨 넣어요. 어느 모서리에든 둘 수 있어요."
                },
                {
                    "q": "영상에 GPS 좌표와 지도도 보여줄 수 있나요?",
                    "a": "네. 속도와 함께 위도와 경도, 그리고 경로를 따라가는 작은 움직이는 지도를 오버레이할 수 있어요. 각각을 원하는 곳으로 끌어다 놓고 지도 확대 정도를 정하세요."
                },
                {
                    "q": "녹화에 GPS가 있어야 하나요?",
                    "a": "네. 오버레이는 블랙박스가 저장한 GPS로 그려져요. 클립에 GPS 트랙이 없으면 오버레이할 게 없어요 — 영상은 그래도 내보내지지만 속도, 좌표, 지도 없이 나와요."
                },
                {
                    "q": "제 영상이 업로드되나요?",
                    "a": "아니요. 오버레이는 브라우저 안에서 직접 렌더링되고, 완성된 영상은 곧바로 컴퓨터에 저장돼요."
                },
                {
                    "q": "시간이나 진행 방위, G-포스도 보여줄 수 있나요?",
                    "a": "네. 속도, 좌표, 지도와 함께 시간, 나침반 방위, 이동 거리, G-포스 표시를 더할 수 있어요. G-포스는 별도 센서가 아니라 GPS에서 — 속도와 방향이 어떻게 바뀌는지로 — 계산되기 때문에, 나머지와 마찬가지로 영상에 GPS가 있어야 해요."
                }
            ],
            "ctaPrimary": "내 영상 열기"
        },
        "pl": {
            "title": "Dodaj nakładkę z danymi do wideo z rejestratora — prędkość, GPS i mapa | everydashcam",
            "metaDescription": "Wypal prędkość, współrzędne GPS i ruchomą mapę na wideo z rejestratora — za darmo, w przeglądarce, nic nie wysyłasz. Działa, gdy nagranie ma GPS. 70mai, BlackVue, Viofo i więcej.",
            "ogTitle": "Dodaj nakładkę z prędkością, GPS i mapą do wideo",
            "ogDescription": "Wypal prędkość, współrzędne i ruchomą mapę na wyeksportowanym wideo — za darmo, w przeglądarce, nic nie wysyłasz.",
            "h1": "Dodaj nakładkę z prędkością, GPS i mapą do wideo z rejestratora",
            "lead": "everydashcam potrafi wypalić twoją prędkość, współrzędne GPS i ruchomą minimapę prosto na wyeksportowanym wideo — czytelne odczyty wtopione w obraz, nie osobna aplikacja. Działa w przeglądarce, nic nie jest wysyłane i korzysta z GPS-u, który twój rejestrator już nagrał.",
            "breadcrumbName": "Dodaj nakładkę z danymi",
            "introHeading": "Prędkość i lokalizacja wtopione w obraz",
            "introBody": "Samo nagranie z rejestratora nie pokazuje, jak szybko jechałeś ani gdzie byłeś. everydashcam odczytuje GPS zapisany przez twoją kamerę i nanosi go na wyeksportowane wideo: odczyt prędkości, twoje współrzędne i małą mapę, która porusza się razem z trasą. Dane są częścią obrazu, więc pozostają widoczne wszędzie tam, gdzie plik zostanie odtworzony — bez specjalnego odtwarzacza.",
            "introBody2": "Wszystko dzieje się w twojej przeglądarce. Twoje nagrania są odczytywane lokalnie, a nakładka renderowana na twoim urządzeniu; gotowe wideo zapisuje się prosto na twój komputer.",
            "optionsHeading": "Co możesz nałożyć",
            "options": [
                {
                    "name": "Prędkość",
                    "desc": "Czytelny odczyt prędkości w km/h lub mph, w wybranym przez ciebie rogu."
                },
                {
                    "name": "Współrzędne",
                    "desc": "Twoja szerokość i długość geograficzna GPS, aktualizowane wraz z trasą."
                },
                {
                    "name": "Ruchoma mapa",
                    "desc": "Mała mapa, która podąża za trasą — przeciągnij ją tam, gdzie chcesz, ustaw stopień przybliżenia."
                },
                {
                    "name": "Znak wodny",
                    "desc": "Opcjonalny mały znak w rogu kadru."
                }
            ],
            "howHeading": "Jak dodać nakładkę",
            "howSteps": [
                "Przeciągnij folder z karty SD na everydashcam.app i otwórz przejazd.",
                "Otwórz eksport i włącz nakładki, których chcesz — prędkość, współrzędne, ruchomą mapę.",
                "Przeciągnij każdą tam, gdzie ma być, i zaznacz zakres do zapisania.",
                "Zapisz — nakładka zostaje wyrenderowana na wideo i zapisana prosto na twój komputer."
            ],
            "brandsHeading": "Za darmo, w przeglądarce, dla nagrań z rejestratora",
            "brandsBody": "Wypalanie prędkości i mapy na wideo to zwykle robota płatnych programów na komputer, stworzonych dla kamer sportowych. everydashcam robi wersję dla rejestratorów za darmo, w karcie przeglądarki: odczytuje GPS z 70mai, BlackVue, Viofo, Garmin, Vantrue i więcej, i nanosi prędkość, współrzędne oraz ruchomą mapę na eksport — bez instalacji, bez konta, nic nie wysyłasz.",
            "noteHeading": "Warto wiedzieć",
            "noteBody": "Nakładka potrzebuje GPS-u w nagraniu — jeśli nagranie nie ma trasy GPS, nie ma czego nanieść. Poza prędkością, współrzędnymi i ruchomą mapą może też pokazać godzinę, twój kurs, przejechany dystans i odczyt przeciążeń (G) — wszystko wyliczane z tego samego GPS-u, a nie z osobnego czujnika. Renderowanie ponownie koduje wideo, więc dłuższy zakres zajmie chwilę; najpłynniej jest w Chrome, Edge lub innej przeglądarce Chromium na komputerze.",
            "faqHeading": "Najczęstsze pytania",
            "faq": [
                {
                    "q": "Jak dodać nakładkę z prędkością do wideo z rejestratora?",
                    "a": "Otwórz przejazd, przejdź do eksportu i włącz nakładkę z prędkością. everydashcam odczytuje GPS nagrany przez twoją kamerę i wypala odczyt prędkości (km/h lub mph) na wyeksportowanym wideo. Możesz umieścić go w dowolnym rogu."
                },
                {
                    "q": "Czy mogę pokazać współrzędne GPS i mapę na wideo?",
                    "a": "Tak. Obok prędkości możesz nałożyć swoją szerokość i długość geograficzną oraz małą ruchomą mapę, która podąża za trasą. Przeciągnij każdą tam, gdzie chcesz, i ustaw stopień przybliżenia mapy."
                },
                {
                    "q": "Czy potrzebuje GPS-u w nagraniu?",
                    "a": "Tak. Nakładka powstaje z GPS-u zapisanego przez twój rejestrator. Jeśli nagranie nie ma trasy GPS, nie ma czego nałożyć — wideo i tak się wyeksportuje, tylko bez prędkości, współrzędnych i mapy."
                },
                {
                    "q": "Czy moje wideo jest wysyłane?",
                    "a": "Nie. Nakładka jest renderowana lokalnie w twojej przeglądarce, a gotowe wideo zapisuje się prosto na twój komputer."
                },
                {
                    "q": "Czy może też pokazać godzinę, kurs albo przeciążenia?",
                    "a": "Tak. Obok prędkości, współrzędnych i mapy możesz dodać godzinę, kurs z kompasu, przejechany dystans i odczyt przeciążeń (G). Przeciążenia są wyliczane z twojego GPS-u — z tego, jak zmienia się prędkość i kierunek — a nie z osobnego czujnika, więc tak jak reszta potrzebują GPS-u w nagraniu."
                }
            ],
            "ctaPrimary": "Otwórz swoje nagrania"
        },
        "pt": {
            "title": "Adicione uma sobreposição de dados ao vídeo da dashcam — velocidade, GPS e mapa | everydashcam",
            "metaDescription": "Grave velocidade, coordenadas GPS e um mapa em movimento no vídeo da dashcam — grátis, no navegador, nada vai pra nuvem. Funciona quando sua gravação tem GPS. 70mai, BlackVue, Viofo e mais.",
            "ogTitle": "Adicione velocidade, GPS e mapa ao vídeo da dashcam",
            "ogDescription": "Grave velocidade, coordenadas e um mapa em movimento no vídeo exportado — grátis, no navegador, nada vai pra nuvem.",
            "h1": "Adicione uma sobreposição de velocidade, GPS e mapa ao vídeo da sua dashcam",
            "lead": "O everydashcam grava sua velocidade, suas coordenadas GPS e um minimapa em movimento direto no vídeo exportado — leituras limpas embutidas na imagem, sem precisar de outro app. Roda no seu navegador, nada vai pra nuvem e funciona com o GPS que sua dashcam já gravou.",
            "breadcrumbName": "Adicionar sobreposição de dados",
            "introHeading": "Velocidade e localização, embutidas na imagem",
            "introBody": "Sozinho, um clipe de dashcam não mostra a que velocidade você ia nem onde estava. O everydashcam lê o GPS que sua câmera salvou e desenha isso no vídeo exportado: a leitura da velocidade, suas coordenadas e um mapinha que se move com o trajeto. Os dados fazem parte da imagem, então ficam visíveis onde quer que o arquivo seja reproduzido — sem precisar de um player especial.",
            "introBody2": "Tudo acontece no seu navegador. Suas gravações são lidas localmente e a sobreposição é renderizada no seu dispositivo; o vídeo pronto é salvo direto no seu computador.",
            "optionsHeading": "O que dá pra sobrepor",
            "options": [
                {
                    "name": "Velocidade",
                    "desc": "Uma leitura limpa da velocidade em km/h ou mph, desenhada no canto que você escolher."
                },
                {
                    "name": "Coordenadas",
                    "desc": "Sua latitude e longitude GPS, atualizadas conforme o trajeto avança."
                },
                {
                    "name": "Mapa em movimento",
                    "desc": "Um mapinha que segue o trajeto — arraste pra onde quiser e defina o nível de zoom."
                },
                {
                    "name": "Marca d'água",
                    "desc": "Uma marquinha opcional num canto do quadro."
                }
            ],
            "howHeading": "Como adicionar a sobreposição",
            "howSteps": [
                "Arraste a pasta do cartão SD pra everydashcam.app e abra a viagem.",
                "Abra a exportação e ligue as sobreposições que quiser — velocidade, coordenadas, o mapa em movimento.",
                "Arraste cada uma pro lugar certo e escolha o trecho pra salvar.",
                "Salve — a sobreposição é renderizada no vídeo e gravada direto no seu computador."
            ],
            "brandsHeading": "Grátis, no navegador, pra gravações de dashcam",
            "brandsBody": "Gravar velocidade e um mapa no vídeo costuma ser tarefa de programas pagos de desktop feitos pra câmeras de ação. O everydashcam faz a versão pra dashcam de graça, numa aba do navegador: lê o GPS de 70mai, BlackVue, Viofo, Garmin, Vantrue e outras, e desenha velocidade, coordenadas e um mapa em movimento na exportação — sem instalar, sem conta, nada vai pra nuvem.",
            "noteHeading": "Bom saber",
            "noteBody": "A sobreposição precisa de GPS na sua gravação — se um registro não tem trajeto GPS, não há o que desenhar. Além de velocidade, coordenadas e o mapa em movimento, ela também pode mostrar a hora, sua direção, a distância percorrida e uma leitura de força G — tudo calculado a partir do mesmo GPS, não de um sensor separado. A renderização recodifica o vídeo, então um trecho longo leva um tempinho; Chrome, Edge ou outro navegador Chromium num computador é o mais tranquilo.",
            "faqHeading": "Perguntas frequentes",
            "faq": [
                {
                    "q": "Como adiciono uma sobreposição de velocidade ao vídeo da dashcam?",
                    "a": "Abra a viagem, vá em exportar e ligue a sobreposição de velocidade. O everydashcam lê o GPS que sua câmera gravou e grava a leitura da velocidade (km/h ou mph) no vídeo exportado. Você pode colocá-la em qualquer canto."
                },
                {
                    "q": "Dá pra mostrar coordenadas GPS e um mapa no vídeo?",
                    "a": "Dá. Junto da velocidade você pode sobrepor sua latitude e longitude e um mapinha em movimento que segue o trajeto. Arraste cada um pra onde quiser e defina o nível de zoom do mapa."
                },
                {
                    "q": "Precisa de GPS na gravação?",
                    "a": "Precisa. A sobreposição é desenhada a partir do GPS que sua dashcam salvou. Se um clipe não tem trajeto GPS, não há o que sobrepor — o vídeo continua sendo exportado, só que sem velocidade, coordenadas ou o mapa."
                },
                {
                    "q": "Meu vídeo vai pra nuvem?",
                    "a": "Não. A sobreposição é renderizada localmente no seu navegador e o vídeo pronto é salvo direto no seu computador."
                },
                {
                    "q": "Dá pra mostrar a hora, a direção ou a força G também?",
                    "a": "Dá. Junto da velocidade, das coordenadas e do mapa você pode adicionar a hora, uma direção de bússola, a distância percorrida e uma leitura de força G. A força G é calculada a partir do seu GPS — de como sua velocidade e direção mudam — e não de um sensor separado, então ela precisa de GPS na gravação, como o resto."
                }
            ],
            "ctaPrimary": "Abrir suas gravações"
        },
        "zh": {
            "title": "给行车记录仪视频叠加数据 — 速度、GPS 和地图 | everydashcam",
            "metaDescription": "把速度、GPS 坐标和移动地图烧进行车记录仪视频 — 免费，在浏览器里完成，不上传。录像里有 GPS 就能用。支持 70mai、BlackVue、Viofo 等。",
            "ogTitle": "给行车记录仪视频叠加速度、GPS 和地图",
            "ogDescription": "把速度、坐标和移动地图烧进导出的视频里 — 免费，在浏览器里完成，不上传。",
            "h1": "给行车记录仪视频叠加速度、GPS 和地图",
            "lead": "everydashcam 能把你的速度、GPS 坐标和一张会动的小地图直接烧进导出的视频里 — 清爽的读数嵌进画面，而不是另开一个 App。它在你的浏览器里跑，什么都不上传，用的就是你行车记录仪本来已经录下的 GPS。",
            "breadcrumbName": "叠加数据",
            "introHeading": "速度和位置，嵌进画面里",
            "introBody": "光看一段行车记录仪片段，看不出你当时开多快、人在哪儿。everydashcam 读出记录仪存下的 GPS，把它画到导出的视频上：一个速度读数、你的坐标，还有一张随路线移动的小地图。这些数据是画面的一部分，所以无论在哪儿播都看得见 — 不用什么专门的播放器。",
            "introBody2": "一切都在你的浏览器里完成。你的录像在本地被读取，叠加层在你的设备上渲染；做好的视频直接存到你的电脑上。",
            "optionsHeading": "可以叠加什么",
            "options": [
                {
                    "name": "速度",
                    "desc": "一个清爽的速度读数，单位 km/h 或 mph，画在你选的那个角上。"
                },
                {
                    "name": "坐标",
                    "desc": "你的 GPS 经纬度，随路线移动实时更新。"
                },
                {
                    "name": "移动地图",
                    "desc": "一张跟着路线走的小地图 — 拖到你想要的位置，再设它放大多少。"
                },
                {
                    "name": "水印",
                    "desc": "可选，在画面一角加一个小标记。"
                }
            ],
            "howHeading": "怎么加叠加层",
            "howSteps": [
                "把 SD 卡的文件夹拖到 everydashcam.app 上，打开行程。",
                "打开导出，把你想要的叠加层打开 — 速度、坐标、移动地图。",
                "把每个都拖到该放的位置，再选要保存的区间。",
                "保存 — 叠加层会渲染到视频上，直接写到你的电脑里。"
            ],
            "brandsHeading": "免费，在浏览器里，专为行车记录仪录像",
            "brandsBody": "把速度和地图烧进视频，通常是那些为运动相机做的付费桌面工具的活儿。everydashcam 把行车记录仪这一版做成免费的，就在一个浏览器标签页里：它从 70mai、BlackVue、Viofo、Garmin、Vantrue 等设备里读出 GPS，把速度、坐标和移动地图画到导出的视频上 — 不用安装，不用账号，什么都不上传。",
            "noteHeading": "提前说明",
            "noteBody": "叠加层需要你录像里有 GPS — 如果某段录像没有 GPS 轨迹，就没什么可画的。除了速度、坐标和移动地图，它还能显示时间、你的方向、行驶里程和 G 值读数 — 这些都从同一份 GPS 算出来，不靠单独的传感器。渲染会重新编码视频，所以区间长一点就得花点时间；在电脑上用 Chrome、Edge 或别的 Chromium 浏览器最顺畅。",
            "faqHeading": "常见问题",
            "faq": [
                {
                    "q": "怎么给行车记录仪视频加速度叠加？",
                    "a": "打开行程，进入导出，把速度叠加打开。everydashcam 会读出记录仪录下的 GPS，把速度读数（km/h 或 mph）烧进导出的视频里。你可以把它放在任意一个角上。"
                },
                {
                    "q": "能在视频上显示 GPS 坐标和地图吗？",
                    "a": "能。除了速度，你还能叠加经纬度，以及一张跟着路线走的移动小地图。把每个都拖到你想要的位置，再设地图放大多少。"
                },
                {
                    "q": "录像里一定要有 GPS 吗？",
                    "a": "是的。叠加层是根据你行车记录仪存下的 GPS 画出来的。如果某段片段没有 GPS 轨迹，就没什么可叠加的 — 视频照样能导出，只是没有速度、坐标和地图。"
                },
                {
                    "q": "我的视频会被上传吗？",
                    "a": "不会。叠加层在你的浏览器里本地渲染，做好的视频直接存到你的电脑上。"
                },
                {
                    "q": "也能显示时间、方向或 G 值吗？",
                    "a": "能。除了速度、坐标和地图，你还能加上时间、罗盘方向、行驶里程和 G 值读数。G 值是从你的 GPS 算出来的 — 看你的速度和方向怎么变 — 而不是靠单独的传感器，所以和其他读数一样，它也需要录像里有 GPS。"
                }
            ],
            "ctaPrimary": "打开你的录像"
        }
    },
    "blur-license-plate-in-dashcam-video": {
        "de": {
            "title": "Kennzeichen & Gesichter im Dashcam-Video unkenntlich machen — kostenlos, im Browser | everydashcam",
            "metaDescription": "Kennzeichen und Gesichter im Dashcam-Video verpixeln, bevor du es teilst — kostenlos, im Browser, nichts wird hochgeladen. Die Abdeckung folgt dem Objekt automatisch.",
            "ogTitle": "Kennzeichen im Dashcam-Video verpixeln — kostenlos",
            "ogDescription": "Verpixle ein Kennzeichen oder ein Gesicht, lass die Abdeckung automatisch folgen und speichere den Clip — kostenlos, im Browser, nichts wird hochgeladen.",
            "h1": "Kennzeichen und Gesichter in deinem Dashcam-Video unkenntlich machen",
            "lead": "Dashcam-Aufnahmen zu posten heißt meistens, das Kennzeichen von jemandem — oder das Gesicht eines Passanten — dem ganzen Internet zu zeigen. everydashcam deckt beides ab, bevor du teilst: Zieh einen Rahmen über Kennzeichen oder Gesicht, lass ihn dem Objekt folgen und speichere den Clip mit fest eingebrannter Abdeckung. Alles läuft im Browser, dein Video verlässt dein Gerät also nie.",
            "breadcrumbName": "Kennzeichen & Gesichter verbergen",
            "introHeading": "Zeig den Vorfall, nicht die Unbeteiligten",
            "introBody": "Ein Fall für die Versicherung, eine Anzeige, ein Clip fürs Forum — der Vorfall zählt, die Identitäten drumherum nicht. Eine eingebrannte Abdeckung hält fremde Kennzeichen und die Gesichter von Passanten raus: Die Pixel selbst werden ersetzt, es gibt also keine versteckte Ebene, die sich in der gespeicherten Datei wieder ablösen ließe.",
            "introBody2": "everydashcam verarbeitet Videos lokal, sodass die Originalaufnahme auf deinem Gerät bleibt. Das Abdecken passiert direkt im Browser-Tab, und das fertige Video wird direkt auf deinem Computer gespeichert.",
            "optionsHeading": "Was du machen kannst",
            "options": [
                {
                    "name": "Verpixeln",
                    "desc": "Ein grobes Mosaik über dem Bereich — die empfohlene Abdeckung: eindeutig gewollt und kaum rückgängig zu machen."
                },
                {
                    "name": "Deckende Füllung",
                    "desc": "Eine undurchsichtige Fläche, die den Bereich komplett verbirgt."
                },
                {
                    "name": "Weiche Unschärfe",
                    "desc": "Ein sanfter Weichzeichner — sieht am schönsten aus, verbirgt aber am wenigsten; nimm ihn für die Optik, nicht für die Privatsphäre."
                },
                {
                    "name": "Dem Objekt folgen",
                    "desc": "Markiere ein Kennzeichen oder Gesicht einmal, und die Abdeckung verfolgt es durch den Clip — jederzeit von Hand korrigierbar."
                },
                {
                    "name": "Feste Zone",
                    "desc": "Hefte eine Abdeckung für einen Zeitraum an eine Stelle — für dein eigenes Kennzeichen, eine Spiegelung oder ein Display im Innenraum."
                }
            ],
            "howHeading": "So machst du ein Kennzeichen oder Gesicht unkenntlich",
            "howSteps": [
                "Steck die SD-Karte in deinen Computer und zieh den ganzen Ordner auf everydashcam.app.",
                "Öffne die Fahrt, öffne den Export und wähl den Bereich, den du speichern willst.",
                "Leg eine Zone über das Kennzeichen oder Gesicht — lass sie dem Objekt folgen oder hefte sie fest und stell den Zeitraum von Hand ein.",
                "Speichern — die Abdeckung wird fest ins Video gerechnet, und die Datei landet direkt auf deinem Computer."
            ],
            "brandsHeading": "Funktioniert mit Aufnahmen jeder Dashcam",
            "brandsBody": "Ein Kennzeichen unkenntlich zu machen ist normalerweise ein Job für einen Videoeditor mit Tracking-Plugin — schweres Gerät für einen 30-Sekunden-Clip. everydashcam erledigt das auf derselben Seite, auf der du deine Fahrten ansiehst: Es liest Aufnahmen von 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase und Dutzenden mehr, und die Abdeckung wird über das Bild selbst gezeichnet — sie funktioniert also gleich, egal welche Kamera die Datei geschrieben hat.",
            "noteHeading": "Gut zu wissen",
            "noteBody": "Das automatische Folgen lädt beim ersten Mal eine kleine Hilfsdatei herunter (es fragt vorher) und funktioniert danach offline. Es verfolgt ein Objekt pro Zone und kann es in schwierigen Fällen verlieren — Blendung, Dunkelheit, schnelle Bewegung —, also wirf vor dem Teilen kurz einen Blick aufs Ergebnis; den Rahmen kannst du jederzeit von Hand verschieben. Beim Speichern wird das Video neu kodiert, und am vollständigsten läuft der Editor in Chrome, Edge oder einem anderen Chromium-Browser am Computer. Für echte Privatsphäre nimm das Verpixeln oder die deckende Füllung — die weiche Unschärfe ist die schwächste der drei.",
            "faqHeading": "Häufige Fragen",
            "faq": [
                {
                    "q": "Wie mache ich ein Kennzeichen in Dashcam-Aufnahmen unkenntlich?",
                    "a": "Öffne die Fahrt, öffne den Export und zieh eine Zone über das Kennzeichen. Die Abdeckung kann dem Auto automatisch durchs Bild folgen. Wähl den Bereich, speichere — die Abdeckung ist fest ins gespeicherte Video eingebrannt."
                },
                {
                    "q": "Kann die Abdeckung einem fahrenden Auto automatisch folgen?",
                    "a": "Ja. Markiere Kennzeichen oder Gesicht einmal, und die Abdeckung verfolgt das Objekt in Bewegung. Verrutscht sie oder verliert sie das Objekt, siehst du es in der Vorschau — verschieb den Rahmen jederzeit von Hand, deine Korrekturen haben Vorrang."
                },
                {
                    "q": "Lässt sich die Abdeckung aus dem gespeicherten Video wieder entfernen?",
                    "a": "Die Abdeckung wird in die Pixel der gespeicherten Datei gerechnet — es gibt keine separate Ebene zum Ausschalten. Verpixeln und die deckende Füllung sind kaum rückgängig zu machen; die weiche Unschärfe ist die schwächste der drei, nimm für Privatsphäre lieber die anderen beiden."
                },
                {
                    "q": "Wird mein Video zum Abdecken hochgeladen?",
                    "a": "Nein. Die Aufnahme wird lokal gelesen, das Folgen läuft auf deinem Gerät, und das fertige Video wird direkt auf deinem Computer gespeichert."
                },
                {
                    "q": "Ist es kostenlos?",
                    "a": "Ja — kostenlos, ohne Anmeldung, nichts zu installieren. Seite öffnen, Ordner draufziehen, abdecken und speichern."
                }
            ],
            "ctaPrimary": "Aufnahmen öffnen"
        },
        "es": {
            "title": "Difuminar matrículas y caras en vídeos de dashcam — gratis, en tu navegador | everydashcam",
            "metaDescription": "Difumina o pixela matrículas y caras en el vídeo de tu dashcam antes de compartirlo — gratis, en tu navegador, sin subir nada. La máscara sigue sola al objeto y queda grabada en el archivo.",
            "ogTitle": "Difumina matrículas y caras en tu dashcam — gratis",
            "ogDescription": "Pixela una matrícula o una cara, deja que la máscara la siga sola y guarda el clip — gratis, en tu navegador, sin subir nada.",
            "h1": "Difumina matrículas y caras en el vídeo de tu dashcam",
            "lead": "Publicar imágenes de la dashcam suele significar enseñar la matrícula de alguien — o la cara de un peatón — a todo internet. everydashcam las tapa antes de compartir: dibuja un recuadro sobre la matrícula o la cara, deja que siga al objeto mientras se mueve y guarda el clip con la máscara grabada en la imagen. Funciona en tu navegador, así que el vídeo nunca sale de tu dispositivo.",
            "breadcrumbName": "Difuminar matrículas y caras",
            "introHeading": "Comparte el incidente, no a los demás",
            "introBody": "Un parte para el seguro, una denuncia, un clip para un foro — lo que importa es el incidente, no las identidades de alrededor. Una máscara grabada deja fuera las matrículas de otros conductores y las caras de los peatones: se sustituyen los propios píxeles, así que en el archivo guardado no hay ninguna capa oculta que se pueda quitar.",
            "introBody2": "everydashcam procesa los vídeos en local, así que la grabación original se queda en tu dispositivo. El tapado ocurre directamente en la pestaña del navegador, y el vídeo final se guarda directamente en tu ordenador.",
            "optionsHeading": "Qué puedes hacer",
            "options": [
                {
                    "name": "Píxeles",
                    "desc": "Un mosaico grueso sobre la zona — la opción recomendada: claramente deliberada y difícil de revertir."
                },
                {
                    "name": "Relleno sólido",
                    "desc": "Un relleno opaco que oculta la zona por completo."
                },
                {
                    "name": "Difuminado suave",
                    "desc": "Un desenfoque ligero — es el que mejor queda pero el que menos oculta; úsalo por estética, no por privacidad."
                },
                {
                    "name": "Seguir al objeto",
                    "desc": "Marca una matrícula o una cara una vez y la máscara la sigue por todo el clip — corrígela a mano en cualquier momento."
                },
                {
                    "name": "Zona fija",
                    "desc": "Fija una máscara en un punto durante un rango de tiempo — para tu propia matrícula, un reflejo o una pantalla en la cabina."
                }
            ],
            "howHeading": "Cómo difuminar una matrícula o una cara",
            "howSteps": [
                "Conecta la tarjeta SD al ordenador y suelta la carpeta entera en everydashcam.app.",
                "Abre el trayecto, abre la exportación y elige el rango que quieres guardar.",
                "Añade una zona sobre la matrícula o la cara — deja que siga al objeto, o fíjala en un punto y ajusta su rango de tiempo a mano.",
                "Guarda — la máscara se graba en el vídeo y el archivo se escribe directamente en tu ordenador."
            ],
            "brandsHeading": "Funciona con las grabaciones de cualquier dashcam",
            "brandsBody": "Difuminar una matrícula suele ser trabajo de un editor de vídeo con plugin de seguimiento — artillería pesada para un clip de 30 segundos. everydashcam lo hace en la misma página donde ves tus trayectos: lee grabaciones de 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase y decenas más, y la máscara se dibuja sobre la propia imagen — así que funciona igual sin importar qué cámara escribió el archivo.",
            "noteHeading": "Conviene saberlo",
            "noteBody": "El seguimiento automático descarga un pequeño archivo auxiliar la primera vez que lo usas (pide permiso antes) y después funciona sin conexión. Sigue un objeto por zona y puede perderlo en casos difíciles — reflejos, oscuridad, movimiento rápido —, así que echa un vistazo rápido al resultado antes de compartir; siempre puedes mover el recuadro a mano. Al guardar, el vídeo se recodifica, y el editor funciona al completo en Chrome, Edge u otro navegador Chromium en un ordenador. Para privacidad de verdad, elige los píxeles o el relleno sólido — el difuminado suave es el más débil de los tres.",
            "faqHeading": "Preguntas frecuentes",
            "faq": [
                {
                    "q": "¿Cómo difumino una matrícula en la grabación de mi dashcam?",
                    "a": "Abre el trayecto, abre la exportación y dibuja una zona sobre la matrícula. La máscara puede seguir sola al coche mientras se mueve por el cuadro. Elige el rango, guarda — el difuminado queda grabado en el vídeo guardado."
                },
                {
                    "q": "¿La máscara puede seguir sola a un coche en movimiento?",
                    "a": "Sí. Marca la matrícula o la cara una vez y la máscara la sigue en movimiento. Si se desvía o pierde el objeto, lo verás en la vista previa — mueve el recuadro a mano en cualquier momento, tus correcciones tienen prioridad."
                },
                {
                    "q": "¿Se puede quitar el difuminado del vídeo guardado?",
                    "a": "La máscara se graba en los propios píxeles del archivo guardado — no hay ninguna capa aparte que se pueda desactivar. Los píxeles y el relleno sólido son difíciles de revertir; el difuminado suave es el más débil de los tres, así que para privacidad elige los otros dos."
                },
                {
                    "q": "¿Mi vídeo se sube a algún sitio para difuminarlo?",
                    "a": "No. La grabación se lee en local, el seguimiento se ejecuta en tu dispositivo y el vídeo final se guarda directamente en tu ordenador."
                },
                {
                    "q": "¿Es gratis?",
                    "a": "Sí — gratis, sin registro, sin instalar nada. Abre la página, suelta tu carpeta, difumina y guarda."
                }
            ],
            "ctaPrimary": "Abre tus grabaciones"
        },
        "fr": {
            "title": "Flouter une plaque d'immatriculation ou un visage sur une vidéo de dashcam — gratuit, dans ton navigateur | everydashcam",
            "metaDescription": "Floute ou pixellise plaques et visages sur ta vidéo de dashcam avant de partager — gratuit, dans ton navigateur, rien n'est envoyé. Le masque suit l'objet tout seul et s'incruste dans le fichier.",
            "ogTitle": "Flouter plaques et visages — dashcam, gratuit",
            "ogDescription": "Pixellise une plaque ou un visage, laisse le masque le suivre tout seul et enregistre le clip — gratuit, dans ton navigateur, rien n'est envoyé.",
            "h1": "Floute les plaques et les visages sur ta vidéo de dashcam",
            "lead": "Publier des images de dashcam, c'est souvent montrer la plaque de quelqu'un — ou le visage d'un passant — à tout internet. everydashcam les couvre avant le partage : dessine un cadre sur la plaque ou le visage, laisse-le suivre l'objet dans l'image et enregistre le clip avec le masque incrusté. Tout se passe dans ton navigateur, donc la vidéo ne quitte jamais ton appareil.",
            "breadcrumbName": "Flouter plaques et visages",
            "introHeading": "Partage l'incident, pas les passants",
            "introBody": "Un dossier d'assurance, un dépôt de plainte, un clip pour un forum — c'est l'incident qui compte, pas les identités autour. Un masque incrusté garde les plaques des autres conducteurs et les visages des piétons hors de l'image : les pixels eux-mêmes sont remplacés, il n'y a donc aucune couche cachée à retirer dans le fichier enregistré.",
            "introBody2": "everydashcam traite les vidéos en local, donc l'enregistrement original reste sur ton appareil. Le masquage se fait directement dans l'onglet du navigateur, et la vidéo finale est enregistrée directement sur ton ordinateur.",
            "optionsHeading": "Ce que tu peux faire",
            "options": [
                {
                    "name": "Pixellisation",
                    "desc": "Une mosaïque grossière sur la zone — le masque recommandé : clairement volontaire et difficile à annuler."
                },
                {
                    "name": "Aplat opaque",
                    "desc": "Un remplissage opaque qui cache la zone complètement."
                },
                {
                    "name": "Flou léger",
                    "desc": "Un flou doux — le plus joli mais celui qui cache le moins ; à réserver à l'esthétique, pas à la vie privée."
                },
                {
                    "name": "Suivre l'objet",
                    "desc": "Marque une plaque ou un visage une fois et le masque le suit tout au long du clip — corrige-le à la main à tout moment."
                },
                {
                    "name": "Zone fixe",
                    "desc": "Épingle un masque à un endroit pour une plage de temps — pour ta propre plaque, un reflet ou un écran dans l'habitacle."
                }
            ],
            "howHeading": "Comment flouter une plaque ou un visage",
            "howSteps": [
                "Branche la carte SD sur ton ordinateur et dépose tout le dossier sur everydashcam.app.",
                "Ouvre le trajet, ouvre l'export et sélectionne la plage à enregistrer.",
                "Ajoute une zone de floutage sur la plaque ou le visage — laisse-la suivre l'objet, ou épingle-la et règle sa plage de temps à la main.",
                "Enregistre — le masque est incrusté dans la vidéo et le fichier est écrit directement sur ton ordinateur."
            ],
            "brandsHeading": "Fonctionne avec les images de n'importe quelle dashcam",
            "brandsBody": "Flouter une plaque, c'est d'habitude le travail d'un éditeur vidéo avec un plugin de tracking — l'artillerie lourde pour un clip de 30 secondes. everydashcam le fait sur la même page où tu regardes tes trajets : il lit les enregistrements 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase et des dizaines d'autres, et le masque est dessiné sur l'image elle-même — il fonctionne donc pareil quelle que soit la caméra qui a écrit le fichier.",
            "noteHeading": "Bon à savoir",
            "noteBody": "Le suivi automatique télécharge un petit fichier d'appoint à la première utilisation (il demande d'abord) puis fonctionne hors ligne. Il suit un objet par zone et peut le perdre dans les cas difficiles — reflets, obscurité, mouvement rapide — alors jette un œil au résultat avant de partager ; tu peux toujours déplacer le cadre à la main. L'enregistrement réencode la vidéo, et l'éditeur est le plus complet dans Chrome, Edge ou un autre navigateur Chromium sur un ordinateur. Pour une vraie confidentialité, préfère la pixellisation ou l'aplat opaque — le flou léger est le plus faible des trois.",
            "faqHeading": "FAQ",
            "faq": [
                {
                    "q": "Comment flouter une plaque d'immatriculation sur une vidéo de dashcam ?",
                    "a": "Ouvre le trajet, ouvre l'export et dessine une zone de floutage sur la plaque. Le masque peut suivre la voiture tout seul dans l'image. Sélectionne la plage, enregistre — le floutage est incrusté dans la vidéo enregistrée."
                },
                {
                    "q": "Le masque peut-il suivre une voiture en mouvement tout seul ?",
                    "a": "Oui. Marque la plaque ou le visage une fois et le masque suit l'objet dans ses déplacements. S'il dérive ou perd l'objet, tu le verras dans l'aperçu — déplace le cadre à la main à tout moment, tes corrections ont la priorité."
                },
                {
                    "q": "Peut-on retirer le floutage de la vidéo enregistrée ?",
                    "a": "Le masque est incrusté dans les pixels mêmes du fichier enregistré — il n'y a pas de couche séparée à désactiver. La pixellisation et l'aplat opaque sont difficiles à annuler ; le flou léger est le plus faible des trois, préfère donc les deux autres pour la vie privée."
                },
                {
                    "q": "Ma vidéo est-elle envoyée quelque part pour le floutage ?",
                    "a": "Non. L'enregistrement est lu en local, le suivi tourne sur ton appareil, et la vidéo finale est enregistrée directement sur ton ordinateur."
                },
                {
                    "q": "Est-ce gratuit ?",
                    "a": "Oui — gratuit, sans inscription, rien à installer. Ouvre la page, dépose ton dossier, floute et enregistre."
                }
            ],
            "ctaPrimary": "Ouvrir tes enregistrements"
        },
        "ja": {
            "title": "ドラレコ映像のナンバープレートや顔にぼかしを入れる — 無料、ブラウザだけで | everydashcam",
            "metaDescription": "共有する前に、ドラレコ映像のナンバープレートや顔をぼかし・モザイクで隠せます。無料、ブラウザだけで、どこにもアップロードしません。カバーは対象を自動で追いかけ、保存ファイルに焼き込まれます。",
            "ogTitle": "ドラレコのナンバーや顔をぼかす — 無料",
            "ogDescription": "ナンバーや顔にモザイクをかけ、カバーに自動で追いかけさせて、クリップを保存。無料、ブラウザだけで、どこにもアップロードしません。",
            "h1": "ドラレコ映像のナンバープレートや顔をぼかす",
            "lead": "ドラレコの映像を公開するということは、誰かのナンバー — あるいは通行人の顔 — をインターネット全体に見せることになりがちです。everydashcamは共有する前にそれを隠します。ナンバーや顔の上に枠を描き、動く対象を自動で追いかけさせて、カバーが焼き込まれた状態でクリップを保存。すべてブラウザの中で動くので、動画がお使いの端末を離れることはありません。",
            "breadcrumbName": "ナンバーや顔をぼかす",
            "introHeading": "見せるのは出来事だけ、周りの人は写さない",
            "introBody": "保険の申請、警察への提出、フォーラムへの投稿 — 大事なのは出来事そのもので、周りの人の身元ではありません。焼き込まれたカバーなら、他の車のナンバーや歩行者の顔を映像から外せます。ピクセルそのものが置き換わるため、保存したファイルに剥がせる隠しレイヤーは残りません。",
            "introBody2": "everydashcamは動画をローカルで処理するため、元の録画はお使いの端末に残ったままです。隠す処理はブラウザのタブの中で行われ、完成した動画はそのままパソコンに保存されます。",
            "optionsHeading": "できること",
            "options": [
                {
                    "name": "モザイク",
                    "desc": "領域を粗いモザイクで覆います — おすすめのカバーです。意図的なのがひと目で分かり、元に戻すのはほぼ不可能です。"
                },
                {
                    "name": "塗りつぶし",
                    "desc": "領域を完全に隠す不透明なカバーです。"
                },
                {
                    "name": "軽いぼかし",
                    "desc": "やわらかなぼかし — 見た目は一番きれいですが、隠す力は一番弱め。見栄え用で、プライバシー用ではありません。"
                },
                {
                    "name": "対象を追いかける",
                    "desc": "ナンバーや顔を一度マークすれば、カバーがクリップの中でずっと追いかけます — いつでも手で修正できます。"
                },
                {
                    "name": "固定ゾーン",
                    "desc": "指定した時間だけ、決まった場所にカバーを固定します — 自分のナンバー、映り込み、車内の画面などに。"
                }
            ],
            "howHeading": "ナンバーや顔をぼかす手順",
            "howSteps": [
                "SDカードをパソコンに挿し、フォルダーごとeverydashcam.appにドロップします。",
                "走行を開き、エクスポートを開いて、保存したい範囲を選びます。",
                "ナンバーや顔の上にぼかしゾーンを追加します — 対象を自動で追いかけさせるか、位置を固定して時間範囲を手で設定します。",
                "保存します — カバーは動画に焼き込まれ、ファイルはそのままパソコンに書き出されます。"
            ],
            "brandsHeading": "どのドラレコの映像でも使えます",
            "brandsBody": "ナンバーをぼかすのは、普通ならトラッキングプラグイン入りの動画編集ソフトの仕事 — 30秒のクリップには大げさすぎる道具です。everydashcamは走行を見るのと同じページでそれをこなします。70mai、BlackVue、Viofo、Garmin、Vantrue、Nextbaseをはじめ数十種類の録画を読み込め、カバーは画像そのものの上に描かれます — どのカメラが書いたファイルでも同じように動きます。",
            "noteHeading": "知っておきたいこと",
            "noteBody": "自動追跡は初回だけ小さな補助ファイルをダウンロードし（事前に確認します）、以降はオフラインで動きます。1つのゾーンにつき1つの対象を追いかけますが、逆光・暗さ・速い動きなど難しい場面では見失うことがあります。共有する前に結果をさっと確認してください。枠はいつでも手で動かせます。保存時に動画は再エンコードされ、エディターが最も充実するのはパソコンのChromeやEdgeなどChromium系ブラウザです。本当にプライバシーを守りたいなら、モザイクか塗りつぶしを — 軽いぼかしは3つの中で一番弱い選択肢です。",
            "faqHeading": "よくある質問",
            "faq": [
                {
                    "q": "ドラレコ映像のナンバープレートはどうやってぼかしますか？",
                    "a": "走行を開き、エクスポートを開いて、ナンバーの上にぼかしゾーンを描きます。カバーはフレーム内を動く車を自動で追いかけられます。範囲を選んで保存すれば、ぼかしは保存した動画に焼き込まれています。"
                },
                {
                    "q": "動いている車をカバーが自動で追いかけられますか？",
                    "a": "はい。ナンバーや顔を一度マークすれば、カバーが動きに合わせて追いかけます。ずれたり対象を見失ったりすればプレビューで分かります — 枠はいつでも手で動かせて、手での修正が優先されます。"
                },
                {
                    "q": "保存した動画からぼかしを外せますか？",
                    "a": "カバーは保存ファイルのピクセルそのものに描き込まれます — オフにできる別レイヤーはありません。モザイクと塗りつぶしは元に戻すのがほぼ不可能です。軽いぼかしは3つの中で一番弱いので、プライバシー目的なら他の2つを選んでください。"
                },
                {
                    "q": "ぼかすために動画はアップロードされますか？",
                    "a": "いいえ。録画はローカルで読み込まれ、追跡はお使いの端末上で動き、完成した動画はそのままパソコンに保存されます。"
                },
                {
                    "q": "無料ですか？",
                    "a": "はい — 無料で、登録もインストールも不要です。ページを開いて、フォルダーをドロップして、ぼかして保存するだけです。"
                }
            ],
            "ctaPrimary": "映像を開く"
        },
        "ko": {
            "title": "블랙박스 영상 번호판·얼굴 블러 처리 — 무료, 브라우저에서 | everydashcam",
            "metaDescription": "공유하기 전에 블랙박스 영상의 차량 번호판과 얼굴을 블러·모자이크로 가려요 — 무료, 브라우저에서, 아무것도 업로드되지 않아요. 커버가 대상을 알아서 따라가고 저장 파일에 그대로 새겨져요.",
            "ogTitle": "블랙박스 영상 번호판·얼굴 블러 — 무료",
            "ogDescription": "번호판이나 얼굴에 모자이크를 씌우고, 커버가 알아서 따라가게 한 뒤 클립을 저장하세요 — 무료, 브라우저에서, 아무것도 업로드되지 않아요.",
            "h1": "블랙박스 영상의 번호판과 얼굴을 블러 처리하세요",
            "lead": "블랙박스 영상을 올린다는 건 보통 누군가의 번호판 — 또는 행인의 얼굴 — 을 온 인터넷에 보여준다는 뜻이에요. everydashcam는 공유 전에 그걸 가려요: 번호판이나 얼굴 위에 상자를 그리고, 움직이는 대상을 알아서 따라가게 한 다음, 커버가 화면에 새겨진 채로 클립을 저장하세요. 모두 브라우저에서 돌아가니 영상은 기기를 떠나지 않아요.",
            "breadcrumbName": "번호판·얼굴 블러",
            "introHeading": "사고만 보여주고, 지나가는 사람은 빼고",
            "introBody": "보험 청구, 경찰 신고, 커뮤니티에 올릴 클립 — 중요한 건 사고 자체지, 주변 사람들의 신원이 아니에요. 화면에 새겨진 커버는 다른 운전자의 번호판과 보행자의 얼굴을 영상에서 지워줘요: 픽셀 자체가 바뀌기 때문에, 저장된 파일에는 벗겨낼 수 있는 숨은 레이어가 없어요.",
            "introBody2": "everydashcam는 영상을 기기에서 처리하므로 원본 녹화는 기기에 그대로 남아요. 가리는 작업은 브라우저 탭 안에서 바로 이루어지고, 완성된 영상은 곧장 컴퓨터에 저장돼요.",
            "optionsHeading": "할 수 있는 것",
            "options": [
                {
                    "name": "픽셀 모자이크",
                    "desc": "영역 위에 굵은 모자이크를 씌워요 — 추천하는 커버예요: 의도가 분명하고 되돌리기 어려워요."
                },
                {
                    "name": "단색 채우기",
                    "desc": "영역을 완전히 가리는 불투명한 채우기예요."
                },
                {
                    "name": "살짝 흐리기",
                    "desc": "부드러운 블러 — 보기엔 제일 좋지만 가장 덜 가려요; 프라이버시용이 아니라 화면을 다듬는 용도예요."
                },
                {
                    "name": "대상 따라가기",
                    "desc": "번호판이나 얼굴을 한 번만 표시하면 커버가 클립 내내 따라가요 — 언제든 손으로 고칠 수 있어요."
                },
                {
                    "name": "고정 영역",
                    "desc": "정해진 시간 동안 한 자리에 커버를 고정해요 — 내 번호판, 반사, 차 안의 화면 같은 곳에요."
                }
            ],
            "howHeading": "번호판이나 얼굴을 가리는 방법",
            "howSteps": [
                "SD 카드를 컴퓨터에 꽂고 폴더 전체를 everydashcam.app에 끌어다 놓으세요.",
                "주행을 열고, 내보내기를 열고, 저장할 구간을 고르세요.",
                "번호판이나 얼굴 위에 블러 영역을 추가하세요 — 대상을 따라가게 하거나, 자리에 고정하고 시간 구간을 직접 정하세요.",
                "저장하세요 — 커버가 영상에 새겨지고 파일은 곧장 컴퓨터에 저장돼요."
            ],
            "brandsHeading": "어떤 블랙박스 영상이든 돼요",
            "brandsBody": "번호판을 가리는 건 보통 트래킹 플러그인이 달린 영상 편집기의 일이에요 — 30초짜리 클립에 쓰기엔 너무 무거운 도구죠. everydashcam는 주행을 보는 바로 그 페이지에서 해결해요: 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase 등 수십 종의 녹화를 읽고, 커버는 화면 자체 위에 그려져요 — 그래서 어떤 카메라가 기록한 파일이든 똑같이 동작해요.",
            "noteHeading": "알아두면 좋아요",
            "noteBody": "자동 따라가기는 처음 쓸 때 작은 보조 파일을 내려받고(먼저 물어봐요) 그 뒤로는 오프라인에서도 동작해요. 영역 하나당 대상 하나를 따라가고, 역광·어둠·빠른 움직임 같은 어려운 상황에서는 대상을 놓칠 수 있어요 — 공유 전에 결과를 한 번 훑어보세요; 상자는 언제든 손으로 옮길 수 있어요. 저장하면 영상이 다시 인코딩되고, 편집기는 컴퓨터의 Chrome, Edge 등 Chromium 브라우저에서 가장 온전하게 돌아가요. 진짜 프라이버시가 목적이라면 픽셀 모자이크나 단색 채우기를 고르세요 — 살짝 흐리기는 셋 중 가장 약해요.",
            "faqHeading": "자주 묻는 질문",
            "faq": [
                {
                    "q": "블랙박스 영상에서 번호판은 어떻게 가리나요?",
                    "a": "주행을 열고, 내보내기를 열고, 번호판 위에 블러 영역을 그리세요. 커버는 화면 속을 움직이는 차를 알아서 따라갈 수 있어요. 구간을 고르고 저장하면 블러가 저장된 영상에 그대로 새겨져요."
                },
                {
                    "q": "커버가 움직이는 차를 자동으로 따라가나요?",
                    "a": "네. 번호판이나 얼굴을 한 번만 표시하면 커버가 움직임을 따라가요. 어긋나거나 대상을 놓치면 미리보기에서 바로 보여요 — 언제든 상자를 손으로 옮기세요, 직접 고친 게 우선이에요."
                },
                {
                    "q": "저장된 영상에서 블러를 지울 수 있나요?",
                    "a": "커버는 저장 파일의 픽셀 자체에 새겨져요 — 끌 수 있는 별도 레이어가 없어요. 픽셀 모자이크와 단색 채우기는 되돌리기 어렵고, 살짝 흐리기는 셋 중 가장 약하니 프라이버시가 목적이라면 앞의 두 가지를 고르세요."
                },
                {
                    "q": "블러 처리를 하려면 영상이 업로드되나요?",
                    "a": "아니요. 녹화는 로컬에서 읽히고, 따라가기는 기기에서 돌아가고, 완성된 영상은 곧장 컴퓨터에 저장돼요."
                },
                {
                    "q": "무료인가요?",
                    "a": "네 — 무료예요. 가입도, 설치도 필요 없어요. 페이지를 열고, 폴더를 끌어다 놓고, 가리고, 저장하세요."
                }
            ],
            "ctaPrimary": "내 영상 열기"
        },
        "pl": {
            "title": "Zamazywanie tablic rejestracyjnych i twarzy na wideo z kamerki — za darmo, w przeglądarce | everydashcam",
            "metaDescription": "Zamaż tablice rejestracyjne i twarze na nagraniu z wideorejestratora przed udostępnieniem — za darmo, w przeglądarce, nic nie jest wysyłane. Zasłona sama podąża za obiektem.",
            "ogTitle": "Zamaż tablice i twarze na wideo z kamerki — za darmo",
            "ogDescription": "Spikseluj tablicę albo twarz, pozwól zasłonie samej podążać za obiektem i zapisz klip — za darmo, w przeglądarce, nic nie jest wysyłane.",
            "h1": "Zamaż tablice rejestracyjne i twarze na nagraniu z wideorejestratora",
            "lead": "Publikacja nagrania z kamerki zwykle oznacza pokazanie czyjejś tablicy — albo twarzy przechodnia — całemu internetowi. everydashcam zakrywa je przed udostępnieniem: narysuj ramkę na tablicy lub twarzy, pozwól jej podążać za obiektem w kadrze i zapisz klip z zasłoną wypaloną w obrazie. Wszystko działa w przeglądarce, więc wideo nigdy nie opuszcza twojego urządzenia.",
            "breadcrumbName": "Zamazywanie tablic i twarzy",
            "introHeading": "Pokaż zdarzenie, nie przypadkowych ludzi",
            "introBody": "Zgłoszenie do ubezpieczyciela, zawiadomienie na policję, klip na forum — liczy się zdarzenie, nie tożsamości wokół niego. Wypalona zasłona usuwa z kadru cudze tablice i twarze pieszych: podmieniane są same piksele, więc w zapisanym pliku nie ma ukrytej warstwy, którą dałoby się zdjąć.",
            "introBody2": "everydashcam przetwarza wideo lokalnie, więc oryginalne nagranie zostaje na twoim urządzeniu. Zamazywanie dzieje się prosto w karcie przeglądarki, a gotowe wideo zapisuje się od razu na komputerze.",
            "optionsHeading": "Co możesz zrobić",
            "options": [
                {
                    "name": "Piksele",
                    "desc": "Gruba mozaika na wybranym obszarze — zalecana zasłona: wyraźnie celowa i trudna do cofnięcia."
                },
                {
                    "name": "Jednolite wypełnienie",
                    "desc": "Nieprzezroczyste wypełnienie, które całkowicie zakrywa obszar."
                },
                {
                    "name": "Delikatne rozmycie",
                    "desc": "Miękkie rozmycie — wygląda najładniej, ale zakrywa najsłabiej; do kosmetyki, nie do prywatności."
                },
                {
                    "name": "Podążanie za obiektem",
                    "desc": "Zaznacz tablicę albo twarz raz, a zasłona poprowadzi ją przez cały klip — w każdej chwili poprawisz ją ręcznie."
                },
                {
                    "name": "Strefa stała",
                    "desc": "Przypnij zasłonę w jednym miejscu na wybrany czas — dla własnej tablicy, odbicia albo ekranu w kabinie."
                }
            ],
            "howHeading": "Jak zamazać tablicę albo twarz",
            "howSteps": [
                "Włóż kartę SD do komputera i upuść cały folder na everydashcam.app.",
                "Otwórz przejazd, otwórz eksport i zaznacz zakres, który chcesz zapisać.",
                "Dodaj strefę rozmycia na tablicy lub twarzy — pozwól jej podążać za obiektem albo przypnij ją w miejscu i ustaw zakres czasu ręcznie.",
                "Zapisz — zasłona zostaje wtopiona w wideo, a plik trafia prosto na twój komputer."
            ],
            "brandsHeading": "Działa z nagraniami z każdej kamerki",
            "brandsBody": "Zamazanie tablicy to zwykle robota dla edytora wideo z wtyczką do śledzenia — ciężki sprzęt jak na 30-sekundowy klip. everydashcam robi to na tej samej stronie, na której oglądasz przejazdy: czyta nagrania z 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase i dziesiątek innych, a zasłona jest rysowana na samym obrazie — działa więc tak samo niezależnie od tego, która kamera zapisała plik.",
            "noteHeading": "Warto wiedzieć",
            "noteBody": "Automatyczne podążanie przy pierwszym użyciu pobiera mały plik pomocniczy (najpierw pyta) i potem działa offline. Śledzi jeden obiekt na strefę i w trudnych warunkach — odblaski, ciemność, szybki ruch — może go zgubić, więc przed udostępnieniem rzuć okiem na wynik; ramkę zawsze możesz przesunąć ręcznie. Zapis ponownie koduje wideo, a edytor najpełniej działa w Chrome, Edge lub innej przeglądarce Chromium na komputerze. Dla prawdziwej prywatności wybieraj piksele albo jednolite wypełnienie — delikatne rozmycie jest najsłabsze z trzech.",
            "faqHeading": "Najczęstsze pytania",
            "faq": [
                {
                    "q": "Jak zamazać tablicę rejestracyjną na nagraniu z kamerki?",
                    "a": "Otwórz przejazd, otwórz eksport i narysuj strefę rozmycia na tablicy. Zasłona może sama podążać za autem poruszającym się w kadrze. Zaznacz zakres, zapisz — rozmycie zostaje wypalone w zapisanym wideo."
                },
                {
                    "q": "Czy zasłona sama podąży za jadącym autem?",
                    "a": "Tak. Zaznacz tablicę albo twarz raz, a zasłona poprowadzi obiekt w ruchu. Jeśli zjedzie albo zgubi obiekt, zobaczysz to w podglądzie — w każdej chwili przesuń ramkę ręcznie, twoje poprawki mają pierwszeństwo."
                },
                {
                    "q": "Czy da się usunąć rozmycie z zapisanego wideo?",
                    "a": "Zasłona jest wtopiona w same piksele zapisanego pliku — nie ma osobnej warstwy do wyłączenia. Piksele i jednolite wypełnienie trudno cofnąć; delikatne rozmycie jest najsłabsze z trzech, więc do prywatności wybieraj dwa pierwsze."
                },
                {
                    "q": "Czy moje wideo jest gdzieś wysyłane do zamazania?",
                    "a": "Nie. Nagranie jest czytane lokalnie, podążanie działa na twoim urządzeniu, a gotowe wideo zapisuje się prosto na komputerze."
                },
                {
                    "q": "Czy to darmowe?",
                    "a": "Tak — za darmo, bez rejestracji, bez instalowania. Otwórz stronę, upuść folder, zamaż i zapisz."
                }
            ],
            "ctaPrimary": "Otwórz swoje nagrania"
        },
        "pt": {
            "title": "Desfocar placa de carro e rostos em vídeo de dashcam — grátis, no navegador | everydashcam",
            "metaDescription": "Desfoque ou pixelize placas de carro e rostos no vídeo da sua dashcam antes de compartilhar — grátis, no navegador, sem enviar nada. A tarja segue sozinha o objeto e fica gravada no arquivo.",
            "ogTitle": "Desfocar placas e rostos em vídeo de dashcam — grátis",
            "ogDescription": "Pixelize uma placa ou um rosto, deixe a tarja seguir sozinha e salve o clipe — grátis, no navegador, sem enviar nada.",
            "h1": "Desfoque placas de carro e rostos no vídeo da sua dashcam",
            "lead": "Publicar imagens de dashcam geralmente significa mostrar a placa de alguém — ou o rosto de um pedestre — para a internet inteira. O everydashcam cobre tudo antes de você compartilhar: desenhe uma caixa sobre a placa ou o rosto, deixe-a seguir o objeto em movimento e salve o clipe com a tarja gravada na imagem. Roda no seu navegador, então o vídeo nunca sai do seu dispositivo.",
            "breadcrumbName": "Desfocar placas e rostos",
            "introHeading": "Compartilhe o incidente, não quem passava por ali",
            "introBody": "Um acionamento do seguro, um boletim de ocorrência, um clipe para um fórum — o que importa é o incidente, não as identidades ao redor. Uma tarja gravada mantém de fora as placas de outros motoristas e os rostos dos pedestres: os próprios pixels são substituídos, então não há camada oculta para remover no arquivo salvo.",
            "introBody2": "O everydashcam processa o vídeo localmente, então a gravação original fica no seu dispositivo. A cobertura acontece direto na aba do navegador, e o vídeo pronto é salvo direto no seu computador.",
            "optionsHeading": "O que dá pra fazer",
            "options": [
                {
                    "name": "Pixelizar",
                    "desc": "Um mosaico grosso sobre a área — a cobertura recomendada: claramente proposital e difícil de reverter."
                },
                {
                    "name": "Cobertura sólida",
                    "desc": "Um preenchimento opaco que esconde a área por completo."
                },
                {
                    "name": "Desfoque leve",
                    "desc": "Um borrado suave — é o mais bonito, mas o que menos esconde; use por estética, não por privacidade."
                },
                {
                    "name": "Seguir o objeto",
                    "desc": "Marque uma placa ou um rosto uma vez e a tarja o acompanha pelo clipe — corrija à mão a qualquer momento."
                },
                {
                    "name": "Zona fixa",
                    "desc": "Fixe uma tarja em um ponto por um intervalo de tempo — para a sua própria placa, um reflexo ou uma tela na cabine."
                }
            ],
            "howHeading": "Como desfocar uma placa ou um rosto",
            "howSteps": [
                "Coloque o cartão SD no computador e solte a pasta inteira em everydashcam.app.",
                "Abra a viagem, abra a exportação e escolha o trecho que quer salvar.",
                "Adicione uma zona de desfoque sobre a placa ou o rosto — deixe-a seguir o objeto, ou fixe-a no lugar e defina o intervalo de tempo à mão.",
                "Salve — a tarja é gravada no vídeo e o arquivo é escrito direto no seu computador."
            ],
            "brandsHeading": "Funciona com imagens de qualquer dashcam",
            "brandsBody": "Desfocar uma placa costuma ser trabalho para editor de vídeo com plugin de rastreamento — artilharia pesada para um clipe de 30 segundos. O everydashcam faz isso na mesma página em que você assiste às viagens: lê gravações de 70mai, BlackVue, Viofo, Garmin, Vantrue, Nextbase e dezenas de outras, e a tarja é desenhada sobre a própria imagem — então funciona igual, não importa qual câmera gravou o arquivo.",
            "noteHeading": "Bom saber",
            "noteBody": "O acompanhamento automático baixa um pequeno arquivo auxiliar no primeiro uso (ele pede antes) e depois funciona offline. Ele segue um objeto por zona e pode perdê-lo em casos difíceis — reflexos, escuridão, movimento rápido —, então dê uma olhada rápida no resultado antes de compartilhar; você sempre pode mover a caixa à mão. Salvar recodifica o vídeo, e o editor é mais completo no Chrome, Edge ou outro navegador Chromium no computador. Para privacidade de verdade, prefira a pixelização ou a cobertura sólida — o desfoque leve é o mais fraco dos três.",
            "faqHeading": "Perguntas frequentes",
            "faq": [
                {
                    "q": "Como desfocar uma placa de carro na gravação da dashcam?",
                    "a": "Abra a viagem, abra a exportação e desenhe uma zona de desfoque sobre a placa. A tarja pode seguir o carro sozinha enquanto ele se move no quadro. Escolha o trecho, salve — o desfoque fica gravado no vídeo salvo."
                },
                {
                    "q": "A tarja acompanha sozinha um carro em movimento?",
                    "a": "Sim. Marque a placa ou o rosto uma vez e a tarja acompanha o objeto em movimento. Se ela sair do lugar ou perder o objeto, você vê na prévia — mova a caixa à mão a qualquer momento, as suas correções têm prioridade."
                },
                {
                    "q": "Dá para remover o desfoque do vídeo salvo?",
                    "a": "A tarja é gravada nos próprios pixels do arquivo salvo — não existe camada separada para desligar. A pixelização e a cobertura sólida são difíceis de reverter; o desfoque leve é o mais fraco dos três, então prefira os outros dois para privacidade."
                },
                {
                    "q": "Meu vídeo é enviado para algum lugar para o desfoque?",
                    "a": "Não. A gravação é lida localmente, o acompanhamento roda no seu dispositivo e o vídeo pronto é salvo direto no seu computador."
                },
                {
                    "q": "É grátis?",
                    "a": "Sim — grátis, sem cadastro, nada para instalar. Abra a página, solte a sua pasta, desfoque e salve."
                }
            ],
            "ctaPrimary": "Abrir suas gravações"
        },
        "zh": {
            "title": "行车记录仪视频车牌、人脸打码 — 免费，浏览器里完成 | everydashcam",
            "metaDescription": "分享前给行车记录仪视频里的车牌和人脸打码 — 免费，在浏览器里完成，不上传任何内容。遮罩自动跟随目标移动，并直接烧录进保存的文件。",
            "ogTitle": "行车记录仪视频车牌人脸打码 — 免费",
            "ogDescription": "给车牌或人脸打上马赛克，遮罩自动跟随目标，保存片段 — 免费，在浏览器里完成，不上传任何内容。",
            "h1": "给行车记录仪视频里的车牌和人脸打码",
            "lead": "把行车记录仪的视频发出去，往往意味着把别人的车牌 — 或者路人的脸 — 展示给整个互联网。everydashcam 在分享前帮你遮住它们：在车牌或人脸上画一个框，让它自动跟随画面中的目标，保存片段时遮罩直接烧录进画面。一切都在浏览器里运行，视频从不离开你的设备。",
            "breadcrumbName": "车牌人脸打码",
            "introHeading": "分享事故本身，而不是路过的人",
            "introBody": "保险理赔、报警材料、发到论坛的片段 — 重要的是事故本身，不是周围人的身份。烧录进画面的遮罩能把其他车的车牌和行人的脸挡在外面：替换的是像素本身，所以保存的文件里没有任何可以揭掉的隐藏图层。",
            "introBody2": "everydashcam 在本地处理视频，原始录像一直留在你的设备上。打码就在浏览器标签页里完成，成品视频直接保存到你的电脑。",
            "optionsHeading": "你可以做什么",
            "options": [
                {
                    "name": "马赛克",
                    "desc": "在区域上打上粗颗粒马赛克 — 推荐的遮罩方式：意图明显，也很难还原。"
                },
                {
                    "name": "纯色覆盖",
                    "desc": "不透明的色块，把区域完全盖住。"
                },
                {
                    "name": "轻微模糊",
                    "desc": "柔和的虚化 — 看起来最好看，但遮得最少；适合美化画面，不适合保护隐私。"
                },
                {
                    "name": "自动跟随目标",
                    "desc": "只需标记一次车牌或人脸，遮罩就会在整个片段里跟着它 — 随时可以手动修正。"
                },
                {
                    "name": "固定区域",
                    "desc": "把遮罩钉在一个位置、限定一段时间 — 适合自己的车牌、反光或车内的屏幕。"
                }
            ],
            "howHeading": "如何给车牌或人脸打码",
            "howSteps": [
                "把 SD 卡插进电脑，把整个文件夹拖到 everydashcam.app。",
                "打开行程，打开导出，选好要保存的区间。",
                "在车牌或人脸上添加打码区域 — 让它自动跟随目标，或固定位置、手动设定时间区间。",
                "保存 — 遮罩被渲染进视频，文件直接写到你的电脑上。"
            ],
            "brandsHeading": "任何行车记录仪的录像都能用",
            "brandsBody": "给车牌打码通常得靠带跟踪插件的视频剪辑软件 — 为一段 30 秒的片段动用重型工具。everydashcam 在你看行程的同一个页面里就能搞定：它能读取 70mai、BlackVue、Viofo、Garmin、Vantrue、Nextbase 等数十种记录仪的录像，遮罩直接画在画面上 — 所以不管文件是哪台相机录的，效果都一样。",
            "noteHeading": "提前说明",
            "noteBody": "自动跟随第一次使用时会下载一个小的辅助文件（会先询问），之后离线也能用。它每个区域跟踪一个目标，在强光、黑暗、快速移动等困难场景可能跟丢 — 分享前快速检查一下结果；方框随时可以手动移动。保存会重新编码视频，编辑器在电脑上的 Chrome、Edge 或其他 Chromium 浏览器里功能最完整。想真正保护隐私，选马赛克或纯色覆盖 — 轻微模糊是三者中最弱的。",
            "faqHeading": "常见问题",
            "faq": [
                {
                    "q": "怎么给行车记录仪录像里的车牌打码？",
                    "a": "打开行程，打开导出，在车牌上画一个打码区域。遮罩可以自动跟着画面里移动的车。选好区间，保存 — 马赛克就烧录在保存的视频里了。"
                },
                {
                    "q": "遮罩能自动跟着行驶中的车吗？",
                    "a": "能。只需标记一次车牌或人脸，遮罩就会跟着它移动。如果它跑偏或跟丢了目标，在预览里一眼就能看出来 — 随时手动移动方框，你的修正优先。"
                },
                {
                    "q": "保存后的视频能去掉打码吗？",
                    "a": "遮罩直接渲染进保存文件的像素里 — 没有可以关掉的独立图层。马赛克和纯色覆盖很难还原；轻微模糊是三者中最弱的，要保护隐私请优先用前两种。"
                },
                {
                    "q": "打码时我的视频会被上传吗？",
                    "a": "不会。录像在本地读取，跟随在你的设备上运行，成品视频直接保存到你的电脑。"
                },
                {
                    "q": "免费吗？",
                    "a": "免费 — 不用注册，不用安装。打开页面，拖入文件夹，打码，保存。"
                }
            ],
            "ctaPrimary": "打开你的录像"
        }
    },
};
