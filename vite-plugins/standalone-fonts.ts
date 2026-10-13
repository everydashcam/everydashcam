import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

function readStandaloneFonts(stylesPath: string): string {
    const faces = readFileSync(resolve(stylesPath, "fonts.css"), "utf8");
    const stacksImport = /^@import ["']\.\/font-stacks\.css["'];\s*/;
    if (!stacksImport.test(faces)) throw new Error("standalone font stylesheet is missing its font stacks import");
    const stacks = readFileSync(resolve(stylesPath, "font-stacks.css"), "utf8");
    return faces.replace(stacksImport, `${stacks}\n`);
}

// Standalone documents share the viewer's font definitions without its CSS bundle.
export function standaloneFontsPlugin(): Plugin {
    let stylesPath: string;
    return {
        name: "everydashcam-standalone-fonts",
        configResolved(config) {
            stylesPath = resolve(config.root, "src/styles");
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if ((req.url ?? "").split("?")[0] !== "/fonts.css") return next();
                res.setHeader("Content-Type", "text/css; charset=utf-8");
                res.end(readStandaloneFonts(stylesPath));
            });
        },
        generateBundle() {
            this.emitFile({
                type: "asset",
                fileName: "fonts.css",
                source: readStandaloneFonts(stylesPath),
            });
        },
    };
}
