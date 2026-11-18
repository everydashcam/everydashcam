// Generates dist/third-party-notices.txt - the license texts of every
// production npm package that can end up in the shipped bundle.
//
// WHY: MIT/BSD-style licenses require reproducing the copyright notice and
// license text "with the distribution". The minifier strips comments from the
// bundle, so the deployed site has to carry the notices some other way - this
// file, linked from the landing footer. MPL-2.0 packages (mediabunny)
// additionally require telling recipients where the MPL-covered source lives;
// the per-package "Source:" line covers that.
//
// The package list comes from package-lock.json (production = entries without
// the `dev` flag), so transitive dependencies are covered without shelling out
// to npm. @types/* are excluded - type declarations never reach the bundle.
// Over-collection is deliberate: a package that ends up tree-shaken away still
// appearing here is harmless; a missing notice is a license violation.
//
// Fail-loud: a production package with no license text, no SPDX id and no
// entry in KNOWN_MISSING_LICENSE fails the build - that is a new dependency
// whose licensing nobody has looked at yet.
//
// Wired into `npm run build` after `vite build` (writes into dist/). Runs
// post-build on purpose: the file stays out of the service-worker precache
// manifest - legal notices are not worth megabytes of offline cache.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Packages that ship neither a license file nor an SPDX id. Each entry needs
// a reason; the generated notice points at the repository instead of a text.
const KNOWN_MISSING_LICENSE = new Map([
    [
        "@mapbox/jsonlint-lines-primitives",
        "the npm package declares no license and ships no license text; see the repository",
    ],
]);

export function generateThirdPartyNotices(root = process.cwd()) {
    const ROOT = resolve(root);
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

    // name@version -> { name, version, dir } deduped across nested node_modules
    // paths (the same package can appear both hoisted and nested in the lock).
    const packages = new Map();
    for (const [path, meta] of Object.entries(lock.packages)) {
        if (!path.startsWith("node_modules/") || meta.dev) continue;
        const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
        if (name.startsWith("@types/")) continue;
        packages.set(`${name}@${meta.version}`, { name, version: meta.version, dir: join(ROOT, path) });
    }

    // Prefer the real file over package.json metadata: the file carries the
    // copyright line, which is the part the licenses require us to reproduce.
    function findLicenseFiles(dir) {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            return [];
        }
        return entries.filter((f) => /^(licen[cs]e|notice|copying)([.-]|$)/i.test(f)).sort();
    }

    function repoUrl(pkgJson, name) {
        const raw =
            typeof pkgJson.repository === "string" ? pkgJson.repository : (pkgJson.repository?.url ?? pkgJson.homepage);
        if (!raw) return `https://www.npmjs.com/package/${name}`;
        const url = raw
            .replace(/^git\+/, "")
            .replace(/^git:\/\//, "https://")
            .replace(/^ssh:\/\/git@/, "https://")
            .replace(/^git@([^:]+):/, "https://$1/")
            .replace(/^github:/, "https://github.com/")
            .replace(/^gitlab:/, "https://gitlab.com/")
            .replace(/^bitbucket:/, "https://bitbucket.org/")
            .replace(/\.git$/, "");
        // npm shorthand "owner/repo" implies GitHub.
        return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
    }

    const RULE = "=".repeat(80);
    const sections = [];
    const failures = [];

    for (const { name, version, dir } of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        let pkgJson = {};
        try {
            pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        } catch {
            failures.push(
                `${name}@${version}: package.json unreadable at ${dir} - is node_modules in sync with the lock?`,
            );
            continue;
        }

        const spdx = pkgJson.license ?? "";
        const files = findLicenseFiles(dir);
        const lines = [RULE, `${name} ${version}`];
        if (spdx) lines.push(`License: ${spdx}`);
        lines.push(`Source: ${repoUrl(pkgJson, name)}`, "");

        if (files.length > 0) {
            for (const file of files) {
                lines.push(readFileSync(join(dir, file), "utf8").trim(), "");
            }
        } else if (KNOWN_MISSING_LICENSE.has(name)) {
            lines.push(`Note: ${KNOWN_MISSING_LICENSE.get(name)}.`, "");
        } else if (spdx) {
            lines.push("Note: the npm package ships no license text; see the source repository.", "");
        } else {
            failures.push(
                `${name}@${version}: no license file, no SPDX id, no KNOWN_MISSING_LICENSE entry - vet its licensing first`,
            );
            continue;
        }
        sections.push(lines.join("\n"));
    }

    sections.push(
        [RULE, "Bundled typefaces", readFileSync(join(ROOT, "public/fonts/OFL.txt"), "utf8").trim()].join("\n"),
        [
            RULE,
            "OpenFreeMap map sprite assets",
            readFileSync(join(ROOT, "public/styles/sprite/NOTICE.txt"), "utf8").trim(),
            "",
            readFileSync(join(ROOT, "public/styles/sprite/LICENSE.txt"), "utf8").trim(),
        ].join("\n"),
    );

    if (failures.length > 0) {
        throw new Error(`third-party notices failed\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    }

    const header = [
        "Third-party notices for everydashcam (https://everydashcam.app)",
        "",
        "everydashcam itself is licensed under AGPL-3.0-only; its source code lives at",
        "the repository linked from the site. This file reproduces the license texts",
        "of third-party packages and assets used by the application. The package list",
        "is generated from package-lock.json at build time and may include packages",
        "that the final bundle does not actually contain.",
        "",
    ].join("\n");

    return `${header}\n${sections.join("\n\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const dist = resolve(process.cwd(), "dist");
    if (!existsSync(join(dist, "index.html"))) throw new Error("dist/index.html not found - run vite build first");
    const output = join(dist, "third-party-notices.txt");
    writeFileSync(output, generateThirdPartyNotices());
    console.log("generate-third-party-notices: OK");
}
