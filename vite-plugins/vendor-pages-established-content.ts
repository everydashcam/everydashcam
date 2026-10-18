import type { Lang } from "../src/i18n/index.js";
import type { FeatureSlug } from "./feature-pages.js";
import type { VendorContent, VendorLocaleContent } from "./vendor-pages.js";

interface RecordingCopy {
    lead: string;
    compatibility: string;
    openTip: string;
}

interface EstablishedCamera {
    slug: VendorContent["slug"];
    displayName: string;
    models: string[];
    features: readonly FeatureSlug[];
    locales: Record<"en", RecordingCopy> & Partial<Record<Lang, RecordingCopy>>;
}

const LABELS: Record<Lang, { title: string; cta: string }> = {
    en: { title: "{vendor} recording player", cta: "Open {vendor} recordings" },
    ru: { title: "Плеер записей {vendor}", cta: "Открыть записи {vendor}" },
    de: { title: "Player für {vendor}-Aufnahmen", cta: "{vendor}-Aufnahmen öffnen" },
    es: { title: "Reproductor de grabaciones {vendor}", cta: "Abrir grabaciones {vendor}" },
    fr: { title: "Lecteur de vidéos {vendor}", cta: "Ouvrir les vidéos {vendor}" },
    pl: { title: "Odtwarzacz nagrań {vendor}", cta: "Otwórz nagrania {vendor}" },
    pt: { title: "Player de gravações {vendor}", cta: "Abrir gravações {vendor}" },
    zh: { title: "{vendor} 录像播放器", cta: "打开 {vendor} 录像" },
    ja: { title: "{vendor} 録画プレーヤー", cta: "{vendor} の録画を開く" },
    ko: { title: "{vendor} 녹화 플레이어", cta: "{vendor} 녹화 열기" },
};

const VIDEO_FEATURES = ["blur-license-plate-in-dashcam-video"] as const;
const GPS_FEATURES = [...VIDEO_FEATURES, "add-data-overlay-to-dashcam-video"] as const;
const MULTI_CAMERA_FEATURES = [...GPS_FEATURES, "combine-dashcam-cameras-into-one-video"] as const;

