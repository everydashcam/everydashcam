// Synthetic card layouts for path-filter integration, not original camera trees.
import { cpSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_70MAI } from "./_fixtures.js";

/** Relocates the sample log to exercise the supported hidden telemetry path. */
export function write70maiHiddenGpsCard(directory: string): void {
    cpSync(SAMPLE_70MAI, directory, { recursive: true });
    mkdirSync(join(directory, ".GPS"));
    renameSync(join(directory, "GPSData000001.txt"), join(directory, ".GPS", "GPSData000001.txt"));
}
