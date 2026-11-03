import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BufferSource, EncodedPacketSink, Input, MATROSKA, MP4, QTFF } from "mediabunny";
import { expect, loadTrip, openExport, readInMemoryDownload } from "./_fixtures.js";

/** Runs against both the hosted app and the file-origin portable artifact. */
export async function checkAudioExport(
    page: Page,
    source: "aac-main" | "pcm-u8" | "opus",
    reencodeVideo = false,
    locale: "en" | "ru" = "en",
): Promise<void> {
    await loadTrip(page, resolve("tests/testdata/audio-export/__fixtures__", source));
    await openExport(page);
    await expect(page.locator("#export-panel-audio")).toBeChecked();
    if (reencodeVideo) await page.locator('input[name="export-panel-quality"][value="medium"]').check();
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 60_000 });
    if (source === "aac-main") {
        await expect(
            page
                .locator("#toast-container")
                .getByText(
                    locale === "ru"
                        ? "Фрагмент сохранён без звука — звук в этой записи не поддерживается"
                        : "Clip saved without sound — this recording’s audio isn’t supported",
                    { exact: true },
                ),
        ).toBeVisible();
    }
    await page.locator("#export-panel-done-summary button").click();
    const result = await readInMemoryDownload(page);
    expect(result).toMatchObject({ ftyp: true, moov: true, mdat: true, soun: source !== "aac-main" });

    if (source !== "aac-main") {
        const bytes = await page.evaluate(async () => {
            const blobs = (window as unknown as { __downloads: Blob[] }).__downloads;
            const blob = blobs.findLast((entry) => entry.type === "video/mp4")!;
            return Array.from(new Uint8Array(await blob.arrayBuffer()));
        });
        const output = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: [MP4] });
        const original = new Input({
            source: new BufferSource(
                readFileSync(
                    resolve(
                        "tests/testdata/audio-export/__fixtures__",
                        source,
                        source === "opus" ? "20260101_120000.mkv" : "20260101_120000.mov",
                    ),
                ),
            ),
            formats: source === "opus" ? [MATROSKA] : [QTFF],
        });
        try {
            if (source === "opus") expect(await (await original.getPrimaryAudioTrack())!.getCodec()).toBe("opus");
            const audio = (await output.getPrimaryAudioTrack())!;
            expect((await audio.getDecoderConfig())?.codec).toMatch(/^(mp4a\.40\.2|opus)$/);
            expect(await audio.computeDuration()).toBeGreaterThanOrEqual(1.99);
            const packetData = async (input: Input) => {
                const packets: Uint8Array[] = [];
                for await (const packet of new EncodedPacketSink((await input.getPrimaryVideoTrack())!).packets()) {
                    packets.push(packet.data);
                }
                return packets;
            };
            if (reencodeVideo) {
                expect(await packetData(output), "changing quality re-encodes the video").not.toEqual(
                    await packetData(original),
                );
            } else {
                expect(await packetData(output), "audio conversion preserves every encoded video packet").toEqual(
                    await packetData(original),
                );
            }
        } finally {
            output.dispose();
            original.dispose();
        }
        const decoded = await page.evaluate(async (data) => {
            const context = new AudioContext();
            try {
                const buffer = await context.decodeAudioData(new Uint8Array(data).buffer);
                const channel = buffer.getChannelData(0);
                return {
                    rate: buffer.sampleRate,
                    channels: buffer.numberOfChannels,
                    rms: Math.sqrt(channel.reduce((sum, value) => sum + value * value, 0) / channel.length),
                };
            } finally {
                await context.close();
            }
        }, bytes);
        expect(decoded.channels).toBe(2);
        expect(decoded.rms, "the converted soundtrack contains the source tone").toBeGreaterThan(0.05);
    }
}
