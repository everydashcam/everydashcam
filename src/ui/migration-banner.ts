import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { getCurrentLang } from "../i18n/index.js";

type MigrationSource = "apex" | "ru";

const SOURCE_KEY = "everydashcam:migration:source";
const DISMISSED_PREFIX = "everydashcam:migration:dismissed:";

export function migrationAddress(hostname: string): "old" | "new" | null {
    if (/^(?:(?:www|ru|beta)\.)?everydashcam\.app$/.test(hostname)) return "new";
    if (/^(?:(?:www|ru|beta)\.)?dashcamigo\.app$/.test(hostname)) return "old";
    return null;
}

function isSource(value: string | null): value is MigrationSource {
    return value === "apex" || value === "ru";
}

function readSession(key: string): string | null {
    try {
        return sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSession(key: string, value: string): void {
    try {
        sessionStorage.setItem(key, value);
    } catch {
        // The visible notice still works when browser storage is unavailable.
    }
}

function readSource(params = new URLSearchParams(location.search)): MigrationSource | null {
    const incoming = params.getAll("dc_from").at(-1) ?? null;
    if (isSource(incoming)) return incoming;
    const stored = readSession(SOURCE_KEY);
    return isSource(stored) ? stored : null;
}

export function migrationRecoveryUrl(): string {
    const source = readSource();
    const isRu = source === "ru" || (source === null && location.hostname === "ru.everydashcam.app");
    return `https://${isRu ? "ru." : ""}dashcamigo.app/migrate/?lang=${getCurrentLang()}`;
}

export function initMigrationBanner(): void {
    if (migrationAddress(location.hostname) !== "new") return;
    const banner = document.getElementById("migration-banner");
    if (!banner) return;

    const params = new URLSearchParams(location.search);
    const source = readSource(params) ?? (location.hostname === "ru.everydashcam.app" ? "ru" : null);
    if (source) writeSession(SOURCE_KEY, source);
    if (params.has("dc_from")) {
        // Keep unrelated query bytes intact, including repeated keys and encoding.
        const query = location.search
            .slice(1)
            .split("&")
            .filter((part) => !new URLSearchParams(part).has("dc_from"))
            .join("&");
        history.replaceState(history.state, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    }
    if (!isSource(source)) return;

    const dismissedKey = DISMISSED_PREFIX + source;
    const isDismissed = readSession(dismissedKey) === "1" || readLocalStorage(dismissedKey) === "1";
    if (isDismissed) return;

    const dismiss = (): void => {
        banner.hidden = true;
        writeSession(dismissedKey, "1");
        writeLocalStorage(dismissedKey, "1");
    };

    if (location.hash === "#restore-notes") {
        dismiss();
        return;
    }
    window.addEventListener("hashchange", () => {
        if (location.hash === "#restore-notes") dismiss();
    });

    document.getElementById("migration-banner-dismiss")?.addEventListener("click", dismiss);
    const transfer = document.getElementById("migration-banner-transfer");
    transfer?.setAttribute("href", migrationRecoveryUrl());
    transfer?.addEventListener("click", dismiss);
    banner.hidden = false;
}
