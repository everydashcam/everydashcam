export declare function parseRegistryBindings(
    fileName: string,
    source: string,
    registryName: string,
): { specifier: string; exportName: string }[];

export declare function parsePrimitiveId(fileName: string, source: string, exportName: string): string;
