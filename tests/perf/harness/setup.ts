// Per-page setup: installs all init scripts and navigates to the preview
// origin. Centralized so each spec doesn't duplicate the boilerplate.

import type { Page } from "@playwright/test";

import { HARNESS_INIT_SCRIPT } from "./files.js";
import { BYTES_READ_INIT_SCRIPT } from "./bytes-read.js";
import { PEAK_MEMORY_INIT_SCRIPT } from "./peak-memory.js";
import { RESET_INIT_SCRIPT } from "./measure.js";

/** Keeps private recording metadata away from map providers and telemetry endpoints. */
export async function blockExternalRequests(page: Page, baseURL = "http://localhost:4173/"): Promise<void> {
    const origin = new URL(baseURL).origin;
    await page
        .context()
        .route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"),
        );
}

/**
 * Installs init scripts and navigates to '/'. The init scripts run BEFORE
 * any app module evaluates, so File.prototype.slice etc. are patched in time
 * to count the very first ingest's reads.
 */
export async function setupPage(page: Page, baseURL = "http://localhost:4173/"): Promise<void> {
    await blockExternalRequests(page, baseURL);
    await page.addInitScript(HARNESS_INIT_SCRIPT);
    await page.addInitScript(BYTES_READ_INIT_SCRIPT);
    await page.addInitScript(PEAK_MEMORY_INIT_SCRIPT);
    await page.addInitScript(RESET_INIT_SCRIPT);
    await page.goto(baseURL);
    // Wait for the app's `dc:ready` event (dispatched after applyStaticI18n +
    // theme init complete) so we don't race with module evaluation in the
    // first scenario call.
    await page.evaluate(async () => {
        if (document.documentElement.classList.contains("is-loading")) {
            await new Promise<void>((resolve) => {
                window.addEventListener("dc:ready", () => resolve(), { once: true });
                // Safety timeout: if dc:ready never fires (early import error),
                // resolve after 10s and let the spec deal with the broken state.
                setTimeout(() => resolve(), 10_000);
            });
        }
    });
}