// Model scope comes from docs/gps-format-coverage.md and its linked fixtures.
// A manufacturer's wider lineup is not evidence that its recordings work.
// Every published locale has its own recording guidance; shared labels only
// supply the product action, never a replacement for missing camera copy.
const PAGES: EstablishedCamera[] = [
    {
        slug: "70mai",
        displayName: "70mai",
        models: ["A810", "A510", "M500", "X800", "Pro (D02 / D03)"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Watch 70mai A810, A510, M500 and X800 trips with video, a route map and speed. Open the original folder in your browser.",
                compatibility:
                    "GPS is supported for the listed recordings, including older Pro D02/D03 files. A510 keeps GPS in the front recording; keep it when watching the rear view.",
                openTip:
                    "Open the whole card, including GPSData*.txt files used by X800. Keep the original front, rear and cabin filenames; a video copied on its own can leave the route behind.",
            },
            ru: {
                lead: "Смотри поездки с 70mai A810, A510, M500 и X800: видео, маршрут и скорость. Открой исходную папку в браузере.",
                compatibility:
                    "GPS поддерживается в перечисленных записях, включая старые Pro D02/D03. У A510 GPS хранится в передней записи: сохрани её для просмотра заднего ракурса с картой.",
                openTip:
                    "Открой карту целиком, включая файлы GPSData*.txt у X800. Сохрани исходные имена передних, задних и салонных записей: при копировании одного видео маршрут может остаться на карте.",
            },
            de: {
                lead: "Sieh dir Fahrten von 70mai A810, A510, M500 und X800 mit Video, Route und Tempo an. Öffne den Originalordner im Browser.",
                compatibility:
                    "GPS wird bei den aufgeführten Aufnahmen unterstützt, auch bei älteren Pro D02/D03. Beim A510 steckt GPS in der Frontaufnahme; behalte sie auch für die Heckansicht mit Karte.",
                openTip:
                    "Öffne die ganze Karte samt GPSData*.txt-Dateien des X800. Behalte die ursprünglichen Dateinamen für Front, Heck und Innenraum. Kopierst du nur ein Video, kann die Route fehlen.",
            },
            es: {
                lead: "Mira viajes de 70mai A810, A510, M500 y X800 con vídeo, ruta y velocidad. Abre la carpeta original en el navegador.",
                compatibility:
                    "El GPS funciona con las grabaciones indicadas, incluidas las antiguas Pro D02/D03. El A510 guarda el GPS en el vídeo delantero: consérvalo para ver la cámara trasera con mapa.",
                openTip:
                    "Abre toda la tarjeta, incluidos los archivos GPSData*.txt del X800. Conserva los nombres originales de las cámaras delantera, trasera e interior; copiar solo un vídeo puede dejar fuera la ruta.",
            },
            fr: {
                lead: "Regarde les trajets des 70mai A810, A510, M500 et X800 avec vidéo, carte et vitesse. Ouvre le dossier original dans ton navigateur.",
                compatibility:
                    "Le GPS est pris en charge pour les enregistrements indiqués, y compris les anciens Pro D02/D03. Sur l’A510, il est dans la vidéo avant : garde-la pour voir l’arrière avec la carte.",
                openTip:
                    "Ouvre toute la carte, avec les fichiers GPSData*.txt du X800. Garde les noms d’origine des vidéos avant, arrière et habitacle ; une vidéo copiée seule peut perdre son trajet.",
            },
            pl: {
                lead: "Oglądaj przejazdy z 70mai A810, A510, M500 i X800 z filmem, mapą i prędkością. Otwórz oryginalny folder w przeglądarce.",
                compatibility:
                    "GPS działa w wymienionych nagraniach, także ze starszych Pro D02/D03. A510 zapisuje GPS w przednim nagraniu; zachowaj je, by oglądać tył razem z mapą.",
                openTip:
                    "Otwórz całą kartę, w tym pliki GPSData*.txt z X800. Zachowaj oryginalne nazwy nagrań przodu, tyłu i wnętrza. Kopiując sam film, możesz pominąć trasę.",
            },
            pt: {
                lead: "Veja viagens de 70mai A810, A510, M500 e X800 com vídeo, mapa e velocidade. Abra a pasta original no navegador.",
                compatibility:
                    "O GPS funciona nas gravações indicadas, incluindo as antigas Pro D02/D03. O A510 guarda o GPS no vídeo frontal; mantenha esse vídeo para ver a câmera traseira com o mapa.",
                openTip:
                    "Abra o cartão inteiro, incluindo os arquivos GPSData*.txt do X800. Preserve os nomes originais das câmeras frontal, traseira e interna; copiar só um vídeo pode deixar o trajeto de fora.",
            },
            zh: {
                lead: "在浏览器中打开原始文件夹，查看 70mai A810、A510、M500 和 X800 的行车视频、路线和速度。",
                compatibility:
                    "支持所列录像的 GPS，包括旧款 Pro D02/D03。A510 将 GPS 保存在前置录像中；查看后置画面时也要保留前置文件，才能显示地图。",
                openTip:
                    "打开整张存储卡，包括 X800 的 GPSData*.txt 文件。保留前置、后置和车内录像的原始文件名；只复制视频可能会漏掉路线数据。",
            },
            ja: {
                lead: "70mai A810、A510、M500、X800 の映像をルートや速度と一緒に確認。元のフォルダーをブラウザーで開けます。",
                compatibility:
                    "旧型 Pro D02/D03 を含む、記載された録画の GPS に対応しています。A510 の GPS は前方録画にあるため、後方映像を地図と見るときも前方ファイルを残してください。",
                openTip:
                    "X800 の GPSData*.txt を含め、カード全体を開いてください。前方・後方・車内の元のファイル名を保ちます。動画だけをコピーするとルートが欠ける場合があります。",
            },
            ko: {
                lead: "70mai A810, A510, M500, X800의 주행 영상을 경로와 속도와 함께 확인해요. 원본 폴더를 브라우저에서 열면 돼요.",
                compatibility:
                    "이 목록의 녹화와 구형 Pro D02/D03의 GPS를 지원해요. A510은 앞쪽 녹화에 GPS를 저장하므로 뒤쪽 영상에 지도를 보려면 앞쪽 파일도 보관해 주세요.",
                openTip:
                    "X800의 GPSData*.txt 파일을 포함해 카드 전체를 열어 주세요. 앞쪽·뒤쪽·실내 영상의 원래 파일명을 유지하세요. 영상만 복사하면 경로가 빠질 수 있어요.",
            },
        },
    },
    {
        slug: "viofo",
        displayName: "Viofo",
        models: ["A119", "A119 V3", "A119 Mini 2", "A119M Pro", "A329", "A329S", "T130"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Review Viofo A119, A329 and T130 recordings with a route and speed. Keep camera views together and save a clip in your browser.",
                compatibility:
                    "GPS is supported for recordings from the listed models. A119 V3 TS recordings are supported too; a map still needs GPS saved during the drive.",
                openTip:
                    "Open the original MP4 or TS folder. Keep filename endings such as F, R and I for the camera views, and parking files such as _PF and _PR. Do not rename dated clips.",
            },
            ru: {
                lead: "Смотри записи Viofo A119, A329 и T130 с маршрутом и скоростью. Открой ракурсы вместе и сохрани фрагмент в браузере.",
                compatibility:
                    "GPS поддерживается в записях перечисленных моделей, в том числе A119 V3 в TS. Для карты нужны GPS-данные, сохранённые во время поездки.",
                openTip:
                    "Открой исходную папку с MP4 или TS. Сохрани окончания F, R и I для ракурсов, а также парковочные файлы вроде _PF и _PR. Не переименовывай ролики с датами.",
            },
            de: {
                lead: "Sieh Viofo-A119-, A329- und T130-Aufnahmen mit Route und Tempo an. Behalte die Kameraansichten zusammen und speichere einen Ausschnitt im Browser.",
                compatibility:
                    "GPS wird bei Aufnahmen der aufgeführten Modelle unterstützt, auch bei A119 V3 im TS-Format. Für die Karte muss GPS während der Fahrt aufgezeichnet worden sein.",
                openTip:
                    "Öffne den Originalordner mit MP4- oder TS-Dateien. Behalte Kamera-Endungen wie F, R und I sowie Parkdateien wie _PF und _PR. Benenne Clips mit Datum im Namen nicht um.",
            },
            es: {
                lead: "Revisa grabaciones Viofo A119, A329 y T130 con ruta y velocidad. Mira las cámaras juntas y guarda un fragmento en el navegador.",
                compatibility:
                    "Se admite GPS en las grabaciones de los modelos indicados, también en los TS del A119 V3. El mapa necesita datos GPS guardados durante el viaje.",
                openTip:
                    "Abre la carpeta original con MP4 o TS. Conserva terminaciones de cámara como F, R e I y archivos de aparcamiento como _PF y _PR. No cambies los nombres que incluyen la fecha.",
            },
            fr: {
                lead: "Regarde les vidéos Viofo A119, A329 et T130 avec trajet et vitesse. Garde les vues ensemble et enregistre un extrait dans ton navigateur.",
                compatibility:
                    "Le GPS est pris en charge pour les modèles indiqués, y compris les TS de l’A119 V3. La carte nécessite des données GPS enregistrées pendant le trajet.",
                openTip:
                    "Ouvre le dossier original de MP4 ou TS. Garde les terminaisons de caméra comme F, R et I, ainsi que les fichiers de stationnement _PF et _PR. Ne renomme pas les vidéos datées.",
            },
            pl: {
                lead: "Przeglądaj nagrania Viofo A119, A329 i T130 z trasą i prędkością. Oglądaj kamery razem i zapisz fragment w przeglądarce.",
                compatibility:
                    "GPS jest obsługiwany w nagraniach wymienionych modeli, także w plikach TS z A119 V3. Mapa wymaga danych GPS zapisanych podczas jazdy.",
                openTip:
                    "Otwórz oryginalny folder MP4 lub TS. Zachowaj końcówki kamer, takie jak F, R i I, oraz pliki parkingowe _PF i _PR. Nie zmieniaj nazw zawierających datę.",
            },
            pt: {
                lead: "Revise gravações Viofo A119, A329 e T130 com trajeto e velocidade. Veja as câmeras juntas e salve um trecho no navegador.",
                compatibility:
                    "O GPS é compatível com as gravações dos modelos indicados, incluindo os TS do A119 V3. O mapa precisa de dados GPS salvos durante a viagem.",
                openTip:
                    "Abra a pasta original com MP4 ou TS. Preserve terminações de câmera como F, R e I e arquivos de estacionamento como _PF e _PR. Não renomeie os clipes com data no nome.",
            },
            zh: {
                lead: "查看 Viofo A119、A329 和 T130 的录像、路线和速度。在浏览器中一起查看各摄像头画面并保存片段。",
                compatibility: "支持所列型号录像中的 GPS，也支持 A119 V3 的 TS 录像。地图需要行驶时已保存的 GPS 数据。",
                openTip:
                    "打开原始 MP4 或 TS 文件夹。保留 F、R、I 等摄像头文件名结尾，以及 _PF、_PR 等停车录像名称。不要修改带日期的文件名。",
            },
            ja: {
                lead: "Viofo A119、A329、T130 の録画をルートや速度と確認。各カメラの映像をまとめて見て、ブラウザーで必要な部分を保存できます。",
                compatibility:
                    "記載したモデルの GPS に対応し、A119 V3 の TS 録画も開けます。地図には走行中に保存された GPS データが必要です。",
                openTip:
                    "元の MP4 または TS フォルダーを開きます。カメラを示す F、R、I や、駐車録画の _PF、_PR などの末尾を残してください。日付入りのファイル名は変えないでください。",
            },
            ko: {
                lead: "Viofo A119, A329, T130 녹화를 경로와 속도와 함께 확인해요. 카메라 영상을 함께 보고 브라우저에서 필요한 구간을 저장하세요.",
                compatibility:
                    "나열된 모델의 녹화 GPS를 지원하며 A119 V3의 TS 녹화도 열 수 있어요. 지도에는 주행 중 저장된 GPS 데이터가 필요해요.",
                openTip:
                    "원본 MP4 또는 TS 폴더를 열어 주세요. 카메라를 나타내는 F, R, I와 주차 파일의 _PF, _PR 같은 끝부분을 유지하세요. 날짜가 들어간 파일명은 바꾸지 마세요.",
            },
        },
    },
    {
        slug: "blackvue",
        displayName: "BlackVue",
        models: ["DR900X Plus", "DR550GW-2CH"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Watch BlackVue DR900X Plus and DR550GW-2CH recordings locally. Open the card in your browser without a Cloud account, keeping matching GPS files with the videos.",
                compatibility:
                    "Routes and speed are checked on DR550GW-2CH .gps files; .3gf files supply motion data. The DR900X Plus sample contains embedded GPS data without a satellite fix, so its route has not yet been verified on a real recording.",
                openTip:
                    "Open the BlackVue recording folder with the original front and rear clips. Include matching .gps and .3gf files and preserve their names so they can be paired with the videos.",
            },
            ru: {
                lead: "Смотри записи BlackVue DR900X Plus и DR550GW-2CH локально. Открой карту в браузере без аккаунта Cloud, сохранив парные GPS-файлы вместе с видео.",
                compatibility:
                    "Маршрут и скорость проверены на файлах .gps DR550GW-2CH; данные движения хранятся в .3gf. В примере DR900X Plus GPS встроен в видео, но спутниковые координаты не определены: маршрут пока не проверен на реальной записи.",
                openTip:
                    "Открой папку BlackVue с исходными передними и задними роликами. Добавь соответствующие .gps и .3gf и сохрани их имена, чтобы плеер сопоставил данные с видео.",
            },
            de: {
                lead: "Sieh BlackVue-DR900X-Plus- und DR550GW-2CH-Aufnahmen lokal an. Öffne die Karte im Browser ohne Cloud-Konto und behalte passende GPS-Dateien bei den Videos.",
                compatibility:
                    "Route und Tempo wurden mit DR550GW-2CH-.gps-Dateien geprüft; .3gf-Dateien liefern Bewegungsdaten. Die Beispielaufnahme des DR900X Plus enthält GPS-Daten ohne Satellitenposition. Eine echte Route wurde damit noch nicht bestätigt.",
                openTip:
                    "Öffne den BlackVue-Aufnahmeordner mit den ursprünglichen Front- und Heckvideos. Nimm passende .gps- und .3gf-Dateien mit und behalte ihre Namen, damit sie den Videos zugeordnet werden können.",
            },
            es: {
                lead: "Mira grabaciones BlackVue DR900X Plus y DR550GW-2CH localmente. Abre la tarjeta en el navegador sin cuenta Cloud y conserva los archivos GPS junto a los vídeos.",
                compatibility:
                    "La ruta y la velocidad están verificadas con archivos .gps del DR550GW-2CH; los .3gf aportan datos de movimiento. La muestra DR900X Plus contiene GPS sin posición de satélite, por lo que su ruta aún no se ha verificado en una grabación real.",
                openTip:
                    "Abre la carpeta BlackVue con los vídeos delanteros y traseros originales. Incluye los .gps y .3gf correspondientes y conserva sus nombres para asociarlos con los vídeos.",
            },
            fr: {
                lead: "Regarde les vidéos BlackVue DR900X Plus et DR550GW-2CH localement. Ouvre la carte dans ton navigateur sans compte Cloud et garde les fichiers GPS avec les vidéos.",
                compatibility:
                    "Le trajet et la vitesse sont vérifiés avec les fichiers .gps du DR550GW-2CH ; les .3gf fournissent les données de mouvement. L’exemple DR900X Plus contient du GPS sans position satellite : son trajet n’a pas encore été vérifié sur une vraie vidéo.",
                openTip:
                    "Ouvre le dossier BlackVue avec les vidéos avant et arrière originales. Ajoute les fichiers .gps et .3gf correspondants et garde leurs noms pour les associer aux vidéos.",
            },
            pl: {
                lead: "Oglądaj nagrania BlackVue DR900X Plus i DR550GW-2CH lokalnie. Otwórz kartę w przeglądarce bez konta Cloud i zachowaj pasujące pliki GPS razem z filmami.",
                compatibility:
                    "Trasę i prędkość sprawdzono w plikach .gps z DR550GW-2CH; pliki .3gf dostarczają dane o ruchu. Próbka DR900X Plus zawiera GPS bez pozycji satelitarnej, więc trasa nie została jeszcze potwierdzona na prawdziwym nagraniu.",
                openTip:
                    "Otwórz folder BlackVue z oryginalnymi nagraniami przodu i tyłu. Dodaj pasujące pliki .gps i .3gf i zachowaj ich nazwy, aby można je było połączyć z filmami.",
            },
            zh: {
                lead: "在本机查看 BlackVue DR900X Plus 和 DR550GW-2CH 录像。在浏览器中打开存储卡，无需 Cloud 账户；请将配套 GPS 文件与视频一起保留。",
                compatibility:
                    "已用 DR550GW-2CH 的 .gps 文件验证路线和速度；.3gf 文件提供运动数据。DR900X Plus 样本内含 GPS 数据，但没有卫星定位结果，因此尚未用真实录像验证其路线。",
                openTip:
                    "打开含有原始前后录像的 BlackVue 文件夹。同时保留对应的 .gps 和 .3gf 文件及原始名称，让播放器将数据与视频配对。",
            },
            ja: {
                lead: "BlackVue DR900X Plus と DR550GW-2CH の録画を端末で確認。Cloud アカウントなしでカードをブラウザーから開き、対応する GPS ファイルも動画と一緒に残してください。",
                compatibility:
                    "DR550GW-2CH の .gps ファイルでルートと速度を確認済みです。.3gf は動きのデータです。DR900X Plus のサンプルには GPS データがありますが衛星測位ができておらず、実際の録画でルートはまだ確認されていません。",
                openTip:
                    "元の前方・後方映像がある BlackVue フォルダーを開きます。対応する .gps と .3gf も含め、動画と結び付けられるようファイル名を変えないでください。",
            },
            ko: {
                lead: "BlackVue DR900X Plus와 DR550GW-2CH 녹화를 기기에서 봐요. Cloud 계정 없이 브라우저에서 카드를 열고, 영상과 짝을 이루는 GPS 파일도 함께 보관해 주세요.",
                compatibility:
                    "DR550GW-2CH의 .gps 파일에서 경로와 속도를 확인했어요. .3gf는 움직임 데이터를 제공해요. DR900X Plus 샘플에는 GPS 데이터가 있지만 위성 위치를 잡지 못해 실제 녹화의 경로는 아직 확인되지 않았어요.",
                openTip:
                    "앞쪽·뒤쪽 원본 영상이 있는 BlackVue 폴더를 열어 주세요. 대응하는 .gps와 .3gf 파일도 포함하고 영상과 연결할 수 있도록 원래 이름을 유지하세요.",
            },
        },
    },
    {
        slug: "gopro",
        displayName: "GoPro",
        models: ["HERO5", "HERO6", "HERO7", "HERO8", "MAX"],
        features: GPS_FEATURES,
        locales: {
            en: {
                lead: "Watch original GoPro MP4 recordings and save a clip locally in your browser. GPS routes and speed are checked on HERO5, HERO6 and MAX recordings.",
                compatibility:
                    "The HERO7 and HERO8 samples contain GPS data without a satellite fix, so they do not verify a real route. GPS checks on HERO5, HERO6 and MAX do not confirm every model variant or later HERO generation.",
                openTip:
                    "Open the original MP4s from the GoPro card and keep all numbered parts of a long recording. Edited or downloaded copies can lose GPS even when the picture looks unchanged.",
            },
            ru: {
                lead: "Смотри исходные MP4 GoPro и сохраняй фрагменты локально в браузере. GPS-маршрут и скорость проверены на записях HERO5, HERO6 и MAX.",
                compatibility:
                    "В примерах HERO7 и HERO8 есть GPS-данные, но нет спутниковых координат: реальный маршрут на них не проверен. Проверка HERO5, HERO6 и MAX не подтверждает все варианты моделей и более поздние поколения HERO.",
                openTip:
                    "Открой исходные MP4 с карты GoPro и сохрани все пронумерованные части длинной записи. Изменённые или скачанные копии могут потерять GPS, даже если картинка выглядит так же.",
            },
            de: {
                lead: "Sieh originale GoPro-MP4-Aufnahmen an und speichere Ausschnitte lokal im Browser. GPS-Route und Tempo wurden an HERO5-, HERO6- und MAX-Aufnahmen geprüft.",
                compatibility:
                    "Die HERO7- und HERO8-Beispiele enthalten GPS-Daten ohne Satellitenposition und bestätigen daher keine echte Route. Die Prüfungen mit HERO5, HERO6 und MAX bestätigen nicht jede Modellvariante oder spätere HERO-Generation.",
                openTip:
                    "Öffne die originalen MP4s der GoPro-Karte und behalte alle nummerierten Teile langer Aufnahmen. Bearbeitete oder heruntergeladene Kopien können GPS verlieren, obwohl das Bild gleich aussieht.",
            },
            es: {
                lead: "Mira MP4 originales de GoPro y guarda fragmentos localmente en el navegador. La ruta GPS y la velocidad están verificadas en grabaciones HERO5, HERO6 y MAX.",
                compatibility:
                    "Las muestras HERO7 y HERO8 contienen GPS sin posición de satélite, así que no verifican una ruta real. Las pruebas con HERO5, HERO6 y MAX no confirman todas las variantes ni generaciones HERO posteriores.",
                openTip:
                    "Abre los MP4 originales de la tarjeta GoPro y conserva todas las partes numeradas de una grabación larga. Las copias editadas o descargadas pueden perder el GPS aunque la imagen parezca igual.",
            },
            fr: {
                lead: "Regarde les MP4 originaux GoPro et enregistre un extrait localement dans ton navigateur. Le trajet GPS et la vitesse sont vérifiés sur HERO5, HERO6 et MAX.",
                compatibility:
                    "Les exemples HERO7 et HERO8 contiennent du GPS sans position satellite : ils ne valident donc pas de trajet réel. Les tests sur HERO5, HERO6 et MAX ne confirment pas toutes les variantes ni les générations HERO suivantes.",
                openTip:
                    "Ouvre les MP4 originaux de la carte GoPro et garde toutes les parties numérotées des longues vidéos. Les copies modifiées ou téléchargées peuvent perdre le GPS, même si l’image semble identique.",
            },
            pl: {
                lead: "Oglądaj oryginalne MP4 GoPro i zapisuj fragmenty lokalnie w przeglądarce. Trasę GPS i prędkość sprawdzono na nagraniach HERO5, HERO6 i MAX.",
                compatibility:
                    "Próbki HERO7 i HERO8 zawierają GPS bez pozycji satelitarnej, więc nie potwierdzają rzeczywistej trasy. Testy HERO5, HERO6 i MAX nie potwierdzają wszystkich wariantów modeli ani późniejszych generacji HERO.",
                openTip:
                    "Otwórz oryginalne MP4 z karty GoPro i zachowaj wszystkie numerowane części długiego nagrania. Edytowane lub pobrane kopie mogą stracić GPS, mimo że obraz wygląda tak samo.",
            },
            pt: {
                lead: "Veja MP4 originais GoPro e salve trechos localmente no navegador. O trajeto GPS e a velocidade foram verificados em gravações HERO5, HERO6 e MAX.",
                compatibility:
                    "As amostras HERO7 e HERO8 contêm GPS sem posição de satélite, por isso não verificam um trajeto real. Os testes com HERO5, HERO6 e MAX não confirmam todas as variantes nem gerações HERO posteriores.",
                openTip:
                    "Abra os MP4 originais do cartão GoPro e preserve todas as partes numeradas de uma gravação longa. Cópias editadas ou baixadas podem perder o GPS mesmo quando a imagem parece igual.",
            },
            zh: {
                lead: "查看 GoPro 原始 MP4 录像，在浏览器中将片段保存到本机。已在 HERO5、HERO6 和 MAX 录像中验证 GPS 路线和速度。",
                compatibility:
                    "HERO7 和 HERO8 样本内含 GPS 数据，但没有卫星定位结果，因此未能验证真实路线。HERO5、HERO6 和 MAX 的测试不代表所有型号变体或后续 HERO 系列均已验证。",
                openTip:
                    "打开 GoPro 存储卡中的原始 MP4，保留长录像的所有编号分段。编辑或下载的副本即使画面看起来相同，也可能丢失 GPS。",
            },
            ja: {
                lead: "GoPro の元の MP4 を確認し、ブラウザーで必要な部分を端末に保存。GPS ルートと速度は HERO5、HERO6、MAX の録画で確認済みです。",
                compatibility:
                    "HERO7 と HERO8 のサンプルには GPS データがありますが衛星測位ができておらず、実際のルートは未確認です。HERO5、HERO6、MAX の確認結果は、すべての派生モデルや後の HERO 世代には当てはまりません。",
                openTip:
                    "GoPro カードの元の MP4 を開き、長い録画の番号付きファイルをすべて残してください。編集済みやダウンロードしたコピーは、映像が同じでも GPS が失われている場合があります。",
            },
            ko: {
                lead: "GoPro 원본 MP4를 보고 필요한 구간을 브라우저에서 기기에 저장해요. GPS 경로와 속도는 HERO5, HERO6, MAX 녹화에서 확인했어요.",
                compatibility:
                    "HERO7과 HERO8 샘플에는 GPS 데이터가 있지만 위성 위치를 잡지 못해 실제 경로는 확인하지 못했어요. HERO5, HERO6, MAX의 확인 결과가 모든 모델 변형이나 이후 HERO 세대까지 보장하지는 않아요.",
                openTip:
                    "GoPro 카드의 원본 MP4를 열고 긴 녹화의 번호가 붙은 모든 파일을 보관해 주세요. 편집하거나 내려받은 사본은 화면이 같아 보여도 GPS가 사라질 수 있어요.",
            },
        },
    },
    {
        slug: "garmin",
        displayName: "Garmin",
        models: [],
        features: VIDEO_FEATURES,
        locales: {
            en: {
                lead: "Open Garmin recordings locally and save the part of the drive you need. A readable video and a GPS route are separate capabilities.",
                compatibility:
                    "Garmin GPS support has not yet been verified with a real camera recording. There is no confirmed model list for X-series, Mini or other Garmin Dash Cams; do not rely on a route map for these models.",
                openTip:
                    "Choose the original recording folder from the Garmin card. Keep the source files when saving an edited clip: a visible speed stamp is part of the picture, not a separate GPS route.",
            },
            ru: {
                lead: "Открой записи Garmin локально и сохрани нужный участок поездки. Просмотр видео и карта GPS — отдельные возможности.",
                compatibility:
                    "GPS Garmin пока не проверен на реальной записи камеры. Подтверждённого списка моделей X, Mini и других Garmin Dash Cam нет; рассчитывать на карту для этих моделей пока нельзя.",
                openTip:
                    "Выбери исходную папку с карты Garmin. Сохрани оригиналы, когда будешь сохранять изменённый фрагмент: видимый штамп скорости — часть изображения, а не отдельный GPS-маршрут.",
            },
            de: {
                lead: "Öffne Garmin-Aufnahmen lokal und speichere den benötigten Teil der Fahrt. Videowiedergabe und GPS-Route sind getrennte Funktionen.",
                compatibility:
                    "Garmin-GPS wurde noch nicht an einer echten Kameraaufnahme geprüft. Für X-Serie, Mini und andere Garmin Dash Cams gibt es keine bestätigte Modellliste; verlasse dich bei diesen Modellen nicht auf eine Routenkarte.",
                openTip:
                    "Wähle den Originalordner auf der Garmin-Karte. Behalte die Quelldateien beim Speichern eines bearbeiteten Clips: Eine sichtbare Tempoanzeige gehört zum Bild und ist keine separate GPS-Route.",
            },
            es: {
                lead: "Abre grabaciones Garmin localmente y guarda la parte del viaje que necesitas. Reproducir vídeo y mostrar una ruta GPS son funciones distintas.",
                compatibility:
                    "El GPS de Garmin aún no se ha verificado con una grabación real. No hay una lista confirmada de modelos X, Mini u otras Garmin Dash Cam; no cuentes con el mapa para estos modelos.",
                openTip:
                    "Elige la carpeta original de la tarjeta Garmin. Conserva los originales al guardar un clip editado: una velocidad impresa en la imagen no es una ruta GPS separada.",
            },
            fr: {
                lead: "Ouvre les vidéos Garmin localement et garde le passage utile du trajet. La lecture vidéo et le trajet GPS sont deux fonctions distinctes.",
                compatibility:
                    "Le GPS Garmin n’a pas encore été vérifié sur une vraie vidéo de caméra. Aucune liste de modèles X, Mini ou autres Garmin Dash Cam n’est confirmée ; ne compte pas sur une carte pour ces modèles.",
                openTip:
                    "Choisis le dossier original de la carte Garmin. Garde les originaux quand tu enregistres un extrait modifié : une vitesse inscrite dans l’image n’est pas un trajet GPS séparé.",
            },
            pl: {
                lead: "Otwórz nagrania Garmin lokalnie i zapisz potrzebny odcinek przejazdu. Odtwarzanie filmu i mapa GPS to oddzielne funkcje.",
                compatibility:
                    "GPS Garmin nie został jeszcze sprawdzony na prawdziwym nagraniu z kamery. Nie ma potwierdzonej listy modeli X, Mini ani innych Garmin Dash Cam; nie zakładaj, że pokażą mapę.",
                openTip:
                    "Wybierz oryginalny folder z karty Garmin. Zachowaj pliki źródłowe przy zapisywaniu edytowanego klipu: prędkość widoczna na obrazie nie jest oddzielną trasą GPS.",
            },
            pt: {
                lead: "Abra gravações Garmin localmente e salve a parte da viagem de que precisa. Reprodução de vídeo e trajeto GPS são recursos separados.",
                compatibility:
                    "O GPS Garmin ainda não foi verificado com uma gravação real. Não há uma lista confirmada de modelos X, Mini ou outras Garmin Dash Cam; não conte com o mapa nesses modelos.",
                openTip:
                    "Escolha a pasta original do cartão Garmin. Mantenha os arquivos originais ao salvar um clipe editado: a velocidade estampada na imagem não é um trajeto GPS separado.",
            },
            zh: {
                lead: "在本机打开 Garmin 录像，保存需要的行车片段。播放视频和显示 GPS 路线是两项独立功能。",
                compatibility:
                    "Garmin GPS 尚未用真实摄像机录像验证。X 系列、Mini 及其他 Garmin Dash Cam 都没有已确认的型号清单；目前不能依赖这些型号显示路线地图。",
                openTip:
                    "选择 Garmin 存储卡中的原始录像文件夹。保存编辑后的片段时，也请保留源文件：画面上的速度数字属于图像，并不是独立的 GPS 路线。",
            },
            ja: {
                lead: "Garmin の録画を端末で開き、必要な走行区間を保存。動画の再生と GPS ルートの表示は別の機能です。",
                compatibility:
                    "Garmin の GPS は実際のカメラ録画ではまだ未検証です。X シリーズ、Mini、その他の Garmin Dash Cam に確認済みモデルの一覧はなく、地図の表示は保証できません。",
                openTip:
                    "Garmin カードの元の録画フォルダーを選びます。編集したクリップを保存するときも元のファイルを残してください。映像に写った速度の数字は画像の一部で、独立した GPS ルートではありません。",
            },
        },
    },
    {
        slug: "vantrue",
        displayName: "Vantrue",
        models: ["N2X"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Review Vantrue N2X recordings with the GPS route and speed saved in the video. Find a moment and save it locally in your browser.",
                compatibility:
                    "GPS is checked on N2X recordings. Other Vantrue models can use different GPS formats. Letters identify camera views, but the player may need you to choose their positions.",
                openTip:
                    "Open the original folder and retain the A, B or C endings in filenames. Keep normal, event and parking clips with their original names so the trip and camera views can be grouped.",
            },
            ru: {
                lead: "Смотри записи Vantrue N2X с GPS-маршрутом и скоростью из видео. Найди нужный момент и сохрани его локально в браузере.",
                compatibility:
                    "GPS проверен на записях N2X. Другие модели Vantrue могут хранить GPS иначе. Буквы обозначают ракурсы, но их положение может потребоваться выбрать в плеере.",
                openTip:
                    "Открой исходную папку и сохрани окончания A, B или C в именах. Не переименовывай обычные, событийные и парковочные ролики, чтобы плеер сгруппировал поездку и ракурсы.",
            },
            de: {
                lead: "Prüfe Vantrue-N2X-Aufnahmen mit GPS-Route und Tempo aus dem Video. Finde den passenden Moment und speichere ihn lokal im Browser.",
                compatibility:
                    "GPS wurde an N2X-Aufnahmen geprüft. Andere Vantrue-Modelle können GPS anders speichern. Buchstaben kennzeichnen Kameraansichten; ihre Position musst du eventuell im Player wählen.",
                openTip:
                    "Öffne den Originalordner und behalte die Endungen A, B oder C. Lass die Namen normaler, Ereignis- und Parkclips unverändert, damit Fahrt und Ansichten zusammenbleiben.",
            },
            es: {
                lead: "Revisa grabaciones Vantrue N2X con la ruta GPS y la velocidad guardadas en el vídeo. Encuentra el momento y guárdalo localmente en el navegador.",
                compatibility:
                    "El GPS se ha comprobado en grabaciones N2X. Otros Vantrue pueden guardarlo de otra forma. Las letras identifican las vistas; quizá debas elegir su posición en el reproductor.",
                openTip:
                    "Abre la carpeta original y conserva las terminaciones A, B o C. Mantén los nombres de clips normales, de eventos y de aparcamiento para agrupar el viaje y las cámaras.",
            },
            fr: {
                lead: "Regarde les vidéos Vantrue N2X avec leur trajet GPS et leur vitesse. Trouve le bon moment et enregistre-le localement dans ton navigateur.",
                compatibility:
                    "Le GPS a été vérifié sur des vidéos N2X. D’autres Vantrue peuvent le stocker autrement. Les lettres désignent les vues ; tu devras peut-être choisir leur position dans le lecteur.",
                openTip:
                    "Ouvre le dossier original et garde les terminaisons A, B ou C. Conserve les noms des vidéos normales, d’événement et de stationnement pour regrouper trajet et caméras.",
            },
            pl: {
                lead: "Przeglądaj nagrania Vantrue N2X z trasą GPS i prędkością zapisaną w filmie. Znajdź moment i zapisz go lokalnie w przeglądarce.",
                compatibility:
                    "GPS sprawdzono w nagraniach N2X. Inne Vantrue mogą zapisywać go inaczej. Litery oznaczają widoki kamer; ich pozycję może być trzeba wybrać w odtwarzaczu.",
                openTip:
                    "Otwórz oryginalny folder i zachowaj końcówki A, B lub C. Nie zmieniaj nazw nagrań zwykłych, zdarzeń i parkingowych, aby połączyć przejazd oraz widoki kamer.",
            },
            zh: {
                lead: "查看 Vantrue N2X 录像及视频中保存的 GPS 路线和速度。找到需要的时刻，在浏览器中保存到本机。",
                compatibility:
                    "已在 N2X 录像中验证 GPS。其他 Vantrue 型号可能采用不同的保存方式。字母用于区分摄像头画面，但具体位置可能需要在播放器中选择。",
                openTip:
                    "打开原始文件夹，保留文件名末尾的 A、B 或 C。不要更改普通、事件和停车录像的名称，以便将同次行程和各摄像头画面归组。",
            },
            ja: {
                lead: "Vantrue N2X の録画を動画内の GPS ルートや速度と確認。必要な場面を探して、ブラウザーで端末に保存できます。",
                compatibility:
                    "N2X の録画で GPS を確認しています。他の Vantrue は保存方法が異なる場合があります。文字で映像を区別しますが、カメラの位置はプレーヤーで選ぶ場合があります。",
                openTip:
                    "元のフォルダーを開き、ファイル名末尾の A、B、C を残してください。通常・イベント・駐車録画の名前を保つと、走行と各カメラの映像をまとめられます。",
            },
            ko: {
                lead: "Vantrue N2X 녹화를 영상에 저장된 GPS 경로와 속도와 함께 확인해요. 원하는 순간을 찾아 브라우저에서 기기에 저장하세요.",
                compatibility:
                    "N2X 녹화에서 GPS를 확인했어요. 다른 Vantrue 모델은 저장 방식이 다를 수 있어요. 문자로 카메라를 구분하지만 위치는 플레이어에서 직접 선택해야 할 수도 있어요.",
                openTip:
                    "원본 폴더를 열고 파일명 끝의 A, B, C를 유지하세요. 일반·이벤트·주차 녹화의 이름을 보존해야 주행과 카메라 영상을 함께 묶을 수 있어요.",
            },
        },
    },
    {
        slug: "thinkware",
        displayName: "Thinkware",
        models: ["F200 PRO"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Watch Thinkware F200 PRO front and rear recordings together, with the route from the front video. Review and save a clip in your browser.",
                compatibility:
                    "GPS is checked in the F200 PRO front recording. The rear clip in the checked pair has no GPS of its own; keep the front clip even when you only need the rear picture.",
                openTip:
                    "Open the parent folder containing both camera views. Preserve names beginning REC, EVT, PARK or MAN and their camera endings so ordinary, saved and parking recordings stay identifiable.",
            },
            ru: {
                lead: "Смотри передние и задние записи Thinkware F200 PRO вместе, с маршрутом из переднего видео. Сохрани нужный фрагмент в браузере.",
                compatibility:
                    "GPS проверен в передней записи F200 PRO. В проверенной паре у заднего ролика собственного GPS нет: сохрани передний, даже если нужен только задний ракурс.",
                openTip:
                    "Открой общую папку с обоими ракурсами. Сохрани начала имён REC, EVT, PARK или MAN и окончания камер, чтобы отличать обычные, сохранённые и парковочные записи.",
            },
            de: {
                lead: "Sieh Thinkware-F200-PRO-Aufnahmen von Front und Heck zusammen an, mit der Route aus dem Frontvideo. Speichere Ausschnitte im Browser.",
                compatibility:
                    "GPS wurde in der F200-PRO-Frontaufnahme geprüft. Das zugehörige Heckvideo hat kein eigenes GPS; behalte das Frontvideo auch dann, wenn du nur die Heckansicht brauchst.",
                openTip:
                    "Öffne den gemeinsamen Ordner beider Ansichten. Behalte Namensanfänge wie REC, EVT, PARK oder MAN und die Kamera-Endungen, damit normale, gespeicherte und Parkaufnahmen erkennbar bleiben.",
            },
            es: {
                lead: "Mira juntas las cámaras delantera y trasera de Thinkware F200 PRO, con la ruta del vídeo delantero. Guarda un fragmento en el navegador.",
                compatibility:
                    "El GPS se ha comprobado en la grabación delantera F200 PRO. El vídeo trasero del par comprobado no tiene GPS propio; conserva el delantero aunque solo necesites la vista trasera.",
                openTip:
                    "Abre la carpeta común de ambas cámaras. Conserva los prefijos REC, EVT, PARK o MAN y las terminaciones de cámara para distinguir grabaciones normales, guardadas y de aparcamiento.",
            },
            fr: {
                lead: "Regarde ensemble l’avant et l’arrière de la Thinkware F200 PRO, avec le trajet de la vidéo avant. Enregistre un extrait dans ton navigateur.",
                compatibility:
                    "Le GPS a été vérifié dans la vidéo avant F200 PRO. La vidéo arrière de la paire vérifiée n’a pas son propre GPS ; garde l’avant même si tu ne veux voir que l’arrière.",
                openTip:
                    "Ouvre le dossier commun aux deux caméras. Garde les préfixes REC, EVT, PARK ou MAN et les terminaisons de caméra pour distinguer vidéos normales, sauvegardées et de stationnement.",
            },
            pl: {
                lead: "Oglądaj razem przód i tył z Thinkware F200 PRO z trasą z przedniego filmu. Zapisz potrzebny fragment w przeglądarce.",
                compatibility:
                    "GPS sprawdzono w przednim nagraniu F200 PRO. Tylny film ze sprawdzonej pary nie ma własnego GPS; zachowaj przedni, nawet jeśli potrzebujesz tylko tylnego widoku.",
                openTip:
                    "Otwórz wspólny folder obu kamer. Zachowaj początki REC, EVT, PARK lub MAN oraz końcówki kamer, aby rozróżniać nagrania zwykłe, zapisane i parkingowe.",
            },
            zh: {
                lead: "一起查看 Thinkware F200 PRO 的前后录像，并显示前置视频中的路线。在浏览器中保存需要的片段。",
                compatibility:
                    "已在 F200 PRO 前置录像中验证 GPS。经验证的配对后置视频没有自身的 GPS；即使只需要后置画面，也请保留前置视频。",
                openTip:
                    "打开同时包含两个摄像头录像的上级文件夹。保留 REC、EVT、PARK、MAN 等文件名前缀及摄像头结尾，以区分普通、已保存和停车录像。",
            },
            ja: {
                lead: "Thinkware F200 PRO の前後映像を、前方動画のルートと一緒に確認。ブラウザーで必要な場面を保存できます。",
                compatibility:
                    "F200 PRO の前方録画で GPS を確認しています。確認した後方動画には独自の GPS がないため、後方だけを見たい場合も前方動画を残してください。",
                openTip:
                    "両方の映像を含む親フォルダーを開きます。通常・保存済み・駐車録画を区別できるよう、REC、EVT、PARK、MAN などの先頭とカメラを示す末尾を保ってください。",
            },
            ko: {
                lead: "Thinkware F200 PRO의 앞뒤 영상을 앞쪽 영상의 경로와 함께 봐요. 필요한 구간을 브라우저에서 저장할 수 있어요.",
                compatibility:
                    "F200 PRO 앞쪽 녹화에서 GPS를 확인했어요. 확인한 뒤쪽 영상에는 자체 GPS가 없으므로 뒤쪽 화면만 필요해도 앞쪽 파일을 보관해 주세요.",
                openTip:
                    "두 카메라가 함께 들어 있는 상위 폴더를 열어 주세요. REC, EVT, PARK, MAN 같은 시작 부분과 카메라를 나타내는 끝부분을 유지하면 일반·저장·주차 녹화를 구분할 수 있어요.",
            },
        },
    },
    {
        slug: "nextbase",
        displayName: "Nextbase",
        models: ["322GW"],
        features: GPS_FEATURES,
        locales: {
            en: {
                lead: "Open original Nextbase 322GW recordings with a GPS route and speed chart. Review the drive and save a clip locally in your browser.",
                compatibility:
                    "Video and GPS are checked on a 322GW recording ending _FH. This does not confirm other Nextbase models or every front/rear recording combination.",
                openTip:
                    "Use the original high-quality clips, with H at the end of the filename, such as _FH.MP4. L versions are smaller copies of the same view; keep the original names and dates.",
            },
            ru: {
                lead: "Открой исходные записи Nextbase 322GW с GPS-маршрутом и графиком скорости. Просмотри поездку и сохрани фрагмент локально в браузере.",
                compatibility:
                    "Видео и GPS проверены на записи 322GW с окончанием _FH. Это не подтверждает другие модели Nextbase или все сочетания передней и задней камер.",
                openTip:
                    "Используй исходные ролики высокого качества с H в конце имени, например _FH.MP4. Версии L — уменьшенные копии того же ракурса; сохрани исходные имена и даты.",
            },
            de: {
                lead: "Öffne originale Nextbase-322GW-Aufnahmen mit GPS-Route und Tempo-Diagramm. Prüfe die Fahrt und speichere einen Clip lokal im Browser.",
                compatibility:
                    "Video und GPS wurden an einer 322GW-Aufnahme mit der Endung _FH geprüft. Andere Nextbase-Modelle oder alle Front-Heck-Kombinationen sind damit nicht bestätigt.",
                openTip:
                    "Nutze die Originalclips hoher Qualität mit H am Namensende, etwa _FH.MP4. L-Versionen sind kleinere Kopien derselben Ansicht. Behalte die ursprünglichen Namen und Datumsangaben.",
            },
            es: {
                lead: "Abre las grabaciones originales de Nextbase 322GW con ruta GPS y gráfico de velocidad. Revisa el viaje y guarda un fragmento localmente en el navegador.",
                compatibility:
                    "El vídeo y el GPS se han comprobado en una grabación del 322GW terminada en _FH. Esto no confirma la compatibilidad de otros modelos Nextbase ni de todas las combinaciones de grabaciones delanteras y traseras.",
                openTip:
                    "Usa los vídeos originales de alta calidad, con H al final del nombre, como _FH.MP4. Las versiones L son copias más pequeñas de la misma vista; conserva los nombres y las fechas originales.",
            },
            fr: {
                lead: "Ouvre les vidéos originales Nextbase 322GW avec trajet GPS et graphique de vitesse. Regarde le trajet et garde un extrait localement.",
                compatibility:
                    "La vidéo et le GPS ont été vérifiés sur un fichier 322GW finissant par _FH. Cela ne confirme pas les autres Nextbase ni toutes les combinaisons avant/arrière.",
                openTip:
                    "Utilise les originaux de haute qualité avec H à la fin du nom, comme _FH.MP4. Les versions L sont des copies plus petites de la même vue. Garde les noms et dates d’origine.",
            },
            pl: {
                lead: "Otwórz oryginalne nagrania Nextbase 322GW z trasą GPS i wykresem prędkości. Przejrzyj przejazd i zapisz fragment lokalnie w przeglądarce.",
                compatibility:
                    "Wideo i GPS sprawdzono na nagraniu 322GW z końcówką _FH. Nie potwierdza to innych Nextbase ani wszystkich połączeń przedniej i tylnej kamery.",
                openTip:
                    "Użyj oryginałów wysokiej jakości z H na końcu nazwy, np. _FH.MP4. Wersje L to mniejsze kopie tego samego widoku. Zachowaj oryginalne nazwy i daty.",
            },
        },
    },
    {
        slug: "redtiger",
        displayName: "REDTIGER",
        models: ["F7NP-4K", "F17"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Watch REDTIGER F7NP-4K and F17 recordings with their camera views, GPS map and speed. Save the part you need without uploading the drive.",
                compatibility:
                    "Video, paired cameras and GPS are checked on F7NP-4K and F17 recordings. The older encrypted F7N GPS format is not readable; its speed stamp alone cannot provide a route map.",
                openTip:
                    "Open the common parent of Movie_F and Movie_R on F7NP-4K, or Video_Front, Video_Inside and Video_Rear on F17. Keep any Event or Parking folders and the original names so camera views stay together.",
            },
            ru: {
                lead: "Смотри записи REDTIGER F7NP-4K и F17 с ракурсами камер, GPS-картой и скоростью. Сохрани нужный участок без загрузки поездки на сервер.",
                compatibility:
                    "Видео, парные камеры и GPS проверены на записях F7NP-4K и F17. Старый зашифрованный GPS-формат F7N не читается; одного штампа скорости недостаточно для карты маршрута.",
                openTip:
                    "Открой общую родительскую папку для Movie_F и Movie_R у F7NP-4K или Video_Front, Video_Inside и Video_Rear у F17. Сохрани папки Event или Parking, если они есть, и исходные имена, чтобы ракурсы оставались вместе.",
            },
            de: {
                lead: "Sieh REDTIGER-F7NP-4K- und F17-Aufnahmen mit Kameraansichten, GPS-Karte und Tempo an. Speichere den benötigten Teil ohne Upload der Fahrt.",
                compatibility:
                    "Video, Kamerapaare und GPS wurden an F7NP-4K- und F17-Aufnahmen geprüft. Das ältere verschlüsselte GPS-Format des F7N ist nicht lesbar; die Tempoanzeige im Bild liefert keine Routenkarte.",
                openTip:
                    "Öffne den gemeinsamen übergeordneten Ordner von Movie_F und Movie_R beim F7NP-4K oder Video_Front, Video_Inside und Video_Rear beim F17. Behalte vorhandene Event- oder Parking-Ordner und die ursprünglichen Dateinamen, damit die Ansichten zusammenbleiben.",
            },
            es: {
                lead: "Mira grabaciones REDTIGER F7NP-4K y F17 con las vistas de las cámaras, mapa GPS y velocidad. Guarda lo que necesitas sin subir el viaje.",
                compatibility:
                    "Vídeo, cámaras emparejadas y GPS se han comprobado en grabaciones F7NP-4K y F17. El antiguo GPS cifrado del F7N no se puede leer; la velocidad dibujada no basta para mostrar una ruta.",
                openTip:
                    "Abre la carpeta común de Movie_F y Movie_R en F7NP-4K, o Video_Front, Video_Inside y Video_Rear en F17. Conserva las carpetas Event o Parking disponibles y los nombres originales para mantener juntas las vistas.",
            },
            fr: {
                lead: "Regarde les enregistrements REDTIGER F7NP-4K et F17 avec les vues des caméras, la carte GPS et la vitesse. Enregistre le passage utile sans envoyer le trajet en ligne.",
                compatibility:
                    "La vidéo, les vues appariées et le GPS ont été vérifiés sur des enregistrements F7NP-4K et F17. L’ancien format GPS chiffré du F7N n’est pas lisible ; la vitesse affichée sur l’image ne suffit pas à tracer le trajet sur une carte.",
                openTip:
                    "Ouvre le dossier parent commun à Movie_F et Movie_R sur le F7NP-4K, ou à Video_Front, Video_Inside et Video_Rear sur le F17. Garde les dossiers Event ou Parking s’ils sont présents et les noms d’origine pour conserver les vues ensemble.",
            },
            ja: {
                lead: "REDTIGER F7NP-4K と F17 の各カメラの録画を、GPS 地図や速度と一緒に確認。走行動画をアップロードせずに必要な部分を保存できます。",
                compatibility:
                    "F7NP-4K と F17 の録画で、動画再生、カメラ映像の組み合わせ、GPS を確認済みです。F7N の旧式の暗号化 GPS 形式は読み取れず、映像に表示された速度だけでは地図にルートを表示できません。",
                openTip:
                    "F7NP-4K では Movie_F と Movie_R、F17 では Video_Front、Video_Inside、Video_Rear に共通する親フォルダーを開いてください。Event や Parking フォルダーがあればそれも残し、各カメラの映像をまとめられるよう元のファイル名を保ってください。",
            },
        },
    },
    {
        slug: "navitel",
        displayName: "NAVITEL",
        models: ["R600 GPS"],
        features: GPS_FEATURES,
        locales: {
            en: {
                lead: "Watch original NAVITEL R600 GPS recordings with the route and speed saved by the camera. Open the folder and save a clip in your browser.",
                compatibility:
                    "GPS is checked on an original R600 GPS MOV recording. Re-exported R600 GPS review clips can lack GPS, so a playing picture or visible speed does not establish route support.",
                openTip:
                    "Choose the original MOV files from the card, keeping their names. Keep these originals when making a shorter copy; an ordinary video export may leave the GPS behind.",
            },
            ru: {
                lead: "Смотри исходные записи NAVITEL R600 GPS с маршрутом и скоростью, сохранёнными камерой. Открой папку и сохрани фрагмент в браузере.",
                compatibility:
                    "GPS проверен на исходной MOV-записи R600 GPS. В преобразованных роликах из обзоров R600 GPS GPS может отсутствовать: видео и видимая скорость сами по себе не подтверждают карту.",
                openTip:
                    "Выбери исходные MOV с карты и сохрани их имена. Оставь оригиналы у себя, когда делаешь короткую копию: обычный экспорт видео может не сохранить GPS.",
            },
            pl: {
                lead: "Oglądaj oryginalne nagrania NAVITEL R600 GPS z trasą i prędkością zapisaną przez kamerę. Otwórz folder i zapisz fragment w przeglądarce.",
                compatibility:
                    "GPS sprawdzono na oryginalnym pliku MOV z R600 GPS. Ponownie wyeksportowane filmy z recenzji R600 GPS mogą nie mieć GPS; sam obraz i widoczna prędkość nie potwierdzają mapy.",
                openTip:
                    "Wybierz oryginalne MOV z karty i zachowaj ich nazwy. Zostaw oryginały, gdy tworzysz krótszą kopię: zwykły eksport wideo może pominąć GPS.",
            },
        },
    },
    {
        slug: "mio",
        displayName: "Mio MiVue",
        models: ["955WD Pro"],
        features: MULTI_CAMERA_FEATURES,
        locales: {
            en: {
                lead: "Open Mio MiVue 955WD Pro front and rear recordings with a route and speed. Keep the matching NMEA files for the map.",
                compatibility:
                    "Video, paired views and GPS are checked on 955WD Pro recordings. The front video's matching .NMEA file supplies the route; copying only the rear video leaves that data out.",
                openTip:
                    "Open the common parent of the F and R folders. Preserve FILE…F.mp4 and FILE…R.mp4 names and the matching .NMEA files beside the front recordings.",
            },
            ru: {
                lead: "Открой передние и задние записи Mio MiVue 955WD Pro с маршрутом и скоростью. Для карты сохрани соответствующие файлы NMEA.",
                compatibility:
                    "Видео, парные ракурсы и GPS проверены на записях 955WD Pro. Маршрут хранится в парном файле .NMEA переднего видео; при копировании только заднего эти данные теряются.",
                openTip:
                    "Открой общую родительскую папку для F и R. Сохрани имена FILE…F.mp4 и FILE…R.mp4 и соответствующие .NMEA рядом с передними записями.",
            },
            de: {
                lead: "Öffne Front- und Heckaufnahmen des Mio MiVue 955WD Pro mit Route und Tempo. Behalte die passenden NMEA-Dateien für die Karte.",
                compatibility:
                    "Video, Ansichtenpaare und GPS wurden an 955WD-Pro-Aufnahmen geprüft. Die .NMEA-Datei des Frontvideos liefert die Route; kopierst du nur das Heckvideo, fehlen diese Daten.",
                openTip:
                    "Öffne den gemeinsamen übergeordneten Ordner von F und R. Behalte die Namen FILE…F.mp4 und FILE…R.mp4 sowie die passenden .NMEA-Dateien neben den Frontaufnahmen.",
            },
            fr: {
                lead: "Ouvre l’avant et l’arrière du Mio MiVue 955WD Pro avec trajet et vitesse. Garde les fichiers NMEA correspondants pour la carte.",
                compatibility:
                    "Vidéo, vues appariées et GPS ont été vérifiés sur des enregistrements 955WD Pro. Le fichier .NMEA de la vidéo avant fournit le trajet ; copier seulement l’arrière laisse ces données de côté.",
                openTip:
                    "Ouvre le dossier parent commun à F et R. Garde les noms FILE…F.mp4 et FILE…R.mp4 ainsi que les fichiers .NMEA correspondants à côté des vidéos avant.",
            },
            pl: {
                lead: "Otwórz przód i tył z Mio MiVue 955WD Pro z trasą i prędkością. Zachowaj pasujące pliki NMEA, aby zobaczyć mapę.",
                compatibility:
                    "Wideo, pary kamer i GPS sprawdzono w nagraniach 955WD Pro. Trasę zawiera plik .NMEA przedniego filmu; kopiując tylko tył, pomijasz te dane.",
                openTip:
                    "Otwórz wspólny folder nadrzędny dla F i R. Zachowaj nazwy FILE…F.mp4 i FILE…R.mp4 oraz pasujące .NMEA obok przednich nagrań.",
            },
            zh: {
                lead: "打开 Mio MiVue 955WD Pro 的前后录像，一起查看路线和速度。保留配套的 NMEA 文件，才能显示地图。",
                compatibility:
                    "已在 955WD Pro 录像中验证视频播放、前后画面配对和 GPS。路线来自前置视频配套的 .NMEA 文件；只复制后置视频会漏掉这些数据。",
                openTip:
                    "打开 F 和 R 文件夹共同的上级文件夹。保留 FILE…F.mp4 和 FILE…R.mp4 的原始名称，并将配套的 .NMEA 文件与前置录像放在一起。",
            },
        },
    },
    {
        slug: "navman",
        displayName: "Navman MiVue",
        models: ["150 Safety"],
        features: GPS_FEATURES,
        locales: {
            en: {
                lead: "Watch Navman MiVue 150 Safety recordings with GPS from their matching NMEA files. Review the trip locally without MiVue Manager.",
                compatibility:
                    "GPS is checked on 150 Safety recordings with separate NMEA files. This does not confirm the GPS format of other Navman MiVue models.",
                openTip:
                    "Copy the videos and matching .NMEA files together, with their original names. Open the whole folder: a video sent on its own may play without a route.",
            },
            ru: {
                lead: "Смотри записи Navman MiVue 150 Safety с GPS из соответствующих NMEA-файлов. Просматривай поездку локально без MiVue Manager.",
                compatibility:
                    "GPS проверен на записях 150 Safety с отдельными файлами NMEA. Это не подтверждает GPS-формат других моделей Navman MiVue.",
                openTip:
                    "Скопируй видео и соответствующие .NMEA вместе, сохранив исходные имена. Открой всю папку: отправленный отдельно ролик может воспроизводиться без маршрута.",
            },
        },
    },
    {
        slug: "fitcamx",
        displayName: "FITCAMX",
        models: [],
        features: [...VIDEO_FEATURES, "combine-dashcam-cameras-into-one-video"],
        locales: {
            en: {
                lead: "Watch FITCAMX front and rear recordings together. Keep ordinary and saved clips organised, then trim and save the part you need.",
                compatibility:
                    "Support covers the checked FITCAMX TS and MP4 recording layouts, not every car-specific kit. Video playback is confirmed; GPS mapping for these layouts is not.",
                openTip:
                    "Open the whole folder with Movie, Movie_E, EMR and EMR_E when present. The _E folders identify the rear view and EMR marks saved events; keep these folders and original filenames.",
            },
            ru: {
                lead: "Смотри передние и задние записи FITCAMX вместе. Обычные и сохранённые ролики остаются упорядоченными; нужный участок можно обрезать и сохранить.",
                compatibility:
                    "Поддерживаются проверенные форматы FITCAMX в TS и MP4, а не все комплекты под конкретные автомобили. Просмотр видео подтверждён, карта GPS для этих форматов — пока нет.",
                openTip:
                    "Открой всю папку с Movie, Movie_E, EMR и EMR_E, если они есть. Папки _E обозначают задний ракурс, а EMR — сохранённые события. Сохрани эти папки и исходные имена файлов.",
            },
            de: {
                lead: "Sieh FITCAMX-Aufnahmen von Front und Heck zusammen an. Behalte normale und gespeicherte Clips geordnet und speichere den benötigten Ausschnitt.",
                compatibility:
                    "Unterstützt werden die geprüften FITCAMX-TS- und MP4-Aufnahmearten, nicht jedes fahrzeugspezifische Set. Videowiedergabe ist bestätigt, eine GPS-Karte für diese Formate noch nicht.",
                openTip:
                    "Öffne den ganzen Ordner mit Movie, Movie_E, EMR und EMR_E, soweit vorhanden. _E kennzeichnet die Heckansicht, EMR gespeicherte Ereignisse. Behalte die Ordner und ursprünglichen Dateinamen.",
            },
            pl: {
                lead: "Oglądaj razem przednie i tylne nagrania FITCAMX. Zachowaj porządek w zwykłych i zapisanych klipach, a potrzebny odcinek przytnij i zapisz.",
                compatibility:
                    "Obsługiwane są sprawdzone układy nagrań FITCAMX TS i MP4, nie każdy zestaw do konkretnego auta. Odtwarzanie wideo jest potwierdzone, mapa GPS dla tych formatów jeszcze nie.",
                openTip:
                    "Otwórz cały folder z Movie, Movie_E, EMR i EMR_E, jeśli są dostępne. Foldery _E oznaczają tył, a EMR zapisane zdarzenia. Zachowaj te foldery i oryginalne nazwy plików.",
            },
            zh: {
                lead: "一起查看 FITCAMX 的前后录像。普通片段和已保存片段保持有序，按需截取并保存所需部分。",
                compatibility:
                    "支持范围以已验证的 FITCAMX TS 和 MP4 录像格式为准，不涵盖所有车型专用套件。已确认视频可正常播放，但尚未确认这些格式能显示 GPS 地图。",
                openTip:
                    "打开整个录像文件夹，包括其中的 Movie、Movie_E、EMR 和 EMR_E 文件夹（如有）。_E 文件夹表示后置画面，EMR 表示已保存的事件；请保留这些文件夹和原始文件名。",
            },
        },
    },
];

export const establishedCameraPages: VendorContent[] = PAGES.map(({ locales, ...page }) => {
    const translated: Partial<Record<Lang, VendorLocaleContent>> = {};
    for (const lang of Object.keys(locales) as Lang[]) {
        const copy = locales[lang]!;
        const label = LABELS[lang];
        const title = label.title.replace("{vendor}", page.displayName);
        translated[lang] = {
            title: `${title} | everydashcam`,
            h1: title,
            ogTitle: title,
            metaDescription: copy.lead,
            ogDescription: copy.lead,
            lead: copy.lead,
            ctaPrimary: label.cta.replace("{vendor}", page.displayName),
            modelsCompat: copy.compatibility,
            formatIntro: copy.openTip,
        };
    }
    return { ...page, locales: { ...translated, en: translated.en! } };
});
