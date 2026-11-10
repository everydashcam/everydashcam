import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { createLogger } from "../log.js";
import { UPDATE_MESSAGE, isUpdateResult, type UpdateRequest, type UpdateResult } from "../sw-update-protocol.js";
import { activateModal, deactivateModal, isAnyModalOpen } from "./modal-helper.js";
import { markIntentionalNavigation } from "./nav-intent.js";
import { notify } from "./notifications.js";
import { createUpdateObserver, type ObservedRegistration, type ObservedWorker } from "./sw-update-observer.js";

const log = createLogger("sw-update");

// The restart dialog cannot be dismissed while notes are saved, so a write that
// never settles must not hold the window behind it.
const NOTES_SAVE_TIMEOUT_MS = 15_000;

/** Resolves false when notes are not confirmed saved within the limit. A late
 *  write keeps running; the window simply stays open. */
async function saveNotesWithin(saveNotes: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
            log.warn("notes save timed out", { timeoutMs });
            resolve(false);
        }, timeoutMs);
    });
    try {
        return await Promise.race([saveNotes(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Asks the waiting worker to take over. Resolves null when it does not answer
 *  in time or with a result this release does not know. */
function requestActivation(worker: ServiceWorker, timeoutMs = 10_000): Promise<UpdateResult | null> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const finish = (result: UpdateResult | null): void => {
            clearTimeout(timer);
            channel.port1.close();
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
            finish(isUpdateResult(event.data) ? event.data : null);
        };
        try {
            worker.postMessage({ type: UPDATE_MESSAGE } satisfies UpdateRequest, [channel.port2]);
        } catch {
            finish(null);
        }
    });
}

/**
 * Owns the update notification and the user-requested restart into a waiting
 * worker. The restart runs only while `isBusy` reports no work a restart would
 * lose and no dialog is open, only after `saveNotes` resolves true within
 * NOTES_SAVE_TIMEOUT_MS (notes reached durable storage), and only when the worker
 * reports no other open window of the site. Once notes are saved, any other
 * outcome ends in a reload: the user has accepted the restart, a reload loads
 * the newest active release, and an update that is still waiting announces
 * itself again.
 * `loadController` is the worker that controlled the page when it loaded.
 * Returns the function that hands each registration from register() to the
 * update observer.
 */
export function initServiceWorkerUpdates(options: {
    container: ServiceWorkerContainer;
    loadController: ServiceWorker | null;
    isBusy: () => boolean;
    saveNotes: () => Promise<boolean>;
}): (registration: ObservedRegistration) => void {
    const { container } = options;
    let isRestarting = false;
    let dialog: HTMLElement | null = null;

    const reload = (): void => {
        markIntentionalNavigation();
        location.reload();
    };
    // Reloading before the new worker controls this window could load the old
    // release again.
    container.addEventListener("controllerchange", () => {
        if (isRestarting) reload();
    });

    const closeDialog = (): void => {
        if (!dialog) return;
        deactivateModal(dialog);
        dialog.remove();
        dialog = null;
    };

    const showDialog = (confirm: boolean): void => {
        closeDialog();
        const root = document.createElement("div");
        root.id = "sw-update-modal";
        root.className = "export-modal modal-overlay";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-labelledby", "sw-update-title");
        root.setAttribute("aria-describedby", "sw-update-body");
        root.tabIndex = -1;
        const card = document.createElement("div");
        card.className = "export-modal-card modal-card";
        const title = document.createElement("div");
        title.id = "sw-update-title";
        title.className = "export-modal-title";
        title.textContent = t(confirm ? "status.update.confirm" : "status.update.restarting");
        const section = document.createElement("div");
        section.className = "export-modal-section";
        const body = document.createElement("p");
        body.id = "sw-update-body";
        body.className = "export-modal-body";
        body.textContent = t("status.update.body");
        section.append(body);
        let cancel: HTMLButtonElement | undefined;
        if (confirm) {
            const actions = document.createElement("div");
            actions.className = "export-modal-actions";
            cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "dc-btn dc-btn--ghost";
            cancel.textContent = t("status.update.cancel");
            cancel.addEventListener("click", closeDialog);
            const apply = document.createElement("button");
            apply.type = "button";
            apply.className = "dc-btn dc-btn--primary";
            apply.textContent = t("status.update.apply");
            apply.addEventListener("click", () => {
                closeDialog();
                void restart();
            });
            actions.append(cancel, apply);
            section.append(actions);
        }
        card.append(title, section);
        root.append(card);
        document.body.append(root);
        dialog = root;
        activateModal(root, {
            onClose: () => {
                if (confirm) closeDialog();
            },
            initialFocus: cancel ?? root,
        });
    };

    const isBusyNow = (): boolean => options.isBusy() || isAnyModalOpen();

    const announce = (messageKey: I18nKey = "status.update.ready"): void => {
        const isReady = messageKey === "status.update.ready";
        notify({
            severity: isReady ? "info" : "warn",
            messageKey,
            ...(messageKey === "status.update.busy" && { messageParams: { panel: t("export.title") } }),
            actionKey: "status.update.action",
            // The drawer keeps one way back to the update. Retry results stay
            // text-only there so repeated attempts do not stack buttons.
            actionInDrawer: isReady,
            onAction: () => {
                if (isRestarting) return;
                if (isBusyNow()) announce("status.update.busy");
                else showDialog(true);
            },
        });
    };

    const stop = (messageKey: I18nKey): void => {
        isRestarting = false;
        closeDialog();
        announce(messageKey);
    };

    const restart = async (): Promise<void> => {
        if (isRestarting) return;
        if (isBusyNow()) {
            announce("status.update.busy");
            return;
        }
        isRestarting = true;
        // The non-dismissable dialog keeps new work from starting while notes
        // are saved and the worker takes over.
        showDialog(false);
        try {
            if (!(await saveNotesWithin(options.saveNotes, NOTES_SAVE_TIMEOUT_MS))) {
                return stop("status.update.failed");
            }
            const worker = (await container.getRegistration())?.waiting;
            const result = worker ? await requestActivation(worker) : null;
            if (result === "otherWindows") return stop("status.update.otherWindows");
            if (result !== "updating") {
                log.warn("reloading without a worker answer", { hasWaitingWorker: Boolean(worker) });
                return reload();
            }
            // controllerchange normally reloads first; this only bounds a browser
            // that never reports the takeover.
            setTimeout(reload, 10_000);
        } catch (error) {
            log.warn("update failed", { error: error instanceof Error ? error.message : String(error) });
            stop("status.update.failed");
        }
    };

    let announcedSerial = 0;
    const observer = createUpdateObserver({
        loadController: options.loadController,
        currentController: (): ObservedWorker | null => container.controller,
        page: { window, document },
        onChange: (state) => {
            if (!state.waitingWorker || state.updateSerial === announcedSerial) return;
            announcedSerial = state.updateSerial;
            announce();
        },
    });
    // An update installed by an earlier visit is already waiting now. Reading
    // it here, not after the deferred register(), announces it without delay.
    if (options.loadController) void observer.readAtLoad(() => container.getRegistration());
    return (registration) => observer.adopt(registration);
}
