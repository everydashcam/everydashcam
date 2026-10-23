import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { GeoJSONSource } from "maplibre-gl";
import { expect, loadTrip, pausePlayback, SAMPLE_NOGPS } from "./_fixtures.js";

export type ZeroCoordinate = "latitude" | "longitude";

const RECORDING_NAME = "NO20260101-120000-000001F.MP4";
const START_UTC = Date.UTC(2026, 0, 1, 12) / 1000;
const OFFSETS = [0, 0.5, 1, 1.25, 1.5, 2, 2.5];
const SPEEDS = [20, 0, 20, 0, 0, 20, 20];

function writeCard(directory: string, zeroCoordinate: ZeroCoordinate): number[][] {
    mkdirSync(directory, { recursive: true });
    copyFileSync(join(SAMPLE_NOGPS, "clip-no-gps.mp4"), join(directory, RECORDING_NAME));
    let fixIndex = 0;
    const coordinates = OFFSETS.map((offset) => {
        if (offset === 0.5 || offset === 1.25 || offset === 1.5) return [0, 0];
        const delta = fixIndex++ * 0.00001;
        return zeroCoordinate === "latitude" ? [20 + delta, 0] : [0, 50 + delta];
    });
    const rows = OFFSETS.map((offset, index) => {
        const [lon, lat] = coordinates[index]!;
        // The isolated missing fix carries an impact; losing its record or
        // moving its acceleration to a neighbor changes the event timestamp.
        const accelX = offset === 0.5 ? 100 : 0;
        const bearing = lat === 0 && lon === 0 ? 27000 : 9000;
        return `${START_UTC - 8 * 3600 + offset},A,${lat},${lon},${bearing},${SPEEDS[index]! * 100},${accelX},100,0,${RECORDING_NAME},0,0,0`;
    });
    writeFileSync(join(directory, "GPSData000001.txt"), `$V02\n${rows.join("\n")}\n`);
    return coordinates.filter(([lon, lat]) => lon !== 0 || lat !== 0);
}

/** Missing-fix sentinels pass through the real parser, merge and map on both editions. */
export async function checkZeroGps(page: Page, directory: string, zeroCoordinate: ZeroCoordinate): Promise<void> {
    const expectedCoordinates = writeCard(directory, zeroCoordinate);
    await loadTrip(page, directory);
    await pausePlayback(page);
    await expect(page.locator("#trip-analysis-status")).toBeHidden();

    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { map, miniMap } = window.__everydashcam.state;
                return Promise.all(
                    [map, miniMap].map(async (view) => {
                        const source = view?.getSource("trip-line") as GeoJSONSource | undefined;
                        if (!source) return null;
                        const data = await source.getData();
                        if (data.type !== "Feature" || data.geometry.type !== "LineString") return null;
                        return data.geometry.coordinates.map((point: number[]) =>
                            point.map((value) => Number(value.toFixed(8))),
                        );
                    }),
                );
            }),
        )
        .toEqual([expectedCoordinates, expectedCoordinates]);

    const overview = await page.evaluate(() => {
        const { map, startMarker, endMarker } = window.__everydashcam.state;
        const bounds = map!.getBounds();
        return {
            containsOrigin: bounds.contains([0, 0]),
            latitudeSpan: bounds.getNorth() - bounds.getSouth(),
            longitudeSpan: bounds.getEast() - bounds.getWest(),
            hasEventSource: Boolean(map!.getSource("trip-events")),
            endpoints: [startMarker!, endMarker!].map((marker) => {
                const { lng, lat } = marker.getLngLat();
                return [Number(lng.toFixed(8)), Number(lat.toFixed(8))];
            }),
        };
    });
    expect(overview.containsOrigin, "initial map bounds exclude the missing-signal location").toBe(false);
    expect(overview.latitudeSpan, "initial zoom covers the local route").toBeLessThan(1);
    expect(overview.longitudeSpan, "initial zoom covers the local route").toBeLessThan(1);
    expect(overview.endpoints).toEqual([expectedCoordinates[0], expectedCoordinates.at(-1)]);
    expect(overview.hasEventSource, "an impact without coordinates has no spatial pin").toBe(false);

    const telemetry = await page.evaluate(() => {
        const { state } = window.__everydashcam;
        const trip = state.trips[state.active!.trip]!;
        return {
            offsets: trip.records.map((record) => record.unixSeconds - trip.startUtc),
            speeds: trip.records.map((record) => record.speedMs),
            missingPositions: trip.records.filter((record) => record.lat === 0 && record.lon === 0).length,
            impactOffset: trip.events[0]?.unixSeconds === undefined ? null : trip.events[0].unixSeconds - trip.startUtc,
            impactAccel: trip.records[1]?.accelXg,
            inferredSegments: trip.inferredSegments,
            chartSpeeds: state.chart!.data.datasets[0]!.data,
            chartAccel: state.chart!.data.datasets[1]!.data,
        };
    });
    expect(telemetry.offsets, "all GPS and telemetry timestamps survive").toEqual(OFFSETS);
    expect(telemetry.speeds, "recorded speed survives missing positions").toEqual(SPEEDS);
    expect(telemetry.missingPositions).toBe(3);
    expect(telemetry.impactOffset, "the impact stays at its original missing-fix timestamp").toBe(0.5);
    expect(telemetry.impactAccel).toBeGreaterThan(0.8);
    expect(telemetry.inferredSegments, "missing GPS speeds and headings produce no inferred maneuvers").toEqual([]);
    expect(telemetry.chartSpeeds).toHaveLength(OFFSETS.length);
    for (const index of [1, 3, 4]) {
        expect(telemetry.chartSpeeds[index], "the speed chart has a gap where GPS reports no position").toMatchObject({
            x: OFFSETS[index],
            y: Number.NaN,
        });
    }
    expect(telemetry.chartAccel[1], "the independent accelerometer chart preserves the impact").toMatchObject({
        x: 0.5,
        y: expect.closeTo(6 / 7, 6),
    });

    for (const [time, hasFix] of [
        [0.5, false],
        [1, true],
        [1.5, false],
        [2, true],
    ] as const) {
        await page.evaluate((time) => {
            window.__everydashcam.dom.player.currentTime = time;
        }, time);
        await expect(page.locator("#mini-map .car-marker-wrap")).toHaveCSS("visibility", hasFix ? "visible" : "hidden");
        await expect(page.locator("#mini-map .map-no-gps")).toHaveJSProperty("hidden", hasFix);
    }
}
