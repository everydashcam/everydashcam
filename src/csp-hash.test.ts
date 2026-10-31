import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pluginUrl = new URL("../vite-plugins/csp-hash.ts", import.meta.url).href;
const fixtureHtml = '<html><head><meta charset="UTF-8"><script id="dc-bootstrap">boot()</script></head></html>';
const fixtureHeaders =
    "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'\n";

describe("meta CSP build option", () => {
    it.each([
        { name: "omits meta CSP when the flag is unset", env: undefined, option: undefined, expected: false },
        { name: "omits meta CSP for META_CSP=0", env: "0", option: undefined, expected: false },
        { name: "injects meta CSP for META_CSP=1", env: "1", option: undefined, expected: true },
        {
            name: "does not treat arbitrary nonempty values as enabled",
            env: "true",
            option: undefined,
            expected: false,
        },
        { name: "lets an explicit false override META_CSP=1", env: "1", option: false, expected: false },
        { name: "lets an explicit true override META_CSP=0", env: "0", option: true, expected: true },
    ])("$name", ({ env: value, option, expected }) => {
        const root = mkdtempSync(join(tmpdir(), "everydashcam-csp-"));
        const dist = join(root, "dist");
        try {
            mkdirSync(dist);
            writeFileSync(join(dist, "index.html"), fixtureHtml);
            writeFileSync(join(dist, "_headers"), fixtureHeaders);
            const env = { ...process.env };
            if (value === undefined) delete env.META_CSP;
            else env.META_CSP = value;
            // A separate process gives the plugin a real cwd without changing
            // the test runner's cwd or touching another suite's dist artifacts.
            execFileSync(
                process.execPath,
                [
                    "--experimental-strip-types",
                    "--input-type=module",
                    "--eval",
                    `import { cspHashPlugin } from ${JSON.stringify(pluginUrl)};
                    cspHashPlugin(JSON.parse(process.argv[1])).closeBundle();`,
                    JSON.stringify({ metaCsp: option }),
                ],
                { cwd: root, env, stdio: "pipe" },
            );

            const html = readFileSync(join(dist, "index.html"), "utf8");
            expect(html.includes('http-equiv="Content-Security-Policy"')).toBe(expected);
            if (!expected) expect(html).toBe(fixtureHtml);
            // Disabling HTML delivery must not disable the response-header CSP.
            const headers = readFileSync(join(dist, "_headers"), "utf8");
            expect(headers).toContain("'sha256-");
            expect(headers).toContain("frame-ancestors 'none'");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
