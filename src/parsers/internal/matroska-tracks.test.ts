import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readMatroskaFirstAudioTrack } from "./matroska-tracks.js";

const IMA_ADPCM_MKV = "../../../tests/testdata/audio-export/__fixtures__/ima-adpcm/20260101_120000.mkv";
const H264_MP4 = "../../../tests/testdata/70mai-multichannel/Normal/Front/NO20260101-120000-000001F.MP4";

function fixtureBytes(path: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(readFileSync(new URL(path, import.meta.url)));
}

describe("readMatroskaFirstAudioTrack", () => {
    it("reads the codec ID and WAVE header of an ACM audio track", async () => {
        const header = await readMatroskaFirstAudioTrack(new Blob([fixtureBytes(IMA_ADPCM_MKV)]));
        expect(header?.codecId).toBe("A_MS/ACM");
        const waveFormat = header!.codecPrivate!;
        expect(waveFormat.byteLength, "WAVEFORMATEX with the IMA extension").toBe(20);
        expect(waveFormat[0]! | (waveFormat[1]! << 8), "wFormatTag").toBe(0x0011);
        expect(waveFormat[2]! | (waveFormat[3]! << 8), "nChannels").toBe(1);
    });

    it("finds no track in a file that is not Matroska", async () => {
        expect(await readMatroskaFirstAudioTrack(new Blob([fixtureBytes(H264_MP4)]))).toBeNull();
    });

    it("finds no track in a header cut before its tracks", async () => {
        const bytes = fixtureBytes(IMA_ADPCM_MKV);
        expect(await readMatroskaFirstAudioTrack(new Blob([bytes.slice(0, 200)]))).toBeNull();
    });
});
