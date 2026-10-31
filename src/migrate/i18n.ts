import type { Lang } from "../i18n/index.js";

export type MigrationLang = Lang;

const en = {
    title: "Save your dashcamigo notes",
    intro: "dashcamigo is now everydashcam. Save your notes here, then continue to the new site.",
    source: "Reading notes saved at",
    scope: "Use the same browser, profile and address where you saved your notes. Each address keeps its own copy.",
    loading: "Reading your saved notes…",
    ready: "Your notes, markers and favorites are ready to save.",
    empty: "No saved notes were found here.",
    error: "Couldn't read your notes. Close this page and try again. If it still fails, check that this browser allows saved site data. Don't clear site data or remove the installed app; contact feedback@dashcamigo.app for help.",
    downloadError: "Couldn't save the file. Allow downloads for this site and try again.",
    saved: "Check that the notes backup is in your downloads before you continue.",
    download: "Save notes backup",
    retry: "Try again",
    restore: "Next, choose this file to bring your notes to everydashcam.",
    privacy: "This page only reads your saved notes. Nothing is uploaded or deleted.",
    language: "Language",
    continue: "Continue to everydashcam",
} as const;

type MigrationKey = keyof typeof en;

const ru = {
    title: "Сохрани пометки dashcamigo",
    intro: "dashcamigo теперь everydashcam. Сохрани пометки здесь, затем переходи на новый сайт.",
    source: "Пометки с адреса",
    scope: "Используй тот же браузер, профиль и адрес, где сохранял пометки. На каждом адресе хранится своя копия.",
    loading: "Чтение сохранённых пометок…",
    ready: "Пометки, маркеры и избранное готовы к сохранению.",
    empty: "Здесь нет сохранённых пометок.",
    error: "Не удалось прочитать пометки. Закрой эту страницу и попробуй снова. Если не поможет, проверь, разрешено ли браузеру сохранять данные сайтов. Не очищай данные сайта и не удаляй установленное приложение; напиши на feedback@dashcamigo.app.",
    downloadError: "Не удалось сохранить файл. Разреши скачивание файлов с этого сайта и попробуй снова.",
    saved: "Проверь, что резервная копия пометок появилась в загрузках, прежде чем продолжить.",
    download: "Сохранить резервную копию пометок",
    retry: "Попробовать снова",
    restore: "На следующем экране выбери этот файл, чтобы перенести пометки в everydashcam.",
    privacy: "Эта страница только читает сохранённые пометки. Ничего не отправляется и не удаляется.",
    language: "Язык",
    continue: "Продолжить в everydashcam",
} satisfies Record<MigrationKey, string>;

const de = {
    title: "Sichere deine dashcamigo-Notizen",
    intro: "dashcamigo heißt jetzt everydashcam. Sichere deine Notizen hier und gehe dann zur neuen Website.",
    source: "Notizen von dieser Adresse",
    scope: "Nutze denselben Browser, dasselbe Profil und dieselbe Adresse, unter der du deine Notizen gespeichert hast. Jede Adresse hat ihre eigene Kopie.",
    loading: "Gespeicherte Notizen werden gelesen…",
    ready: "Deine Notizen, Marker und Favoriten sind bereit zum Sichern.",
    empty: "Hier wurden keine gespeicherten Notizen gefunden.",
    error: "Deine Notizen konnten nicht gelesen werden. Schließe diese Seite und versuche es erneut. Falls es weiterhin nicht klappt, prüfe, ob dein Browser Website-Daten speichern darf. Lösche keine Website-Daten und entferne die installierte App nicht. Hilfe bekommst du unter feedback@dashcamigo.app.",
    downloadError:
        "Die Datei konnte nicht gespeichert werden. Erlaube Downloads für diese Website und versuche es erneut.",
    saved: "Prüfe, ob die Notizen-Sicherung in deinen Downloads liegt, bevor du fortfährst.",
    download: "Notizen-Sicherung speichern",
    retry: "Erneut versuchen",
    restore: "Wähle im nächsten Schritt diese Datei, um deine Notizen zu everydashcam zu übertragen.",
    privacy: "Diese Seite liest nur deine gespeicherten Notizen. Nichts wird hochgeladen oder gelöscht.",
    language: "Sprache",
    continue: "Weiter zu everydashcam",
} satisfies Record<MigrationKey, string>;

