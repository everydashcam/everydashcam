import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
// These cases build synthetic variants or exercise Vite's development server.
// CI runs both projects; publication tests only the final artifact.
const toolingTests = ["download", "offline-choice", "updates", "yandex"].map((name) => `**/${name}.spec.ts`);

export default defineConfig({
    testDir: "./portable",
    outputDir: resolve(root, "test-results/portable"),
    workers: 1,
    fullyParallel: false,
    forbidOnly: true,
    retries: 0,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    projects: [
        { name: "artifact", testIgnore: toolingTests },
        { name: "tooling", testMatch: toolingTests },
    ],
    use: {
        channel: process.env.PW_CHANNEL || "chromium",
        headless: true,
        viewport: { width: 1440, height: 960 },
        locale: "de-DE",
        serviceWorkers: "block",
        trace: "retain-on-failure",
    },
    reporter: [["list"]],
});
