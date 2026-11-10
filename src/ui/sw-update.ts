import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { activateModal, deactivateModal, isAnyModalOpen } from "./modal-helper.js";
import { markIntentionalNavigation } from "./nav-intent.js";
import { notify, type PinnedStatusInput, setPinnedStatus } from "./notifications.js";
import { canReloadWithoutAsking, isRestartLocked, subscribeRestartLock } from "./restart-gate.js";
import { createRestartController, type UserRestartFailure } from "./sw-restart.js";
import {
    createUpdateObserver,
    type ObservedRegistration,
    type ObservedWorker,
    type UpdateState,
} from "./sw-update-observer.js";

const UPDATE_STATUS_ID = "update";

const FAILURE_MESSAGES: Record<UserRestartFailure, I18nKey> = {
    notesNotSaved: "status.update.failed",
    otherWindows: "status.update.otherWindows",
    failed: "status.update.failed",
};

/**
 * The update status line for `state`, or null when it should be hidden. It
 * shows while the page runs an older release than the browser holds and no
 * restart holds the lock: during a restart the dialog speaks instead, and the
 * line returns if the restart stops. Its revision is the release serial, so
 * the dot lights once per new release.
 */
export function updateStatusLine(
    state: UpdateState,
    isRestartLocked: boolean,
    onAction: () => void,
): PinnedStatusInput | null {
    if (!state.isPageBehind || isRestartLocked) return null;
    return {
        severity: "info",
        messageKey: "status.update.pending",
        actionKey: "status.update.action",
        onAction,
        revision: state.updateSerial,
    };
}

/**
 * Owns the update status line, the restart dialogs and the wiring between the
 * update observer and the restart controller. A user restart starts only while
 * `isBusy` reports no work a restart would lose and no dialog is open, and only
 * after the user confirms. The non-dismissable "updating" dialog is shown for
 * exactly as long as the restart lock is held.
 * `loadController` is the worker that controlled the page when it loaded.
 * Returns the function that hands each registration from register() to the
 * update observer.
 */
export function initServiceWorkerUpdates(options: {
    container: ServiceWorkerContainer;
    loadController: ServiceWorker | null;
    isBusy: () => boolean;
    saveNotes: () => Promise<boolean>;
    /** Live work a reload without asking would destroy. */
    liveWork: () => { hasOpenTrips: boolean; isIngesting: boolean };
}): (registration: ObservedRegistration) => void {
    const { container } = options;
    let dialog: HTMLElement | null = null;

    const closeDialog = (): void => {
        if (!dialog) return;
        deactivateModal(dialog);
        dialog.remove();
        dialog = null;
    };

    // "confirm" asks the user. The other kinds report a restart in progress
    // and cannot be dismissed. The worker-change rule reloads only a page with
    // nothing open, so its dialog has no warning about reopening recordings.
    const showDialog = (kind: "confirm" | "userRestart" | "unaskedReload"): void => {
        const confirm = kind === "confirm";
        closeDialog();
        const root = document.createElement("div");
        root.id = "sw-update-modal";
        root.className = "export-modal modal-overlay";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-labelledby", "sw-update-title");
        if (kind !== "unaskedReload") root.setAttribute("aria-describedby", "sw-update-body");
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
        if (kind !== "unaskedReload") section.append(body);
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
                startUserRestart();
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

    // Answers to an explicit request. The pinned status line stays the way
    // back to the update, so these toasts keep their retry action out of the
    // drawer and repeated attempts do not stack buttons there.
    const announce = (messageKey: I18nKey): void => {
        notify({
            severity: "warn",
            messageKey,
            ...(messageKey === "status.update.busy" && { messageParams: { panel: t("export.title") } }),
            actionKey: "status.update.action",
            onAction: requestRestart,
        });
    };

    const requestRestart = (): void => {
        if (isRestartLocked()) return;
        if (isBusyNow()) announce("status.update.busy");
        else showDialog("confirm");
    };

    // Re-checked after confirmation: work may have started while the dialog was open.
    const startUserRestart = (): void => {
        if (isRestartLocked()) return;
        if (isBusyNow()) announce("status.update.busy");
        else void controller.restart();
    };

    let updateState: UpdateState = { waitingWorker: null, isPageBehind: false, updateSerial: 0 };
    // The line names the browser's own path out loud: closing the app applies
    // the update even when every restart attempt from this page fails.
    const syncStatusLine = (): void => {
        setPinnedStatus(UPDATE_STATUS_ID, updateStatusLine(updateState, isRestartLocked(), requestRestart));
    };

    const observer = createUpdateObserver({
        loadController: options.loadController,
        currentController: (): ObservedWorker | null => container.controller,
        page: { window, document, now: () => performance.now(), isOnline: () => navigator.onLine },
        onChange: (state) => {
            updateState = state;
            syncStatusLine();
        },
    });

    const controller = createRestartController({
        saveNotes: options.saveNotes,
        waitingWorker: () => observer.refresh().waitingWorker,
        loadController: options.loadController,
        currentController: () => container.controller,
        canReloadWithoutAsking: () => canReloadWithoutAsking({ ...options.liveWork(), isModalOpen: isAnyModalOpen() }),
        reloadPage: () => location.reload(),
        markIntentionalNavigation,
        onUserRestartFailed: (failure) => announce(FAILURE_MESSAGES[failure]),
    });

    // The dialog reflects the lock: it keeps new work from starting while
    // notes are saved and the worker takes over, and leaves with the lock.
    subscribeRestartLock((reason) => {
        if (reason) showDialog(reason === "user" ? "userRestart" : "unaskedReload");
        else closeDialog();
        syncStatusLine();
    });
    container.addEventListener("controllerchange", () => {
        controller.handleControllerChange();
        observer.refresh();
    });

    // An update installed by an earlier visit is already waiting now. Reading
    // it here, not after the deferred register(), shows it without delay.
    if (options.loadController) void observer.readAtLoad(() => container.getRegistration());
    return (registration) => observer.adopt(registration);
}
