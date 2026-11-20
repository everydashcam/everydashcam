import type { Page } from "@playwright/test";
import { expect, loadTrip, openExport, pausePlayback } from "./_fixtures.js";

/** Edits the clock correction on a paused frame: the GPS readout, the trip
 *  header and the clock overlay follow it, the position does not move, the
 *  field accepts typed and pasted signs, and the value survives a reload. */
export async function checkClockCorrection(page: Page): Promise<void> {
    await loadTrip(page);
    await pausePlayback(page);
    const cameraTzSec = await page.evaluate(() => {
        const { state } = window.__everydashcam;
        return state.active ? (state.trips[state.active.trip]?.cameraTzSec ?? null) : null;
    });
    expect(cameraTzSec, "the correction applies only to a known camera clock").not.toBeNull();
    await openExport(page);
    await page.locator("#export-panel-ov-clock").check();
    const canvas = page.locator("#player-telemetry-canvas");
    await expect(canvas).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const pixels = () => canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL());
    const clock = page.locator("#pm-time");
    const header = page.locator("#top-panel-trip-name");
    await expect(clock).toHaveText(/^\d\d:\d\d:\d\d$/);
    await expect(header).not.toBeEmpty();
    const originalClock = await clock.innerText();
    const originalHeader = await header.innerText();
    const originalPixels = await pixels();
    const position = await page.locator("#pm-coords").textContent();
    const speed = await page.locator("#pm-speed").textContent();
    const playhead = await page.evaluate(() => window.__everydashcam.dom.player.currentTime);

    await page.locator("#settings-btn").click();
    const input = page.locator("#settings-clock-correction");
    await expect(input).toHaveValue("0");
    const label = await page.locator('[data-i18n="settings.playback.clockCorrection.label"]').innerText();
    expect(await clock.getAttribute("title")).toContain(label);
    await expect(page.locator("#settings-clock-correction-example")).toContainText("10:26:34");

    const base = Date.parse(`2000-01-01T${originalClock}Z`);
    const overlayByMinutes = new Map<number, string>();
    for (const minutes of [30, -30, 0, 30]) {
        await input.fill(String(minutes));
        await input.press("Tab");
        const expected = new Date(base + minutes * 60_000).toISOString().slice(11, 19);
        await expect(clock).toHaveText(expected);
        // The header formats the same camera clock to the minute.
        if (minutes === 0) await expect(header).toHaveText(originalHeader);
        else await expect(header).not.toHaveText(originalHeader);
        await expect(page.locator("#pm-coords")).toHaveText(position!);
        await expect(page.locator("#pm-speed")).toHaveText(speed!);
        expect(await page.evaluate(() => window.__everydashcam.dom.player.currentTime)).toBe(playhead);
        const overlay = await pixels();
        expect(overlay === originalPixels, "clock overlay updates on the paused frame").toBe(minutes === 0);
        overlayByMinutes.set(minutes, overlay);
    }
    expect(overlayByMinutes.get(30) === overlayByMinutes.get(-30), "opposite corrections draw different clocks").toBe(
        false,
    );

    // The field reads what the hint tells the user to type, in every engine.
    const typeCorrection = async (text: string): Promise<void> => {
        await input.fill("");
        await input.pressSequentially(text);
        await input.press("Tab");
    };
    await typeCorrection("+45");
    await expect(input, "a leading plus is a positive correction").toHaveValue("45");
    await typeCorrection("1500");
    await expect(input, "an out-of-range value clamps to the limit").toHaveValue("1440");
    await typeCorrection("");
    await expect(input, "a cleared field removes the correction").toHaveValue("0");
    await expect(clock).toHaveText(originalClock);
    await input.evaluate((element) => {
        const text = "\u221230";
        const clipboardData = new DataTransfer();
        clipboardData.setData("text", text);
        // Firefox builds a synthetic paste from its own `data`/`dataType`
        // members and ignores `clipboardData`; other engines do the reverse.
        const init: ClipboardEventInit & { data: string; dataType: string } = {
            clipboardData,
            data: text,
            dataType: "text/plain",
            bubbles: true,
            cancelable: true,
        };
        element.dispatchEvent(new ClipboardEvent("paste", init));
    });
    await expect(input, "a pasted typographic minus keeps its sign").toHaveValue("-30");
    await expect(clock).toHaveText(new Date(base - 30 * 60_000).toISOString().slice(11, 19));
    await typeCorrection("30");

    await page.reload();
    await page.locator("#settings-btn").click();
    await expect(input).toHaveValue("30");
}
