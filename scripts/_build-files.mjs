import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Portable downloads are complete artifacts with their own CSP and metadata. */
export function hostedHtmlFiles(directory) {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((path) => !relative(directory, path).split(sep).includes("downloads"))
        .sort();
}
