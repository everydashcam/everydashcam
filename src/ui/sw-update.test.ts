import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "./sw-update-observer.js";

// Sever the DOM-bound UI modules; the status-line decision is pure.
vi.mock("./notifications.js", () => ({ notify: vi.fn(), setPinnedStatus: vi.fn() }));
vi.mock("./modal-helper.js", () => ({ activateModal: vi.fn(), deactivateModal: vi.fn(), isAnyModalOpen: vi.fn() }));
vi.mock("../i18n/index.js", () => ({ t: (key: string) => key }));

const { updateStatusLine } = await import("./sw-update.js");

const BEHIND: UpdateState = { waitingWorker: null, isPageBehind: true, updateSerial: 2 };

describe("update status line", () => {
    it("shows while the page is behind, with the release serial as its revision", () => {
        const onAction = vi.fn();

        expect(updateStatusLine(BEHIND, false, onAction)).toEqual({
            severity: "info",
            messageKey: "status.update.pending",
            actionKey: "status.update.action",
            onAction,
            revision: 2,
        });
    });

    it("hides while a restart holds the lock and returns once it is released", () => {
        expect(updateStatusLine(BEHIND, true, vi.fn()), "restart running").toBeNull();
        expect(updateStatusLine(BEHIND, false, vi.fn()), "restart stopped").not.toBeNull();
    });

    it("hides when the page runs the newest release", () => {
        expect(updateStatusLine({ ...BEHIND, isPageBehind: false }, false, vi.fn())).toBeNull();
    });
});
