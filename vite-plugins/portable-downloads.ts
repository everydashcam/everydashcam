import { matchesArtifactIntegrity } from "../scripts/_artifact-integrity.mjs";
import { hostedHtmlFiles } from "../scripts/_build-files.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { readPortableArtifacts, stagePortableArtifacts } from "../scripts/_portable-artifacts.mjs";
import { type PortableManifest, portableDownloadPath } from "../src/portable/manifest.mjs";

const DOWNLOAD_ANCHOR = /<a\b(?=[^>]*\bid="portable-download")[^>]*>[\s\S]*?<\/a>/g;

function renderPortableDownload(html: string, manifest: PortableManifest | null, locale?: string): string {
    const file = locale ? manifest?.files[locale] : undefined;
    return html.replace(DOWNLOAD_ANCHOR, (anchor) => {
        if (!file) return "";
        const size = new Intl.NumberFormat(locale ?? "en", {
            style: "unit",
            unit: "megabyte",
            unitDisplay: "short",
            maximumFractionDigits: 1,
        }).format(file.bytes / 1000000);
        const details = `${manifest?.version} · ${size}`;
        const withTitle = /\stitle="[^"]*"/.test(anchor)
            ? anchor.replace(/(\stitle=")([^"]*)(")/, `$1$2 · ${details}$3`)
            : anchor.replace("<a ", `<a title="${details}" `);
        return withTitle
            .replace(/\s+data-i18n-attr="title:portable.download.description"/, "")
            .replace(/\s+hidden(?:="[^"]*")?/, "")
            .replace(/\s+download(?:="[^"]*")?/, "")
            .replace(
                "<a ",
                `<a href="${portableDownloadPath(locale!)}" download="${file.filename}" data-portable-bytes="${file.bytes}" data-portable-version="${manifest?.version}" `,
            );
    });
}

export function publishPortableDownloads(
    dist: string,
    manifestPath?: string,
    allowCustom = false,
    allowDevelopment = false,
): void {
    const manifest = manifestPath
        ? stagePortableArtifacts(resolve(manifestPath), dist, allowCustom, allowDevelopment)
        : null;
    // Process shells and their marketing descendants after prerendering.
    for (const path of hostedHtmlFiles(dist)) {
        const locale = relative(dist, path)
            .split(sep)
            .slice(0, -1)
            .find((part) => /^[a-z]{2}$/.test(part));
        const html = readFileSync(path, "utf8");
        const updated = renderPortableDownload(html, manifest, locale);
        if (html !== updated) writeFileSync(path, updated);
    }
    if (!manifest) return;
    // Keep one copy of the current binaries. A temporary redirect is not
    // heuristically cached, so saved locale links follow each new deployment.
    // Prepend these rules: Pages treats only the leading splat-free block as
    // static (exact lookup, 2,000-rule limit); every rule after the first
    // dynamic one is matched in file order against the 100-rule dynamic limit.
    const redirects = join(dist, "_redirects");
    const stableDownloads = Object.entries(manifest.files)
        .map(([locale, file]) => `${portableDownloadPath(locale)} ${file.path} 302`)
        .join("\n");
    writeFileSync(redirects, `${stableDownloads}\n${existsSync(redirects) ? readFileSync(redirects, "utf8") : ""}`);
    const headers = join(dist, "_headers");
    // Binary assets retain the dated .html download filename. Pages Analytics
    // checks the uploaded asset type before these response headers apply.
    writeFileSync(
        headers,
        `${readFileSync(headers, "utf8")}\n/downloads/portable/:version/:filename\n  Content-Type: application/octet-stream\n  Content-Disposition: attachment; filename=":filename.html"\n  Cache-Control: public, max-age=31536000, immutable, no-transform\n  X-Robots-Tag: noindex\n\n/downloads/portable/latest.json\n  Content-Type: application/json; charset=utf-8\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n  X-Robots-Tag: noindex\n`,
    );
}

export function portableDownloadsPlugin(options: { allowCustom?: boolean } = {}): Plugin {
    let isBuild = false;
    let developmentManifest: PortableManifest | null = null;
    return {
        name: "everydashcam-portable-downloads",
        configResolved(config) {
            isBuild = config.command === "build";
        },
        configureServer(server) {
            const explicitManifest = process.env.PORTABLE_MANIFEST;
            const manifestPath = resolve(server.config.root, explicitManifest || "dist-portable/manifest.json");
            if (explicitManifest || existsSync(manifestPath)) {
                try {
                    developmentManifest = readPortableArtifacts(manifestPath, true);
                } catch {
                    // Artifact paths may point outside the public checkout.
                    throw new Error("invalid public portable artifacts for local development");
                }
            }
            const manifest = developmentManifest;
            const files = new Map(Object.values(manifest?.files ?? {}).map((file) => [file.path, file]));
            const redirects = new Map(
                Object.entries(manifest?.files ?? {}).map(([locale, file]) => [
                    portableDownloadPath(locale),
                    file.path,
                ]),
            );
            server.middlewares.use((request, response, next) => {
                const pathname = request.url?.split("?")[0] ?? "";
                if (!pathname.startsWith("/downloads/portable/")) return next();
                response.setHeader("Cache-Control", "no-store, no-transform");
                response.setHeader("X-Content-Type-Options", "nosniff");
                response.setHeader("X-Robots-Tag", "noindex");
                if (request.method !== "GET" && request.method !== "HEAD") {
                    response.setHeader("Allow", "GET, HEAD");
                    response.statusCode = 405;
                    response.end();
                    return;
                }
                const destination = redirects.get(pathname);
                if (destination) {
                    response.statusCode = 302;
                    response.setHeader("Location", destination);
                    response.end();
                    return;
                }
                if (pathname === "/downloads/portable/latest.json" && manifest) {
                    const body = `${JSON.stringify(manifest)}\n`;
                    response.setHeader("Content-Type", "application/json; charset=utf-8");
                    response.setHeader("Access-Control-Allow-Origin", "*");
                    response.setHeader("Content-Length", Buffer.byteLength(body));
                    response.end(request.method === "HEAD" ? undefined : body);
                    return;
                }
                const file = files.get(pathname);
                if (!file) {
                    response.statusCode = 404;
                    response.end();
                    return;
                }
                try {
                    const bytes = readFileSync(resolve(dirname(manifestPath), file.filename));
                    // Rebuilding while Vite runs must never serve bytes under stale metadata.
                    if (!matchesArtifactIntegrity(bytes, file)) {
                        throw new Error("portable artifact integrity mismatch");
                    }
                    response.setHeader("Content-Type", "application/octet-stream");
                    response.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
                    response.setHeader("Content-Length", bytes.length);
                    response.end(request.method === "HEAD" ? undefined : bytes);
                } catch {
                    response.statusCode = 503;
                    response.end("portable artifact unavailable; restart the development server after rebuilding");
                }
            });
        },
        transformIndexHtml(html, context) {
            if (isBuild) return html;
            const pathname = (context.originalUrl ?? context.path).split("?")[0] ?? "";
            const locale = /^\/([a-z]{2})(?:\/|$)/.exec(pathname)?.[1];
            return renderPortableDownload(html, developmentManifest, locale);
        },
        closeBundle() {
            if (isBuild) {
                publishPortableDownloads(
                    resolve(process.cwd(), "dist"),
                    process.env.PORTABLE_MANIFEST,
                    options.allowCustom,
                    process.env.PORTABLE_ALLOW_DEV === "1",
                );
            }
        },
    };
}
