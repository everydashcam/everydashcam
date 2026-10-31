import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { matchesArtifactIntegrity, sha256Hex } from "../scripts/_artifact-integrity.mjs";
import { hostedHtmlFiles } from "../scripts/_build-files.mjs";
import { box, readBoxHeader, u32be } from "../scripts/_mp4-fixture.mjs";

const directories: string[] = [];
function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "build-artifacts-"));
    directories.push(path);
    return path;
}
afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("checks size and SHA-256 of exactly the published byte view", () => {
    const storage = Buffer.from("xabcx");
    const bytes = storage.subarray(1, 4);
    const expected = { bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    expect(sha256Hex(bytes)).toBe(expected.sha256);
    expect(matchesArtifactIntegrity(bytes, expected)).toBe(true);
    expect(matchesArtifactIntegrity(Buffer.from("abd"), expected)).toBe(false);
    expect(matchesArtifactIntegrity(bytes, { ...expected, bytes: 4 })).toBe(false);
    expect(matchesArtifactIntegrity(storage, expected)).toBe(false);
});

it("enumerates hosted pages recursively while excluding portable artifacts at every depth", () => {
    const root = temporaryDirectory();
    for (const file of [
        "index.html",
        "en/cameras/index.html",
        "nested/ru/index.html",
        "downloads/a.html",
        "en/downloads/b.html",
        "en/app.js",
    ]) {
        const path = join(root, file);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "");
    }
    mkdirSync(join(root, "directory.html"));
    expect(hostedHtmlFiles(root).map((path) => relative(root, path))).toEqual([
        "en/cameras/index.html",
        "index.html",
        "nested/ru/index.html",
    ]);
});

it("retains MP4 box lengths, extended headers and size-to-end semantics", () => {
    const regular = box("free", Buffer.from([1, 2]));
    expect(regular).toEqual(Buffer.from([0, 0, 0, 10, 102, 114, 101, 101, 1, 2]));
    const extended = Buffer.concat([u32be(1), Buffer.from("free"), u32be(0), u32be(17), Buffer.from([3])]);
    const toEnd = Buffer.concat([u32be(0), Buffer.from("mdat"), Buffer.from([4])]);
    const bytes = Buffer.concat([regular, extended, toEnd]);
    const path = join(temporaryDirectory(), "boxes.mp4");
    writeFileSync(path, bytes);
    const fd = openSync(path, "r");
    try {
        expect(readBoxHeader(fd, 0, bytes.length)).toEqual({ type: "free", size: 10, headerSize: 8 });
        expect(readBoxHeader(fd, 10, bytes.length)).toEqual({ type: "free", size: 17, headerSize: 16 });
        expect(readBoxHeader(fd, 27, bytes.length)).toEqual({ type: "mdat", size: 9, headerSize: 8 });
        expect(readBoxHeader(fd, 10, 25)).toBeNull();
        expect(readBoxHeader(fd, bytes.length - 2, bytes.length)).toBeNull();
    } finally {
        closeSync(fd);
    }
});
