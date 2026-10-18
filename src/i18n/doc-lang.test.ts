import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { LANGS } from "./languages.js";

const script = readFileSync("public/doc-lang.js", "utf-8");
const languages = LANGS.map(({ code }) => code);

function openPage(pathname: string, search: string, stored: Record<string, string> = {}, failWrite?: (key: string) => boolean) {
    const articles = languages.map((lang) => ({
        hidden: lang !== "en",
        getAttribute: () => lang,
    }));
    const document = {
        documentElement: { lang: "en", getAttribute: () => null },
        querySelectorAll: (selector: string) => (selector === "article[data-lang]" ? articles : []),
    };
    runInNewContext(script, {
        document,
        window: { location: { pathname, search } },
        navigator: { language: "en-US" },
        localStorage: {
            getItem: (key: string) => stored[key] ?? null,
            setItem: (key: string, value: string) => {
                if (failWrite?.(key)) throw new Error("storage full");
                stored[key] = value;
            },
        },
        URLSearchParams,
    });
    return { lang: document.documentElement.lang, visible: articles.filter((article) => !article.hidden).map((article) => article.getAttribute()) };
}

describe("standalone page language", () => {
    it("keeps a missing page in the requested URL language", () => {
        for (const lang of languages) {
            expect(openPage(`/${lang}/missing`, "", { "everydashcam:doc-lang": "en" })).toEqual({ lang, visible: [lang] });
        }
    });

    it("keeps an explicit locale path ahead of a conflicting language query", () => {
        expect(openPage("/ru/missing", "?lang=en", { "everydashcam:doc-lang": "fr" })).toEqual({ lang: "ru", visible: ["ru"] });
    });

    it("lets explicit language links override a saved preference", () => {
        expect(openPage("/privacy", "?lang=fr", { "everydashcam:doc-lang": "ru" })).toEqual({ lang: "fr", visible: ["fr"] });
    });

    it("uses the app language when no document preference exists", () => {
        expect(openPage("/404", "", { "everydashcam:lang": "ja" })).toEqual({ lang: "ja", visible: ["ja"] });
    });

    it("reads and writes only the current preference names", () => {
        const stored: Record<string, string> = { "dashcamigo:doc-lang": "ru", "dashcamigo:lang": "ja" };
        expect(openPage("/terms", "", stored)).toEqual({ lang: "en", visible: ["en"] });
        expect(stored).toEqual({
            "dashcamigo:doc-lang": "ru",
            "dashcamigo:lang": "ja",
            "everydashcam:doc-lang": "en",
        });
        stored["everydashcam:doc-lang"] = "fr";
        expect(openPage("/terms", "", stored)).toEqual({ lang: "fr", visible: ["fr"] });
    });

    it("shows the requested language when saving it fails", () => {
        const stored = { "everydashcam:doc-lang": "ru" };
        expect(openPage("/terms", "?lang=de", stored, () => true)).toEqual({ lang: "de", visible: ["de"] });
        expect(stored["everydashcam:doc-lang"]).toBe("ru");
    });

    it("falls back to English for unsupported languages", () => {
        expect(openPage("/missing", "?lang=xx", { "everydashcam:doc-lang": "xx" })).toEqual({ lang: "en", visible: ["en"] });
    });

    it("provides a translated error and a locale home link for every language", () => {
        const html = readFileSync("public/404.html", "utf-8");
        const articles = [...html.matchAll(/<article data-lang="([a-z]+)"[^>]*>([\s\S]*?)<\/article>/g)];
        expect(articles.map((article) => article[1]).sort()).toEqual([...languages].sort());
        for (const [, lang, article] of articles) {
            expect(article).toMatch(/<h1>[^<]+<\/h1>/);
            expect(article).toContain(`href="/${lang}/"`);
        }
    });
});
