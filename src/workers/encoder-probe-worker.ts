import type { EncoderProbeWorkerContract } from "./encoder-probe-protocol.js";
import { probeEncoder } from "../transcode/encoder-probe.js";
import { createTypedWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

declare const self: WorkerScopeEndpoint;

createTypedWorkerServer<EncoderProbeWorkerContract>(self, {
    onRequest: {
        probe: (config, ctx) => {
            if (typeof config !== "object" || config === null) throw new Error("invalid encoder probe request");
            const { width, height, frameRate, bitrate } = config;
            if (
                typeof width !== "number" ||
                typeof height !== "number" ||
                typeof frameRate !== "number" ||
                typeof bitrate !== "number" ||
                !Number.isInteger(width) ||
                !Number.isInteger(height) ||
                width < 2 ||
                height < 2 ||
                width % 2 ||
                height % 2 ||
                !Number.isFinite(frameRate) ||
                frameRate < 5 ||
                frameRate > 120 ||
                !Number.isFinite(bitrate) ||
                bitrate <= 0
            )
                throw new Error("invalid encoder probe configuration");
            return probeEncoder({ width, height, frameRate, bitrate }, ctx.signal);
        },
    },
});
