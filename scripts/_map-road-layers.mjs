// Each elevation paints a complete casing/fill pair before the next one.
// A sort key cannot order casings and fills across separate style layers.
// Dashed classes (path, rail, transit) live in dedicated layers so drivable
// roads omit line-dasharray and stay on MapLibre's plain line shader instead
// of lineSDF.

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
const ROUNDED_LEVEL = ["round", LEVEL];
const SOLID_CLASSES = [
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
];
const DASHED_CLASSES = ["path", "rail", "transit"];
const ALL_CLASSES = [...SOLID_CLASSES, ...DASHED_CLASSES];
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
// Explicit casing/fill pairs cover the common OSM levels (-2..2). OSM allows
// -5..5, and multi-level interchanges do use 3+; those share the below/above
// casing and fill passes, so the style avoids dozens of mostly empty layers
// that MapLibre would check on every frame.
const MIN_LEVEL = -2;
const MAX_LEVEL = 2;

// Outlined roads swap the roles: the casing carries the class colour and every
// drivable road shares one dark interior.
export function roadColorExpression(palette, kind, outlined = false) {
    if (kind === "dashed") {
        return ["match", CLASS, "path", palette.path, palette.rail];
    }
    if (kind === "fill" && outlined) return palette.roadInterior;
    if (kind === "casing" && !outlined) return ["case", IS_BRIDGE, palette.bridgeCasing, palette.roadCasing];
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
const SOLID_WIDTH_INDEX = [
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
    3,
];
const ALL_WIDTH_INDEX = [
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
const SOLID_MIN_ZOOM = [
    "case",
    IS_RAMP,
    ["case", ["==", CLASS, "motorway"], 12, 13],
    ["match", CLASS, ["motorway", "trunk", "primary"], 5, ["secondary", "tertiary"], 7, ["service", "track"], 15, 12],
];
const ALL_MIN_ZOOM = [
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
const DASHED_MIN_ZOOM = ["match", CLASS, "rail", 13, 14];

export function roadWidth(kind, scale = 1, hasDashedClasses = false) {
    if (kind === "dashed") {
        const stops = WIDTHS.filter((row) => row[0] >= 12).flatMap((row) => {
            const pathW = row[6] * scale;
            const railW = row[7] * scale;
            return [row[0], ["case", ["==", CLASS, "path"], pathW, railW]];
        });
        return ["interpolate", ["exponential", 1.2], ["zoom"], ...stops];
    }
    const widthCount = hasDashedClasses ? 7 : 5;
    const stops = WIDTHS.flatMap((row) => {
        const width = [
            "*",
            ["case", IS_RAMP, 0.65, 1],
            ["at", ["var", "width_index"], ["literal", row.slice(1, 1 + widthCount).map((value) => value * scale)]],
        ];
        const value = kind === "fill" ? width : ["+", width, ["case", IS_BRIDGE, 2.2, 1.2]];
        return [row[0], value];
    });
    return [
        "let",
        "width_index",
        hasDashedClasses ? ALL_WIDTH_INDEX : SOLID_WIDTH_INDEX,
        ["interpolate", ["exponential", 1.2], ["zoom"], ...stops],
    ];
}

function roadLayer(level, crossing, kind, filter) {
    // Casings outline path/rail/transit only on bridges: the bridge passes of
    // the explicit levels hold nothing else, and the shared passes of the
    // extreme levels pick their bridges by filter. Other casings omit those
    // classes instead of drawing zero-width lines.
    const hasDashedClasses = kind === "casing" && (crossing === "bridge" || crossing === "all");
    const classFilter = !hasDashedClasses
        ? ["in", CLASS, ["literal", SOLID_CLASSES]]
        : crossing === "bridge"
          ? ["in", CLASS, ["literal", ALL_CLASSES]]
          : [
                "any",
                ["in", CLASS, ["literal", SOLID_CLASSES]],
                ["all", ["in", CLASS, ["literal", DASHED_CLASSES]], IS_BRIDGE],
            ];
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
            classFilter,
            [">=", ["zoom"], hasDashedClasses ? ALL_MIN_ZOOM : SOLID_MIN_ZOOM],
            filter,
        ],
        layout: { "line-cap": "round", "line-join": "round", "line-sort-key": SORT_KEY },
        paint: {
            "line-color": roadColorExpression(LIGHT, kind),
            "line-width": roadWidth(kind, 1, hasDashedClasses),
            "line-opacity": ["case", IS_TUNNEL, 0.65, 1],
        },
    };
}

// Each dashed group paints between the casing and the fill of its anchor pair,
// so trails and rail stay above road casings and below road fills. Every bridge
// group paints after the casing pass of its highest bridge level, otherwise a
// dashed bridge would lose its fill under its own casing. The groups cover
// every level exactly once.
const DASHED_GROUPS = [
    { name: "tunnel", level: -1, crossing: "tunnel", filter: ["all", ["!", IS_BRIDGE], ["<", ROUNDED_LEVEL, 0]] },
    { name: "surface", level: 0, crossing: "surface", filter: ["all", ["!", IS_BRIDGE], ["==", ROUNDED_LEVEL, 0]] },
    // Rare bridges below level 0 paint here too, above level 0 roads: their
    // casing precedes this pass, which matters more than the crossing order.
    {
        name: "bridge",
        level: 1,
        crossing: "bridge",
        filter: ["all", ["<=", ROUNDED_LEVEL, 1], ["any", IS_BRIDGE, ["==", ROUNDED_LEVEL, 1]]],
    },
    { name: "upper", level: MAX_LEVEL, crossing: "bridge", filter: ["==", ROUNDED_LEVEL, MAX_LEVEL] },
    // Levels above the explicit pairs paint inside the shared "above" pass:
    // anchored at MAX_LEVEL, a level 3 rail bridge would sit under the fill of
    // the level 2 road bridges it crosses.
    { name: "above", level: "above", crossing: "all", filter: [">", ROUNDED_LEVEL, MAX_LEVEL] },
];

function dashedRoadLayer(name, levelFilter) {
    return {
        id: `road-dashed-${name}-fill`,
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 13,
        metadata: {
            "everydashcam:role": "transport",
            "everydashcam:road-kind": "dashed",
            "everydashcam:road-crossing": name,
        },
        filter: [
            "all",
            ["==", ["geometry-type"], "LineString"],
            ["in", CLASS, ["literal", DASHED_CLASSES]],
            [">=", ["zoom"], DASHED_MIN_ZOOM],
            levelFilter,
        ],
        layout: { "line-cap": "round", "line-join": "round", "line-sort-key": SORT_KEY },
        paint: {
            "line-color": roadColorExpression(LIGHT, "dashed"),
            "line-width": roadWidth("dashed"),
            "line-opacity": ["case", IS_TUNNEL, 0.65, 1],
            "line-dasharray": ["match", CLASS, "path", ["literal", [1, 0.7]], ["literal", [3, 2]]],
        },
    };
}

// One casing/fill pair, with the dashed group anchored to it in between.
function roadLayerPair(level, crossing, filter) {
    const dashed = DASHED_GROUPS.find((group) => group.level === level && group.crossing === crossing);
    return [
        roadLayer(level, crossing, "casing", filter),
        ...(dashed ? [dashedRoadLayer(dashed.name, dashed.filter)] : []),
        roadLayer(level, crossing, "fill", filter),
    ];
}

export function createOpenMapTilesRoadLayers() {
    // Extreme levels share one casing pass and one fill pass, each sorted by
    // level. Where two extreme levels cross, the lower fill covers the upper
    // casing; everywhere else they keep the outline of the explicit levels.
    const layers = roadLayerPair("below", "all", ["<", ROUNDED_LEVEL, MIN_LEVEL]);
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
        for (const crossing of ["tunnel", "surface", "bridge"]) {
            const crossingFilter =
                crossing === "tunnel"
                    ? IS_TUNNEL
                    : crossing === "bridge"
                      ? IS_BRIDGE
                      : ["all", ["!", IS_TUNNEL], ["!", IS_BRIDGE]];
            const filter = ["all", ["==", ROUNDED_LEVEL, level], crossingFilter];
            layers.push(...roadLayerPair(level, crossing, filter));
        }
    }
    layers.push(...roadLayerPair("above", "all", [">", ROUNDED_LEVEL, MAX_LEVEL]));
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
