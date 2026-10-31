import { expect, test } from "@playwright/test";

import { setupPage } from "./setup.js";

test("perf setup loads local assets and blocks requests outside the preview origin", async ({ page, context }) => {
    await setupPage(page);
    expect(await page.evaluate(async () => (await fetch(location.href)).ok)).toBe(true);

    // The probe stays on loopback even if the guard regresses. A second hostname
    // is a different origin; navigation avoids an app CSP hiding a missing guard.
    const probe = await context.newPage();
    await expect(probe.goto("http://127.0.0.1:4173/__perf-network-probe")).rejects.toThrow("ERR_BLOCKED_BY_CLIENT");
    await probe.close();
});