const es = {
    title: "Guarda tus notas de dashcamigo",
    intro: "dashcamigo ahora es everydashcam. Guarda tus notas aquí y continúa al nuevo sitio.",
    source: "Notas guardadas en",
    scope: "Usa el mismo navegador, perfil y dirección donde guardaste tus notas. Cada dirección tiene su propia copia.",
    loading: "Leyendo tus notas guardadas…",
    ready: "Tus notas, marcadores y favoritos están listos para guardar.",
    empty: "No se encontraron notas guardadas aquí.",
    error: "No se pudieron leer tus notas. Cierra esta página e inténtalo de nuevo. Si sigue fallando, comprueba que el navegador permita guardar datos de sitios web. No borres esos datos ni desinstales la app; escribe a feedback@dashcamigo.app para pedir ayuda.",
    downloadError: "No se pudo guardar el archivo. Permite las descargas de este sitio e inténtalo de nuevo.",
    saved: "Comprueba que la copia de notas esté en tus descargas antes de continuar.",
    download: "Guardar copia de notas",
    retry: "Intentar de nuevo",
    restore: "En la siguiente pantalla, elige este archivo para llevar tus notas a everydashcam.",
    privacy: "Esta página solo lee tus notas guardadas. No se sube ni se elimina nada.",
    language: "Idioma",
    continue: "Continuar a everydashcam",
} satisfies Record<MigrationKey, string>;

const fr = {
    title: "Sauvegarde tes notes dashcamigo",
    intro: "dashcamigo devient everydashcam. Sauvegarde tes notes ici, puis passe au nouveau site.",
    source: "Notes enregistrées à cette adresse",
    scope: "Utilise le même navigateur, le même profil et la même adresse que pour tes notes. Chaque adresse conserve sa propre copie.",
    loading: "Lecture de tes notes enregistrées…",
    ready: "Tes notes, repères et favoris sont prêts à être sauvegardés.",
    empty: "Aucune note enregistrée ici.",
    error: "Impossible de lire tes notes. Ferme cette page et réessaie. Si le problème persiste, vérifie que ton navigateur autorise l’enregistrement des données des sites. N’efface pas ces données et ne désinstalle pas l’app ; écris à feedback@dashcamigo.app pour obtenir de l’aide.",
    downloadError: "Impossible d’enregistrer le fichier. Autorise les téléchargements pour ce site et réessaie.",
    saved: "Vérifie que la sauvegarde des notes est dans tes téléchargements avant de continuer.",
    download: "Sauvegarder les notes",
    retry: "Réessayer",
    restore: "À l’étape suivante, choisis ce fichier pour transférer tes notes vers everydashcam.",
    privacy: "Cette page lit uniquement tes notes enregistrées. Rien n’est envoyé ni supprimé.",
    language: "Langue",
    continue: "Continuer vers everydashcam",
} satisfies Record<MigrationKey, string>;

const ja = {
    title: "dashcamigo のメモを保存",
    intro: "dashcamigo は everydashcam になりました。ここでメモを保存してから、新しいサイトへ進んでください。",
    source: "メモの保存元",
    scope: "メモを保存したときと同じブラウザ、プロフィール、アドレスを使ってください。メモはアドレスごとに別々に保存されています。",
    loading: "保存済みのメモを読み込んでいます…",
    ready: "メモ、マーカー、お気に入りを保存できます。",
    empty: "ここには保存済みのメモがありません。",
    error: "メモを読み込めませんでした。このページを閉じて、もう一度試してください。解決しない場合は、ブラウザでサイトデータの保存が許可されているか確認してください。サイトデータを消去したり、インストール済みのアプリを削除したりせず、feedback@dashcamigo.app にお問い合わせください。",
    downloadError: "ファイルを保存できませんでした。このサイトからのダウンロードを許可して、もう一度試してください。",
    saved: "続ける前に、ダウンロード先にメモのバックアップがあることを確認してください。",
    download: "メモのバックアップを保存",
    retry: "もう一度試す",
    restore: "次の画面でこのファイルを選ぶと、メモを everydashcam に移せます。",
    privacy: "このページは保存済みのメモを読み取るだけです。アップロードや削除は行いません。",
    language: "言語",
    continue: "everydashcam へ進む",
} satisfies Record<MigrationKey, string>;

