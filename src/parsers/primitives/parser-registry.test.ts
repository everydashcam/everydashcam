import { describe, expect, it } from "vitest";

import { parsePrimitiveId, parseRegistryBindings } from "../../../scripts/_parser-registry.mjs";

describe("parser registry source", () => {
    it("preserves import aliases and registry order without reading comments or types", () => {
        const source = `
            import type { Primitive } from "./types.js";
            // import { ghost } from "./ghost.js";
            import { first as local, type Ignored, second } from "./parsers.js"
            export const REGISTRY: Primitive[] = [
                second, /* ], ghost */ local,
            ] satisfies Primitive[];
        `;
        expect(parseRegistryBindings("index.ts", source, "REGISTRY")).toEqual([
            { specifier: "./parsers.js", exportName: "second" },
            { specifier: "./parsers.js", exportName: "first" },
        ]);
    });

    it.each(["[]", "[...parsers]", "[createParser()]", "[{ id: 'inline' }]", "[parser,,parser]"])(
        "rejects a registry that can hide entries: %s",
        (initializer) => {
            expect(() =>
                parseRegistryBindings(
                    "index.ts",
                    `import { parser } from "./one.js"; export const REGISTRY = ${initializer};`,
                    "REGISTRY",
                ),
            ).toThrow();
        },
    );

    it.each([
        'import type { parser } from "./one.js";',
        'import { type parser } from "./one.js";',
        'import * as parser from "./one.js";',
        'import parser from "./one.js";',
    ])("rejects entries without a named value import: %s", (declaration) => {
        expect(() =>
            parseRegistryBindings("index.ts", `${declaration} export const REGISTRY = [parser];`, "REGISTRY"),
        ).toThrow(/named value import/);
    });

    it("reads the own id instead of an earlier comment, nested property, or unrelated export", () => {
        const source = `
            export const other = { id: "other" };
            export const parser = {
                // id: "commented-out",
                marker() { return { id: "nested" }; },
                "id": "actual\\u002did",
            } satisfies Primitive;
        `;
        expect(parsePrimitiveId("parser.ts", source, "parser")).toBe("actual-id");
    });

    it("resolves only a top-level constant for the id", () => {
        const source = `
            function unrelated() { const FORMAT_ID = "nested"; }
            export const FORMAT_ID = "actual" as const;
            export const parser: Primitive = { id: FORMAT_ID };
        `;
        expect(parsePrimitiveId("parser.ts", source, "parser")).toBe("actual");
        expect(() =>
            parsePrimitiveId("parser.ts", source.replace("export const FORMAT_ID", "let FORMAT_ID"), "parser"),
        ).toThrow(/static string id/);
    });

    it.each([
        '{ id: "first", ...extra }',
        '{ id: "first", [key]: "second" }',
        '{ id: "first", id: "second" }',
        '{ get id() { return "dynamic"; } }',
        "{ id: makeId() }",
        "{ id: MISSING }",
        '{ id: "" }',
        'makePrimitive("dynamic")',
    ])("rejects ambiguous or dynamic ids: %s", (initializer) => {
        expect(() => parsePrimitiveId("parser.ts", `export const parser = ${initializer};`, "parser")).toThrow();
    });

    it("reports invalid TypeScript instead of accepting a partial parse", () => {
        expect(() => parsePrimitiveId("broken.ts", 'export const parser = { id: "one" ', "parser")).toThrow(
            /cannot parse broken.ts/,
        );
    });
});
