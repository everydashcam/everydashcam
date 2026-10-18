import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyStaticSearchMeta } from "../../vite-plugins/static-search-meta.js";

const dirs: string[] = [];
const mirror = {
    origin: "https://mirror.example.test",
    localeSegments: ["de"],
    rootLocaleSegment: "de",
} as const;

function fixture(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "dc-static-search-meta-"));
    dirs.push(dir);
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>ok</body></html>';
    for (const name of ["privacy.html", "terms.html", "add-my-camera.html"]) {
        writeFileSync(resolve(dir, name), html);
    }
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("static document search metadata", () => {
    it("allows large image previews on primary production documents", () => {
        const dir = fixture();
        applyStaticSearchMeta(dir, {
            noIndex: false,
            deployment: { profile: "primary", seoCutover: false, mirror: null },
        });
        expect(readFileSync(resolve(dir, "privacy.html"), "utf-8")).not.toContain("noindex");
        expect(readFileSync(resolve(dir, "privacy.html"), "utf-8")).toContain('content="max-image-preview:large"');
    });

    it("makes standalone documents noindex in a preview build", () => {
        const dir = fixture();
        applyStaticSearchMeta(dir, {
            noIndex: true,
            deployment: { profile: "mirror", seoCutover: false, mirror },
        });
        expect(readFileSync(resolve(dir, "privacy.html"), "utf-8")).toContain('<meta name="robots" content="noindex, nofollow">');
    });

    it("does not add a Yandex exclusion to legacy document fallbacks", () => {
        const dir = fixture();
        applyStaticSearchMeta(dir, {
            noIndex: false,
            deployment: { profile: "mirror", seoCutover: true, mirror },
        });
        expect(readFileSync(resolve(dir, "privacy.html"), "utf-8")).not.toContain('name="yandex"');
        expect(readFileSync(resolve(dir, "privacy.html"), "utf-8")).toContain('<meta name="robots" content="max-image-preview:large">');
    });
});
