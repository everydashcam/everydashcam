import type { FeatureSlug } from "./feature-pages.js";
import type { VendorContent, VendorLocaleContent } from "./vendor-pages.js";

// SEO copy focuses on the camera and player benefits. Format details and
// recording evidence belong in docs/gps-format-coverage.md and its linked docs.
// These pages describe the named models, not every device sold under a brand.
interface CameraCopy {
    title: string;
    description: string;
    lead: string;
    compatibility: string;
    openTip: string;
}

interface CameraPage {
    slug: VendorContent["slug"];
    displayName: string;
    models: string[];
    features: readonly FeatureSlug[];
    en: CameraCopy;
    ru: CameraCopy;
}

const VIDEO_FEATURES = ["blur-license-plate-in-dashcam-video"] as const;
const GPS_FEATURES = [...VIDEO_FEATURES, "add-data-overlay-to-dashcam-video"] as const;
const MULTI_CAMERA_FEATURES = [...GPS_FEATURES, "combine-dashcam-cameras-into-one-video"] as const;

function localize(copy: CameraCopy, name: string, lang: "en" | "ru"): VendorLocaleContent {
    return {
        title: `${copy.title} | everydashcam`,
        metaDescription: copy.description,
        ogTitle: copy.title,
        ogDescription: copy.description,
        h1: copy.title,
        lead: copy.lead,
        ctaPrimary: lang === "en" ? `Open ${name} recordings` : `Открыть записи ${name}`,
        modelsCompat: copy.compatibility,
        formatIntro: copy.openTip,
    };
}

