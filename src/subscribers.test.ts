import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, getLogBuffer } from "./log.js";
import { createSubscribers } from "./subscribers.js";

beforeEach(() => {
    _resetForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("application subscribers", () => {
    it("keeps other views updated and reports a repeated failure once per subscription", () => {
        const changes = createSubscribers<[number]>("test-frames");
        const failure = new Error("renderer unavailable");
        const broken = () => {
            throw failure;
        };
        const values: number[] = [];
        const unsubscribe = changes.subscribe(broken);
        changes.subscribe((value) => values.push(value));
        changes.emit(1);
        changes.emit(2);
        expect(values).toEqual([1, 2]);
        expect(getLogBuffer()).toHaveLength(1);
        expect(getLogBuffer()[0]).toMatchObject({
            ns: "subscribers:test-frames",
            level: "warn",
            msg: "subscriber failed",
        });
        unsubscribe();
        changes.subscribe(broken);
        changes.emit(3);
        expect(getLogBuffer()).toHaveLength(2);
    });

    it("registers before the immediate notification and isolates its failure", () => {
        const changes = createSubscribers<[string]>("test-connectivity");
        const values: string[] = [];
        const stop = changes.subscribe(
            (value) => {
                values.push(value);
                if (value === "initial") {
                    changes.emit("nested");
                    throw new Error("initial view failed");
                }
            },
            ["initial"],
        );
        changes.emit("updated");
        stop();
        changes.emit("unobserved");
        expect(values).toEqual(["initial", "nested", "updated"]);
    });

    it("preserves live subscription removal during notification and session disposal", () => {
        const changes = createSubscribers("test-removal");
        const seen: string[] = [];
        let stopSecond = () => {};
        changes.subscribe(() => {
            seen.push("first");
            stopSecond();
        });
        stopSecond = changes.subscribe(() => seen.push("second"));
        changes.emit();
        changes.clear();
        changes.emit();
        expect(seen).toEqual(["first"]);
    });

    it("keeps mutable preference copies independent for each observer", () => {
        const changes = createSubscribers<[{ value: number }]>("test-map");
        const source = { value: 3 };
        changes.subscribe((copy) => {
            copy.value = 99;
        });
        const seen: number[] = [];
        changes.subscribe((copy) => seen.push(copy.value));
        changes.emitWith(() => [{ ...source }]);
        expect(seen).toEqual([3]);
        expect(source.value).toBe(3);
    });
});
