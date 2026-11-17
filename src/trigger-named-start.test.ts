import { describe, expect, it } from "vitest";
import { classifyFilenameTime } from "./parsers/filename/index.js";
import { type DurationClip, estimateTriggerNamedStartOffsets } from "./trigger-named-start.js";

// Card file times from a U3000 PRO diagnostic report. Android reads the card's
// zone-less times as UTC, so these carry the camera's local wall clock.
const LOOP_CLOSES: [name: string, mtimeIso: string][] = [
    ["REC_20261115_165449_F.MP4", "2026-11-15T16:55:49Z"],
    ["REC_20261115_165449_R.MP4", "2026-11-15T16:55:49Z"],
    ["REC_20261115_165549_F.MP4", "2026-11-15T16:56:49Z"],
];
const PARKING_CLOSES: [name: string, mtimeIso: string][] = [
    ["PAK_20261116_104313_F.MP4", "2026-11-16T10:43:24Z"],
    ["PAK_20261116_104336_F.MP4", "2026-11-16T10:43:46Z"],
    ["PAK_20261116_104349_F.MP4", "2026-11-16T10:44:00Z"],
];

function clip(name: string, mtimeMs: number, durationSec: number, metadataReady?: boolean): DurationClip {
    const folder = name.startsWith("REC") ? "cont_rec" : name.startsWith("PAK") ? "parking_rec" : "incabin_rec";
    return {
        file: new File([], name, { lastModified: mtimeMs }),
        relativePath: `0000-0000/${folder}/${name}`,
        durationSec,
        ...(metadataReady === undefined ? {} : { metadataReady }),
    };
}

function card(shiftMs = 0): DurationClip[] {
    return [
        ...LOOP_CLOSES.map(([name, iso]) => clip(name, Date.parse(iso) + shiftMs, 60)),
        ...PARKING_CLOSES.map(([name, iso]) => clip(name, Date.parse(iso) + shiftMs, 20)),
    ];
}

const offsetsByName = (clips: DurationClip[]): Record<string, number> => {
    const offsets = estimateTriggerNamedStartOffsets(clips, classifyFilenameTime);
    return Object.fromEntries(clips.flatMap((c) => (offsets.has(c.file) ? [[c.file.name, offsets.get(c.file)!]] : [])));
};

describe("estimateTriggerNamedStartOffsets", () => {
    it("measures each parking clip's pre-event lead from the card's close times", () => {
        expect(offsetsByName(card())).toEqual({
            "PAK_20261116_104313_F.MP4": -9,
            "PAK_20261116_104336_F.MP4": -10,
            "PAK_20261116_104349_F.MP4": -9,
        });
    });

    it("ignores whole zone steps when the system reads card times as local time", () => {
        expect(offsetsByName(card(6 * 3600_000))).toEqual(offsetsByName(card()));
        expect(offsetsByName(card(-5.75 * 3600_000))).toEqual(offsetsByName(card()));
    });

    it("trusts no card times when the loop clips do not close one length after their names", () => {
        const copied = card().map((c, index) =>
            clip(c.file.name, Date.parse("2026-11-16T06:00:00Z") + index * 7_000, c.durationSec),
        );
        expect(offsetsByName(copied)).toEqual({});
    });

    it("needs loop clips from the same source to vouch for the card", () => {
        const parkingOnly = card().filter((c) => c.file.name.startsWith("PAK"));
        expect(offsetsByName(parkingOnly)).toEqual({});
        const otherSource = card().map((c) => (c.file.name.startsWith("PAK") ? { ...c, sourceKey: "other" } : c));
        expect(offsetsByName(otherSource)).toEqual({});
    });

    it("keeps the trigger time for a clip whose start falls outside the pre-event window", () => {
        const clips = card();
        const late = clips.findIndex((c) => c.file.name === "PAK_20261116_104336_F.MP4");
        clips[late] = clip("PAK_20261116_104336_F.MP4", Date.parse("2026-11-16T10:43:20Z"), 20);
        expect(Object.keys(offsetsByName(clips))).toEqual(["PAK_20261116_104313_F.MP4", "PAK_20261116_104349_F.MP4"]);
    });

    it("skips clips whose duration is still a provisional estimate", () => {
        const clips = card().map((c) =>
            c.file.name === "PAK_20261116_104313_F.MP4" ? clip(c.file.name, c.file.lastModified, 60, false) : c,
        );
        expect(offsetsByName(clips)).not.toHaveProperty("PAK_20261116_104313_F.MP4");
    });

    it("leaves the interior camera out: it stamps mtime when a clip opens", () => {
        const interior = clip("EXT_20261115_165455_I.MP4", Date.parse("2026-11-15T16:54:56Z"), 59.9994);
        expect(offsetsByName([...card(), interior])).not.toHaveProperty(interior.file.name);
    });
});
