import type { EncoderProbeConfig, EncoderProbeResult } from "../transcode/encoder-probe-result.js";
import type { WorkerContract, WorkerRequest } from "./_protocol/worker-contract.js";

export type EncoderProbeWorkerContract = WorkerContract<
    { probe: WorkerRequest<EncoderProbeConfig, EncoderProbeResult> },
    Record<never, never>,
    Record<never, never>,
    Record<never, never>
>;
