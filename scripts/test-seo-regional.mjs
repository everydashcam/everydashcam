// Build both production profiles from one checkout and validate their actual
// output together. Plugins write dist/, so builds must run sequentially.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getIndexableSeoLocales } from "../src/i18n/seo-config.ts";

const locales = getIndexableSeoLocales();
const mirror = {
    origin: "https://regional.example.test",
    localeSegments: locales.map((locale) => locale.urlSegment),
    rootLocaleSegment: "de",
    regionalHreflangs: Object.fromEntries(
        locales.map((locale) => {
            const language = new Intl.Locale(locale.hreflang);
            return [locale.urlSegment, `${language.language}${language.script ? `-${language.script}` : ""}-CA`];
        }),
    ),
};
const environment = {
    ...process.env,
    NODE_ENV: "production",
    VITE_USER_NODE_ENV: "production",
    SEO_CUTOVER: "1",
    SEO_MIRROR_CONFIG: JSON.stringify(mirror),
    VITE_NO_INDEX: "0",
    VITE_SENTRY_DSN: "",
    SENTRY_AUTH_TOKEN: "",
    SENTRY_ORG: "",
    SENTRY_PROJECT: "",
    INDEXNOW_KEY: "",
    VITE_YANDEX_TILES_API_KEY: "",
    VITE_DEFAULT_MAP_PROVIDER: "",
    PORTABLE_MANIFEST: "",
    META_CSP: "1",
    DISABLE_CLOUDFLARE_ANALYTICS: "1",
};

function run(command, args, env = environment) {
    const result = spawnSync(command, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with ${result.signal ?? result.status}`);
}

const temporary = mkdtempSync(join(tmpdir(), "everydashcam-regional-seo-"));
try {
    for (const profile of ["primary", "mirror"]) {
        process.stdout.write(`[test-seo-regional] building synthetic ${profile} production artifact\n`);
        run("npm", ["run", "build"], { ...environment, DEPLOYMENT_PROFILE: profile });
        if (profile === "primary") cpSync(resolve("dist"), join(temporary, "primary"), { recursive: true });
    }
    run(process.execPath, ["scripts/check-seo.mjs", join(temporary, "primary"), "dist"]);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