const PAGES: CameraPage[] = [
    {
        slug: "comtec",
        displayName: "COMTEC",
        models: ["EG-1"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "COMTEC EG-1 helmet dashcam player",
            description:
                "Watch COMTEC EG-1 front and rear recordings with a GPS route and speed chart. Free browser player, with your recordings staying on your device.",
            lead: "Review a motorcycle ride from your COMTEC EG-1 helmet camera. Watch the front and rear views alongside the route and speed, with your recordings staying on your device.",
            compatibility:
                "Supports video, route and speed from the COMTEC EG-1 helmet camera.",
            openTip:
                "Open the Movie folder with its Front and Rear subfolders to bring both cameras together in one trip. Keep the original filenames.",
        },
        ru: {
            title: "Плеер для шлемного регистратора COMTEC EG-1",
            description:
                "Смотри записи передней и задней камер COMTEC EG-1 с GPS-маршрутом и графиком скорости. Бесплатный плеер в браузере, записи остаются на твоём устройстве.",
            lead: "Посмотри поездку на мотоцикле, снятую шлемным регистратором COMTEC EG-1. Передняя и задняя камеры, маршрут и скорость — на одном экране. Записи остаются на твоём устройстве.",
            compatibility:
                "Поддерживаются видео, маршрут и скорость со шлемного регистратора COMTEC EG-1.",
            openTip:
                "Открой папку Movie вместе с подпапками Front и Rear, чтобы собрать обе камеры в одну поездку. Сохрани исходные имена файлов.",
        },
    },
    {
        slug: "avylet",
        displayName: "Avylet",
        models: ["A1"],
        features: GPS_FEATURES,
        en: {
            title: "Avylet A1 dashcam player",
            description:
                "Play Avylet A1 recordings in your browser. View the route from recordings made with the optional GPS receiver. Free, local playback.",
            lead: "Watch Avylet A1 recordings straight from the SD card. With the optional GPS receiver connected during recording, you can also follow the route and speed while watching.",
            compatibility:
                "Video and GPS are supported for A1 recordings in TS mode. The camera needs its GPS receiver to record a route; video recorded without it still plays.",
            openTip:
                "Open the entire recording folder, including the original .TS files. Keep their date-based names so the clips can be placed on the trip timeline.",
        },
        ru: {
            title: "Плеер для видеорегистратора Avylet A1",
            description:
                "Смотри записи Avylet A1 в браузере. Маршрут доступен в записях с дополнительным GPS-приёмником. Бесплатно, файлы остаются на устройстве.",
            lead: "Открой записи Avylet A1 прямо с SD-карты. Если во время записи был подключён дополнительный GPS-приёмник, можно смотреть маршрут и скорость вместе с видео.",
            compatibility:
                "Видео и GPS поддерживаются для записей A1 в режиме TS. Для записи маршрута камере нужен GPS-приёмник; видео без него тоже воспроизводится.",
            openTip:
                "Открой папку с записями целиком, включая исходные файлы .TS. Сохрани их имена с датами, чтобы ролики расположились на шкале поездки.",
        },
    },
    {
        slug: "izeeker",
        displayName: "iZEEKER",
        models: ["iD300"],
        features: GPS_FEATURES,
        en: {
            title: "iZEEKER iD300 video and GPS player",
            description:
                "Open iZEEKER iD300 recordings with a route map and speed chart. Keep the original filenames and watch locally in your browser.",
            lead: "Review an iZEEKER iD300 trip with video, a route map and a speed chart on one screen. The player reads the GPS saved in the original recording.",
            compatibility:
                "GPS support covers the iD300 recording layout. It does not establish compatibility with every iZEEKER model or with videos that have been converted by another app.",
            openTip:
                "Open the original MP4 folder and keep the camera's filenames. The dates in those names help place the iD300 GPS records at the right time.",
        },
        ru: {
            title: "Плеер iZEEKER iD300 с картой GPS",
            description:
                "Открой записи iZEEKER iD300 с картой маршрута и графиком скорости. Сохрани исходные имена файлов и смотри видео локально в браузере.",
            lead: "Посмотри поездку с iZEEKER iD300: видео, маршрут и график скорости на одном экране. Плеер читает GPS из исходной записи регистратора.",
            compatibility:
                "GPS поддерживается для формата записей iD300. Это не подтверждает совместимость со всеми моделями iZEEKER или видео, преобразованными в другом приложении.",
            openTip:
                "Открой папку с исходными MP4 и сохрани имена файлов регистратора. Даты в этих именах помогают правильно расположить GPS-записи iD300 по времени.",
        },
    },
    {
        slug: "compartir",
        displayName: "Compartir",
        models: [],
        features: GPS_FEATURES,
        en: {
            title: "Compartir dashcam player with GPS",
            description:
                "Play the checked Compartir TS recordings with their GPS route in your browser. No conversion or recording upload needed.",
            lead: "Open Compartir recordings without converting them first. everydashcam plays the checked TS files and shows the route and speed when the camera recorded GPS.",
            compatibility:
                "Video and GPS are checked on the supplied Compartir TS recordings. Their retail model is unconfirmed; this is recording-level evidence, not a model-wide promise. A converted MP4 can lose the route.",
            openTip:
                "Choose the original folder from the SD card. Keep the .TS files and their names instead of making converted copies just to open them in a player.",
        },
        ru: {
            title: "Плеер Compartir с GPS-картой",
            description:
                "Смотри проверенные TS-записи Compartir с маршрутом GPS в браузере. Без предварительного преобразования и загрузки видео на сервер.",
            lead: "Открой записи Compartir без предварительного преобразования. everydashcam воспроизводит проверенные TS-файлы и показывает маршрут и скорость, если камера записала GPS.",
            compatibility:
                "Видео и GPS проверены на предоставленных TS-записях Compartir. Название модели не подтверждено: проверены именно эти записи, а не вся линейка. Преобразованный MP4 может потерять маршрут.",
            openTip:
                "Выбери исходную папку с SD-карты. Сохрани файлы .TS и их имена: делать преобразованные копии ради просмотра не нужно.",
        },
    },
    {
        slug: "vueroid",
        displayName: "Vueroid",
        models: ["S1 4K Infinite"],
        features: GPS_FEATURES,
        en: {
            title: "Vueroid S1 4K Infinite recording player",
            description:
                "Watch Vueroid S1 4K Infinite originals with a GPS route and speed chart. Review and trim recordings locally in your browser.",
            lead: "Review Vueroid S1 4K Infinite recordings alongside their route and speed. Find the moment you need, then trim a clip for sharing without uploading the drive.",
            compatibility:
                "GPS support covers original S1 4K Infinite recordings. Edited comparison videos or downloads from video sites can lose the GPS even when the speed is still visible in the picture.",
            openTip:
                "Use the original MP4s from the camera's card. Open the recording folder before choosing a trip; a re-encoded review clip is not a substitute for the originals when you need the map.",
        },
        ru: {
            title: "Плеер записей Vueroid S1 4K Infinite",
            description:
                "Смотри исходные записи Vueroid S1 4K Infinite с GPS-маршрутом и графиком скорости. Просмотр и обрезка локально в браузере.",
            lead: "Посмотри записи Vueroid S1 4K Infinite вместе с маршрутом и скоростью. Найди нужный момент и сохрани фрагмент, не загружая поездку на сервер.",
            compatibility:
                "GPS поддерживается в исходных записях S1 4K Infinite. Смонтированные сравнения и ролики с видеосайтов могут потерять GPS, даже если скорость осталась видна на изображении.",
            openTip:
                "Используй исходные MP4 с карты камеры. Открой папку с записями и выбери поездку: преобразованный ролик из обзора не заменит оригиналы, если нужна карта.",
        },
    },
    {
        slug: "botslab",
        displayName: "Botslab",
        models: ["G300H Pro"],
        features: GPS_FEATURES,
        en: {
            title: "Botslab G300H Pro recording and GPS player",
            description:
                "Open Botslab G300H Pro videos together with GPS.TXT to view the trip route and speed. Watch and trim locally in your browser.",
            lead: "Watch a Botslab G300H Pro trip with its route and speed. Keep GPS.TXT with the recordings: it holds the route for multiple clips, rather than just one video.",
            compatibility:
                "GPS support covers G300H Pro recordings using the G300HPro recording layout. Copying only the video folder leaves out the GPS log needed for the map.",
            openTip:
                "Open the common parent folder containing 360CARDVR/REC and GPS.TXT. Preserve the original folder structure so the route can be matched to the trip's clips.",
        },
        ru: {
            title: "Плеер записей и GPS для Botslab G300H Pro",
            description:
                "Открой видео Botslab G300H Pro вместе с GPS.TXT, чтобы увидеть маршрут и скорость. Просмотр и обрезка локально в браузере.",
            lead: "Посмотри поездку с Botslab G300H Pro вместе с маршрутом и скоростью. Сохрани GPS.TXT рядом с записями: этот файл хранит маршрут для нескольких роликов, а не одного видео.",
            compatibility:
                "GPS поддерживается для записей G300H Pro с форматом G300HPro. Если скопировать только папку с видео, файл GPS для карты останется на устройстве.",
            openTip:
                "Открой общую родительскую папку с 360CARDVR/REC и GPS.TXT. Сохрани исходную структуру, чтобы маршрут сопоставился с роликами поездки.",
        },
    },
    {
        slug: "neoline",
        displayName: "Neoline",
        models: ["Spectrum"],
        features: GPS_FEATURES,
        en: {
            title: "Neoline Spectrum video and GPS player",
            description:
                "Play Neoline Spectrum originals with a route map and speed chart. Keep the camera's filenames and open the folder in your browser.",
            lead: "Watch Neoline Spectrum recordings with the GPS route and speed saved by the camera. Move along the trip timeline to find the part you want to keep.",
            compatibility:
                "GPS support covers the Spectrum recording layout. The route starts where valid satellite positions are available; a missing fix does not prevent video playback.",
            openTip:
                "Open the original MP4 folder without renaming its files. Spectrum recordings use the filename date to place their GPS points on the trip timeline.",
        },
        ru: {
            title: "Плеер Neoline Spectrum с GPS-картой",
            description:
                "Смотри исходные записи Neoline Spectrum с маршрутом и графиком скорости. Сохрани имена файлов камеры и открой папку в браузере.",
            lead: "Смотри записи Neoline Spectrum с маршрутом и скоростью, сохранёнными камерой. Перемещайся по шкале поездки, чтобы найти и сохранить нужный фрагмент.",
            compatibility:
                "GPS поддерживается для формата записей Spectrum. Маршрут начинается там, где есть корректные спутниковые координаты; отсутствие GPS-сигнала не мешает смотреть видео.",
            openTip:
                "Открой папку с исходными MP4, не переименовывая файлы. Дата в имени записи Spectrum помогает разместить точки GPS на шкале поездки.",
        },
    },
    {
        slug: "escort",
        displayName: "Escort",
        models: ["M2"],
        features: GPS_FEATURES,
        en: {
            title: "Escort M2 recording player with a route map",
            description:
                "Watch Escort M2 recordings with GPS from their matching .map files. Open the whole folder locally, without installing a player.",
            lead: "Open an Escort M2 recording and follow its route while watching. everydashcam reads the matching .map file next to the video to add GPS to the trip.",
            compatibility:
                "The supported M2 layout stores the route separately from the video. A video copied on its own can play without showing a map.",
            openTip:
                "Copy the videos and their matching .map files together. Keep their original names and open the containing folder so the player can pair each route with its recording.",
        },
        ru: {
            title: "Плеер Escort M2 с картой маршрута",
            description:
                "Смотри записи Escort M2 с GPS из соответствующих файлов .map. Открой всю папку локально, без установки плеера.",
            lead: "Открой запись Escort M2 и следи за маршрутом во время просмотра. everydashcam читает соответствующий файл .map рядом с видео и добавляет GPS к поездке.",
            compatibility:
                "В поддерживаемом формате M2 маршрут хранится отдельно от видео. Если скопировать только ролик, он может воспроизводиться без карты.",
            openTip:
                "Скопируй видео вместе с соответствующими файлами .map. Сохрани исходные имена и открой общую папку, чтобы плеер сопоставил маршруты с записями.",
        },
    },
    {
        slug: "carcam",
        displayName: "CARCAM",
        models: ["CC-365 (4CH)"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "CARCAM CC-365 multi-camera recording player",
            description:
                "Review CARCAM CC-365 recordings together with GPS. Keep all camera folders to group the views into trips and save a clip in your browser.",
            lead: "Review the different views from a CARCAM CC-365 recording together. Open all camera folders to keep the trip in one place, with a route when GPS was recorded.",
            compatibility:
                "Video and GPS support covers the CARCAM CC-365 recording layout. Camera letters identify the recorded views; their physical positions can depend on how the cameras were installed.",
            openTip:
                "Open the common folder containing the camera subfolders, such as Normal/A. Keep the A–D filename endings and folder names so the player can group the views.",
        },
        ru: {
            title: "Плеер для нескольких камер CARCAM CC-365",
            description:
                "Смотри записи CARCAM CC-365 вместе с GPS. Сохрани папки всех камер, чтобы объединить ракурсы в поездки и сохранить фрагмент в браузере.",
            lead: "Смотри разные ракурсы записи CARCAM CC-365 вместе. Открой папки всех камер, чтобы собрать поездку на одном экране и увидеть маршрут, если GPS был записан.",
            compatibility:
                "Видео и GPS поддерживаются для формата CARCAM CC-365. Буквы камер обозначают ракурсы записи; их положение в автомобиле может зависеть от установки.",
            openTip:
                "Открой общую папку с подпапками камер, например Normal/A. Сохрани окончания A–D в именах файлов и названия папок, чтобы плеер сгруппировал ракурсы.",
        },
    },
    {
        slug: "beferich",
        displayName: "Beferich",
        models: ["J18"],
        features: GPS_FEATURES,
        en: {
            title: "Beferich J18 video and GPS player",
            description:
                "Watch Beferich J18 front recordings with their GPS route. Use original MP4 files to keep the map available when reviewing a trip.",
            lead: "Play Beferich J18 front-camera recordings with their route and speed. The GPS is kept in the original MP4, so there is no separate route file to select for this layout.",
            compatibility:
                "Video and GPS have been checked on J18 front recordings. This does not confirm GPS in every rear-camera recording or every firmware variant.",
            openTip:
                "Open the original recording folder and retain the dated filenames ending in _f.mp4. Use those originals for the map: saving a converted copy can remove the GPS.",
        },
        ru: {
            title: "Плеер Beferich J18 с GPS-картой",
            description:
                "Смотри записи передней камеры Beferich J18 с GPS-маршрутом. Используй исходные MP4, чтобы сохранить карту при просмотре поездки.",
            lead: "Смотри записи передней камеры Beferich J18 вместе с маршрутом и скоростью. GPS хранится в исходном MP4: отдельный файл маршрута для этого формата выбирать не нужно.",
            compatibility:
                "Видео и GPS проверены на передних записях J18. Это не подтверждает GPS во всех записях задней камеры или во всех вариантах прошивки.",
            openTip:
                "Открой исходную папку и сохрани имена с датами, заканчивающиеся на _f.mp4. Для карты используй оригиналы: преобразованная копия может потерять GPS.",
        },
    },
    {
        slug: "datakam",
        displayName: "DATAKAM",
        models: ["G5P"],
        features: GPS_FEATURES,
        en: {
            title: "DATAKAM G5P exported recording player",
            description:
                "Open DATAKAM G5P recordings exported by Registrator Viewer with GPS preserved. Watch the video and route locally in your browser.",
            lead: "Reopen DATAKAM G5P clips saved by Registrator Viewer with their GPS preserved. Watch the exported video alongside its route without uploading it.",
            compatibility:
                "GPS support here covers the exported recording layout. It is not a promise that every original G5P file from an SD card contains GPS the player can read.",
            openTip:
                "Choose the recordings exported from Registrator Viewer with GPS retained. If an ordinary video editor removed that data, the picture may play while the map stays empty.",
        },
        ru: {
            title: "Плеер экспортированных записей DATAKAM G5P",
            description:
                "Открой записи DATAKAM G5P, экспортированные из Registrator Viewer с сохранением GPS. Смотри видео и маршрут локально в браузере.",
            lead: "Открой фрагменты DATAKAM G5P, сохранённые через Registrator Viewer вместе с GPS. Смотри экспортированное видео рядом с маршрутом, не загружая его на сервер.",
            compatibility:
                "Поддержка GPS здесь относится к формату экспортированных записей. Это не обещание чтения GPS из любого исходного файла G5P с SD-карты.",
            openTip:
                "Выбери записи, экспортированные из Registrator Viewer с сохранённым GPS. Если обычный видеоредактор удалил эти данные, видео может воспроизводиться без карты.",
        },
    },
    {
        slug: "2e-drive",
        displayName: "2E Drive",
        models: ["730 Magnet"],
        features: GPS_FEATURES,
        en: {
            title: "2E-Drive 730 Magnet recording player with GPS",
            description:
                "Play 2E Drive 730 recordings with their embedded GPS route and speed. Open original files locally in a free browser player.",
            lead: "Watch a 2E Drive 730 trip with the route and speed stored in the original recording. Find a moment on the timeline and save a shorter clip for sharing.",
            compatibility:
                "Video and GPS support covers 730 recordings. Other 2E Drive models may store their route differently; the model name alone does not guarantee the map.",
            openTip:
                "Use the original video files from the card, with their original names. The 730 layout carries GPS inside the recording, so a separately downloaded map file is not needed.",
        },
        ru: {
            title: "Плеер записей 2E-Drive 730 Magnet с GPS",
            description:
                "Смотри записи 2E Drive 730 с маршрутом и скоростью из исходных файлов. Открой видео локально в бесплатном браузерном плеере.",
            lead: "Посмотри поездку с 2E Drive 730 вместе с маршрутом и скоростью из исходной записи. Найди момент на шкале времени и сохрани короткий фрагмент для отправки.",
            compatibility:
                "Видео и GPS поддерживаются для записей 730. Другие модели 2E Drive могут хранить маршрут иначе; одного названия модели недостаточно, чтобы обещать карту.",
            openTip:
                "Используй исходные видео с карты и сохрани их имена. В формате 730 GPS находится внутри записи, поэтому отдельно скачивать файл карты не нужно.",
        },
    },
    {
        slug: "sony",
        displayName: "Sony",
        models: ["HDR-AS30V"],
        features: GPS_FEATURES,
        en: {
            title: "Sony HDR-AS30V Action Cam video and GPS player",
            description:
                "Watch Sony HDR-AS30V action-camera recordings with GPS from the matching LOG files. Keep video and route logs together for local playback.",
            lead: "Watch Sony HDR-AS30V Action Cam recordings alongside their route. Open the videos together with the camera's GPS logs to bring the trip onto the map.",
            compatibility:
                "Support covers HDR-AS30V recording logs. The route can start later than the video while the camera waits for a GPS fix; this does not mean the beginning of the video is missing.",
            openTip:
                "Copy the camera's .LOG files along with its original MP4s and open their common parent folder. A log may contain route information for more than one clip.",
        },
        ru: {
            title: "Плеер Sony HDR-AS30V Action Cam с GPS",
            description:
                "Смотри записи экшен-камеры Sony HDR-AS30V с GPS из файлов LOG. Сохрани видео и файлы маршрута вместе для локального просмотра.",
            lead: "Смотри записи Sony HDR-AS30V Action Cam рядом с маршрутом. Открой видео вместе с GPS-файлами камеры, чтобы увидеть поездку на карте.",
            compatibility:
                "Поддерживаются файлы маршрута HDR-AS30V. Маршрут может начаться позже видео, пока камера ищет спутники; это не означает, что начало видео потеряно.",
            openTip:
                "Скопируй файлы .LOG камеры вместе с исходными MP4 и открой их общую родительскую папку. Один LOG может содержать маршрут для нескольких роликов.",
        },
    },
    {
        slug: "hp",
        displayName: "HP",
        models: ["f969x"],
        features: VIDEO_FEATURES,
        en: {
            title: "HP f969x dashcam video player",
            description:
                "Open HP f969x TS recordings in your browser. Watch and trim video locally; a speed stamp in the picture does not provide a separate GPS map.",
            lead: "Watch HP f969x recordings directly from their TS files, then save the part you need. A location or speed stamp already in the video stays visible during playback.",
            compatibility:
                "The checked f969x recordings support video playback, but do not contain readable GPS for a separate route map. Numbers printed in the picture cannot supply that route.",
            openTip:
                "Open the original recording folder, including files such as HPIM…F.TS. Keep the camera's filenames and use the video timeline to review the trip.",
        },
        ru: {
            title: "Видеоплеер для регистратора HP f969x",
            description:
                "Открой TS-записи HP f969x в браузере. Смотри и обрезай видео локально; штамп скорости на изображении не даёт отдельную GPS-карту.",
            lead: "Смотри записи HP f969x прямо из TS-файлов и сохраняй нужные фрагменты. Скорость или координаты, уже нанесённые на видео камерой, остаются видны при просмотре.",
            compatibility:
                "Проверенные записи f969x воспроизводятся, но не содержат читаемого GPS для отдельной карты маршрута. Цифры на изображении не заменяют эти данные.",
            openTip:
                "Открой исходную папку с записями, включая файлы вида HPIM…F.TS. Сохрани имена файлов камеры и просматривай поездку по шкале видео.",
        },
    },
    {
        slug: "silverstone-f1",
        displayName: "SilverStone F1",
        models: ["A80-GPS Sky"],
        features: GPS_FEATURES,
        en: {
            title: "SilverStone F1 A80-GPS Sky video and GPS player",
            description:
                "Watch SilverStone F1 A80 recordings with the route and speed stored in the original files. Free browser playback, no recording uploads.",
            lead: "Review SilverStone F1 A80 recordings with a route map and speed chart. Open the card's folder to move through the trip without opening each short clip separately.",
            compatibility:
                "GPS support covers the A80 recording layout. It should not be assumed for the whole SilverStone F1 range or for copies made by a video editor.",
            openTip:
                "Open the original recordings together and keep their camera-generated names. A80 route data is carried inside the video; retain those originals when saving an edited clip for someone else.",
        },
        ru: {
            title: "Плеер SilverStone F1 A80-GPS Sky с GPS-картой",
            description:
                "Смотри записи SilverStone F1 A80 с маршрутом и скоростью из исходных файлов. Бесплатный просмотр в браузере без отправки видео на сервер.",
            lead: "Смотри записи SilverStone F1 A80 с картой маршрута и графиком скорости. Открой папку с карты, чтобы перемещаться по поездке, не выбирая каждый короткий ролик отдельно.",
            compatibility:
                "GPS поддерживается для формата записей A80. Это не обещание для всей линейки SilverStone F1 или копий, сохранённых видеоредактором.",
            openTip:
                "Открой исходные записи вместе и сохрани имена, заданные камерой. Маршрут A80 хранится внутри видео; оставь оригиналы у себя, когда сохраняешь изменённый фрагмент для отправки.",
        },
    },
    {
        slug: "roadgid",
        displayName: "Roadgid",
        models: ["Tube"],
        features: GPS_FEATURES,
        en: {
            title: "Roadgid Tube video and route player",
            description:
                "Review Roadgid Tube recordings with GPS and speed. Open the original dated video files to watch and save a clip locally in your browser.",
            lead: "Open Roadgid Tube recordings with their GPS route and speed. Use the trip timeline to review what happened and save the relevant part of the drive.",
            compatibility:
                "GPS support covers Tube's original recording layout. A date in the filename helps organise the trip, but the actual route comes from GPS inside the recording.",
            openTip:
                "Open the folder containing the original dated recordings. Keep the long date-and-counter filenames; renaming clips or converting them first can remove information used for the trip or map.",
        },
        ru: {
            title: "Плеер видео и маршрута Roadgid Tube",
            description:
                "Смотри записи Roadgid Tube с GPS и скоростью. Открой исходные видео с датами в именах, чтобы просмотреть и сохранить фрагмент в браузере.",
            lead: "Открой записи Roadgid Tube с маршрутом GPS и скоростью. Используй шкалу поездки, чтобы разобраться в событии и сохранить нужный участок дороги.",
            compatibility:
                "GPS поддерживается для исходного формата Tube. Дата в имени файла помогает упорядочить поездку, а сам маршрут берётся из GPS внутри записи.",
            openTip:
                "Открой папку с исходными записями. Сохрани длинные имена с датой и счётчиком: переименование или преобразование роликов может убрать информацию для поездки или карты.",
        },
    },
    {
        slug: "ibox",
        displayName: "iBOX",
        models: ["iCON", "RoadScan 2K WiFi GPS Dual"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "iBOX iCON and RoadScan 2K recording player with GPS",
            description:
                "Play iBOX iCON and RoadScan 2K recordings with a GPS route and speed chart. Keep RoadScan 2K front and rear folders together.",
            lead: "Watch iBOX iCON and RoadScan 2K recordings with the route and speed saved by the camera. Open the original files locally and save a clip without installing a manufacturer player.",
            compatibility:
                "GPS is checked on iCON and RoadScan 2K recordings. This does not establish GPS support for RoadScan 4K, which uses a different recording layout.",
            openTip:
                "Open the original recording folder and keep its filenames. For RoadScan 2K, include the F and R folders: the folder names identify the camera views, and their file counters can differ.",
        },
        ru: {
            title: "Плеер записей iBOX iCON и RoadScan 2K с GPS",
            description:
                "Смотри записи iBOX iCON и RoadScan 2K с маршрутом GPS и графиком скорости. Открой переднюю и заднюю папки RoadScan 2K вместе.",
            lead: "Смотри записи iBOX iCON и RoadScan 2K с маршрутом и скоростью, сохранёнными камерой. Открой исходные файлы локально и сохрани фрагмент без установки программы производителя.",
            compatibility:
                "GPS проверен на записях iCON и RoadScan 2K. Это не подтверждает поддержку GPS у RoadScan 4K: у этой модели другой формат записи.",
            openTip:
                "Открой исходную папку с записями и сохрани имена файлов. У RoadScan 2K добавь папки F и R: именно они обозначают ракурсы, а счётчики в именах файлов могут различаться.",
        },
    },
    {
        slug: "ddpai",
        displayName: "DDPAI",
        models: ["MOLA N3", "Z50", "Z60 Pro"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "DDPAI video and GPS player for MOLA N3, Z50 and Z60 Pro",
            description:
                "Open DDPAI MOLA N3 and Z50 videos locally. Z60 Pro GPS files are supported too; keep matching route files with the original recordings.",
            lead: "Review DDPAI MOLA N3 and Z50 videos in your browser. Z60 Pro stores readable GPS in separate files, which may need copying from the camera itself.",
            compatibility:
                "Video playback is checked on MOLA N3 and Z50 recordings. Z60 Pro GPS reading and filename matching are checked on real .gpx files and .git archives; exact video synchronization still needs matching original videos.",
            openTip:
                "Open 200video and 203gps from their common parent, preserving .gpx and .git files and subfolders. If Z60 Pro GPS files are missing from the SD card, connect the camera by USB and check its internal DCIM/203gps folder; storage can vary by firmware.",
        },
        ru: {
            title: "Плеер видео и GPS DDPAI MOLA N3, Z50 и Z60 Pro",
            description:
                "Открой видео DDPAI MOLA N3 и Z50 локально. GPS-файлы Z60 Pro тоже поддерживаются: сохрани файлы маршрута вместе с исходными записями.",
            lead: "Смотри видео DDPAI MOLA N3 и Z50 в браузере. У Z60 Pro GPS читается из отдельных файлов: их может потребоваться скопировать с самой камеры.",
            compatibility:
                "Просмотр видео проверен на записях MOLA N3 и Z50. Чтение GPS Z60 Pro и сопоставление по именам проверены на реальных файлах .gpx и архивах .git; для проверки точной синхронизации ещё нужны соответствующие исходные видео.",
            openTip:
                "Открой общую родительскую папку для 200video и 203gps, сохранив файлы .gpx и .git и подпапки. Если на SD-карте Z60 Pro нет GPS-файлов, подключи камеру по USB и проверь DCIM/203gps во внутренней памяти; расположение зависит от прошивки.",
        },
    },
    {
        slug: "blackview",
        displayName: "Blackview",
        models: ["X5S PRO"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "Blackview X5S PRO video and GPS player",
            description:
                "Open Blackview X5S PRO TS recordings with their GPS route. Keep front and rear folders together to review the trip locally.",
            lead: "Watch Blackview X5S PRO front and rear recordings together with the route saved by the camera. Open the original TS files in your browser and save the part you need.",
            compatibility:
                "Video and GPS are checked on X5S PRO recordings. Some parking and time-lapse clips contain no GPS fixes; those clips can play without adding a route to the map.",
            openTip:
                "Open the common parent of the F and R recording folders, including parking folders. Preserve the original .TS files and date-based names so both views stay associated with the trip.",
        },
        ru: {
            title: "Плеер Blackview X5S PRO с видео и GPS",
            description:
                "Открой TS-записи Blackview X5S PRO с GPS-маршрутом. Сохрани переднюю и заднюю папки вместе для локального просмотра поездки.",
            lead: "Смотри передние и задние записи Blackview X5S PRO вместе с маршрутом, сохранённым камерой. Открой исходные TS-файлы в браузере и сохрани нужный участок.",
            compatibility:
                "Видео и GPS проверены на записях X5S PRO. В некоторых парковочных и ускоренных записях нет GPS-координат: такие ролики воспроизводятся, но не добавляют маршрут на карту.",
            openTip:
                "Открой общую родительскую папку для F и R, включая парковочные записи. Сохрани исходные .TS и имена с датами, чтобы оба ракурса оставались привязаны к поездке.",
        },
    },
    {
        slug: "innovv",
        displayName: "INNOVV",
        models: ["N2", "K3"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "INNOVV N2 and K3 motorcycle recording player",
            description:
                "Watch INNOVV N2 and K3 motorcycle recordings with GPS. Open original TS files and paired camera views locally in your browser.",
            lead: "Review an INNOVV N2 or K3 ride with video, a route map and speed. Keep the original camera views together and save a clip without uploading the ride.",
            compatibility:
                "GPS is checked on original N2 and K3 TS recordings. The two models store GPS differently, and paired cameras can record different fixes; this does not confirm every INNOVV model or firmware.",
            openTip:
                "Open the original recording folder with both camera views. Preserve .TS files, subfolders and filename endings; converting the videos first can remove their GPS.",
        },
        ru: {
            title: "Плеер записей мотокамер INNOVV N2 и K3",
            description:
                "Смотри записи мотокамер INNOVV N2 и K3 с GPS. Открой исходные TS-файлы и парные ракурсы локально в браузере.",
            lead: "Посмотри поездку с INNOVV N2 или K3: видео, маршрут и скорость на одном экране. Открой исходные ракурсы вместе и сохрани фрагмент без загрузки поездки на сервер.",
            compatibility:
                "GPS проверен на исходных TS-записях N2 и K3. Модели хранят GPS по-разному, а парные камеры могут записывать разные координаты. Это не подтверждает все модели и прошивки INNOVV.",
            openTip:
                "Открой исходную папку с обоими ракурсами. Сохрани файлы .TS, подпапки и окончания имён: предварительное преобразование видео может удалить GPS.",
        },
    },
    {
        slug: "xega",
        displayName: "XEGA",
        models: ["XG-37-AU4G"],
        features: MULTI_CAMERA_FEATURES,
        en: {
            title: "XEGA XG-37-AU4G recording and GPS player",
            description:
                "Watch XEGA XG-37-AU4G MP4 recordings with their GPS route. Keep InternalView, ExteriorView and dated folders for local playback.",
            lead: "Review XEGA XG-37-AU4G interior and exterior recordings with the GPS positions saved inside the original videos. Open the card's folders directly in your browser.",
            compatibility:
                "GPS positions are checked on XG-37-AU4G recordings. Speed is estimated from changes in position, not read as a separate camera measurement; gaps or weak fixes can affect that estimate.",
            openTip:
                "Open the parent containing InternalView and ExteriorView. Keep their dated subfolders and original MP4 names: the folders supply the recording date and identify the camera views.",
        },
        ru: {
            title: "Плеер записей и GPS XEGA XG-37-AU4G",
            description:
                "Смотри MP4-записи XEGA XG-37-AU4G с GPS-маршрутом. Сохрани InternalView, ExteriorView и папки с датами для локального просмотра.",
            lead: "Смотри внутренний и внешний ракурсы XEGA XG-37-AU4G с GPS-координатами из исходных видео. Открой папки с карты прямо в браузере.",
            compatibility:
                "GPS-координаты проверены на записях XG-37-AU4G. Скорость оценивается по изменению положения, а не читается как отдельное измерение камеры; пропуски и неточные координаты могут влиять на оценку.",
            openTip:
                "Открой родительскую папку для InternalView и ExteriorView. Сохрани вложенные папки с датами и исходные имена MP4: папки задают дату записи и обозначают ракурсы.",
        },
    },
    {
        slug: "aspiring",
        displayName: "ASPIRING",
        models: ["Expert 9"],
        features: GPS_FEATURES,
        en: {
            title: "ASPIRING Expert 9 video and GPS player",
            description:
                "Play ASPIRING Expert 9 TS recordings with the GPS route saved in the original files. Review and trim the trip locally in your browser.",
            lead: "Watch ASPIRING Expert 9 recordings with their route and speed. The original TS files carry the GPS, so you can open the recording folder without exporting a separate track.",
            compatibility:
                "Video and GPS are checked on Expert 9 recordings. This confirms the sampled recording layout, not every ASPIRING model or a converted copy of the same video.",
            openTip:
                "Keep the original .TS files and their camera-generated names. Open the folder from the card before editing: an ordinary video conversion can preserve the picture while dropping the route.",
        },
        ru: {
            title: "Плеер ASPIRING Expert 9 с видео и GPS",
            description:
                "Смотри TS-записи ASPIRING Expert 9 с GPS-маршрутом из исходных файлов. Просматривай и обрезай поездку локально в браузере.",
            lead: "Смотри записи ASPIRING Expert 9 с маршрутом и скоростью. GPS хранится в исходных TS-файлах: можно открыть папку с записями без отдельного экспорта трека.",
            compatibility:
                "Видео и GPS проверены на записях Expert 9. Это подтверждает проверенный формат записи, а не все модели ASPIRING или преобразованные копии того же видео.",
            openTip:
                "Сохрани исходные файлы .TS и имена, заданные камерой. Открой папку с карты до редактирования: обычное преобразование видео может сохранить изображение, но удалить маршрут.",
        },
    },
    {
        slug: "jooyfact",
        displayName: "JOOYFACT",
        models: ["A1"],
        features: VIDEO_FEATURES,
        en: {
            title: "JOOYFACT A1 MOV recording player",
            description:
                "Open JOOYFACT A1 MOV recordings locally in your browser. Watch the trip and save a shorter clip from the original camera files.",
            lead: "Watch JOOYFACT A1 MOV recordings without converting them first. Open the original folder, find the moment you need and save a shorter clip locally.",
            compatibility:
                "Video playback is checked on A1 MOV recordings. The checked sample contains no readable GPS, so it does not provide a separate route map or establish GPS support for other JOOYFACT recordings.",
            openTip:
                "Choose the original .MOV files together and preserve their names. Use the video timeline to find an event; a visible date or speed stamp remains part of the picture.",
        },
        ru: {
            title: "Плеер MOV-записей JOOYFACT A1",
            description:
                "Открой MOV-записи JOOYFACT A1 локально в браузере. Посмотри поездку и сохрани короткий фрагмент из исходных файлов камеры.",
            lead: "Смотри MOV-записи JOOYFACT A1 без предварительного преобразования. Открой исходную папку, найди нужный момент и сохрани короткий фрагмент локально.",
            compatibility:
                "Просмотр видео проверен на MOV-записях A1. В проверенном примере нет читаемого GPS: он не даёт отдельную карту маршрута и не подтверждает GPS в других записях JOOYFACT.",
            openTip:
                "Выбери исходные файлы .MOV вместе и сохрани их имена. Ищи событие по шкале видео; видимый штамп даты или скорости остаётся частью изображения.",
        },
    },
    {
        slug: "rexing",
        displayName: "Rexing",
        models: ["SC4KS"],
        features: VIDEO_FEATURES,
        en: {
            title: "Rexing SC4KS TS recording player",
            description:
                "Play Rexing SC4KS TS recordings in your browser. Review the original video and save a clip locally without uploading the trip.",
            lead: "Open Rexing SC4KS TS recordings straight from the card. Watch the original video, move through the trip and save the part you need in your browser.",
            compatibility:
                "The checked SC4KS sample supports video playback but contains no readable GPS. A route map is not confirmed for this recording; other Rexing models can use different formats.",
            openTip:
                "Open the original recording folder and retain the .TS files, names and subfolders. Start with the files from the card; no conversion to MP4 is needed before opening them.",
        },
        ru: {
            title: "Плеер TS-записей Rexing SC4KS",
            description:
                "Смотри TS-записи Rexing SC4KS в браузере. Просматривай исходное видео и сохраняй фрагменты локально без загрузки поездки на сервер.",
            lead: "Открой TS-записи Rexing SC4KS прямо с карты. Смотри исходное видео, перемещайся по поездке и сохраняй нужный участок в браузере.",
            compatibility:
                "Проверенный пример SC4KS воспроизводится, но не содержит читаемого GPS. Карта маршрута для этой записи не подтверждена; другие модели Rexing могут использовать иные форматы.",
            openTip:
                "Открой исходную папку с записями и сохрани файлы .TS, имена и подпапки. Используй файлы с карты: преобразовывать их в MP4 перед открытием не нужно.",
        },
    },
];

export const cameraPages: VendorContent[] = PAGES.map(({ en, ru, ...page }) => ({
    ...page,
    locales: { en: localize(en, page.displayName, "en"), ru: localize(ru, page.displayName, "ru") },
}));
