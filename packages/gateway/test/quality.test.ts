import { DEFAULT_VOID_RULES, type VoidRules } from "@p402/shared";
import { describe, expect, it } from "vitest";
import type { ForwardResult } from "../src/paywall/proxy";
import { isJsonContentType, judgeResponse, valueAtPath } from "../src/paywall/quality";

const rules = (overrides: Partial<VoidRules> = {}): VoidRules => ({ ...DEFAULT_VOID_RULES, ...overrides });

const response = (status: number, body: string | Buffer, contentType: string | null = "application/json"): ForwardResult => ({
  kind: "response",
  status,
  contentType,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  latencyMs: 12,
});

const verdict = (result: ForwardResult, r: VoidRules = rules(), schema: string | null = null) => {
  const j = judgeResponse(result, r, schema);
  return j.status === "accepted" ? "accepted" : j.voidReason;
};

describe("quality guard", () => {
  it("bills a normal JSON answer", () => {
    expect(verdict(response(200, '{"products":[{"id":"p1"}]}'))).toBe("accepted");
  });

  it("voids timeouts, unreachable sellers and oversized answers", () => {
    expect(verdict({ kind: "timeout", latencyMs: 8_000 })).toBe("timeout");
    expect(verdict({ kind: "unreachable", latencyMs: 3, detail: "ECONNREFUSED" })).toBe("upstream_unreachable");
    expect(verdict({ kind: "too_large", latencyMs: 30, status: 200 })).toBe("upstream_unreachable");
  });

  it("voids 5xx and 4xx (except 402) only when the seller's rules say so", () => {
    expect(verdict(response(503, '{"error":"down"}'))).toBe("upstream_5xx");
    expect(verdict(response(503, '{"error":"down"}'), rules({ on5xx: false }))).toBe("accepted");
    expect(verdict(response(404, '{"error":"missing"}'))).toBe("upstream_4xx");
    expect(verdict(response(429, '{"error":"slow down"}'))).toBe("upstream_4xx");
    expect(verdict(response(404, '{"error":"missing"}'), rules({ on4xx: false }))).toBe("accepted");
    expect(verdict(response(402, '{"error":"pay"}'))).toBe("accepted");
  });

  it("voids JSON that does not parse when requireJson, but never text bodies", () => {
    expect(verdict(response(200, '{"products": ['))).toBe("malformed_json");
    expect(verdict(response(200, '{"products": [', "application/problem+json"))).toBe("malformed_json");
    expect(verdict(response(200, '{"products": ['), rules({ requireJson: false }))).toBe("accepted");
    expect(verdict(response(200, "not json at all", "text/plain"))).toBe("accepted");
  });

  it("voids empty results unless empty is billable", () => {
    for (const body of ["", "   ", "[]", "{}", "null"]) expect(verdict(response(200, body))).toBe("empty_result");
    expect(verdict(response(200, "[]", "text/plain"))).toBe("empty_result");
    expect(verdict(response(200, "[]"), rules({ emptyIsBillable: true }))).toBe("accepted");
    expect(verdict(response(204, "", null))).toBe("empty_result");
  });

  it("checks emptyResultPaths only where the array exists", () => {
    const r = rules({ emptyResultPaths: ["products", "data.items"] });
    expect(verdict(response(200, '{"products":[],"next_page_token":null}'), r)).toBe("empty_result");
    expect(verdict(response(200, '{"data":{"items":[]}}'), r)).toBe("empty_result");
    expect(verdict(response(200, '{"products":[{"id":1}],"data":{"items":[2]}}'), r)).toBe("accepted");
    // A product detail answer has no "products" array at all: billable.
    expect(verdict(response(200, '{"id":"p1","title":"Espresso"}'), r)).toBe("accepted");
    // No content-type: still inspected for emptiness.
    expect(verdict(response(200, '{"products":[]}', null), r)).toBe("empty_result");
  });

  it("validates the endpoint's JSON Schema", () => {
    const schema = JSON.stringify({ type: "object", required: ["id"], properties: { id: { type: "string" }, email: { type: "string", format: "email" } } });
    expect(verdict(response(200, '{"id":"a"}'), rules(), schema)).toBe("accepted");
    expect(verdict(response(200, '{"id":7}'), rules(), schema)).toBe("schema_mismatch");
    expect(verdict(response(200, '{"id":"a","email":"nope"}'), rules(), schema)).toBe("schema_mismatch");
    expect(verdict(response(200, "<html>", "text/html"), rules(), schema)).toBe("schema_mismatch");
    // A broken stored schema never voids a call.
    expect(verdict(response(200, '{"id":"a"}'), rules(), "{not json")).toBe("accepted");
  });

  it("applies the rules in SPEC order (status before body before schema)", () => {
    const schema = JSON.stringify({ type: "object", required: ["id"] });
    expect(verdict(response(500, "", "application/json"), rules(), schema)).toBe("upstream_5xx");
    expect(verdict(response(200, "{oops"), rules(), schema)).toBe("malformed_json");
    expect(verdict(response(200, "{}"), rules(), schema)).toBe("empty_result");
  });

  it("helpers", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/vnd.api+json")).toBe(true);
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    expect(valueAtPath({ a: { b: [1] } }, "a.b")).toEqual([1]);
    expect(valueAtPath({ a: [{ b: 2 }] }, "a.0.b")).toBe(2);
    expect(valueAtPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });
});
