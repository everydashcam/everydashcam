import { afterEach, describe, expect, it, vi } from "vitest";
import {
    readLocalStorage,
    readLocalStorageJson,
    removeLocalStorage,
    writeLocalStorage,
    writeLocalStorageJson,
} from "./local-storage.js";

afterEach(() => vi.unstubAllGlobals());

describe("best-effort preference storage", () => {
    it("handles a blocked global getter as well as unavailable storage", () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get: () => {
                throw new DOMException("blocked", "SecurityError");
            },
        });
        try {
            expect(readLocalStorage("pref")).toBeNull();
            expect(readLocalStorageJson("pref")).toBeNull();
            expect(writeLocalStorage("pref", "1")).toBe(false);
            expect(removeLocalStorage("pref")).toBe(false);
        } finally {
            if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
            else Reflect.deleteProperty(globalThis, "localStorage");
        }
        vi.stubGlobal("localStorage", undefined);
        expect(readLocalStorage("pref")).toBeNull();
    });

    it("reports failed writes so a session preference cannot be replaced by stale storage", () => {
        const data = new Map([["pref", "old"]]);
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: () => {
                throw new DOMException("full", "QuotaExceededError");
            },
            removeItem: () => {
                throw new DOMException("blocked", "SecurityError");
            },
        });
        expect(writeLocalStorageJson("pref", { changed: true })).toBe(false);
        expect(removeLocalStorage("pref")).toBe(false);
        expect(readLocalStorage("pref")).toBe("old");
    });

    it("reads current data without caching and leaves schema validation to preferences", () => {
        const data = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => data.set(key, value),
            removeItem: (key: string) => data.delete(key),
        });
        expect(readLocalStorageJson("pref")).toBeNull();
        data.set("pref", "{");
        expect(readLocalStorageJson("pref")).toBeNull();
        expect(writeLocalStorageJson("pref", { mode: "unknown" })).toBe(true);
        expect(readLocalStorageJson("pref")).toEqual({ mode: "unknown" });
        data.set("pref", '"new"');
        expect(readLocalStorageJson("pref")).toBe("new");
        expect(removeLocalStorage("pref")).toBe(true);
        expect(readLocalStorage("pref")).toBeNull();
    });
});
