import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Trip } from "../trips.js";
import {
    nextTripForPreview,
    observeTripPreviewHost,
    pickNextPreview,
    resetTripPreviewHosts,
    setTripPreviewDisplayOrder,
    unobserveTripPreviewHost,
} from "./trip-preview-order.js";

/** Drains the picker the way the preview pass does: each pick is taken once. */
function drain(order: string[], visible: Set<string>, fallback: string[], done: Set<string> = new Set()): string[] {
    const taken = new Set(done);
    const picks: string[] = [];
    for (;;) {
        const next = pickNextPreview(order, visible, (item) => !taken.has(item), fallback);
        if (next === null) return picks;
        taken.add(next);
        picks.push(next);
    }
}

describe("preview order", () => {
    it("builds the visible cards first, then continues down the list from them and wraps to the top", () => {
        const order = ["a", "b", "c", "d", "e", "f"];
        expect(drain(order, new Set(["d", "c"]), [])).toEqual(["c", "d", "e", "f", "a", "b"]);
    });

    it("follows the list order from the top when nothing is visible", () => {
        expect(drain(["new", "mid", "old"], new Set(), [])).toEqual(["new", "mid", "old"]);
    });

    it("leaves trips the list does not show for last, in fallback order", () => {
        expect(drain(["b", "a"], new Set(["a"]), ["hidden-new", "b", "hidden-old"])).toEqual([
            "a",
            "b",
            "hidden-new",
            "hidden-old",
        ]);
    });

    it("skips trips that already have a preview or failed", () => {
        expect(drain(["a", "b", "c"], new Set(["b"]), [], new Set(["b", "c"]))).toEqual(["a"]);
    });
});

describe("preview host visibility", () => {
    // The node test environment has no IntersectionObserver; this one hands
    // the test the callback so it reports entries the way the browser does.
    let reportEntries: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void = () => {};
    beforeAll(() => {
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
                    reportEntries = (entries) => callback(entries as IntersectionObserverEntry[]);
                }
                observe(): void {}
                unobserve(): void {}
                disconnect(): void {}
            },
        );
    });
    afterAll(() => {
        vi.unstubAllGlobals();
    });

    // Hosts and trips only serve as identities here.
    const newHost = (): Element => ({}) as Element;
    const newTrip = (): Trip => ({}) as Trip;

    /** A collapsed parking run at the top: its stack is on screen, the first
     *  trip's own card is hidden inside, then an ordinary card follows. */
    function renderCollapsedRunAboveCard(): { runTrip: Trip; cardTrip: Trip; stack: Element; hiddenCard: Element } {
        resetTripPreviewHosts();
        const runTrip = newTrip();
        const cardTrip = newTrip();
        const stack = newHost();
        const hiddenCard = newHost();
        const card = newHost();
        setTripPreviewDisplayOrder([runTrip, cardTrip]);
        observeTripPreviewHost(stack, runTrip);
        observeTripPreviewHost(hiddenCard, runTrip);
        observeTripPreviewHost(card, cardTrip);
        reportEntries([
            { target: stack, isIntersecting: true },
            { target: hiddenCard, isIntersecting: false },
            { target: card, isIntersecting: true },
        ]);
        return { runTrip, cardTrip, stack, hiddenCard };
    }

    it("keeps a trip visible while its hidden card reports, if its run stack is on screen", () => {
        const { runTrip } = renderCollapsedRunAboveCard();
        expect(nextTripForPreview(() => true, [])).toBe(runTrip);
    });

    it("drops a trip from the visible ones once its last host leaves the view", () => {
        const { cardTrip, stack } = renderCollapsedRunAboveCard();
        reportEntries([{ target: stack, isIntersecting: false }]);
        expect(nextTripForPreview(() => true, [])).toBe(cardTrip);
    });

    it("keeps a trip visible when its hidden card is replaced", () => {
        const { runTrip, hiddenCard } = renderCollapsedRunAboveCard();
        unobserveTripPreviewHost(hiddenCard);
        expect(nextTripForPreview(() => true, [])).toBe(runTrip);
    });
});
