import { DESKTOP, SAMPLE_70MAI, expect, gotoApp, loadTrip, presetLocalStorage, test } from "./_fixtures.js";

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    await loadTrip(page, SAMPLE_70MAI);
    const video = page.locator(".video-tile.active video:not(.preload-slot)");
    await video.evaluate((el: HTMLVideoElement) => el.pause());
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.seeking && el.readyState >= 2)).toBe(true);
});

test("unchanged playback samples preserve readout and progress text", async ({ page }, testInfo) => {
    const result = await page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>(".video-tile.active video:not(.preload-slot)");
        const speed = document.getElementById("pm-speed");
        const coords = document.getElementById("pm-coords");
        const clock = document.getElementById("pm-time");
        const distance = document.getElementById("pm-distance-value");
        const progress = document.getElementById("player-mini-progress");
        const unitsToggle = document.getElementById("pm-speed-toggle");
        if (!video || !speed || !coords || !clock || !distance || !progress || !unitsToggle) {
            throw new Error("playback readout unavailable");
        }
        video.dispatchEvent(new Event("timeupdate"));
        const observer = new MutationObserver(() => {});
        for (const el of [speed, coords, clock, distance]) {
            observer.observe(el, { childList: true, characterData: true, subtree: true });
        }
        observer.observe(progress, { attributes: true, attributeFilter: ["aria-valuetext"] });
        const before = speed.textContent;
        for (let index = 0; index < 50; index++) video.dispatchEvent(new Event("timeupdate"));
        const repeatedWrites = observer.takeRecords().length;
        unitsToggle.click();
        const unitChangeWrites = observer.takeRecords().length;
        observer.disconnect();
        return { repeatedWrites, unitChangeWrites, before, after: speed.textContent };
    });
    expect(result.repeatedWrites, "unchanged samples do not replace text nodes or accessibility text").toBe(0);
    expect(result.unitChangeWrites, "unit changes invalidate the cached readout").toBeGreaterThan(0);
    expect(result.after).not.toBe(result.before);
    await testInfo.attach("readout-work", { body: JSON.stringify(result), contentType: "application/json" });
});

test("in-place GPS corrections refresh readouts and then stay idle", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { state, dom } = window.__everydashcam;
        const video = dom.player;
        const trip = state.active && state.trips[state.active.trip];
        const record = trip?.records[0];
        const frame = state.active && trip?.frames[state.active.frame];
        if (!record || !frame || !record.active || Math.abs(record.unixSeconds - frame.startUtc) > 0.01) {
            throw new Error("initial GPS sample unavailable");
        }
        if (video.currentTime !== 0) {
            const seeked = new Promise<void>((resolve) =>
                video.addEventListener("seeked", () => resolve(), { once: true }),
            );
            video.currentTime = 0;
            await seeked;
        }
        const refresh = (): void => {
            video.dispatchEvent(new Event("timeupdate"));
        };
        refresh();
        const before = {
            clock: dom.metrics.time.textContent,
            speed: dom.metrics.speed.textContent,
            coords: dom.metrics.coords.textContent,
        };
        const original = { ...record };
        const observer = new MutationObserver(() => {});
        for (const el of [dom.metrics.time, dom.metrics.speed, dom.metrics.coords, dom.metrics.distance]) {
            observer.observe(el, { childList: true, characterData: true, subtree: true });
        }
        try {
            // Keep this same sample nearer than the next 1 Hz record at t=0.
            // Progressive metadata can correct the object without replacing it.
            record.unixSeconds -= 0.75;
            refresh();
            const correctedClock = dom.metrics.time.textContent;
            record.speedMs += 1;
            refresh();
            const correctedSpeed = dom.metrics.speed.textContent;
            record.lat += 0.001;
            refresh();
            const correctedLat = dom.metrics.coords.textContent;
            record.lon += 0.001;
            refresh();
            const correctedLon = dom.metrics.coords.textContent;
            record.active = false;
            refresh();
            const lostFix = dom.metrics.readout.classList.contains("is-nofix");
            const lostSpeed = dom.metrics.speed.textContent;
            record.active = true;
            refresh();
            const restoredFix = !dom.metrics.readout.classList.contains("is-nofix");
            observer.takeRecords();
            for (let index = 0; index < 50; index++) refresh();
            return {
                before,
                correctedClock,
                correctedSpeed,
                correctedLat,
                correctedLon,
                lostFix,
                lostSpeed,
                restoredFix,
                repeatedWrites: observer.takeRecords().length,
            };
        } finally {
            observer.disconnect();
            Object.assign(record, original);
            refresh();
        }
    });
    expect(result.correctedClock, "a timestamp correction on the same GPS object updates its clock").not.toBe(
        result.before.clock,
    );
    expect(result.correctedSpeed).not.toBe(result.before.speed);
    expect(result.correctedLat).not.toBe(result.before.coords);
    expect(result.correctedLon).not.toBe(result.correctedLat);
    expect(result.lostFix).toBe(true);
    expect(result.lostSpeed).not.toBe(result.correctedSpeed);
    expect(result.restoredFix).toBe(true);
    expect(result.repeatedWrites, "corrected but unchanged samples preserve their text nodes").toBe(0);
});

