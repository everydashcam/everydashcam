void (async () => {
    let shell: HTMLElement | null = document.documentElement;
    const status = document.getElementById("dc-portable-status")!;
    const payload = document.getElementById("dc-portable-payload")!;
    const unsupported = status.dataset.unsupported!;
    const failed = status.dataset.failed!;

    function stopWatching(): void {
        removeEventListener("dc:ready", ready);
        removeEventListener("error", onError);
        removeEventListener("unhandledrejection", onRejection);
        removeEventListener("securitypolicyviolation", onPolicyViolation);
    }

    function fail(message: string, error: unknown): void {
        if (!shell) return;
        stopWatching();
        if (document.documentElement !== shell) document.documentElement.replaceWith(shell);
        shell.classList.remove("is-loading");
        shell.dataset.portableState = "error";
        // The application logger is not available when its bundle cannot start.
        shell.dataset.portableError = error instanceof Error ? error.message : String(error);
        status.textContent = message;
    }

    function ready(): void {
        stopWatching();
        document.documentElement.dataset.portableState = "ready";
        shell = null;
    }

    function onError(event: ErrorEvent): void {
        fail(failed, event.error ?? event.message);
    }

    function onRejection(event: PromiseRejectionEvent): void {
        fail(failed, event.reason);
    }

    function onPolicyViolation(event: SecurityPolicyViolationEvent): void {
        if (event.effectiveDirective === "script-src-elem") fail(failed, "portable script blocked by policy");
    }

    if (typeof DecompressionStream !== "function") {
        fail(unsupported, "gzip decompression is unavailable");
        return;
    }

    try {
        // Older browsers with gzip streams can still lack the native base64 decoder.
        const byteArray = Uint8Array as Uint8ArrayConstructor & {
            fromBase64?: (input: string) => Uint8Array<ArrayBuffer>;
        };
        const bytes =
            typeof byteArray.fromBase64 === "function"
                ? byteArray.fromBase64(payload.textContent!)
                : Uint8Array.from(atob(payload.textContent!), (character) => character.charCodeAt(0));
        payload.remove();
        payload.textContent = "";
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const html = await new Response(stream).text();
        const restored = new DOMParser().parseFromString(html, "text/html");
        const scripts = [...restored.querySelectorAll<HTMLScriptElement>("script")].filter(
            (script) => !script.type || script.type === "module",
        );
        if (
            restored.documentElement.dataset.edition !== "portable" ||
            !restored.getElementById("dc-i18n") ||
            scripts.length !== 2 ||
            scripts[0]!.type !== "" ||
            scripts[1]!.type !== "module" ||
            scripts.some((script) => script.hasAttribute("src"))
        ) {
            throw new Error("invalid portable document");
        }
        restored.documentElement.classList.add("is-loading");
        restored.documentElement.dataset.portableState = "loading";
        addEventListener("dc:ready", ready, { once: true });
        addEventListener("error", onError);
        addEventListener("unhandledrejection", onRejection);
        addEventListener("securitypolicyviolation", onPolicyViolation);
        document.documentElement.replaceWith(restored.documentElement);
        // Parsed scripts are inert. Recreate only the theme bootstrap and app;
        // the dictionary remains a data island. CSP still checks their hashes.
        for (const original of scripts) {
            const script = document.createElement("script");
            script.type = original.type;
            script.textContent = original.textContent;
            script.addEventListener("error", () => fail(failed, "portable script could not start"), { once: true });
            original.replaceWith(script);
        }
    } catch (error) {
        fail(failed, error);
    }
})();
