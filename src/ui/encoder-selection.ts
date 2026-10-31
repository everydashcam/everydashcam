import type { EncoderProbeWorkerContract } from "../workers/encoder-probe-protocol.js";
import { createLogger } from "../log.js";
import type { EncoderProbeConfig, EncoderProbeResult } from "../transcode/encoder-probe-result.js";
import { createTypedWorkerClient, type TypedWorkerClient } from "../workers/_protocol/worker-client.js";

const log = createLogger("export:encoder-probe");
const PROBE_TIMEOUT_MS = 20_000;
const MAX_CACHED_CONFIGS = 16;
const cache = new Map<string, EncoderProbeResult>();

export async function selectAutoEncoder(config: EncoderProbeConfig, signal: AbortSignal): Promise<EncoderProbeResult> {
    signal.throwIfAborted();
    const key = JSON.stringify(config);
    const cached = cache.get(key);
    if (cached) return cached;
    let client: TypedWorkerClient<EncoderProbeWorkerContract> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let result: EncoderProbeResult;
    try {
        const worker = new Worker(new URL("../workers/encoder-probe-worker.ts", import.meta.url), {
            type: "module",
            name: "encoder-probe-worker",
        });
        client = createTypedWorkerClient<EncoderProbeWorkerContract>(worker, { name: "encoder-probe" });
        timeout = setTimeout(() => {
            timedOut = true;
            client?.dispose("encoder probe timed out");
        }, PROBE_TIMEOUT_MS);
        result = await client.request("probe", config, { signal });
        log.info("encoder trial measured", { ...config, ...result });
    } catch (err) {
        signal.throwIfAborted();
        // Worker disposal also uses AbortError; a deadline is not a user cancellation.
        if (!timedOut && err instanceof Error && err.name === "AbortError") throw err;
        log.warn("encoder trial unavailable", { err: err instanceof Error ? err.message : String(err), ...config });
        result = {
            hardwareAcceleration: "no-preference",
            reason: "inconclusive",
            standard: null,
            software: null,
            response: null,
        };
    } finally {
        clearTimeout(timeout);
        client?.dispose();
    }
    signal.throwIfAborted();
    if (cache.size >= MAX_CACHED_CONFIGS) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
}

export function _resetForTests(): void {
    cache.clear();
}