const ko = {
    title: "dashcamigo 메모 저장",
    intro: "dashcamigo가 everydashcam으로 바뀌었어요. 여기서 메모를 저장한 뒤 새 사이트로 이동하세요.",
    source: "메모가 저장된 주소",
    scope: "메모를 저장했던 브라우저, 프로필, 주소를 그대로 사용해 주세요. 주소마다 메모가 따로 저장돼요.",
    loading: "저장된 메모를 읽는 중…",
    ready: "메모, 마커, 즐겨찾기를 저장할 준비가 됐어요.",
    empty: "여기에 저장된 메모가 없어요.",
    error: "메모를 읽지 못했어요. 이 페이지를 닫고 다시 시도해 주세요. 계속 안 되면 브라우저에서 사이트 데이터 저장을 허용하는지 확인해 주세요. 사이트 데이터를 지우거나 설치한 앱을 삭제하지 말고 feedback@dashcamigo.app으로 문의해 주세요.",
    downloadError: "파일을 저장하지 못했어요. 이 사이트의 다운로드를 허용하고 다시 시도해 주세요.",
    saved: "계속하기 전에 다운로드 폴더에 메모 백업이 있는지 확인해 주세요.",
    download: "메모 백업 저장",
    retry: "다시 시도",
    restore: "다음 화면에서 이 파일을 선택하면 메모를 everydashcam으로 옮길 수 있어요.",
    privacy: "이 페이지는 저장된 메모를 읽기만 해요. 업로드하거나 삭제하지 않아요.",
    language: "언어",
    continue: "everydashcam으로 계속하기",
} satisfies Record<MigrationKey, string>;

const pl = {
    title: "Zapisz swoje notatki dashcamigo",
    intro: "dashcamigo to teraz everydashcam. Zapisz tutaj notatki, a potem przejdź do nowej strony.",
    source: "Notatki zapisane pod adresem",
    scope: "Użyj tej samej przeglądarki, profilu i adresu, w których zapisujesz notatki. Każdy adres przechowuje osobną kopię.",
    loading: "Odczytywanie zapisanych notatek…",
    ready: "Twoje notatki, znaczniki i ulubione są gotowe do zapisania.",
    empty: "Nie znaleziono tu zapisanych notatek.",
    error: "Nie udało się odczytać notatek. Zamknij tę stronę i spróbuj ponownie. Jeśli to nie pomoże, sprawdź, czy przeglądarka pozwala zapisywać dane witryn. Nie usuwaj tych danych ani zainstalowanej aplikacji; napisz na feedback@dashcamigo.app, aby uzyskać pomoc.",
    downloadError: "Nie udało się zapisać pliku. Zezwól na pobieranie z tej witryny i spróbuj ponownie.",
    saved: "Zanim przejdziesz dalej, sprawdź, czy kopia notatek jest w pobranych plikach.",
    download: "Zapisz kopię notatek",
    retry: "Spróbuj ponownie",
    restore: "Na następnym ekranie wybierz ten plik, aby przenieść notatki do everydashcam.",
    privacy: "Ta strona tylko odczytuje zapisane notatki. Nic nie jest wysyłane ani usuwane.",
    language: "Język",
    continue: "Przejdź do everydashcam",
} satisfies Record<MigrationKey, string>;

