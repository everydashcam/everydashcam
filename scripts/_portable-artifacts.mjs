import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parsePortableManifest } from "../src/portable/manifest.mjs";

export function readPortableArtifacts(manifestPath, allowDevelopment = false, allowCustom = false) {
    const manifest = parsePortableManifest(
        JSON.parse(readFileSync(manifestPath, "utf8")),
        allowDevelopment,
        allowCustom,
    );
    if (!manifest) throw new Error("invalid portable artifact manifest");
    for (const file of Object.values(manifest.files)) {
        const bytes = readFileSync(resolve(dirname(manifestPath), file.filename));
        if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
            throw new Error(`portable artifact integrity mismatch: ${file.filename}`);
        }
    }
    return manifest;
}

export function stagePortableArtifacts(manifestPath, distDir, allowCustom = false, allowDevelopment = false) {
    const manifest = readPortableArtifacts(manifestPath, allowDevelopment, allowCustom);
    for (const file of Object.values(manifest.files)) {
        // Pages injects analytics into .html assets even with no-transform.
        // The attachment header supplies the download's .html extension.
        const target = resolve(distDir, file.path.slice(1));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(resolve(dirname(manifestPath), file.filename), target);
    }
    const target = resolve(distDir, "downloads/portable/latest.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(manifest)}\n`);
    return manifest;
}

export function stagePortableRelease(manifestPath, destination, allowDevelopment = false) {
    const manifest = readPortableArtifacts(manifestPath, allowDevelopment);
    const filenames = Object.values(manifest.files).map((file) => file.filename);
    mkdirSync(destination, { recursive: true });
    for (const filename of filenames) {
        copyFileSync(resolve(dirname(manifestPath), filename), resolve(destination, filename));
    }
    copyFileSync(manifestPath, resolve(destination, "portable-manifest.json"));
    writeFileSync(resolve(destination, "portable-assets.txt"), `${filenames.join("\n")}\n`);
    return filenames;
}
