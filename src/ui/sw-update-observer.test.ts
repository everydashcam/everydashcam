import { describe, expect, it, vi } from "vitest";
import { createUpdateObserver, type ObservedWorker, type UpdateState } from "./sw-update-observer.js";

class FakeWorker extends EventTarget implements ObservedWorker {
    state: ServiceWorkerState;
    readonly postMessage = vi.fn();
    constructor(state: ServiceWorkerState) {
        super();
        this.state = state;
    }
    moveTo(state: ServiceWorkerState): void {
        this.state = state;
        this.dispatchEvent(new Event("statechange"));
    }
}

class FakeRegistration extends EventTarget {
    installing: FakeWorker | null = null;
    waiting: FakeWorker | null = null;
    active: FakeWorker | null = null;
    readonly update = vi.fn(async () => undefined);
}

class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
}

function setup(options: { loadController: FakeWorker | null }) {
    const changes: UpdateState[] = [];
    const page = { window: new EventTarget(), document: new FakeDocument() };
    let controller: FakeWorker | null = options.loadController;
    const observer = createUpdateObserver({
        loadController: options.loadController,
        currentController: () => controller,
        onChange: (state) => changes.push(state),
        page,
    });
    return {
        observer,
        changes,
        page,
        setController: (next: FakeWorker | null) => {
            controller = next;
        },
    };
}

/** Moves the installing worker into waiting, as the browser does on `installed`. */
function finishInstall(registration: FakeRegistration): FakeWorker {
    const worker = registration.installing!;
    registration.installing = null;
    registration.waiting = worker;
    worker.moveTo("installed");
    return worker;
}

describe("service worker update observer", () => {
    it("sees an installation that started before the registration was adopted", () => {
        const active = new FakeWorker("activated");
        const { observer, changes } = setup({ loadController: active });
        const registration = new FakeRegistration();
        registration.active = active;
        registration.installing = new FakeWorker("installing");
        observer.adopt(registration);
        expect(observer.refresh().waitingWorker).toBeNull();

        const waiting = finishInstall(registration);

        expect(changes.at(-1)).toEqual({ waitingWorker: waiting, isPageBehind: true, updateSerial: 1 });
    });

    it("follows an installation announced by updatefound", () => {
        const active = new FakeWorker("activated");
        const { observer } = setup({ loadController: active });
        const registration = new FakeRegistration();
        registration.active = active;
        observer.adopt(registration);

        registration.installing = new FakeWorker("installing");
        registration.dispatchEvent(new Event("updatefound"));
        const waiting = finishInstall(registration);

        expect(observer.refresh().waitingWorker).toBe(waiting);
    });

    it("does not treat a first installation as an update", () => {
        const { observer, changes } = setup({ loadController: null });
        const registration = new FakeRegistration();
        registration.waiting = new FakeWorker("installed");
        observer.adopt(registration);

        expect(observer.refresh()).toEqual({ waitingWorker: null, isPageBehind: false, updateSerial: 0 });
        expect(changes).toEqual([]);
    });

    it("reports an update that was already waiting at load", async () => {
        const active = new FakeWorker("activated");
        const { observer } = setup({ loadController: active });
        const registration = new FakeRegistration();
        registration.active = active;
        registration.waiting = new FakeWorker("installed");

        await expect(observer.readAtLoad(async () => registration)).resolves.toBe(true);
    });

    it("tells a later update apart from one waiting at load", async () => {
        const active = new FakeWorker("activated");
        const { observer, changes } = setup({ loadController: active });
        const registration = new FakeRegistration();
        registration.active = active;

        await expect(observer.readAtLoad(async () => registration)).resolves.toBe(false);
        registration.installing = new FakeWorker("installing");
        registration.dispatchEvent(new Event("updatefound"));
        finishInstall(registration);

        expect(changes.at(-1)?.waitingWorker).toBe(registration.waiting);
    });

    it("resolves false when the registration lookup fails", async () => {
        const { observer } = setup({ loadController: new FakeWorker("activated") });

        await expect(
            observer.readAtLoad(async () => {
                throw new Error("lookup failed");
            }),
        ).resolves.toBe(false);
    });

    it("re-reads the registration when the page returns from the back/forward cache", () => {
        const active = new FakeWorker("activated");
        const { observer, changes, page } = setup({ loadController: active });
        const registration = new FakeRegistration();
        registration.active = active;
        observer.adopt(registration);
        // The frozen page missed both installation events.
        registration.waiting = new FakeWorker("installed");

        page.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
        expect(changes).toEqual([]);
        page.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));

        expect(changes.at(-1)?.waitingWorker).toBe(registration.waiting);
    });

    it("re-reads the registration when the tab becomes visible", () => {
        const active = new FakeWorker("activated");
        const { observer, changes, page } = setup({ loadController: active });
        const registration = new FakeRegistration();
        registration.active = active;
        observer.adopt(registration);
        registration.waiting = new FakeWorker("installed");

        page.document.visibilityState = "hidden";
        page.document.dispatchEvent(new Event("visibilitychange"));
        expect(changes).toEqual([]);
        page.document.visibilityState = "visible";
        page.document.dispatchEvent(new Event("visibilitychange"));

        expect(changes.at(-1)?.waitingWorker).toBe(registration.waiting);
    });

    it("marks the page behind when another worker controls it without an event", () => {
        const loadWorker = new FakeWorker("activated");
        const { observer, setController } = setup({ loadController: loadWorker });
        const registration = new FakeRegistration();
        const newer = new FakeWorker("activated");
        registration.active = newer;
        observer.adopt(registration);
        setController(newer);

        expect(observer.refresh()).toEqual({ waitingWorker: null, isPageBehind: true, updateSerial: 1 });
    });

    it("does not mark a page loaded without a controller as behind after a takeover", () => {
        const { observer, setController } = setup({ loadController: null });
        const registration = new FakeRegistration();
        const first = new FakeWorker("activated");
        registration.active = first;
        observer.adopt(registration);
        setController(first);

        expect(observer.refresh().isPageBehind).toBe(false);
    });

    it("counts each release once, including after it takes over", () => {
        const loadWorker = new FakeWorker("activated");
        const { observer, setController } = setup({ loadController: loadWorker });
        const registration = new FakeRegistration();
        registration.active = loadWorker;
        observer.adopt(registration);

        const second = new FakeWorker("installed");
        registration.waiting = second;
        expect(observer.refresh().updateSerial, "second release waits").toBe(1);
        expect(observer.refresh().updateSerial, "same release re-read").toBe(1);

        const third = new FakeWorker("installed");
        registration.waiting = third;
        expect(observer.refresh().updateSerial, "third release replaces it").toBe(2);

        registration.waiting = null;
        registration.active = third;
        setController(third);
        expect(observer.refresh(), "third release took over").toEqual({
            waitingWorker: null,
            isPageBehind: true,
            updateSerial: 2,
        });
    });
});
