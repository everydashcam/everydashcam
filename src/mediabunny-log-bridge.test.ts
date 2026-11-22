import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests, getLogBuffer, type Logger, type LogLevel } from "./log.js";
import { createMediabunnyLogForwarder } from "./mediabunny-log-bridge.js";
import {
    BufferTarget,
    EncodedVideoPacketSource,
    Logging,
    LogLevel as MediabunnyLogLevel,
    Mp4OutputFormat,
    Output,
} from "./mediabunny.js";
import { IMA_ADPCM_SAMPLE_ENTRY } from "./parsers/internal/mp4-walker.js";

interface LoggedCall {
    level: LogLevel;
    message: string;
    payload: unknown;
}

function createRecordingLogger(): { logger: Logger; calls: LoggedCall[] } {
    const calls: LoggedCall[] = [];
    const record =
        (level: LogLevel) =>
        (message: string, payload?: unknown): void => {
            calls.push({ level, message, payload });
        };
    const logger: Logger = {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        child: () => logger,
    };
    return { logger, calls };
}

describe("createMediabunnyLogForwarder", () => {
    it("logs a warning once with its message", () => {
        const { logger, calls } = createRecordingLogger();
        const forward = createMediabunnyLogForwarder(logger);
        forward("warn", ["Unsupported edit list entry: media rate must be 1."]);
        expect(calls).toEqual([
            { level: "warn", message: "Unsupported edit list entry: media rate must be 1.", payload: undefined },
        ]);
    });

    it("keeps the error object of an error event for its stack", () => {
        const { logger, calls } = createRecordingLogger();
        const forward = createMediabunnyLogForwarder(logger);
        const cause = new RangeError("bad sps");
        forward("error", ["Error parsing AVC SPS:", cause]);
        expect(calls).toEqual([{ level: "error", message: "Error parsing AVC SPS:", payload: cause }]);
    });

    it("reports repeats only at powers of ten with their count", () => {
        const { logger, calls } = createRecordingLogger();
        const forward = createMediabunnyLogForwarder(logger);
        for (let i = 0; i < 150; i++) forward("error", ["Error parsing HEVC SPS:", new Error("truncated")]);
        expect(calls.map((call) => (call.payload instanceof Error ? "error" : call.payload))).toEqual([
            "error",
            { repeated: 10 },
            { repeated: 100 },
        ]);
    });

    it("counts each distinct message on its own", () => {
        const { logger, calls } = createRecordingLogger();
        const forward = createMediabunnyLogForwarder(logger);
        forward("warn", ["first"]);
        forward("warn", ["second"]);
        forward("error", ["first"]);
        expect(calls.map((call) => `${call.level}:${call.message}`)).toEqual([
            "warn:first",
            "warn:second",
            "error:first",
        ]);
    });

    it("demotes the expected IMA ADPCM codec warning and info messages to debug", () => {
        const { logger, calls } = createRecordingLogger();
        const forward = createMediabunnyLogForwarder(logger);
        forward("warn", [`Unsupported audio codec (sample entry type '${IMA_ADPCM_SAMPLE_ENTRY}').`]);
        forward("warn", ["Unsupported audio codec (sample entry type 'samr')."]);
        forward("info", ["informational"]);
        expect(calls.map((call) => call.level)).toEqual(["debug", "warn", "debug"]);
    });

    it("stringifies non-text arguments into details", () => {
        const { logger, calls } = createRecordingLogger();
        const forward = createMediabunnyLogForwarder(logger);
        forward("warn", ["dropped packets", 3, { track: 1 }]);
        expect(calls[0]?.payload).toEqual({ details: ["3", "[object Object]"] });
    });
});

describe("mediabunny module wrapper", () => {
    beforeEach(() => {
        _resetForTests();
    });

    it("mutes the library console and routes its warnings into the app log", async () => {
        expect(Logging.level, "library console output is muted").toBe(MediabunnyLogLevel.Silent);
        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        output.addVideoTrack(new EncodedVideoPacketSource("avc"));
        await output.start();
        await output.start();
        await output.cancel();
        expect(
            getLogBuffer().map((record) => ({ ns: record.ns, level: record.level, msg: record.msg })),
        ).toContainEqual({
            ns: "mediabunny",
            level: "warn",
            msg: "Output has already been started.",
        });
    });
});
