import { type Page, expect } from "@playwright/test";

interface PixelRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PixelCheckpoint {
    name: string;
    time: number | "first" | "last";
}

/** Inspect saved MP4 pixels in normalized output regions. Captured exports stay
 *  in the browser; downloaded files can be supplied as a single base64 string. */
export async function expectExportedPixelsCovered(
    page: Page,
    regions: { inside: PixelRect; outside: PixelRect[] },
    checkpoints: PixelCheckpoint[],
    expectedDuration: number,
    base64?: string,
): Promise<void> {
    const result = await page.evaluate(
        async ({ regions, checkpoints, base64 }) => {
            const captured = (window as unknown as { __lastExportHandle?: { _buf: Uint8Array } }).__lastExportHandle;
            const bytes =
                base64 === undefined
                    ? new Uint8Array(captured?._buf ?? [])
                    : Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
            if (bytes.length === 0) throw new Error("no export bytes available");
            const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
            const video = document.createElement("video");
            video.muted = true;
            try {
                await new Promise<void>((resolve, reject) => {
                    video.onloadeddata = () => resolve();
                    video.onerror = () => reject(new Error("export decode failed"));
                    video.src = url;
                });
                if (video.videoWidth === 0 || !Number.isFinite(video.duration)) {
                    throw new Error("exported video has no dimensions or duration");
                }
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) throw new Error("canvas context unavailable");
                const mean = (rect: PixelRect): number => {
                    const x = Math.max(0, Math.round(rect.x * canvas.width));
                    const y = Math.max(0, Math.round(rect.y * canvas.height));
                    const width = Math.max(1, Math.min(canvas.width - x, Math.round(rect.w * canvas.width)));
                    const height = Math.max(1, Math.min(canvas.height - y, Math.round(rect.h * canvas.height)));
                    const pixels = context.getImageData(x, y, width, height).data;
                    let sum = 0;
                    for (let i = 0; i < pixels.length; i += 4) {
                        sum += 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
                    }
                    return sum / (pixels.length / 4);
                };
                const samples = [];
                for (const checkpoint of checkpoints) {
                    // Force a drawable image while staying inside the boundary
                    // frame of the 30fps fixture. Packet-derived times can also
                    // select precise presentation intervals explicitly.
                    const time =
                        checkpoint.time === "first"
                            ? 0.00001
                            : checkpoint.time === "last"
                              ? video.duration - 0.000001
                              : checkpoint.time;
                    if (time < 0 || time >= video.duration) throw new Error("checkpoint outside exported video");
                    await new Promise<void>((resolve, reject) => {
                        video.onseeked = () => resolve();
                        video.onerror = () => reject(new Error("export seek failed"));
                        video.currentTime = time;
                    });
                    context.drawImage(video, 0, 0);
                    samples.push({
                        name: checkpoint.name,
                        time: video.currentTime,
                        inside: mean(regions.inside),
                        outside: regions.outside.reduce((sum, rect) => sum + mean(rect), 0) / regions.outside.length,
                    });
                }
                return { samples, duration: video.duration };
            } finally {
                video.removeAttribute("src");
                video.load();
                URL.revokeObjectURL(url);
            }
        },
        { regions, checkpoints, base64 },
    );
    expect(
        Math.abs(result.duration - expectedDuration),
        "export duration matches the selected frame intervals",
    ).toBeLessThan(0.002);
    for (const sample of result.samples) {
        const detail = JSON.stringify(sample);
        expect(sample.inside, detail).toBeLessThan(16);
        expect(sample.outside - sample.inside, `zone must be darker than its surroundings: ${detail}`).toBeGreaterThan(
            24,
        );
    }
}
