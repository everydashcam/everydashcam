import type { PortableManifest } from "../src/portable/manifest.mjs";
export declare function readPortableArtifacts(
    manifestPath: string,
    allowDevelopment?: boolean,
    allowCustom?: boolean,
): PortableManifest;
export declare function stagePortableArtifacts(
    manifestPath: string,
    distDir: string,
    allowCustom?: boolean,
    allowDevelopment?: boolean,
): PortableManifest;
export declare function stagePortableRelease(
    manifestPath: string,
    destination: string,
    allowDevelopment?: boolean,
): string[];
