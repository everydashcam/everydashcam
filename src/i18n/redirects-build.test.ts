import { describe, expect, it } from "vitest";

import { assertObjectStorageRulesMatch, type LegacyRedirectGroup, legacyRedirectGroups, OBJECT_STORAGE_MAX_ROUTING_RULES, objectStorageRoutingRules, renderCloudflareRedirects } from "../../vite-plugins/redirects.js";

const HOST = "mirror.example";

describe("legacy redirects on Object Storage", () => {
    const groups = legacyRedirectGroups();
    const rules = objectStorageRoutingRules(groups, HOST);

    it("lands every legacy URL on its _redirects destination within the rule limit", () => {
        expect(rules.length).toBeLessThanOrEqual(OBJECT_STORAGE_MAX_ROUTING_RULES);
        expect(() => assertObjectStorageRulesMatch(groups, rules)).not.toThrow();
    });

    it("fires only for missing objects on the mirror host", () => {
        for (const rule of rules) {
            expect(rule.condition.httpErrorCodeReturnedEquals).toBe("404");
            expect(rule.redirect).toMatchObject({ hostname: HOST, protocol: "PROTOCOL_HTTPS", httpRedirectCode: "301" });
        }
    });

    it("places a specific rule after the prefix rule it overrides", () => {
        // Object Storage applies the last matching rule.
        const prefixes = rules.map((rule) => rule.condition.keyPrefixEquals);
        expect(prefixes.indexOf("alternatives/navitel-dvr-player")).toBeGreaterThan(prefixes.indexOf("alternatives"));
    });

    it("rejects rules that send a legacy URL elsewhere", () => {
        const withoutNavitel = rules.filter((rule) => !rule.condition.keyPrefixEquals.endsWith("navitel-dvr-player"));
        const check = () => assertObjectStorageRulesMatch(groups, withoutNavitel);
        expect(check).toThrow(/ \/alternatives\/navitel-dvr-player: Object Storage lands on \/en\/alternatives\/navitel-dvr-player\/, _redirects sends \/en\/cameras\/navitel\//);
        expect(check).toThrow(/\/ru\/alternatives\/navitel-dvr-player: Object Storage lands on 404, _redirects sends \/ru\/cameras\/navitel\//);
    });

    it("rejects more rules than Object Storage allows", () => {
        const manyGroups: LegacyRedirectGroup[] = Array.from({ length: OBJECT_STORAGE_MAX_ROUTING_RULES + 1 }, (_, index) => ({
            comment: [],
            redirects: [{ source: `/old-${index}`, destination: `/en/new-${index}/`, scope: "page" }],
        }));
        expect(() => assertObjectStorageRulesMatch(manyGroups, objectStorageRoutingRules(manyGroups, HOST))).toThrow(/51 routing rules/);
    });
});

describe("Cloudflare _redirects rendering", () => {
    it("emits page sources with and without a trailing slash and tree sources with a splat", () => {
        const text = renderCloudflareRedirects([
            {
                comment: ["# Example."],
                redirects: [
                    { source: "/cameras/acme", destination: "/en/cameras/acme/", scope: "page" },
                    { source: "/kk", destination: "/en/", scope: "tree" },
                ],
            },
        ]);
        expect(text.split("\n").slice(4)).toEqual(["# Example.", "/cameras/acme /en/cameras/acme/ 301", "/cameras/acme/ /en/cameras/acme/ 301", "/kk /en/ 301", "/kk/* /en/:splat 301", ""]);
    });
});