const pt = {
    title: "Salve suas anotações do dashcamigo",
    intro: "O dashcamigo agora é everydashcam. Salve suas anotações aqui e continue para o novo site.",
    source: "Anotações salvas em",
    scope: "Use o mesmo navegador, perfil e endereço em que salvou suas anotações. Cada endereço guarda sua própria cópia.",
    loading: "Lendo suas anotações salvas…",
    ready: "Suas anotações, marcadores e favoritos estão prontos para salvar.",
    empty: "Nenhuma anotação salva foi encontrada aqui.",
    error: "Não foi possível ler suas anotações. Feche esta página e tente de novo. Se continuar falhando, confira se o navegador permite salvar dados de sites. Não apague esses dados nem remova o app instalado; escreva para feedback@dashcamigo.app para pedir ajuda.",
    downloadError: "Não foi possível salvar o arquivo. Permita downloads deste site e tente de novo.",
    saved: "Confira se o backup das anotações está nos seus downloads antes de continuar.",
    download: "Salvar backup das anotações",
    retry: "Tentar de novo",
    restore: "Na próxima tela, escolha esse arquivo para levar suas anotações ao everydashcam.",
    privacy: "Esta página só lê suas anotações salvas. Nada é enviado nem apagado.",
    language: "Idioma",
    continue: "Continuar para o everydashcam",
} satisfies Record<MigrationKey, string>;

const zh = {
    title: "保存你的 dashcamigo 备注",
    intro: "dashcamigo 现已更名为 everydashcam。在这里保存备注，然后前往新网站。",
    source: "备注保存于",
    scope: "请使用保存备注时的浏览器、用户配置和地址。每个地址单独保存一份备注。",
    loading: "正在读取已保存的备注…",
    ready: "你的备注、标记和收藏已准备好保存。",
    empty: "这里没有找到已保存的备注。",
    error: "无法读取备注。请关闭此页面后重试。如果仍然失败，请检查浏览器是否允许保存网站数据。不要清除网站数据或卸载已安装的应用；请联系 feedback@dashcamigo.app 获取帮助。",
    downloadError: "无法保存文件。请允许此网站下载文件后重试。",
    saved: "继续之前，请确认下载文件夹中已有备注备份。",
    download: "保存备注备份",
    retry: "重试",
    restore: "在下一页选择此文件，即可将备注迁移到 everydashcam。",
    privacy: "此页面仅读取已保存的备注，不会上传或删除任何内容。",
    language: "语言",
    continue: "继续前往 everydashcam",
} satisfies Record<MigrationKey, string>;

const dictionaries = { de, en, es, fr, ja, ko, pl, pt, ru, zh } satisfies Record<
    MigrationLang,
    Record<MigrationKey, string>
>;

export function isMigrationLanguage(value: string | null): value is MigrationLang {
    return value !== null && Object.hasOwn(dictionaries, value);
}

export function migrationText(lang: MigrationLang, key: MigrationKey): string {
    return dictionaries[lang][key];
}

export function migrationLanguage(): MigrationLang {
    const explicit = new URLSearchParams(location.search).get("lang");
    if (isMigrationLanguage(explicit)) return explicit;
    try {
        // Recovery reads legacy preferences without changing the old origin.
        const stored = localStorage.getItem("dashcamigo:lang") ?? localStorage.getItem("everydashcam:lang");
        if (isMigrationLanguage(stored)) return stored;
    } catch {
        // Reading notes must still work when preferences are unavailable.
    }
    const browser = navigator.language.toLowerCase().split("-")[0] ?? null;
    return isMigrationLanguage(browser) ? browser : "en";
}

export function applyMigrationLanguage(lang: MigrationLang): void {
    document.documentElement.lang = lang;
    document.title = migrationText(lang, "title");
    for (const element of document.querySelectorAll<HTMLElement>("[data-migrate-copy]")) {
        const key = element.dataset.migrateCopy;
        if (key && Object.hasOwn(en, key)) element.textContent = migrationText(lang, key as MigrationKey);
    }
}
