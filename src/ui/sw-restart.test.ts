import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_MESSAGE, type UpdateResult } from "../sw-update-protocol.js";
import { _resetForTests as resetLog, getLogBuffer } from "../log.js";
import {
    _resetForTests,
    claimImportGesture,
    isRestartLocked,
    type RestartReason,
    restartLockReason,
    tryLockRestart,
} from "./restart-gate.js";
import {
    createRestartController,
    NOTES_SAVE_TIMEOUT_MS,
    RELOAD_TIMEOUT_MS,
    requestActivation,
    TAKEOVER_TIMEOUT_MS,
} from "./sw-restart.js";
import type { ObservedWorker } from "./sw-update-observer.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

class FakeWorker extends EventTarget implements ObservedWorker {
    state: ServiceWorkerState = "installed";
    readonly postMessage = vi.fn();
}

/** A page that loaded under `loadWorker` (null: uncontrolled) with `worker` waiting. */
function setup(page: { isControlled?: boolean; canReloadWithoutAsking?: boolean } = {}) {
    const loadWorker = page.isControlled === false ? null : new FakeWorker();
    const worker = new FakeWorker();
    let controller: ObservedWorker | null = loadWorker;
    const notes = deferred<boolean>();
    const answer = deferred<UpdateResult | null>();
    const options = {
        saveNotes: vi.fn(() => notes.promise),
        waitingWorker: vi.fn((): ObservedWorker | null => worker),
        loadController: loadWorker,
        currentController: () => controller,
        canReloadWithoutAsking: vi.fn(() => page.canReloadWithoutAsking ?? true),
        reloadPage: vi.fn(),
        markIntentionalNavigation: vi.fn(),
        onUserRestartFailed: vi.fn(),
        sendActivationRequest: vi.fn(
            (_worker: Pick<ObservedWorker, "postMessage">, _reason: RestartReason, _timeoutMs: number) =>
                answer.promise,
        ),
    };
    const restartController = createRestartController(options);
    /** The waiting worker takes control and the browser reports it. */
    const takeOver = (): void => {
        controller = worker;
        restartController.handleControllerChange();
    };
    return { controller: restartController, options, notes, answer, worker, takeOver };
}

function warnings(): string[] {
    return getLogBuffer()
        .filter((record) => record.level === "warn")
        .map((record) => record.msg);
}

describe("user restart", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        _resetForTests();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("reloads as an intentional navigation when the worker stays silent", async () => {
        const { controller, options, notes, answer, worker } = setup();
        const restart = controller.restart();
        expect(isRestartLocked(), "lock taken synchronously").toBe(true);
        notes.resolve(true);
        answer.resolve(null);
        await restart;

        expect(options.sendActivationRequest).toHaveBeenCalledWith(worker, "user", 10_000);
        expect(options.markIntentionalNavigation).toHaveBeenCalledTimes(1);
        expect(options.reloadPage).toHaveBeenCalledTimes(1);
        expect(options.onUserRestartFailed).not.toHaveBeenCalled();
    });

    it("reloads once the worker takes over", async () => {
        const { controller, options, notes, answer, takeOver } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.resolve("updating");
        await restart;
        expect(options.reloadPage, "waits for the takeover").not.toHaveBeenCalled();

        takeOver();

        expect(options.reloadPage).toHaveBeenCalledTimes(1);
    });

    it("reloads after the takeover window when the browser never reports the takeover", async () => {
        const { controller, options, notes, answer } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.resolve("updating");
        await restart;

        await vi.advanceTimersByTimeAsync(TAKEOVER_TIMEOUT_MS - 1);
        expect(options.reloadPage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(options.reloadPage).toHaveBeenCalledTimes(1);
    });

    it("stops without reloading when another window is open", async () => {
        const { controller, options, notes, answer } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.resolve("otherWindows");
        await restart;

        expect(options.reloadPage).not.toHaveBeenCalled();
        expect(options.onUserRestartFailed).toHaveBeenCalledWith("otherWindows");
        expect(isRestartLocked()).toBe(false);
    });

    it("stops with a failure when the worker declines a user restart against the protocol", async () => {
        const { controller, options, notes, answer } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.resolve("declined");
        await restart;

        expect(options.reloadPage).not.toHaveBeenCalled();
        expect(options.onUserRestartFailed).toHaveBeenCalledWith("failed");
        expect(isRestartLocked()).toBe(false);
    });

    it("does not ask the worker when notes are not saved", async () => {
        const { controller, options, notes } = setup();
        const restart = controller.restart();
        notes.resolve(false);
        await restart;

        expect(options.sendActivationRequest).not.toHaveBeenCalled();
        expect(options.onUserRestartFailed).toHaveBeenCalledWith("notesNotSaved");
        expect(isRestartLocked()).toBe(false);
    });

    it("gives up on a notes save that never settles", async () => {
        const { controller, options } = setup();
        const restart = controller.restart();

        await vi.advanceTimersByTimeAsync(NOTES_SAVE_TIMEOUT_MS);
        await restart;

        expect(options.sendActivationRequest).not.toHaveBeenCalled();
        expect(options.onUserRestartFailed).toHaveBeenCalledWith("notesNotSaved");
        expect(isRestartLocked()).toBe(false);
    });

    it("reloads into the newest active release when no update waits", async () => {
        const { controller, options, notes } = setup();
        options.waitingWorker.mockReturnValue(null);
        const restart = controller.restart();
        notes.resolve(true);
        await restart;

        expect(options.sendActivationRequest).not.toHaveBeenCalled();
        expect(options.reloadPage).toHaveBeenCalledTimes(1);
    });

    it("releases the lock and reports a failure after an exception", async () => {
        const { controller, options, notes, answer } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.reject(new Error("message port closed"));
        await restart;

        expect(options.reloadPage).not.toHaveBeenCalled();
        expect(options.onUserRestartFailed).toHaveBeenCalledWith("failed");
        expect(isRestartLocked()).toBe(false);
    });

    it("releases the lock when the page survives its reload", async () => {
        const { controller, options, notes, answer } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.resolve(null);
        await restart;

        await vi.advanceTimersByTimeAsync(RELOAD_TIMEOUT_MS - 1);
        expect(isRestartLocked()).toBe(true);
        await vi.advanceTimersByTimeAsync(1);

        expect(isRestartLocked()).toBe(false);
        expect(options.reloadPage).toHaveBeenCalledTimes(1);
    });

    it("ignores a second request while one runs", async () => {
        const { controller, options, notes, answer } = setup();
        const first = controller.restart();
        const second = controller.restart();
        notes.resolve(true);
        answer.resolve(null);
        await Promise.all([first, second]);

        expect(options.saveNotes).toHaveBeenCalledTimes(1);
        expect(options.reloadPage).toHaveBeenCalledTimes(1);
    });

    it("keeps the reload of a takeover that arrived while notes were saved", async () => {
        const { controller, options, notes, takeOver } = setup();
        const restart = controller.restart();
        takeOver();
        notes.resolve(false);
        await restart;

        expect(options.reloadPage).toHaveBeenCalledTimes(1);
        expect(options.onUserRestartFailed).not.toHaveBeenCalled();
        expect(isRestartLocked(), "the reload still holds the lock").toBe(true);
    });
});

