// Playback on an origin that is not a secure context: a plain-HTTP address on
// the local network, the self-hosted setup docs/self-hosting.md describes.
// Browsers expose WebCodecs only to secure contexts, so the page cannot probe
// decode support there and must leave the verdict to the native player.

import { expect, gotoApp, loadTrip, masterVideoTime, SAMPLE_70MAI, test } from "./_fixtures.js";

// Chromium treats http://localhost and 127.0.0.0/8 as secure, so the origin
// needs another address. This one is reserved for documentation (RFC 5737) and
// never routed; the resolver rule sends it to the preview server instead.
const INSECURE_HOST = "192.0.2.1";

test.use({
    // The preview server's port comes from tests/playwright.e2e.config.ts.
    baseURL: `http://${INSECURE_HOST}:4173`,
    launchOptions: { args: [`--host-resolver-rules=MAP ${INSECURE_HOST} localhost`] },
});

test("plays an H.264 trip where WebCodecs is unavailable", async ({ page }) => {
    await gotoApp(page, "en");
    expect(
        await page.evaluate(() => ({
            isSecureContext: window.isSecureContext,
            hasVideoDecoder: "VideoDecoder" in window,
        })),
        "the origin is an insecure context without WebCodecs",
    ).toEqual({ isSecureContext: false, hasVideoDecoder: false });

    await loadTrip(page, SAMPLE_70MAI);

    await expect(page.locator(".viewer"), "no codec overlay").not.toHaveClass(/codec-unsupported/);
    await page.locator("#player-play").click();
    await expect.poll(() => masterVideoTime(page), { message: "the master video advances" }).toBeGreaterThan(0.05);
});