test("paused map checks the playhead at idle cadence", async ({ page }, testInfo) => {
    const currentTimeReads = await page.evaluate(async () => {
        const video = document.querySelector<HTMLVideoElement>(".video-tile.active video:not(.preload-slot)");
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
        if (!video || !descriptor?.get || !descriptor.set) throw new Error("media clock unavailable");
        const read = descriptor.get;
        const write = descriptor.set;
        let reads = 0;
        Object.defineProperty(video, "currentTime", {
            configurable: true,
            get() {
                reads++;
                return read.call(video);
            },
            set(value: number) {
                write.call(video, value);
            },
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return reads;
        } finally {
            Reflect.deleteProperty(video, "currentTime");
        }
    });
    expect(currentTimeReads, "idle still observes the playhead for map-state changes").toBeGreaterThan(0);
    expect(currentTimeReads, "a paused mini-map does not poll at display refresh rate").toBeLessThanOrEqual(20);
    await testInfo.attach("idle-work", { body: JSON.stringify({ currentTimeReads }), contentType: "application/json" });
});

test("mini-map playback reuses its width and refreshes zoom after a paused resize", async ({ page }) => {
    await page.waitForFunction(() => window.__everydashcam.state.miniMapReady);
    const result = await page.evaluate(async () => {
        const { state, dom } = window.__everydashcam;
        const mini = state.miniMap;
        if (!mini || !state.miniMapMarker) throw new Error("mini-map unavailable");
        const player = dom.player;
        player.currentTime = 0;
        player.muted = true;
        await player.play();
        // Let the initial layout and map resize settle before counting reads.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const original = window.getComputedStyle;
        let widthReads = 0;
        window.getComputedStyle = (element, pseudo) => {
            if (element === dom.miniMap) widthReads++;
            return original.call(window, element, pseudo);
        };
        const start = player.currentTime;
        try {
            await new Promise((resolve) => setTimeout(resolve, 700));
        } finally {
            window.getComputedStyle = original;
            player.pause();
        }
        const advanced = player.currentTime - start;
        const beforeWidth = Number.parseFloat(getComputedStyle(dom.miniMap).width);
        const beforeZoom = mini.getZoom();
        dom.miniMap.style.width = `${beforeWidth * 1.5}px`;
        mini.resize();
        return { widthReads, advanced, beforeWidth, beforeZoom };
    });
    expect(result.advanced, "the width read budget covers moving playback").toBeGreaterThan(0.4);
    expect(result.widthReads, "moving the marker does not re-read the thumbnail's computed style").toBe(0);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const mini = window.__everydashcam.state.miniMap;
                if (!mini) throw new Error("mini-map unavailable");
                return mini.getZoom();
            }),
        )
        .toBeCloseTo(result.beforeZoom + Math.log2(1.5), 2);
});

