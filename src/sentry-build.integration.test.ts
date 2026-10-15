import { resolve } from "node:path";
import type { OutputChunk } from "rolldown";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { lazyBoundariesPlugin } from "../vite-plugins/lazy-boundaries.js";

async function buildReporting(dsn: string | undefined) {
    // Bundle the real import boundary with synthetic config. Never read checkout
    // dotenv files or inherit their reporting endpoint into these artifacts.
    const result = await build({
        configFile: false,
        envDir: false,
        publicDir: false,
        logLevel: "silent",
        define: {
            "import.meta.env.VITE_SENTRY_DSN": dsn === undefined ? "undefined" : JSON.stringify(dsn),
            __APP_VERSION__: JSON.stringify("synthetic-build"),
            __DEPLOYMENT_PROFILE__: JSON.stringify("primary"),
            __SENTRY_DEBUG__: "false",
            __SENTRY_TRACING__: "false",
        },
        plugins: [lazyBoundariesPlugin()],
        build: {
            write: false,
            minify: true,
            modulePreload: false,
            rolldownOptions: { input: resolve("src/sentry.ts"), preserveEntrySignatures: "strict" },
        },
    });
    if (!("output" in result)) throw new Error("expected one reporting build output");
    return result.output.filter((item): item is OutputChunk => item.type === "chunk");
}

function sdkModules(chunks: OutputChunk[]): string[] {
    return chunks.flatMap((chunk) => Object.keys(chunk.modules).filter((id) => /\/node_modules\/@sentry\//.test(id)));
}

describe("optional reporting build boundary", () => {
    it.each([undefined, ""])("removes the SDK and its initialization island without a DSN (%s)", async (dsn) => {
        const chunks = await buildReporting(dsn);
        expect(sdkModules(chunks)).toEqual([]);
        expect(chunks.flatMap((chunk) => Object.keys(chunk.modules)).some((id) => id.endsWith("/sentry-init.ts"))).toBe(
            false,
        );
        expect(chunks.flatMap((chunk) => chunk.dynamicImports)).toEqual([]);
    });

    it("includes the SDK only through the deferred initialization island when configured", async () => {
        const chunks = await buildReporting("https://public@reports.example.test/1");
        expect(sdkModules(chunks).length).toBeGreaterThan(0);
        const entry = chunks.find((chunk) => chunk.isEntry);
        expect(entry?.dynamicImports.length).toBeGreaterThan(0);
        // lazyBoundariesPlugin also walks every static dependency of this entry.
        expect(sdkModules(chunks.filter((chunk) => chunk.isEntry))).toEqual([]);
    });
});
