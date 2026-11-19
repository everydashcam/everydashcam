#!/usr/bin/env node
// Submit every URL from the live sitemap to each IndexNow-participating
// search engine directly. We do NOT use the global api.indexnow.org endpoint:
// spec says it fans the ping out to every participating engine, but empirically
// it doesn't (at least not to Bing, at least not for our host). Direct fan-out
// also gives per-engine visibility: we see exactly who accepted and who 422'd.
//
// Runs from .github/workflows/indexnow.yml after a successful production
// deployment (workflow_dispatch for an ad-hoc ping). IndexNow requires the
// submitted URLs and the key file to be publicly fetchable when the engine
// processes the ping - that is why the workflow awaits the deployment before
// running this script (never a build step), and why the sitemap comes from
// the live site rather than a local dist/ (what is deployed is what gets
// pinged; a local build could be stale or ahead of production).
//
// Key: INDEXNOW_KEY env (GitHub Actions secret in CI; export it by hand for a
// local run). NOT committed - the key's only protection is an unguessable
// URL; the production build emits dist/<KEY>.txt from the same secret
// (vite-plugins/indexnow-key.ts).
//
// Why no deduplication / state tracking: the sitemap has a few hundred URLs
// (241 as of 2026-07: locale homes + cameras + alternatives + feature pages
// + privacy; grows with page families). A single POST per engine stays
// well under IndexNow's per-request limit (10000 URLs). Repeated submission of
// unchanged URLs may trigger a 429 from individual engines - we surface that
// as a per-engine warning that does not count as accepted, and keep going, so
// one throttled engine doesn't block the rest. Exit 0 unless no engine
// accepts the batch (then exit 1).

const KEY = (process.env.INDEXNOW_KEY ?? "").trim();
if (KEY.length === 0) {
    console.error("indexnow: INDEXNOW_KEY env is not set - see docs/seo.md, IndexNow");
    process.exit(1);
}
const ORIGIN = (process.env.INDEXNOW_ORIGIN ?? "https://everydashcam.app").replace(/\/+$/, "");
let originUrl;
try {
    originUrl = new URL(ORIGIN);
} catch {
    console.error("indexnow: INDEXNOW_ORIGIN must be an absolute HTTPS origin");
    process.exit(1);
}
if (originUrl.protocol !== "https:" || originUrl.pathname !== "/" || originUrl.search || originUrl.hash) {
    console.error("indexnow: INDEXNOW_ORIGIN must be an HTTPS origin without a path, query or fragment");
    process.exit(1);
}
const HOST = originUrl.host;
const KEY_LOCATION = `${ORIGIN}/${KEY}.txt`;

// Direct per-engine endpoints. Order doesn't matter (we Promise.allSettled).
// Amazon is also an IndexNow participant per indexnow.org/faq but their
// endpoint isn't publicly documented in a stable form - skip until needed.
const ENGINES = [
    { id: "bing", endpoint: "https://www.bing.com/indexnow" },
    { id: "yandex", endpoint: "https://yandex.com/indexnow" },
    { id: "naver", endpoint: "https://searchadvisor.naver.com/indexnow" },
    { id: "seznam", endpoint: "https://search.seznam.cz/indexnow" },
    { id: "yep", endpoint: "https://indexnow.yep.com/indexnow" },
];

let sitemap;
try {
    const res = await fetch(`${ORIGIN}/sitemap.xml`);
    if (!res.ok) {
        console.error(`indexnow: ${ORIGIN}/sitemap.xml returned HTTP ${res.status}`);
        process.exit(1);
    }
    sitemap = await res.text();
} catch (err) {
    console.error(`indexnow: cannot fetch ${ORIGIN}/sitemap.xml: ${err.message}`);
    process.exit(1);
}

// Extract <loc>...</loc> values. The sitemap is built by our own
// vite-plugins/seo-prerender.ts so the format is stable; regex is simpler
// than pulling in an XML parser for this one use.
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

if (urls.length === 0) {
    console.error("indexnow: no <loc> entries found in sitemap.xml");
    process.exit(1);
}

// Sanity check: every URL must be under our host. A stray external URL would
// trip every engine's 422 "URL doesn't belong to host" check and reject the
// whole batch.
const offSite = urls.filter((u) => !u.startsWith(`${ORIGIN}/`));
if (offSite.length > 0) {
    console.error(`indexnow: ${offSite.length} URLs are not under ${ORIGIN}, refusing to submit`);
    console.error(`indexnow: first offender: ${offSite[0]}`);
    process.exit(1);
}

const payload = JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList: urls,
});

// Pre-flight: the engines validate by fetching keyLocation, so if the live
// site does not serve our key (the secret was rotated but production not yet
// redeployed with it) every engine would reject the batch. Catch that here
// with a clear message instead of five opaque 403s. Retried: the ping runs
// right after the production upload, and the custom domain can lag it by a
// minute or two - a fresh deploy must wait out propagation, not fail on it.
const PREFLIGHT_ATTEMPTS = 10;
const PREFLIGHT_INTERVAL_MS = 20_000;
let keyIsLive = false;
for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt++) {
    let status = "network error";
    try {
        const keyRes = await fetch(KEY_LOCATION);
        const body = keyRes.ok ? (await keyRes.text()).trim() : "";
        if (keyRes.ok && body === KEY) {
            keyIsLive = true;
            break;
        }
        status = `HTTP ${keyRes.status}`;
    } catch (err) {
        status = err.message;
    }
    console.log(`indexnow: key file not live yet (${status}), attempt ${attempt}/${PREFLIGHT_ATTEMPTS}`);
    if (attempt < PREFLIGHT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_INTERVAL_MS));
    }
}
if (!keyIsLive) {
    console.error(`indexnow: ${KEY_LOCATION} is not serving the current key`);
    console.error("indexnow: deploy a production build with INDEXNOW_KEY set before pinging");
    process.exit(1);
}

console.log(`indexnow: submitting ${urls.length} URLs to ${ENGINES.length} engines`);

async function submitTo(engine) {
    const started = Date.now();
    let res;
    try {
        res = await fetch(engine.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: payload,
        });
    } catch (err) {
        return { id: engine.id, status: 0, ms: Date.now() - started, error: err.message };
    }
    const body = await res.text();
    const ms = Date.now() - started;
    return { id: engine.id, status: res.status, statusText: res.statusText, ms, body };
}

const results = await Promise.all(ENGINES.map(submitTo));

let okCount = 0;
for (const r of results) {
    const tag = `[${r.id}]`.padEnd(10);
    if (r.error) {
        console.error(`${tag} network error after ${r.ms}ms: ${r.error}`);
        continue;
    }
    const line = `${tag} HTTP ${r.status} ${r.statusText ?? ""}  (${r.ms}ms)`;
    // 200 = accepted, 202 = accepted while key validation is pending.
    if (r.status === 200 || r.status === 202) {
        console.log(`${line} - ok`);
        okCount++;
    } else if (r.status === 429) {
        // The engine took nothing; IndexNow asks for a pause, so the next
        // deploy resubmits instead of retrying here.
        console.warn(`${line} - throttled, not accepted`);
    } else {
        console.error(`${line} - rejected`);
        const snippet = (r.body ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
        if (snippet) console.error(`${tag} body: ${snippet}`);
    }
}

console.log(`indexnow: ${okCount}/${ENGINES.length} engines accepted`);

// Exit 0 if at least one engine took the batch. Exit 1 only if every engine
// rejected, throttled or networked-out - that signals something is
// systemically broken (key file missing, payload malformed, no network,
// submissions treated as excessive) and the deploy pipeline should know.
if (okCount === 0) {
    process.exit(1);
}