describe("worker change rule", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        _resetForTests();
        resetLog();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("ignores an event that leaves the load controller in place", () => {
        const { controller, options } = setup();

        controller.handleControllerChange();

        expect(options.reloadPage).not.toHaveBeenCalled();
        expect(options.canReloadWithoutAsking).not.toHaveBeenCalled();
    });

    it("reloads without asking after a late activation when nothing would be lost", () => {
        const { options, takeOver } = setup({ canReloadWithoutAsking: true });

        takeOver();

        expect(options.reloadPage).toHaveBeenCalledTimes(1);
        expect(restartLockReason(), "the reload holds the lock").toBe("auto");
        expect(options.markIntentionalNavigation, "the leave-page prompt stays armed").not.toHaveBeenCalled();
    });

    it("stays under the newer worker and warns when a reload would need asking", () => {
        const { options, takeOver } = setup({ canReloadWithoutAsking: false });

        takeOver();

        expect(options.reloadPage).not.toHaveBeenCalled();
        expect(isRestartLocked()).toBe(false);
        expect(warnings()).toEqual(["page stays under a newer worker"]);
    });

    it("reloads a page loaded without a controller when a restart is running", () => {
        const { options, takeOver } = setup({ isControlled: false });
        tryLockRestart("user");

        takeOver();

        expect(options.reloadPage).toHaveBeenCalledTimes(1);
        expect(options.markIntentionalNavigation).toHaveBeenCalledTimes(1);
    });

    it("leaves a first installation alone", () => {
        const { options, takeOver } = setup({ isControlled: false });

        takeOver();

        expect(options.reloadPage).not.toHaveBeenCalled();
        expect(options.canReloadWithoutAsking).not.toHaveBeenCalled();
        expect(warnings()).toEqual([]);
    });

    it("releases the lock when the page survives an unasked reload", async () => {
        const { takeOver } = setup({ canReloadWithoutAsking: true });
        takeOver();

        await vi.advanceTimersByTimeAsync(10_000);

        expect(isRestartLocked()).toBe(false);
        expect(claimImportGesture(), "imports work again").toBe(true);
    });
});

describe("activation request", () => {
    function answeringWorker(answer: unknown): Pick<ObservedWorker, "postMessage"> & { requests: unknown[] } {
        const requests: unknown[] = [];
        return {
            requests,
            postMessage: (message: unknown, transfer: Transferable[]) => {
                requests.push(message);
                const port = transfer[0] as MessagePort;
                port.postMessage(answer);
                port.close();
            },
        };
    }

    it("sends the update request and resolves the worker's answer", async () => {
        const worker = answeringWorker("otherWindows");

        await expect(requestActivation(worker, "auto", 1000)).resolves.toBe("otherWindows");

        expect(worker.requests).toEqual([{ type: UPDATE_MESSAGE, reason: "auto" }]);
    });

    it("resolves null for an answer this release does not know", async () => {
        await expect(requestActivation(answeringWorker("later"), "user", 1000)).resolves.toBeNull();
    });

    it("resolves null when the worker stays silent", async () => {
        await expect(requestActivation({ postMessage: () => {} }, "user", 20)).resolves.toBeNull();
    });

    it("resolves null when the request cannot be sent", async () => {
        const worker = {
            postMessage: () => {
                throw new DOMException("worker is redundant", "InvalidStateError");
            },
        };

        await expect(requestActivation(worker, "user", 1000)).resolves.toBeNull();
    });
});
