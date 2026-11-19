// Keep the baseline structured answers in sync with the English dictionary.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { enDict } from "./i18n/en.js";

const HTML_PATH = resolve(process.cwd(), "index.html");
const baselineHtml = readFileSync(HTML_PATH, "utf-8");

interface FaqEntry {
    name: string;
    text: string;
}

function extractBaselineFaq(html: string): FaqEntry[] {
    const m = html.match(/<script\b[^>]*\bid="faq-jsonld"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m?.[1]) throw new Error('<script id="faq-jsonld"> not found in index.html');
    const parsed = JSON.parse(m[1].trim()) as {
        mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    return parsed.mainEntity.map((q) => ({ name: q.name, text: q.acceptedAnswer.text }));
}

describe("faq-jsonld baseline parity", () => {
    const baseline = extractBaselineFaq(baselineHtml);

    it("has seven questions", () => {
        expect(baseline).toHaveLength(7);
    });

    it.each([
        [0, "landing.faq.q3", "landing.faq.a3"],
        [1, "landing.faq.q14", "landing.faq.a14"],
        [2, "landing.faq.q15", "landing.faq.a15"],
        [3, "landing.faq.q16", "landing.faq.a16"],
    ] as const)("entry %i: %s / %s matches dict", (idx, qKey, aKey) => {
        const entry = baseline[idx];
        expect(entry, `missing baseline entry ${idx}`).toBeDefined();
        expect(entry?.name).toBe(enDict[qKey]);
        expect(entry?.text).toBe(enDict[aKey]);
    });

    it.each([
        [4, 2],
        [5, 13],
        [6, 12],
    ] as const)("entry %i (q%i) includes the inline link label", (idx, id) => {
        const entry = baseline[idx];
        const expected = `${enDict[`landing.faq.a${id}.before`]}${enDict[`landing.faq.a${id}.link`]}${enDict[`landing.faq.a${id}.after`]}`;
        expect(entry?.name).toBe(enDict[`landing.faq.q${id}`]);
        expect(entry?.text).toBe(expected);
    });
});
