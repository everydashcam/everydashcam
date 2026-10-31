import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagePortableRelease } from "../../scripts/_portable-artifacts.mjs";
import { publishPortableDownloads } from "../../vite-plugins/portable-downloads.js";
import { collectPrecacheEntries, stampPrecacheShells } from "../../vite-plugins/sw-precache.js";
import { portableFilename } from "./release-tags.mjs";

const directories: string[] = [];
const shell =
    '<!doctype html><html><head></head><body><a id="portable-download" hidden download>Download</a><p>Viewer</p></body></html>';

function fixture(version = "v2026.09.25") {
    const root = mkdtempSync(join(tmpdir(), "portable-publication-"));
    directories.push(root);
    const dist = join(root, "dist");
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    for (const locale of ["en", "ru"]) {
        mkdirSync(join(dist, locale, "cameras"), { recursive: true });
        writeFileSync(join(dist, locale, "index.html"), shell);
        writeFileSync(join(dist, locale, "cameras/index.html"), shell);
    }
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), shell);
    writeFileSync(join(dist, "assets/app.js"), "export {};");
    writeFileSync(join(dist, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n");
    writeFileSync(join(dist, "_redirects"), "/uk/* /en/:splat 301\n");
    const filename = portableFilename(version, "en");
    const bytes = Buffer.from('<!doctype html><html lang="en"><script>window.portable=true</script></html>');
    const file = {
        filename,
        path: `/downloads/portable/${version}/${filename.slice(0, -5)}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const manifest = { schemaVersion: 1, distribution: "public", version, files: { en: file } };
    writeFileSync(join(artifacts, filename), bytes);
    const manifestPath = join(artifacts, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return { root, dist, artifacts, manifestPath, manifest, file, bytes };
}

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("portable website publication", () => {
    it("stages release assets only from the validated manifest", () => {
        const { root, artifacts, manifestPath, file, bytes } = fixture();
        const staleName = "dashcamigo-2026-09-24-en.html";
        writeFileSync(join(artifacts, staleName), "stale artifact");
        const destination = join(root, "release");
        expect(file.filename).toBe("everydashcam-2026-09-25-en.html");
        expect(stagePortableRelease(manifestPath, destination)).toEqual([file.filename]);
        expect(existsSync(join(destination, staleName))).toBe(false);
        expect(readFileSync(join(destination, file.filename))).toEqual(bytes);
        expect(readFileSync(join(destination, "portable-assets.txt"), "utf8")).toBe(`${file.filename}\n`);
        expect(readFileSync(join(destination, "portable-manifest.json"))).toEqual(readFileSync(manifestPath));
    });

    it("rejects custom distributions on the public publication path", () => {
        const { dist, manifestPath, manifest } = fixture();
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, distribution: "custom" }));
        expect(() => publishPortableDownloads(dist, manifestPath)).toThrow(/invalid portable artifact manifest/);
        expect(existsSync(join(dist, "downloads"))).toBe(false);
        publishPortableDownloads(dist, manifestPath, true);
        expect(existsSync(join(dist, "downloads/portable/latest.json"))).toBe(true);
    });

    it("rejects development builds unless their publication is explicitly enabled", () => {
        const { dist, manifestPath } = fixture("dev-abcdef1234567");
        expect(() => publishPortableDownloads(dist, manifestPath)).toThrow(/invalid portable artifact manifest/);
        expect(existsSync(join(dist, "downloads"))).toBe(false);
        expect(readFileSync(join(dist, "en/index.html"), "utf8")).toBe(shell);
    });

    it.each(["v2026.09.25", "dev-abcdef1234567"])(
        "publishes %s with exact bytes and matching-locale links outside precache",
        async (version) => {
            const { dist, manifestPath, file, bytes, manifest } = fixture(version);
            publishPortableDownloads(dist, manifestPath, false, version.startsWith("dev-"));
            expect(readFileSync(join(dist, file.path.slice(1)))).toEqual(bytes);
            expect(existsSync(join(dist, `${file.path.slice(1)}.html`))).toBe(false);
            expect(JSON.parse(readFileSync(join(dist, "downloads/portable/latest.json"), "utf8"))).toEqual(manifest);
            for (const page of ["en/index.html", "en/cameras/index.html"]) {
                const html = readFileSync(join(dist, page), "utf8");
                expect(html).toContain('href="/downloads/portable/en.html"');
                expect(html).toContain(`download="${file.filename}"`);
                expect(html).not.toContain(" hidden");
                expect(html).toContain(`data-portable-bytes="${bytes.length}"`);
                expect(html).toContain(`title="${version} · 0 MB"`);
            }
            expect(readFileSync(join(dist, "ru/index.html"), "utf8")).not.toContain("portable-download");
            stampPrecacheShells(dist, ["en", "ru"]);
            expect(
                (await collectPrecacheEntries(dist, ["en", "ru"])).some(({ url }) => url.startsWith("/downloads/")),
            ).toBe(false);
        },
    );

    it("removes downloads from builds without an explicit artifact manifest", () => {
        const { dist } = fixture();
        publishPortableDownloads(dist);
        expect(readFileSync(join(dist, "en/index.html"), "utf8")).not.toContain("portable-download");
        expect(existsSync(join(dist, "downloads"))).toBe(false);
    });

    it.each(["v2026.09.25", "dev-abcdef1234567"])(
        "rejects corrupted %s artifacts before exposing metadata or changing links",
        (version) => {
            const { dist, artifacts, manifestPath, file } = fixture(version);
            writeFileSync(join(artifacts, file.filename), "corrupted");
            expect(() => publishPortableDownloads(dist, manifestPath, false, version.startsWith("dev-"))).toThrow(
                /integrity mismatch/,
            );
            expect(existsSync(join(dist, "downloads/portable/latest.json"))).toBe(false);
            expect(readFileSync(join(dist, "en/index.html"), "utf8")).toBe(shell);
        },
    );

    it("moves stable links to each release while staging only its current binaries", () => {
        const current = fixture();
        const next = fixture("v2026.09.26");
        for (const { dist, manifestPath, file, manifest } of [current, next]) {
            publishPortableDownloads(dist, manifestPath);
            expect(readFileSync(join(dist, "_redirects"), "utf8")).toBe(
                `/downloads/portable/en.html ${file.path} 302\n/uk/* /en/:splat 301\n`,
            );
            expect(readdirSync(join(dist, "downloads/portable")).sort()).toEqual(["latest.json", manifest.version]);
            expect(readdirSync(join(dist, "downloads/portable", manifest.version))).toEqual([
                file.filename.slice(0, -5),
            ]);
            // Old portable clients require exactly these versioned metadata paths.
            expect(JSON.parse(readFileSync(join(dist, "downloads/portable/latest.json"), "utf8"))).toEqual(manifest);
        }
        expect(existsSync(join(next.dist, current.file.path.slice(1)))).toBe(false);
    });

    it("separates attachment headers from the mutable CORS metadata endpoint", () => {
        const { dist, manifestPath } = fixture();
        publishPortableDownloads(dist, manifestPath);
        const headers = readFileSync(join(dist, "_headers"), "utf8");
        const download = headers.split("/downloads/portable/:version/:filename\n")[1]?.split("\n\n")[0];
        const latest = headers.split("/downloads/portable/latest.json\n")[1];
        expect(download).toContain('Content-Disposition: attachment; filename=":filename.html"');
        expect(download).toContain("immutable, no-transform");
        expect(latest).toContain("Access-Control-Allow-Origin: *");
        expect(latest).toContain("max-age=0, must-revalidate");
        expect(latest).not.toContain("Content-Disposition");
        expect(latest).not.toContain("immutable");
        // Both named placeholders require a path segment; latest.json has only one.
        expect(/^\/downloads\/portable\/[^/]+\/[^/]+$/.test("/downloads/portable/latest.json")).toBe(false);
    });
});
