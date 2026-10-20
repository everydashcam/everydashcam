import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePortableManifest, portableDownloadPath, PORTABLE_PRIMARY_ORIGIN } from "../src/portable/manifest.mjs";

async function request(origin, path, allowRedirect = false) {
    const response = await fetch(new URL(path, origin), {
        redirect: allowRedirect ? "manual" : "error",
        headers: { Origin: "null" },
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok && !allowRedirect) throw new Error(`portable download returned HTTP ${response.status}`);
    return response;
}

async function verifyDownloads(expected, origin, allowDevelopment) {
    const latest = await request(origin, "/downloads/portable/latest.json");
    if (latest.headers.get("access-control-allow-origin") !== "*")
        throw new Error("portable metadata does not allow file-origin CORS");
    if (
        !/max-age=0/.test(latest.headers.get("cache-control") ?? "") ||
        /immutable/.test(latest.headers.get("cache-control") ?? "")
    )
        throw new Error("portable metadata cache policy does not revalidate");
    const manifest = parsePortableManifest(await latest.json(), allowDevelopment);
    if (!manifest || JSON.stringify(manifest) !== JSON.stringify(expected))
        throw new Error("published portable metadata differs from the tested artifact");
    for (const [locale, file] of Object.entries(manifest.files)) {
        const redirect = await request(origin, portableDownloadPath(locale), true);
        const location = redirect.headers.get("location");
        if (redirect.status !== 302 || !location || new URL(location, origin).href !== new URL(file.path, origin).href)
            throw new Error(
                `portable stable link does not redirect to the current artifact: ${locale} (HTTP ${redirect.status}, location ${location ?? "none"})`,
            );
        const redirectCache = redirect.headers.get("cache-control") ?? "";
        if (
            redirectCache.includes("immutable") ||
            [...redirectCache.matchAll(/(?:s-maxage|max-age)=(\d+)/g)].some((match) => Number(match[1]) > 0)
        )
            throw new Error("portable stable link caches a stale release redirect");
        const response = await request(origin, file.path);
        if (response.headers.get("content-disposition") !== `attachment; filename="${file.filename}"`)
            throw new Error(`portable download filename mismatch: ${file.filename}`);
        const cacheControl = response.headers.get("cache-control") ?? "";
        if (!cacheControl.includes("immutable") || !cacheControl.includes("no-transform"))
            throw new Error("portable download cache policy is missing immutable or no-transform");
        if (!response.headers.get("x-robots-tag")?.includes("noindex"))
            throw new Error("portable download is indexable");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
            throw new Error(`published portable bytes differ from the release: ${file.filename}`);
    }
}

export async function verifyPublishedPortableDownloads(expected, origin, allowDevelopment = false) {
    // A fresh Pages deployment can expose old metadata or missing assets while
    // its custom domain propagates. Each retry validates the entire publication.
    const attempts = 10;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await verifyDownloads(expected, origin, allowDevelopment);
            return;
        } catch (err) {
            if (attempt === attempts) throw err;
            const error = err instanceof Error ? err.message : String(err);
            console.warn("portable downloads: publication is not ready", { attempt, attempts, error });
            await new Promise((resolve) => setTimeout(resolve, 20000));
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const allowDevelopment = process.env.PORTABLE_ALLOW_DEV === "1";
    const expected = parsePortableManifest(
        JSON.parse(readFileSync(resolve(process.env.PORTABLE_MANIFEST ?? "dist-portable/manifest.json"), "utf8")),
        allowDevelopment,
    );
    if (!expected) throw new Error("invalid expected portable manifest");
    const origin = new URL(process.env.PORTABLE_SMOKE_ORIGIN ?? PORTABLE_PRIMARY_ORIGIN).origin;
    await verifyPublishedPortableDownloads(expected, origin, allowDevelopment);
    console.log("portable downloads: live files, names, hashes, CORS and cache headers verified");
}
