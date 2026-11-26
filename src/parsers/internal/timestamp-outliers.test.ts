import { describe, expect, it } from "vitest";
import type { GpsRecord, SkippedLine } from "../types.js";
import { dropIsolatedTimestampOutliers } from "./timestamp-outliers.js";

function rec(unixSeconds: number, extra: Partial<GpsRecord> = {}): GpsRecord {
    return {
        unixSeconds,
        active: true,
        lat: 44.9,
        lon: 9.66,
        bearingDeg: 10,
        speedMs: 15,
        accelXg: 0,
        accelYg: 0,
        accelZg: 0,
        mp4Filename: "clip.mp4",
        ...extra,
    };
}

function track1Hz(count: number, t0 = 1_795_619_660): GpsRecord[] {
    return Array.from({ length: count }, (_, i) => rec(t0 + i));
}

describe("dropIsolatedTimestampOutliers", () => {
    it("drops an isolated backward interior timestamp glitch and records a skipped line", () => {
        const records = track1Hz(60);
        // VIOFO A229 Plus pattern: HHMM truncated to 00:HH:MM (15 hours early).
        records[24] = rec(records[24]!.unixSeconds - 53_970);
        const skipped: SkippedLine[] = [];

        const kept = dropIsolatedTimestampOutliers(records, skipped, { durationSec: 60 });

        expect(kept).toHaveLength(59);
        expect(kept[0]!.unixSeconds).toBe(records[0]!.unixSeconds);
        expect(kept[kept.length - 1]!.unixSeconds).toBe(records[59]!.unixSeconds);
        expect(skipped).toEqual([
            {
                line: 25,
                raw: `<record 25, unix=${records[24]!.unixSeconds}>`,
                reason: "isolated timestamp outlier",
            },
        ]);
    });

    it("drops an isolated forward interior timestamp glitch", () => {
        const records = track1Hz(20);
        records[10] = rec(records[10]!.unixSeconds + 7200);
        const skipped: SkippedLine[] = [];

        const kept = dropIsolatedTimestampOutliers(records, skipped, { durationSec: 20 });

        expect(kept).toHaveLength(19);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]!.line).toBe(11);
    });

    it("drops a 2-record interior timestamp spike cluster", () => {
        const records = track1Hz(20);
        records[8] = rec(records[8]!.unixSeconds - 40_000);
        records[9] = rec(records[9]!.unixSeconds - 40_000);
        const skipped: SkippedLine[] = [];

        const kept = dropIsolatedTimestampOutliers(records, skipped, { durationSec: 20 });

        expect(kept).toHaveLength(18);
        expect(skipped.map((s) => s.line)).toEqual([9, 10]);
    });

    it("drops a leading backward or impossibly-early timestamp glitch", () => {
        const backward = track1Hz(10);
        backward[0] = rec(backward[1]!.unixSeconds + 3600);
        expect(dropIsolatedTimestampOutliers(backward, undefined, { durationSec: 60 })).toHaveLength(9);

        const early = track1Hz(10);
        early[0] = rec(early[1]!.unixSeconds - 54_000);
        expect(dropIsolatedTimestampOutliers(early, undefined, { durationSec: 60 })).toHaveLength(9);
    });

    it("drops a 2-record leading glitch prefix before a continuous track", () => {
        const records = track1Hz(10);
        records[0] = rec(records[2]!.unixSeconds - 54_000);
        records[1] = rec(records[2]!.unixSeconds - 53_999);

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });

        expect(kept).toHaveLength(8);
        expect(kept[0]!.unixSeconds).toBe(records[2]!.unixSeconds);
    });

    it("drops a trailing backward or impossibly-late timestamp glitch", () => {
        const backward = track1Hz(10);
        backward[9] = rec(backward[8]!.unixSeconds - 54_000);
        expect(dropIsolatedTimestampOutliers(backward, undefined, { durationSec: 60 })).toHaveLength(9);

        const late = track1Hz(10);
        late[9] = rec(late[8]!.unixSeconds + 54_000);
        expect(dropIsolatedTimestampOutliers(late, undefined, { durationSec: 60 })).toHaveLength(9);
    });

    it("preserves a genuine long tunnel gap inside a long clip", () => {
        const t0 = 1_795_619_660;
        // 1 fix at start, 10-minute tunnel inside a 20-minute clip, then 5 fixes.
        const records = [rec(t0), rec(t0 + 600), rec(t0 + 601), rec(t0 + 602), rec(t0 + 603), rec(t0 + 604)];

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 1200 });

        expect(kept).toHaveLength(6);
    });

    it("preserves a leading fix before a long tunnel when clip duration is unknown (e.g. MPEG-TS)", () => {
        const t0 = 1_795_619_660;
        const records = [rec(t0), rec(t0 + 600), rec(t0 + 601), rec(t0 + 602), rec(t0 + 603)];

        expect(dropIsolatedTimestampOutliers(records, undefined, { durationSec: null })).toHaveLength(5);
        expect(dropIsolatedTimestampOutliers(records)).toHaveLength(5);
    });

    it("keeps a valid record sandwiched between two identically glitched timestamps", () => {
        const t0 = 1_795_619_660;
        // Offsets [-54000, 1, -54000, 3, 4, 5, 6]: the two -54000 glitches have
        // dt=0 between them, but neither is corroborated by the real track.
        const records = [
            rec(t0 - 54_000),
            rec(t0 + 1),
            rec(t0 - 54_000),
            rec(t0 + 3),
            rec(t0 + 4),
            rec(t0 + 5),
            rec(t0 + 6),
        ];

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });

        expect(kept.map((r) => r.unixSeconds - t0)).toEqual([1, 3, 4, 5, 6]);
    });

    it("preserves a clean one-day midnight date slip at clip edges", () => {
        const records = track1Hz(10);
        // Leading record on previous UTC date (-86400s): handled by applyGpsDateSlipCorrections.
        records[0] = rec(records[0]!.unixSeconds - 86_400);
        expect(dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 })).toHaveLength(10);

        const trailing = track1Hz(10);
        trailing[9] = rec(trailing[9]!.unixSeconds - 86_400);
        expect(dropIsolatedTimestampOutliers(trailing, undefined, { durationSec: 60 })).toHaveLength(10);
    });

    it("preserves a clean one-day midnight date slip inside a clip for downstream date-slip repair", () => {
        const midnight = 1_795_564_800;
        const records = [-2, -1, -86_400, 1, 2].map((off) => rec(midnight + off));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept).toHaveLength(5);
        expect(kept.map((r) => r.unixSeconds - midnight)).toEqual([-2, -1, -86_400, 1, 2]);
    });

    it("preserves a midnight date slip after a 90 s GPS dropout while still dropping a 00:00:00 glitch at 23:30", () => {
        // 23:59:30 -> 90 s tunnel -> 00:01:00 stamped on the same date:
        // gap = -86400 + 90 = -86310 s (within trips.ts splitAtDateSlips 3600 s bound).
        const tAfterMidnight = 1_795_651_260;
        const backwardSlip = [
            rec(tAfterMidnight + 86_310),
            rec(tAfterMidnight),
            rec(tAfterMidnight + 1),
            rec(tAfterMidnight + 2),
        ];
        expect(dropIsolatedTimestampOutliers(backwardSlip, undefined, { durationSec: 60 })).toHaveLength(4);

        // Leading 00:00:00 glitch on a 23:30:00 clip: gap = +84600 s (< +86400 - 60).
        const leadingMidnightGlitch = [
            rec(tAfterMidnight - 84_600),
            rec(tAfterMidnight),
            rec(tAfterMidnight + 1),
            rec(tAfterMidnight + 2),
        ];
        const kept = dropIsolatedTimestampOutliers(leadingMidnightGlitch, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds)).toEqual([tAfterMidnight, tAfterMidnight + 1, tAfterMidnight + 2]);
    });

    it("does not let repeated stuck-clock 00:00:00 glitches corroborate each other to drop a valid fix", () => {
        // [00:00:00, 00:00:00, 15:00:02, 00:00:00, 15:00:04, 15:00:05]:
        // identical 00:00:00 stamps have zero time progression and must not
        // outvote 15:00:02; all three 00:00:00 glitches should be dropped.
        const midnight = 1_795_564_800;
        const records = [0, 0, 54_002, 0, 54_004, 54_005].map((off) => rec(midnight + off));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds - midnight)).toEqual([54_002, 54_004, 54_005]);
    });

    it("does not drop valid records in a 4-point clip bracketed by identical 00:00:00 stamps with no outer neighbors", () => {
        const midnight = 1_795_564_800;
        const records = [0, 54_001, 54_002, 0].map((off) => rec(midnight + off));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds - midnight)).toEqual([0, 54_001, 54_002, 0]);
    });

    it("does not treat a stuck-clock 00:00:00 run as an advancing confirmation run", () => {
        const midnight = 1_795_564_800;
        const records = [54_000, 54_001, 0, 0, 0].map((off) => rec(midnight + off));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds - midnight)).toEqual([54_000, 54_001, 0, 0, 0]);
    });

    it("drops a leading 00:00:00 glitch on a 10-minute clip when total span exceeds duration while keeping a real tunnel", () => {
        const midnight = 1_795_564_800;
        // 10-minute clip (00:08:00..00:18:00) with leading 00:00:00 glitch:
        // local gap is 481 s (< 720 s), but total span is 1079 s (> 600 + 120).
        const glitched = [rec(midnight), ...Array.from({ length: 599 }, (_, i) => rec(midnight + 481 + i))];
        const keptGlitched = dropIsolatedTimestampOutliers(glitched, undefined, { durationSec: 600 });
        expect(keptGlitched).toHaveLength(599);
        expect(keptGlitched[0]!.unixSeconds).toBe(midnight + 481);

        // Same 10-minute clip with a genuine 8-minute tunnel (00:08:00, then
        // 00:16:00..00:17:59): total span is 599 s (<= 600 + 120), kept intact.
        const tunnel = [rec(midnight + 480), ...Array.from({ length: 120 }, (_, i) => rec(midnight + 960 + i))];
        expect(dropIsolatedTimestampOutliers(tunnel, undefined, { durationSec: 600 })).toHaveLength(121);
    });

    it("does not inflate edge duration tolerance on 10 Hz integer-second streams (XBHT)", () => {
        const midnight = 1_795_564_800;
        // 1-minute clip at 10 Hz with truncated whole-second timestamps:
        // 1 leading glitch at 00:00:00, then 590 records spanning 00:10:01..00:10:59.
        const records: GpsRecord[] = [rec(midnight)];
        for (let s = 1; s <= 59; s++) {
            for (let sub = 0; sub < 10; sub++) records.push(rec(midnight + 600 + s));
        }

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept).toHaveLength(590);
        expect(kept[0]!.unixSeconds).toBe(midnight + 601);
    });

    it("converges in one call when dropping a large spike lowers the median step and reveals a smaller spike", () => {
        const t0 = 1_795_619_660;
        // Initial positive steps include +250 and +78 recovery jumps (median 20 s),
        // so pass 1 drops -250, lowering the median to 1 s, and pass 2 drops -76.
        const records = [0, -250, 0, 1, 2, -76, 2, 22].map((off) => rec(t0 + off));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds - t0)).toEqual([0, 0, 1, 2, 2, 22]);
        expect(dropIsolatedTimestampOutliers(kept, undefined, { durationSec: 60 })).toBe(kept);
    });

    it("evaluates clockGroupIds as single clock units so one bad 18-sample GPS5 block does not erase a valid 2-sample block", () => {
        const t0 = 1_795_619_660;
        const records: GpsRecord[] = [];
        const clockGroupIds: number[] = [];
        // Block 0: 2 valid sub-samples at t0.
        for (let i = 0; i < 2; i++) {
            records.push(rec(t0 + i / 18));
            clockGroupIds.push(0);
        }
        // Block 1: 18 sub-samples from one GPSU 1 hour early.
        for (let i = 0; i < 18; i++) {
            records.push(rec(t0 - 3600 + i / 18));
            clockGroupIds.push(1);
        }
        // Blocks 2..4: 18 sub-samples each at t0 + 1, t0 + 2, t0 + 3.
        for (let b = 1; b <= 3; b++) {
            for (let i = 0; i < 18; i++) {
                records.push(rec(t0 + b + i / 18));
                clockGroupIds.push(b + 1);
            }
        }

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60, clockGroupIds });
        expect(kept).toHaveLength(2 + 3 * 18);
        expect(kept[0]!.unixSeconds).toBe(t0);
        expect(kept.every((r) => r.unixSeconds >= t0)).toBe(true);
    });

    it("converges on cascading interior spikes [0, -3600, 2, -3600, 4, 5] in a single pass", () => {
        const t0 = 1_795_619_660;
        const records = [0, -3600, 2, -3600, 4, 5].map((off) => rec(t0 + off));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds - t0)).toEqual([0, 2, 4, 5]);
        // Second pass must be a no-op (idempotent).
        expect(dropIsolatedTimestampOutliers(kept, undefined, { durationSec: 60 })).toBe(kept);
    });

    it("converges linearly on a long chain of alternating interior spikes", () => {
        const t0 = 1_795_619_660;
        const pairs = 1000;
        const records: GpsRecord[] = [];
        for (let i = 0; i < pairs; i++) {
            records.push(rec(t0 + i * 2));
            records.push(rec(t0 - 3600));
        }
        records.push(rec(t0 + pairs * 2));
        records.push(rec(t0 + pairs * 2 + 1));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 3600 });
        expect(kept).toHaveLength(pairs + 2);
        expect(kept.every((r) => r.unixSeconds >= t0)).toBe(true);
    });

    it("preserves fractional cadence on 18 Hz GoPro tracks so a 10-minute trailing glitch is still dropped", () => {
        const t0 = 1_795_619_660;
        const records = Array.from({ length: 1080 }, (_, i) => rec(t0 + i / 18));
        records[records.length - 1] = rec(t0 + 660); // +10 min glitch on a 60 s clip

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept).toHaveLength(1079);
        expect(kept.at(-1)!.unixSeconds).toBeCloseTo(t0 + 1078 / 18, 6);
    });

    it("transplants peak accel from dropped clock outliers onto the nearest surviving synced record without mutating input", () => {
        const t0 = 1_795_619_660;
        const records = [
            rec(t0 - 50_000, { accelXg: 2.5, accelYg: 0, accelZg: 0 }), // leading glitch with impact
            rec(t0, { accelXg: 0.1, accelYg: 0, accelZg: 0 }),
            rec(t0 + 1, { accelXg: 0.1, accelYg: 0, accelZg: 0 }),
            rec(t0 - 40_000, { accelXg: 0, accelYg: 3.2, accelZg: 0 }), // interior glitch with bigger impact
            rec(t0 + 3, { accelXg: 0.2, accelYg: 0, accelZg: 0 }),
            rec(t0 + 4, { accelXg: 0.1, accelYg: 0, accelZg: 0 }),
        ];
        const snapshot = records.map((r) => ({ ...r }));

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });
        expect(kept.map((r) => r.unixSeconds - t0)).toEqual([0, 1, 3, 4]);
        // Leading spike's 2.5 g moves to nearest surviving neighbor (t0).
        expect(kept[0]!.accelXg).toBe(2.5);
        // Interior spike at index 3 ties between index 2 (t0+1) and index 4 (t0+3); earlier wins.
        expect(kept[1]!.accelYg).toBe(3.2);
        // Input records were never mutated in place.
        expect(records).toEqual(snapshot);
    });

    it("preserves smooth time-lapse cadences without false drops", () => {
        const t0 = 1_795_619_660;
        const records = Array.from({ length: 30 }, (_, i) => rec(t0 + i * 30));

        expect(dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 })).toHaveLength(30);
    });

    it("passes timeUnsynced records through untouched and checks synced neighbors across them", () => {
        const t0 = 1_795_619_660;
        const records = [
            rec(0, { timeUnsynced: true }),
            rec(t0),
            rec(t0 - 40_000), // isolated glitch
            rec(1, { timeUnsynced: true }),
            rec(t0 + 2),
            rec(t0 + 3),
        ];

        const kept = dropIsolatedTimestampOutliers(records, undefined, { durationSec: 60 });

        expect(kept).toHaveLength(5);
        expect(kept.filter((r) => r.timeUnsynced)).toHaveLength(2);
        expect(kept.some((r) => r.unixSeconds === t0 - 40_000)).toBe(false);
    });

    it("is idempotent and leaves short or clean streams untouched", () => {
        const short = track1Hz(2);
        short[1] = rec(short[0]!.unixSeconds - 50_000);
        expect(dropIsolatedTimestampOutliers(short)).toBe(short);

        const clean = track1Hz(20);
        expect(dropIsolatedTimestampOutliers(clean)).toBe(clean);

        const glitched = track1Hz(15);
        glitched[7] = rec(glitched[7]!.unixSeconds - 50_000);
        const skipped: SkippedLine[] = [];
        const firstPass = dropIsolatedTimestampOutliers(glitched, skipped, { durationSec: 60 });
        const secondPass = dropIsolatedTimestampOutliers(firstPass, skipped, { durationSec: 60 });
        expect(secondPass).toBe(firstPass);
        expect(skipped).toHaveLength(1);
    });
});
