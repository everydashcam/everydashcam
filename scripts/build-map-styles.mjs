#!/usr/bin/env node
// Run after editing the canonical public/styles/light.json or its palettes.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMapStyleVariant, MAP_STYLE_VARIANTS } from "./_map-style-palettes.mjs";
import { updateOpenMapTilesRoadLayers } from "./_map-road-layers.mjs";

const root = new URL("../public/styles/", import.meta.url);
const lightUrl = new URL("light.json", root);
const light = updateOpenMapTilesRoadLayers(JSON.parse(await readFile(lightUrl, "utf8")));
await writeFile(lightUrl, `${JSON.stringify(light, null, 2)}\n`, "utf8");
for (const theme of process.argv.includes("--light-only") ? [] : MAP_STYLE_VARIANTS) {
    const output = new URL(`${theme}.json`, root);
    const style = createMapStyleVariant(light, theme);
    await writeFile(output, `${JSON.stringify(style, null, 2)}\n`, "utf8");
    console.log(`build-map-styles: wrote ${fileURLToPath(output)}`);
}
