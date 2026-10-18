import type { Channel } from "../types.js";

/** Spelled-out mounts are portable across filename families; letters are not. */
export function channelFromFolder(folder: string | undefined): Channel | null {
    switch (folder?.toLowerCase()) {
        case "front":
            return "front";
        case "rear":
        case "back":
            return "rear";
        case "interior":
        case "inside":
        case "cabin":
            return "interior";
        default:
            return null;
    }
}

/**
 * Only the immediate parent identifies a channel. Ancestors may name separate
 * devices, including devices named Front or Rear; retain their complete path.
 */
export function matchChannelFolder(relativePath: string): { channel: Channel; parentDir: string } | null {
    const segments = relativePath.split("/").filter((segment) => segment.length > 0);
    const channel = segments.length >= 2 ? channelFromFolder(segments.at(-2)) : null;
    return channel === null ? null : { channel, parentDir: segments.slice(0, -2).join("/") };
}
