// Each elevation paints a complete casing/fill pair before the next one.
// A sort key cannot order casings and fills across separate style layers.

const LIGHT = {
    roadCasing: "#d1c9ba",
    bridgeCasing: "#a7a69f",
    minor: "#ffffff",
    service: "#eee9df",
    secondary: "#f4efb3",
    primary: "#f2c785",
    motorway: "#e99da4",
    path: "#c7a987",
    rail: "#8a8c89",
};
const CLASS = ["get", "class"];
const BRUNNEL = ["get", "brunnel"];
const IS_BRIDGE = ["==", BRUNNEL, "bridge"];
const IS_TUNNEL = ["==", BRUNNEL, "tunnel"];
const IS_RAMP = ["==", ["get", "ramp"], 1];
const DEFAULT_LEVEL = ["case", IS_TUNNEL, -1, IS_BRIDGE, 1, 0];
const LEVEL = ["to-number", ["coalesce", ["get", "layer"], DEFAULT_LEVEL], DEFAULT_LEVEL];
const CLASSES = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "minor",
    "raceway",
    "busway",
    "bus_guideway",
    "service",
    "track",
    "path",
    "rail",
    "transit",
];
const CLASS_RANK = [
    "match",
    CLASS,
    "motorway",
    6,
    ["trunk", "primary"],
    5,
    ["secondary", "tertiary"],
    4,
    ["minor", "raceway", "busway", "bus_guideway"],
    3,
    ["service", "track"],
    2,
    ["rail", "transit"],
    1,
    0,
];
const SORT_KEY = ["+", ["*", LEVEL, 100], ["case", IS_TUNNEL, 0, IS_BRIDGE, 20, 10], CLASS_RANK];
const MIN_LEVEL = -5;
const MAX_LEVEL = 5;

export function roadColorExpression(palette, kind) {
    if (kind === "fill" && palette.roadInterior) {
        return ["match", CLASS, "path", palette.path, ["rail", "transit"], palette.rail, palette.roadInterior];
    }
    if (kind === "casing" && !palette.roadInterior)
        return ["case", IS_BRIDGE, palette.bridgeCasing, palette.roadCasing];
    return [
        "match",
        CLASS,
        "motorway",
        palette.motorway,
        ["trunk", "primary"],
        palette.primary,
        ["secondary", "tertiary"],
        palette.secondary,
        ["service", "track"],
        palette.service,
        "path",
        palette.path,
        ["rail", "transit"],
        palette.rail,
        palette.minor,
    ];
}

// Screen-pixel widths: motorway, primary, secondary, minor, service, path, rail.
const WIDTHS = [
    [5, 0.6, 0.4, 0, 0, 0, 0, 0],
    [8, 1.4, 1.1, 0.6, 0, 0, 0, 0],
    [12, 3.6, 3.2, 2.2, 0.6, 0, 0, 0],
    [14, 5.5, 4.5, 3.6, 2.5, 1, 1, 0.7],
    [16, 8.3, 6.8, 5.7, 5.9, 2, 3, 1.1],
    [20, 18, 17, 13, 18, 7.5, 10, 2],
];
const WIDTH_INDEX = [
    "match",
    CLASS,
    "motorway",
    0,
    ["trunk", "primary"],
    1,
    ["secondary", "tertiary"],
    2,
    ["service", "track"],
    4,
    "path",
    5,
    ["rail", "transit"],
    6,
    3,
];
const MIN_ZOOM = [
    "case",
    IS_RAMP,
    ["case", ["==", CLASS, "motorway"], 12, 13],
    [
        "match",
        CLASS,
        ["motorway", "trunk", "primary"],
        5,
        ["secondary", "tertiary"],
        7,
        ["service", "track"],
        15,
        ["path", "transit"],
        14,
        "rail",
        13,
        12,
    ],
];

export function roadWidth(kind, scale = 1) {
    const stops = WIDTHS.flatMap((row) => {
        const width = [
            "*",
            ["case", IS_RAMP, 0.65, 1],
            ["at", ["var", "width_index"], ["literal", row.slice(1).map((value) => value * scale)]],
        ];
        const value =
            kind === "fill"
                ? width
                : [
                      "case",
                      ["all", ["in", CLASS, ["literal", ["path", "rail", "transit"]]], ["!", IS_BRIDGE]],
                      0,
                      ["+", width, ["case", IS_BRIDGE, 2.2, 1.2]],
                  ];
        return [row[0], value];
    });
    return ["let", "width_index", WIDTH_INDEX, ["interpolate", ["exponential", 1.2], ["zoom"], ...stops]];
}

function roadLayer(level, crossing, kind, filter) {
    return {
        id: `road-level-${level}-${crossing}-${kind}`,
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 5,
        metadata: {
            "everydashcam:role": "transport",
            "everydashcam:road-kind": kind,
            "everydashcam:road-level": level,
            "everydashcam:road-crossing": crossing,
        },
        filter: [
            "all",
            ["==", ["geometry-type"], "LineString"],
            ["in", CLASS, ["literal", CLASSES]],
            [">=", ["zoom"], MIN_ZOOM],
            filter,
        ],
        layout: { "line-cap": "round", "line-join": "round", "line-sort-key": SORT_KEY },
        paint: {
            "line-color": roadColorExpression(LIGHT, kind),
            "line-width": roadWidth(kind),
            "line-opacity": ["case", IS_TUNNEL, 0.65, 1],
            ...(kind === "fill"
                ? {
                      "line-dasharray": [
                          "match",
                          CLASS,
                          "path",
                          ["literal", [1, 0.7]],
                          ["rail", "transit"],
                          ["literal", [3, 2]],
                          ["literal", [1, 0]],
                      ],
                  }
                : {}),
        },
    };
}

export function createOpenMapTilesRoadLayers() {
    // Extreme levels use single fill passes sorted by actual level.
    // Omitting their casing avoids a low road's fill covering a higher casing.
    const below = roadLayer("below", "all", "fill", ["<", LEVEL, MIN_LEVEL]);
    const above = roadLayer("above", "all", "fill", [">", LEVEL, MAX_LEVEL]);
    const layers = [below];
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
        for (const crossing of ["tunnel", "surface", "bridge"]) {
            const crossingFilter =
                crossing === "tunnel"
                    ? IS_TUNNEL
                    : crossing === "bridge"
                      ? IS_BRIDGE
                      : ["all", ["!", IS_TUNNEL], ["!", IS_BRIDGE]];
            const filter = [
                "all",
                [">=", LEVEL, MIN_LEVEL],
                ["<=", LEVEL, MAX_LEVEL],
                ["==", ["round", LEVEL], level],
                crossingFilter,
            ];
            for (const kind of ["casing", "fill"]) layers.push(roadLayer(level, crossing, kind, filter));
        }
    }
    layers.push(above);
    return layers;
}

export function updateOpenMapTilesRoadLayers(style) {
    const result = structuredClone(style);
    result.layers = result.layers.filter(
        (layer) => !(layer.type === "line" && layer["source-layer"] === "transportation" && layer.id !== "road_ferry"),
    );
    const before = result.layers.findIndex((layer) => layer.type === "symbol");
    result.layers.splice(before < 0 ? result.layers.length : before, 0, ...createOpenMapTilesRoadLayers());
    return result;
}
