import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { minify } from "html-minifier-terser";
import type { Plugin } from "vite";
import { DEV_DICTS } from "../src/i18n/dev-dicts.js";
import { LANGS } from "../src/i18n/languages.js";
import { PORTABLE_MAX_BYTES } from "../src/portable/manifest.mjs";
import { generateThirdPartyNotices } from "../scripts/generate-third-party-notices.mjs";
import { escapeAttr, escapeText, stringifyJsonLd } from "./html-utils.js";
import { localizeDocumentLinks } from "./document-links.js";
import { compressPortableHtml } from "./portable-compression.js";

interface PortableOptions {
    locale: string;
    version: string;
    filename: string;
    fullVersionUrl: string;
    hasYandexTilesKey: boolean;
}

const MIME: Record<string, string> = {
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".json": "application/json",
};

function publicDataUrl(path: string): string {
    const data = readFileSync(resolve("public", path.replace(/^\//, "")));
    return `data:${MIME[extname(path)] ?? "application/octet-stream"};base64,${data.toString("base64")}`;
}

export function portableMapAssets(): Record<string, string> {
    return Object.fromEntries(
        [".json", ".png", "@2x.json", "@2x.png"].map((suffix) => [
            `dcasset://assets/sprite${suffix}`,
            publicDataUrl(`/styles/sprite/sprite${suffix}`),
        ]),
    );
}

export function portablePlugin(options: PortableOptions): Plugin {
    let isWorker = false;
    return {
        name: "everydashcam-portable",
        enforce: "pre",
        configResolved(config) {
            isWorker = config.isWorker;
        },
        transform(source, id) {
            if (!id.includes("/src/") || !/\.(?:ts|css)$/.test(id)) return;
            let code = source
                .replace(/\?no-inline(["'])/g, "?inline$1")
                .replace(
                    /(["'])(\/fonts\/[^"']+\.woff2)\1/g,
                    (_match, quote, path: string) => `${quote}${publicDataUrl(path)}${quote}`,
                );
            const imports: string[] = [];
            code = code.replace(
                /new Worker\(new URL\("([^"]+)", import\.meta\.url\),\s*\{\s*type: "module",\s*name: "([^"]+)",?\s*\}\)/g,
                (_match, path: string, name: string) => {
                    const symbol = `PortableWorker${imports.length}`;
                    imports.push(`import ${symbol} from ${JSON.stringify(`${path}?worker&inline`)};`);
                    return `new ${symbol}({name:${JSON.stringify(name)}})`;
                },
            );
            // These entry points only initialize hosted UI. Their unused
            // module-level loggers and sets must not retain an excluded feature.
            const isHostedEntry =
                /\/src\/ui\/(?:sw-registration|lang-suggestion-banner|pwa-install|whats-new-modal|lang-switcher|switch-lang-modal|support-prompt)\.ts$/.test(
                    id,
                );
            return {
                code: `${imports.join("\n")}\n${code}`,
                map: null,
                ...(isHostedEntry ? { moduleSideEffects: false } : {}),
            };
        },
        generateBundle: {
            order: "post",
            async handler(_outputOptions, bundle) {
                const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
                const excluded = chunks
                    .flatMap((chunk) => Object.entries(chunk.modules))
                    .filter(
                        ([id, module]) =>
                            module.renderedLength > 0 &&
                            /onnxruntime|@sentry\/|native-file-system-adapter|tracker-worker|sentry-init|blur-(?:track|detect|assets)\.ts|\/(?:pwa-install|whats-new-modal|lang-switcher|lang-suggestion-banner|sw-registration|support-prompt)\.ts/.test(
                                id,
                            ),
                    );
                if (excluded.length)
                    throw new Error(
                        `excluded portable modules remain: ${excluded.map(([id]) => id.split("/").at(-1)).join(", ")}`,
                    );
                if (isWorker) return;
                const locale = LANGS.find((item) => item.code === options.locale)?.code;
                if (!locale) throw new Error("unknown portable locale");
                const dict = DEV_DICTS[locale];
                const entry = chunks.find((chunk) => chunk.isEntry);
                if (
                    !entry ||
                    chunks.length !== 1 ||
                    entry.imports.length ||
                    entry.dynamicImports.some((path) => path !== entry.fileName)
                ) {
                    throw new Error(
                        `portable application must have one self-contained entry: ${JSON.stringify(chunks.map((chunk) => ({ file: chunk.fileName, entry: chunk.isEntry, imports: chunk.imports, dynamic: chunk.dynamicImports })))}`,
                    );
                }
                let js = entry.code;
                let css = "";
                for (const item of Object.values(bundle)) {
                    if (item.type !== "asset") continue;
                    if (item.fileName.endsWith(".css")) {
                        // PostCSS resolves shared public CSS imports without a TS transform.
                        css += String(item.source).replace(
                            /url\((["']?)(\/fonts\/[^"')\s]+\.woff2)\1\)/g,
                            (_match, _quote, path: string) => `url("${publicDataUrl(path)}")`,
                        );
                    } else if (/maplibre.*worker.*\.js$/.test(item.fileName)) {
                        const bytes = Buffer.from(item.source);
                        // File origins need a classic worker. MapLibre checks the
                        // URL before its fragment, so end a data URL with a .cjs
                        // comment to select classic mode for the bundled IIFE.
                        const expression = `("data:text/javascript;charset=utf-8,"+encodeURIComponent(${JSON.stringify(bytes.toString("utf8"))})+"%0A%2F%2Fworker.cjs")`;
                        const paths = [`/${item.fileName}`, item.fileName];
                        let found = false;
                        for (const path of paths) {
                            for (const quote of ['"', "'", "`"]) {
                                const literal = `${quote}${path}${quote}`;
                                if (js.includes(literal)) {
                                    js = js.replaceAll(literal, expression);
                                    found = true;
                                }
                            }
                        }
                        if (!found) throw new Error("portable map worker URL was not embedded");
                    } else {
                        throw new Error(`unexpected portable companion asset: ${item.fileName}`);
                    }
                }
                let html = readFileSync(resolve("index.html"), "utf8")
                    .replace(/<!-- web-only:start -->[\s\S]*?<!-- web-only:end -->/g, "")
                    .replace(/<!-- portable-only:(?:start|end) -->/g, "")
                    .replace(/data-i18n="[^"]*"(\s+)data-portable-i18n="([^"]*)"/g, 'data-i18n="$2"');
                const bootstrap = `(function(){try{var t=localStorage.getItem("dc-theme");if(t==="light"||t==="dark")document.documentElement.classList.add("dc-"+t)}catch(e){}document.documentElement.classList.add("is-loading");function ready(){document.documentElement.classList.remove("is-loading");document.getElementById("dc-loader")?.remove()}addEventListener("dc:ready",ready,{once:true});setTimeout(ready,15000)})();`;
                const loaderStyle = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
                const faviconDataUrl = publicDataUrl("/favicon.svg");
                html = html
                    .replace(
                        /<head>[\s\S]*?<\/head>/,
                        `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow"><title>everydashcam</title><link rel="icon" href="${faviconDataUrl}">${loaderStyle}<script>${bootstrap}</script><style>${css.replace(/<\/style/gi, "<\\/style")}</style></head>`,
                    )
                    .replace(/<html lang="[^"]*"/, `<html lang="${locale}" data-edition="portable"`)
                    .replace(/(<script\b[^>]*\bid="dc-i18n"[^>]*>)[\s\S]*?(<\/script>)/, `$1${stringifyJsonLd(dict)}$2`)
                    .replace(
                        /<script type="module" src="\/src\/app\.ts"><\/script>/,
                        () => `<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`,
                    )
                    .replaceAll("__PORTABLE_FULL_VERSION_URL__", () => escapeAttr(options.fullVersionUrl));
                html = localizeDocumentLinks(html, locale);
                // Resolve website links against the explicit edition destination; file: has no site root.
                html = html.replace(
                    /(<a\b[^>]*\bhref=")(\/[^"#]*)"/g,
                    (_match, prefix, path: string) =>
                        `${prefix}${escapeAttr(new URL(path, options.fullVersionUrl).href)}" target="_blank" rel="noopener noreferrer"`,
                );
                html = html.replace(/\bsrc="(\/[^" ]+)"/g, (_match, path: string) => `src="${publicDataUrl(path)}"`);
                if (/\bsrcset=/.test(html))
                    throw new Error("portable markup still contains responsive external images");
                const notices = `${readFileSync("LICENSE", "utf8")}\n\n${generateThirdPartyNotices()}`;
                const noticeUrl = `data:text/plain;charset=utf-8;base64,${Buffer.from(notices).toString("base64")}`;
                html = html.replace(
                    /href="[^"]*third-party-notices\.txt"/g,
                    `href="${noticeUrl}" download="everydashcam-notices.txt"`,
                );
                if (!html.includes("<!-- portable-notices -->"))
                    throw new Error("portable notices placeholder is missing");
                html = html.replace(
                    "<!-- portable-notices -->",
                    `<details class="portable-notices" id="portable-notices"><summary>${escapeText(dict["footer.licenses"])}</summary><pre>${escapeText(notices)}</pre></details>`,
                );
                html = await minify(html, {
                    collapseWhitespace: true,
                    removeComments: true,
                    minifyCSS: false,
                    minifyJS: false,
                });
                const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
                    .filter((match) => !/type="application\/(?:ld\+)?json"/.test(match[1]!))
                    .map((match) => `'sha256-${createHash("sha256").update(match[2]!).digest("base64")}'`);
                const mapOrigins = [
                    "https://tiles.openfreemap.org",
                    "https://tile.openstreetmap.org",
                    "https://vector.openstreetmap.org",
                ];
                if (options.hasYandexTilesKey) mapOrigins.push("https://tiles.api-maps.yandex.ru");
                const csp = [
                    "default-src 'none'",
                    `script-src blob: ${hashes.join(" ")}`,
                    "style-src 'unsafe-inline'",
                    "worker-src blob: data:",
                    "font-src data:",
                    `img-src data: blob: ${mapOrigins.join(" ")}`,
                    "media-src blob: data:",
                    `connect-src data: blob: https://everydashcam.app/downloads/portable/latest.json ${mapOrigins.join(" ")}`,
                    "base-uri 'none'",
                    "object-src 'none'",
                    "form-action 'none'",
                ].join("; ");
                html = html.replace(
                    '<meta charset="utf-8">',
                    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`,
                );
                if (hashes.length !== 2) throw new Error("portable document must have two executable scripts");
                html = await compressPortableHtml(html, {
                    locale,
                    fullVersionUrl: options.fullVersionUrl,
                    faviconDataUrl,
                    csp,
                    dictionary: dict,
                });
                // Pages cannot publish a larger individual asset, independent of startup budgets.
                if (Buffer.byteLength(html) > PORTABLE_MAX_BYTES)
                    throw new Error("portable HTML exceeds hosting file limit");
                for (const key of Object.keys(bundle)) delete bundle[key];
                this.emitFile({ type: "asset", fileName: options.filename, source: html });
            },
        },
    };
}
