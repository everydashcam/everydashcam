import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    publicAssetUrls?: string[];
    retainedFiles?: DeploymentAsset[];
    publication?: "publishing" | "complete";
}

export function publicAssetUrls(publicDir: string): string[] {
    const assets = resolve(publicDir, "assets");
    if (!existsSync(assets)) return [];
    return readdirSync(assets, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map(
            (entry) =>
                `/assets/${resolve(entry.parentPath, entry.name)
                    .slice(assets.length + 1)
                    .replaceAll("\\", "/")}`,
        )
        .sort();
}

/** Only explicitly emitted files belong to the current immutable release. */
export function collectDeploymentAssets(
    root: string,
    urls: Iterable<string>,
    publicUrls: string[] = [],
): DeploymentAssets {
    const files: DeploymentAsset[] = [];
    for (const url of [...new Set(urls)].sort()) {
        const bytes = readFileSync(resolve(root, url.slice(1)));
        if (bytes.length > 25 * 1024 * 1024) throw new Error(`hosting file limit exceeded: ${url}`);
        files.push({ url, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return { schema: 1, files, publicAssetUrls: publicUrls };
}

export function deploymentAssetsPlugin(dataAssetUrls: Iterable<string>): Plugin {
    let root: string;
    let publicUrls: string[] = [];
    const bundledUrls = new Set<string>();
    const dataUrls = [...dataAssetUrls];
    return {
        name: "everydashcam-deployment-assets",
        apply: "build",
        configResolved(config) {
            root = resolve(config.root, config.build.outDir);
            publicUrls = config.publicDir ? publicAssetUrls(config.publicDir) : [];
        },
        generateBundle(_, bundle) {
            bundledUrls.clear();
            for (const output of Object.values(bundle)) {
                if (output.fileName.startsWith("assets/") && !/\.(?:map|html)$/.test(output.fileName)) {
                    bundledUrls.add(`/${output.fileName}`);
                }
            }
        },
        closeBundle() {
            // The tracker plugin removes Vite's duplicate runtime binary before
            // this hook. Its explicit content-addressed data replaces that file.
            const urls = [...bundledUrls].filter((url) => existsSync(resolve(root, url.slice(1))));
            urls.push(...dataUrls);
            writeFileSync(
                resolve(root, "deployment-assets.json"),
                JSON.stringify(collectDeploymentAssets(root, urls, publicUrls)),
            );
        },
    };
}
