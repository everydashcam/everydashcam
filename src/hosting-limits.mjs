// Cloudflare Pages rejects a single hosted file above 25 MiB. Portable manifests
// share this cap because their HTML is published through the same host.
export const MAX_HOSTED_ASSET_BYTES = 25 * 1024 * 1024;