test("Chase settles adaptive zoom while the camera keeps following playback", async ({ page }, testInfo) => {
    await page.locator("#mini-map").click();
    await expect(page.locator("body")).not.toHaveClass(/map-morphing/);
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.map?.getPitch() ?? 0)).toBeCloseTo(58, 1);
    await expect(page.locator("#map-chase-adaptive")).toHaveAttribute("aria-pressed", "true");

    const result = await page.evaluate(async () => {
        const { state, dom } = window.__everydashcam;
        const map = state.map;
        const trip = state.active && state.trips[state.active.trip];
        if (!map || !trip) throw new Error("Chase playback unavailable");
        const player = dom.player;
        const speeds = trip.records.map((record) => record.speedMs);
        const originalRate = player.playbackRate;
        const beforeZoom = map.getZoom();
        let zoomChanges = 0;
        let cameraMoves = 0;
        const transitionZooms: number[] = [];
        const onZoom = (): void => {
            zoomChanges++;
            transitionZooms.push(map.getZoom());
        };
        const onMove = (): void => {
            cameraMoves++;
        };
        map.on("zoom", onZoom);
        map.on("move", onMove);
        try {
            if (player.currentTime !== 0) {
                const seeked = new Promise<void>((resolve) =>
                    player.addEventListener("seeked", () => resolve(), { once: true }),
                );
                player.currentTime = 0;
                await seeked;
            }
            for (const record of trip.records) record.speedMs = 33;
            // Re-enable adaptive zoom to seed its speed filter at a steady cruise.
            dom.mapChaseAdaptive.click();
            dom.mapChaseAdaptive.click();
            // The short real fixture keeps moving throughout zoom convergence.
            player.playbackRate = 0.25;
            player.muted = true;
            await player.play();
            const deadline = performance.now() + 5000;
            while (Math.abs(map.getZoom() - 15.4) >= 0.0005) {
                if (performance.now() > deadline) throw new Error("adaptive zoom did not approach cruise framing");
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
            const zoomWhileChanging = [...transitionZooms];
            zoomChanges = 0;
            cameraMoves = 0;
            const startTime = player.currentTime;
            const startCenter = map.getCenter();
            await new Promise((resolve) => setTimeout(resolve, 750));
            const endCenter = map.getCenter();
            return {
                beforeZoom,
                zoomWhileChanging,
                zoomChanges,
                cameraMoves,
                advanced: player.currentTime - startTime,
                centerShift: Math.hypot(endCenter.lat - startCenter.lat, endCenter.lng - startCenter.lng),
                finalZoom: map.getZoom(),
            };
        } finally {
            map.off("zoom", onZoom);
            map.off("move", onMove);
            player.pause();
            player.playbackRate = originalRate;
            trip.records.forEach((record, i) => {
                record.speedMs = speeds[i]!;
            });
        }
    });
    expect(result.beforeZoom - result.finalZoom, "cruising still widens the map view").toBeGreaterThan(0.5);
    expect(new Set(result.zoomWhileChanging).size, "adaptive zoom preserves its smooth transition").toBeGreaterThan(2);
    expect(result.advanced, "the player continues through the measurement").toBeGreaterThan(0.1);
    expect(result.cameraMoves, "following continues after zoom settles at quarter-speed video cadence").toBeGreaterThan(
        2,
    );
    expect(result.centerShift).toBeGreaterThan(0.000001);
    expect(result.finalZoom).toBeCloseTo(15.4, 10);
    expect(result.zoomChanges, "moving the camera does not restart settled zoom work").toBe(0);
    await testInfo.attach("chase-zoom-work", { body: JSON.stringify(result), contentType: "application/json" });
});
