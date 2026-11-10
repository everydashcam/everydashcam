import { describe, expect, it } from "vitest";
import { fileIdentityKey, fileIdentityOf, parseFileIdentityKey } from "./identity.js";

describe("fileIdentityOf", () => {
    it("captures path, size and lastModified without reading bytes", () => {
        const file = new File([new Uint8Array(5)], "REC001.MP4", { lastModified: 1_754_000_000_000 });
        const identity = fileIdentityOf(file, "DCIM/100/REC001.MP4");
        expect(identity).toEqual({
            relativePath: "DCIM/100/REC001.MP4",
            size: 5,
            lastModified: 1_754_000_000_000,
        });
    });
});

describe("fileIdentityKey", () => {
    it("is stable for equal identities", () => {
        const a = { relativePath: "a/b.mp4", size: 10, lastModified: 20 };
        expect(fileIdentityKey(a)).toBe(fileIdentityKey({ ...a }));
    });

    it("changes when any single field changes", () => {
        const base = { relativePath: "a/b.mp4", size: 10, lastModified: 20 };
        const baseKey = fileIdentityKey(base);
        expect(fileIdentityKey({ ...base, relativePath: "a/c.mp4" }), "path change").not.toBe(baseKey);
        expect(fileIdentityKey({ ...base, size: 11 }), "size change").not.toBe(baseKey);
        expect(fileIdentityKey({ ...base, lastModified: 21 }), "mtime change").not.toBe(baseKey);
    });

    it("does not collide when digits shift between numeric fields", () => {
        const a = fileIdentityKey({ relativePath: "x.mp4", size: 1, lastModified: 12 });
        const b = fileIdentityKey({ relativePath: "x.mp4", size: 11, lastModified: 2 });
        expect(a).not.toBe(b);
    });

    it("round-trips a key and rejects malformed keys", () => {
        const identity = { relativePath: "CARD/DCIM/a.mp4", size: 42, lastModified: 1_700_000_000_000 };
        expect(parseFileIdentityKey(fileIdentityKey(identity))).toEqual(identity);
        expect(parseFileIdentityKey("legacy-key")).toBeNull();
        expect(parseFileIdentityKey(["a.mp4", "-1", "2"].join(String.fromCharCode(0)))).toBeNull();
        expect(parseFileIdentityKey(["a.mp4", "", "2"].join(String.fromCharCode(0)))).toBeNull();
        expect(parseFileIdentityKey(["a.mp4", "1e2", "2"].join(String.fromCharCode(0)))).toBeNull();
        expect(parseFileIdentityKey(["a.mp4", "01", "2"].join(String.fromCharCode(0)))).toBeNull();
        expect(parseFileIdentityKey(["a.mp4", "1", "-0"].join(String.fromCharCode(0)))).toBeNull();
        expect(parseFileIdentityKey(["a.mp4", "1", "--2"].join(String.fromCharCode(0)))).toBeNull();
    });

    it("round-trips the 1601 time Chromium reports for a picked file without an OS time", () => {
        const identity = { relativePath: "DCIM/FILE0001.MP4", size: 42, lastModified: -11_644_473_600_000 };
        expect(parseFileIdentityKey(fileIdentityKey(identity))).toEqual(identity);
    });
});
