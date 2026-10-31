import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export interface DeploymentAsset {
    url: string;
    bytes: number;
    sha256: string;
}
export interface DeploymentAssets {
    schema: 1;
    files: DeploymentAsset[];
}

/** Current release only. Previous files are copied after the build; including
 * them here would accumulate every historical release on the next deployment. */
export function collectDeploymentAssets(root: string): DeploymentAssets {
    const files: DeploymentAsset[] = [];
    for (const name of readdirSync(root, { recursive: true }).map(String).sort()) {
        // Public credits/icons also live under assets/, but their stable URLs
        // may legitimately change. Only bundled media carries an immutable hash.
        const bundledAsset =
            name.startsWith("assets/") &&
            (/\.(?:m?js|css)$/.test(name) ||
                /-[A-Za-z0-9_-]{8,}\.(?:svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|wasm)$/.test(name));
        const dataAsset = /^(?:styles\/.*\.(?:json|png|txt)|ort\/.*\.(?:wasm|mjs|bin)|models\/.*\.onnx)$/.test(name);
        if (!bundledAsset && !dataAsset) continue;
        const bytes = readFileSync(resolve(root, name));
        if (bytes.length > 25 * 1024 * 1024) throw new Error(`hosting file limit exceeded: ${name}`);
        files.push({ url: `/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return { schema: 1, files };
}

export function deploymentAssetsPlugin(): Plugin {
    let root: string;
    return {
        name: "everydashcam-deployment-assets",
        apply: "build",
        configResolved(config) {
            root = resolve(config.root, config.build.outDir);
        },
        closeBundle() {
            writeFileSync(resolve(root, "deployment-assets.json"), JSON.stringify(collectDeploymentAssets(root)));
        },
    };
}
