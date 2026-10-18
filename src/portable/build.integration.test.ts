import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { decodePortableHtml } from "../../scripts/_portable-content.mjs";
import { parsePortableManifest } from "./manifest.mjs";

let directory: string;
beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "dc-portable-isolation-"));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function buildArtifact(name: string, overrides: NodeJS.ProcessEnv = {}, fullVersionUrl?: string): Buffer {
    const outDir = join(directory, name);
    execFileSync(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/build-portable.mjs",
            "--locale",
            "ru",
            "--version",
            "v2026.01.01",
            "--out-dir",
            outDir,
            ...(fullVersionUrl ? ["--full-version-url", fullVersionUrl] : []),
        ],
        {
            cwd: resolve("."),
            env: { ...process.env, PORTABLE_YANDEX_TILES_API_KEY: "", ...overrides },
            stdio: "pipe",
        },
    );
    const manifest = parsePortableManifest(
        JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")),
        false,
        Boolean(fullVersionUrl),
    );
    expect(manifest).not.toBeNull();
    const artifact = readFileSync(join(outDir, manifest!.files.ru!.filename));
    const outer = artifact.toString();
    const faviconDataUrl = `data:image/svg+xml;base64,${readFileSync("public/favicon.svg").toString("base64")}`;
    for (const document of [outer, decodePortableHtml(outer)]) {
        const head = document.slice(0, document.indexOf("</head>"));
        expect(head).toContain(`<link rel="icon" href="${faviconDataUrl}">`);
    }
    return artifact;
}

it("produces identical public bytes with unrelated hosted configuration present", () => {
    const artifacts: Buffer[] = [];
    for (const [name, overrides] of [
        ["clean", {}],
        [
            "polluted",
            {
                NODE_ENV: "development",
                VITE_USER_NODE_ENV: "development",
                VITE_SENTRY_DSN: "https://synthetic@example.invalid/1",
                VITE_YANDEX_TILES_API_KEY: "synthetic-private-key",
                VITE_DEFAULT_MAP_PROVIDER: "yandex",
                SEO_DEPLOYMENT_PROFILE: "mirror",
                SEO_MIRROR_CONFIG: "synthetic-invalid-configuration",
                SENTRY_AUTH_TOKEN: "synthetic-token",
            },
        ],
    ] as const) {
        artifacts.push(buildArtifact(name, overrides));
    }
    expect(artifacts[1]).toEqual(artifacts[0]);
    const outer = artifacts[0]!.toString();
    const html = decodePortableHtml(outer);
    expect(html).toContain('href="https://everydashcam.app/ru/"');
    expect(
        html.includes('href="https://everydashcam.app/ru/add-my-camera/"'),
        "camera help uses the portable language",
    ).toBe(true);
    expect(html.includes('href="/ru/add-my-camera/"'), "camera help resolves outside the file origin").toBe(false);
    for (const content of [outer, html]) {
        expect(content).not.toContain("example.invalid");
        expect(content).not.toContain("synthetic-private-key");
    }
    expect(html).not.toContain('id="lang-toggle"');
    expect(html).not.toContain('id="offline-use-modal"');
    expect(html).not.toContain(".offline-use-card");
    expect(html).not.toMatch(/(?:img|connect)-src[^;]+https:\/\/tiles\.api-maps\.yandex\.ru/);
}, 30_000);

it("embeds the explicit portable inputs and preserves literal custom URL characters", () => {
    const key = "synthetic-portable-key";
    const fullVersionUrl = "https://mirror.invalid/viewer/$&/";
    const artifact = buildArtifact(
        "yandex",
        {
            PORTABLE_YANDEX_TILES_API_KEY: `  ${key}  `,
            VITE_YANDEX_TILES_API_KEY: "synthetic-hosted-key",
            VITE_DEFAULT_MAP_PROVIDER: "yandex",
            VITE_SENTRY_DSN: "https://synthetic@example.invalid/1",
        },
        fullVersionUrl,
    );
    const outer = artifact.toString();
    const html = decodePortableHtml(outer);
    expect(html).toContain(key);
    expect(html).not.toContain(`  ${key}  `);
    expect(html).toContain("https://tiles.api-maps.yandex.ru/v1/tiles/");
    expect(html).toContain("projection=web_mercator&apikey=");
    for (const content of [outer, html]) {
        expect(content.includes('href="https://mirror.invalid/viewer/$&amp;/"'), "literal custom destination").toBe(
            true,
        );
        expect(content).not.toContain("__PORTABLE_FULL_VERSION_URL__");
        expect(content).not.toContain("synthetic-hosted-key");
        expect(content).not.toContain("example.invalid");
        expect(content).toMatch(/img-src[^;]+https:\/\/tiles\.api-maps\.yandex\.ru/);
        expect(content).toMatch(/connect-src[^;]+https:\/\/tiles\.api-maps\.yandex\.ru/);
    }
}, 30_000);
