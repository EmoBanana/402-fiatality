import { describe, expect, it } from "vitest";
import type { EndpointRow } from "../src/db/dto";
import { ENDPOINT_PATH_PATTERN, isForwardablePath, matchEndpoint, splitPathAndQuery } from "../src/paywall/match";
import { pathAfterSeller } from "../src/paywall/route";

const ep = (id: string, method: "GET" | "POST", path: string): EndpointRow => ({
  id,
  seller_id: "s",
  method,
  path,
  price_micros: 1,
  description: null,
  response_schema: null,
});

describe("paywall paths", () => {
  it("takes the path + query after /s/:sellerId exactly as sent (what the agent hashed)", () => {
    expect(pathAfterSeller("/s/channel3/v1/search")).toBe("/v1/search");
    expect(pathAfterSeller("/s/channel3/v1/products/p%201?x=1&y=%2F")).toBe("/v1/products/p%201?x=1&y=%2F");
    expect(pathAfterSeller("/s/chan%6Eel3/v1/search?q")).toBe("/v1/search?q");
    expect(pathAfterSeller("/s/channel3/")).toBe("/");
    expect(splitPathAndQuery("/v1/a?b=c?d")).toEqual({ path: "/v1/a", query: "?b=c?d" });
  });

  it("refuses paths that could escape the seller's base path", () => {
    for (const ok of ["/", "/v1/search", "/v1/products/p%201", "/v1/x/"]) expect(isForwardablePath(ok), ok).toBe(true);
    for (const bad of ["v1", "/v1/../admin", "/v1/%2e%2e/admin", "/v1/%2E", "/v1//x", "/v1/a%2Fb", "/v1\\x", "/v1/%zz"]) {
      expect(isForwardablePath(bad), bad).toBe(false);
    }
  });

  it("matches method + pattern, preferring literal segments", () => {
    const endpoints = [ep("byId", "GET", "/v1/products/:id"), ep("featured", "GET", "/v1/products/featured"), ep("search", "POST", "/v1/search")];
    expect(matchEndpoint(endpoints, "GET", "/v1/products/abc")?.id).toBe("byId");
    expect(matchEndpoint(endpoints, "GET", "/v1/products/featured")?.id).toBe("featured");
    expect(matchEndpoint(endpoints, "GET", "/v1/search")).toBeNull();
    expect(matchEndpoint(endpoints, "POST", "/v1/search")?.id).toBe("search");
    expect(matchEndpoint(endpoints, "GET", "/v1/products/")).toBeNull();
    expect(matchEndpoint(endpoints, "GET", "/v1/products/a/b")).toBeNull();
  });

  it("validates listed endpoint paths", () => {
    for (const ok of ["/", "/v1/search", "/v1/products/:id", "/v1/:id/reviews", "/v1/.well-known"]) expect(ENDPOINT_PATH_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["v1", "/v1/../x", "/./x", "//x", "/x/", "/v1/search?q=1", "/v1/:1bad", "/v1/a b"]) expect(ENDPOINT_PATH_PATTERN.test(bad), bad).toBe(false);
  });
});
