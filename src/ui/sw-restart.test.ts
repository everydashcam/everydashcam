import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_MESSAGE, type UpdateResult } from "../sw-update-protocol.js";
import { _resetForTests, isRestartLocked } from "./restart-gate.js";
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

function setup() {
    const worker = new FakeWorker();
    const notes = deferred<boolean>();
    const answer = deferred<UpdateResult | null>();
    const options = {
        saveNotes: vi.fn(() => notes.promise),
        waitingWorker: vi.fn((): ObservedWorker | null => worker),
        reloadPage: vi.fn(),
        markIntentionalNavigation: vi.fn(),
        onUserRestartFailed: vi.fn(),
        sendActivationRequest: vi.fn(
            (_worker: Pick<ObservedWorker, "postMessage">, _timeoutMs: number) => answer.promise,
        ),
    };
    const controller = createRestartController(options);
    return { controller, options, notes, answer, worker };
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

        expect(options.sendActivationRequest).toHaveBeenCalledWith(worker, 10_000);
        expect(options.markIntentionalNavigation).toHaveBeenCalledTimes(1);
        expect(options.reloadPage).toHaveBeenCalledTimes(1);
        expect(options.onUserRestartFailed).not.toHaveBeenCalled();
    });

    it("reloads once the worker takes over", async () => {
        const { controller, options, notes, answer } = setup();
        const restart = controller.restart();
        notes.resolve(true);
        answer.resolve("updating");
        await restart;
        expect(options.reloadPage, "waits for the takeover").not.toHaveBeenCalled();

        controller.handleControllerChange();

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
        const { controller, options, notes } = setup();
        const restart = controller.restart();
        controller.handleControllerChange();
        notes.resolve(false);
        await restart;

        expect(options.reloadPage).toHaveBeenCalledTimes(1);
        expect(options.onUserRestartFailed).not.toHaveBeenCalled();
        expect(isRestartLocked(), "the reload still holds the lock").toBe(true);
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

        await expect(requestActivation(worker, 1000)).resolves.toBe("otherWindows");

        expect(worker.requests).toEqual([{ type: UPDATE_MESSAGE }]);
    });

    it("resolves null for an answer this release does not know", async () => {
        await expect(requestActivation(answeringWorker("later"), 1000)).resolves.toBeNull();
    });

    it("resolves null when the worker stays silent", async () => {
        await expect(requestActivation({ postMessage: () => {} }, 20)).resolves.toBeNull();
    });

    it("resolves null when the request cannot be sent", async () => {
        const worker = {
            postMessage: () => {
                throw new DOMException("worker is redundant", "InvalidStateError");
            },
        };

        await expect(requestActivation(worker, 1000)).resolves.toBeNull();
    });
});
