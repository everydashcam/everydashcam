import { describe, expect, it } from "vitest";

import { buildProvisionalCandidate } from "./ingest-candidate.js";
import { requiresMseBackend } from "./player-video-src.js";

function candidate(name: string) {
    return buildProvisionalCandidate({
        file: { file: new File([new Uint8Array(0)], name), relativePath: `00000001--0000000000--4/${name}` },
        fingerprint: "openpilot|",
        startUtc: 0,
        startSource: "mtime",
        cameraTzSec: null,
        durationSec: 60,
        records: [],
        appliedExtractors: [],
    });
}

describe("requiresMseBackend", () => {
    it("routes raw HEVC streams through MSE, which plays their MP4 view", () => {
        expect(requiresMseBackend(candidate("fcamera.hevc"))).toBe(true);
        expect(requiresMseBackend(candidate("ECAMERA.HEVC"))).toBe(true);
    });

    it("leaves a plain MP4 on the native element", () => {
        expect(requiresMseBackend(candidate("clip.mp4"))).toBe(false);
    });
});
