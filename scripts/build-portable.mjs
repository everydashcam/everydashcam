import { sha256Hex } from "./_artifact-integrity.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import { LANGS } from "../src/i18n/languages.ts";
import { isReleaseTag, portableFilename } from "../src/portable/release-tags.mjs";

// Ambient development mode retains dev-only imports even when Vite builds.
process.env.NODE_ENV = "production";

const { values } = parseArgs({
    options: {
        locale: { type: "string" },
        version: { type: "string" },
        "full-version-url": { type: "string" },
        "out-dir": { type: "string", default: "dist-portable" },
    },
});
function git(...args) {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function currentVersion() {
    const sha = git("rev-parse", "--short", "HEAD");
    const isDirty = git("status", "--porcelain").length > 0;
    if (!isDirty) {
        try {
            const tag = git("describe", "--tags", "--exact-match", "HEAD");
            if (isReleaseTag(tag)) return tag;
        } catch {
            /* An untagged commit is a development build. */
        }
    }
    return `dev-${sha}${isDirty ? "-dirty" : ""}`;
}
const locales = values.locale ? LANGS.filter(({ code }) => code === values.locale) : LANGS;
if (!locales.length) throw new Error("unknown portable locale");
if (values["full-version-url"] && !values.locale)
    throw new Error("a custom full-version URL requires an explicit locale");
const version = values.version ?? currentVersion();
const outDir = resolve(values["out-dir"]);
mkdirSync(outDir, { recursive: true });
const manifest = {
    schemaVersion: 1,
    distribution: values["full-version-url"] ? "custom" : "public",
    version,
    files: {},
};
for (const { code: locale } of locales) {
    const filename = portableFilename(version, locale);
    const fullVersionUrl = new URL(values["full-version-url"] ?? `https://everydashcam.app/${locale}/`);
    if (
        fullVersionUrl.protocol !== "https:" ||
        fullVersionUrl.username ||
        fullVersionUrl.password ||
        fullVersionUrl.search ||
        fullVersionUrl.hash
    ) {
        throw new Error("full-version URL must be an explicit public HTTPS page without credentials or query");
    }
    Object.assign(process.env, {
        DC_PORTABLE_LOCALE: locale,
        DC_PORTABLE_VERSION: version,
        DC_PORTABLE_FILENAME: filename,
        DC_PORTABLE_FULL_VERSION_URL: fullVersionUrl.href,
        DC_PORTABLE_OUT_DIR: outDir,
    });
    await build({ configFile: resolve("vite.portable.config.ts"), logLevel: "warn" });
    const bytes = readFileSync(resolve(outDir, filename));
    manifest.files[locale] = {
        path: `/downloads/portable/${version}/${filename.replace(/\.html$/, "")}`,
        filename,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
    };
    console.log(`portable: ${filename} (${bytes.length} bytes)`);
}
writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
