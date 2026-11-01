// Synthetic card layouts for path-filter integration, not original camera trees.
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_70MAI } from "./_fixtures.js";

/** Relocates the sample log to exercise the supported hidden telemetry path. */
export function write70maiHiddenGpsCard(directory: string): void {
    cpSync(SAMPLE_70MAI, directory, { recursive: true });
    mkdirSync(join(directory, ".GPS"));
    renameSync(join(directory, "GPSData000001.txt"), join(directory, ".GPS", "GPSData000001.txt"));
}

/**
 * Replaces the sample `$V02` log with the dated row grammar (same fixes) and
 * moves the second front clip to an event file. The dated log names clips
 * without their mode prefix, so both clips bind only through the name core.
 * Rear rows for the first recording repeat its front fixes, interleaved per
 * second: the per-channel join and the trip-level dedup both have to hold.
 */
export function write70maiDatedGpsCard(directory: string): void {
    cpSync(SAMPLE_70MAI, directory, { recursive: true });
    rmSync(join(directory, "GPSData000001.txt"));
    mkdirSync(join(directory, "Event", "Front"), { recursive: true });
    renameSync(
        join(directory, "Normal", "Front", "NO20260101-120002-000002F.MP4"),
        join(directory, "Event", "Front", "EV20260101-120002-000002F.MP4"),
    );
    mkdirSync(join(directory, ".GPS"));
    writeFileSync(
        join(directory, ".GPS", "GPSData000001.txt"),
        [
            "2026-01-01 12:00:00,B,A,050km/h,50.000000,30.000000,1,20260101-120000-000001F.MP4",
            "2026-01-01 12:00:00,B,A,050km/h,50.000000,30.000000,0,20260101-120000-000001B.MP4",
            "2026-01-01 12:00:01,B,A,050km/h,50.000100,30.000000,0,20260101-120000-000001F.MP4",
            "2026-01-01 12:00:01,B,A,050km/h,50.000100,30.000000,0,20260101-120000-000001B.MP4",
            "2026-01-01 12:00:02,B,A,050km/h,50.000200,30.000000,0,20260101-120000-000001F.MP4",
            "2026-01-01 12:00:02,B,A,050km/h,50.000200,30.000000,0,20260101-120000-000001B.MP4",
            "2000-00-00 00:00:00,B,V,000km/h,0.000000, 0.000000,0,000000000000000000000000000",
            "2026-01-01 12:00:02,N,A,050km/h,50.000200,30.000000,0,20260101-120002-000002F.MP4",
            "2026-01-01 12:00:03,B,A,050km/h,50.000300,30.000000,0,20260101-120002-000002F.MP4",
            "2026-01-01 12:00:04,B,A,050km/h,50.000400,30.000000,0,20260101-120002-000002F.MP4",
            "",
        ].join("\n"),
    );
}
