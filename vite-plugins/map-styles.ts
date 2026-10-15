import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Public files bypass Vite's JSON transform. Compact the hosted style copies
// after they are written, before swPrecachePlugin hashes them in closeBundle.
// Portable imports the same readable sources through Vite's JSON transform.
export function mapStylesPlugin(): Plugin {
    let stylesDir: string;
    return {
        name: "everydashcam-map-styles",
        apply: "build",
        configResolved(config) {
            stylesDir = resolve(config.root, config.build.outDir, "styles");
        },
        writeBundle() {
            for (const entry of readdirSync(stylesDir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
                const path = resolve(stylesDir, entry.name);
                const style: unknown = JSON.parse(readFileSync(path, "utf8"));
                writeFileSync(path, JSON.stringify(style));
            }
        },
    };
}
