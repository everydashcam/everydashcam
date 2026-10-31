import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** One immutable directory pairs styles with the local sprites they reference. */
export function computeMapStyles(command: "build" | "serve" = "build", root = process.cwd()) {
    // Vite serves public files directly in dev, so edits are visible on reload.
    // Only deployed styles need immutable URLs paired with their sprites.
    if (command === "serve") {
        return {
            urls: { light: "/styles/light.json", dark: "/styles/dark.json", neon: "/styles/neon.json" },
            files: new Map<string, Buffer>(),
        };
    }
    const source = resolve(root, "public/styles");
    const originals = new Map<string, Buffer>();
    for (const rel of readdirSync(source, { recursive: true }).map(String).sort()) {
        if (/\.(?:json|png|txt)$/.test(rel)) originals.set(rel, readFileSync(resolve(source, rel)));
    }
    const hash = createHash("sha256");
    for (const [name, bytes] of originals) hash.update(name).update("\0").update(bytes).update("\0");
    const prefix = `/styles/${hash.digest("hex").slice(0, 16)}/`;
    const files = new Map<string, Buffer>();
    for (const [name, bytes] of originals) {
        files.set(
            prefix + name,
            name.endsWith(".json")
                ? Buffer.from(JSON.stringify(JSON.parse(bytes.toString())).replaceAll('"/styles/', `"${prefix}`))
                : bytes,
        );
    }
    return { urls: { light: `${prefix}light.json`, dark: `${prefix}dark.json`, neon: `${prefix}neon.json` }, files };
}

export function mapStylesPlugin(assets: ReturnType<typeof computeMapStyles>): Plugin {
    let outDir: string;
    let build = false;
    return {
        name: "everydashcam-map-styles",
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir);
            build = config.command === "build";
        },
        writeBundle() {
            if (!build) return;
            rmSync(resolve(outDir, "styles"), { recursive: true, force: true });
            for (const [url, bytes] of assets.files) {
                const path = resolve(outDir, url.slice(1));
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, bytes);
            }
        },
    };
}
