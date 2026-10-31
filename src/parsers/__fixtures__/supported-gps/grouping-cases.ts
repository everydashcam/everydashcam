// Original container clocks and GPS counts after the ingest deduplication step.
export const COLLECTED_CHANNEL_PAIRS = [
    {
        model: "Mikavi PQ6",
        files: [
            {
                fixture: "mikavi-a",
                name: "20210913120104_0000574A.MP4",
                channel: "front",
                gpsCount: 58,
                start: 1631527263,
                createdUtc: "2021-09-13T12:02:03.000Z",
            },
            {
                fixture: "mikavi-b",
                name: "20210913120104_0000575B.MP4",
                channel: "side",
                gpsCount: 58,
                start: 1631527264,
                createdUtc: "2021-09-13T12:02:04.000Z",
            },
            {
                fixture: "mikavi-c",
                name: "20210913120104_0000576C.MP4",
                channel: "rear",
                gpsCount: 59,
                start: 1631527264,
                createdUtc: "2021-09-13T12:02:04.000Z",
            },
        ],
        groups: [["20210913120104_0000574A.MP4", "20210913120104_0000575B.MP4", "20210913120104_0000576C.MP4"]],
    },
    {
        model: "Vantrue S1 Pro Max",
        files: [
            {
                fixture: "vantrue-a",
                name: "20250617_133014_00031_N_A.MP4",
                channel: "front",
                gpsCount: 60,
                start: 1750159814,
                createdUtc: "2025-06-17T13:31:14.000Z",
            },
            {
                fixture: "vantrue-b",
                name: "20250617_133014_00031_N_B.MP4",
                channel: "interior",
                gpsCount: 60,
                start: 1750159814,
                createdUtc: "2025-06-17T13:31:14.000Z",
            },
        ],
        groups: [["20250617_133014_00031_N_A.MP4", "20250617_133014_00031_N_B.MP4"]],
    },
] as const;

export type CollectedPair = (typeof COLLECTED_CHANNEL_PAIRS)[number];
