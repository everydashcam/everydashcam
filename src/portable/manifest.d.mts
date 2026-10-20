export interface PortableFile {
    path: string;
    filename: string;
    bytes: number;
    sha256: string;
}
export interface PortableManifest {
    schemaVersion: 1;
    distribution: "public" | "custom";
    version: string;
    files: Record<string, PortableFile>;
}
export declare const PORTABLE_PRIMARY_ORIGIN: string;
export declare const PORTABLE_UPDATE_URL: string;
export declare const PORTABLE_MAX_BYTES: number;
export declare function portableDownloadPath(locale: string): string;
export declare function parsePortableManifest(
    value: unknown,
    allowDevelopment?: boolean,
    allowCustom?: boolean,
): PortableManifest | null;
