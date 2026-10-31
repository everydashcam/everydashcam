import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { computeMapStyles } from "../vite-plugins/map-styles.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("versions deployed map styles together with their sprite bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "dc-map-styles-"));
    roots.push(root);
    mkdirSync(join(root, "public/styles/sprite"), { recursive: true });
    writeFileSync(join(root, "public/styles/light.json"), '{"sprite":"/styles/sprite/sprite"}');
    writeFileSync(join(root, "public/styles/sprite/sprite.png"), "first sprite");
    const first = computeMapStyles("build", root);
    const style = JSON.parse(first.files.get(first.urls.light)!.toString());
    expect(first.files.has(`${style.sprite}.png`)).toBe(true);
    writeFileSync(join(root, "public/styles/sprite/sprite.png"), "second sprite");
    expect(computeMapStyles("build", root).urls.light).not.toBe(first.urls.light);
    const dev = computeMapStyles("serve", root);
    expect(dev.urls.light).toBe("/styles/light.json");
    expect(dev.files.size).toBe(0);
});
