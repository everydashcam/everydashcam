import {
    type PortableFile,
    parsePortableManifest,
    portableDownloadPath,
    PORTABLE_PRIMARY_ORIGIN,
    PORTABLE_UPDATE_URL,
} from "./manifest.mjs";
import { compareReleaseTags, isReleaseTag } from "./release-tags.mjs";

interface UpdateNotice {
    version: string;
    href: string;
    file?: PortableFile;
}

interface UpdateCheckOptions {
    version: string;
    locale: string;
    events: EventTarget;
    onUpdate: (notice: UpdateNotice) => void;
    fetch?: typeof fetch;
}

const MAX_METADATA_BYTES = 64 * 1024;

async function readMetadata(response: Response): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return text + decoder.decode();
            bytes += value.byteLength;
            if (bytes > MAX_METADATA_BYTES) {
                await reader.cancel();
                return null;
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
}

/** One initial request and one reconnect retry; disposal cancels pending work. */
export function createPortableUpdateCheck(options: UpdateCheckOptions): {
    start: () => void;
    dispose: () => void;
} {
    let attempts = 0;
    let retryEligible = false;
    let reconnectPending = false;
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchMetadata = options.fetch ?? fetch;

    async function check(): Promise<void> {
        if (disposed || controller || attempts >= 2) return;
        attempts++;
        retryEligible = false;
        controller = new AbortController();
        timer = setTimeout(() => controller?.abort(), 5000);
        try {
            const response = await fetchMetadata(PORTABLE_UPDATE_URL, {
                method: "GET",
                credentials: "omit",
                referrerPolicy: "no-referrer",
                cache: "no-cache",
                redirect: "error",
                signal: controller.signal,
            });
            if (!response.ok) {
                controller.abort();
                return;
            }
            const text = await readMetadata(response);
            if (disposed || text === null) return;
            let value: unknown;
            try {
                value = JSON.parse(text);
            } catch {
                return;
            }
            const manifest = parsePortableManifest(value);
            if (!manifest || compareReleaseTags(manifest.version, options.version) <= 0) return;
            const file = manifest.files[options.locale];
            options.onUpdate({
                version: manifest.version,
                href: file
                    ? new URL(portableDownloadPath(options.locale), PORTABLE_PRIMARY_ORIGIN).href
                    : `${PORTABLE_PRIMARY_ORIGIN}/${options.locale}/`,
                ...(file ? { file } : {}),
            });
        } catch {
            retryEligible = !disposed && attempts === 1;
        } finally {
            clearTimeout(timer);
            timer = undefined;
            controller = undefined;
            const shouldRetry = retryEligible && reconnectPending;
            reconnectPending = false;
            if (shouldRetry) void check();
        }
    }

    const online = (): void => {
        // Reconnection can beat the rejection of an in-flight offline request.
        if (controller && attempts === 1) reconnectPending = true;
        else if (retryEligible) void check();
    };

    return {
        start() {
            if (attempts > 0 || disposed || !isReleaseTag(options.version)) return;
            options.events.addEventListener("online", online);
            void check();
        },
        dispose() {
            disposed = true;
            options.events.removeEventListener("online", online);
            controller?.abort();
            clearTimeout(timer);
        },
    };
}

export function initPortableUpdates(version: string, locale: string): void {
    const anchor = document.getElementById("portable-update");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const check = createPortableUpdateCheck({
        version,
        locale,
        events: window,
        onUpdate(notice) {
            anchor.href = notice.href;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            if (notice.file) anchor.download = notice.file.filename;
            anchor.hidden = false;
        },
    });
    window.addEventListener("pagehide", check.dispose, { once: true });
    // The caller runs after core initialization; yield once before doing network work.
    setTimeout(check.start, 0);
}
