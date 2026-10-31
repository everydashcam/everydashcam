import { describe, expect, it } from "vitest";

import { isQuotaExceededError } from "./quota-error.js";

describe("isQuotaExceededError", () => {
    it("matches the standard DOMException QuotaExceededError (name and legacy code 22)", () => {
        const byName = new DOMException("quota", "QuotaExceededError");
        expect(isQuotaExceededError(byName)).toBe(true);
        // The constructor maps the legacy name to code 22, so the code check is
        // a backstop for engines that surface the code without the name.
        expect(byName.code).toBe(22);
    });

    it("matches a forwarded worker error that kept only the name", () => {
        const wrapped = Object.assign(new Error("write failed"), { name: "QuotaExceededError" });
        expect(isQuotaExceededError(wrapped)).toBe(true);
        expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true);
    });

    it("matches the raw message text when the typed shape is lost", () => {
        // The exact Chromium QuotaExceededError message, stringified into a cause.
        expect(
            isQuotaExceededError(
                new Error("The operation failed because it would cause the application to exceed its storage quota."),
            ),
        ).toBe(true);
        expect(isQuotaExceededError(new Error("ENOSPC: no space left on device"))).toBe(true);
        expect(isQuotaExceededError("Disk is full")).toBe(true);
    });

    it("is false for ordinary, non-quota errors (so they fall through to their own handling)", () => {
        expect(isQuotaExceededError(new Error("network request failed"))).toBe(false);
        expect(isQuotaExceededError(new RangeError("Array buffer allocation failed"))).toBe(false);
        expect(isQuotaExceededError(new DOMException("aborted", "AbortError"))).toBe(false);
        expect(isQuotaExceededError("just mentions a quota informally")).toBe(false);
        expect(isQuotaExceededError(null)).toBe(false);
        expect(isQuotaExceededError(undefined)).toBe(false);
    });
});
