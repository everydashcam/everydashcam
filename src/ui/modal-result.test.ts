import { expect, it } from "vitest";
import { createModalResult } from "./modal-result.js";

it("settles a replaced dialog as cancelled and preserves the next choice", async () => {
    const result = createModalResult<boolean>();
    const first = result.wait(false);
    const second = result.wait(false);
    await expect(first).resolves.toBe(false);
    expect(result.pending).toBe(true);
    result.settle(true);
    await expect(second).resolves.toBe(true);
    expect(result.pending).toBe(false);
});

it("ignores repeated close calls and permits a later dialog", async () => {
    const result = createModalResult<string>();
    const first = result.wait("cancel");
    result.settle("files");
    result.settle("cancel");
    await expect(first).resolves.toBe("files");
    const next = result.wait("cancel");
    result.settle("folder");
    await expect(next).resolves.toBe("folder");
});
