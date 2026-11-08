import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEntryDTO, SellerDTO, SellerEarningsDTO } from "@p402/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../src/context";
import { assertSafeSellerUrl, checkSellerUrlShape, guardedLookup, isLoopbackAddress, isPublicAddress } from "../src/sellers/ssrf";
import { createKeyVault, keyVault, loadMasterKey, parseMasterKey } from "../src/sellers/vault";
import { registerSeller, sellerAuth, getSellerRow } from "../src/sellers/registry";
import { ACME_API_KEY, acmeListing, createHarness, injectJson, type Harness } from "./helpers";

describe("SSRF guard", () => {
  it("classifies public and non-public addresses", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808"]) expect(isPublicAddress(a), a).toBe(true);
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "2001:db8::1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("allows http and localhost only in demo mode", () => {
    expect(checkSellerUrlShape("http://localhost:4030/channel3", true).hostname).toBe("localhost");
    expect(checkSellerUrlShape("http://127.0.0.1:4030", true).port).toBe("4030");
    expect(checkSellerUrlShape("http://[::1]:4030", true).hostname).toBe("[::1]");
    expect(() => checkSellerUrlShape("http://localhost:4030", false)).toThrow(/demo mode/);
    expect(() => checkSellerUrlShape("http://api.example.com", true)).toThrow(/https/);
    expect(() => checkSellerUrlShape("https://10.0.0.5/api", true)).toThrow(/not a public address/);
    expect(() => checkSellerUrlShape("https://user:pw@api.example.com", true)).toThrow(/credentials/);
    expect(() => checkSellerUrlShape("https://api.example.com/?x=1", true)).toThrow(/query/);
    expect(() => checkSellerUrlShape("ftp://api.example.com", true)).toThrow(/https/);
    expect(() => checkSellerUrlShape("not a url", true)).toThrow(/valid URL/);
  });

  it("resolves hostnames and rejects any private answer", async () => {
    const resolve = (map: Record<string, string[]>) => async (host: string) =>
      (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    await expect(assertSafeSellerUrl("https://api.example.com", { demo: false, resolve: resolve({ "api.example.com": ["93.184.216.34"] }) })).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeSellerUrl("https://rebind.example.com", { demo: true, resolve: resolve({ "rebind.example.com": ["93.184.216.34", "127.0.0.1"] }) }),
    ).rejects.toMatchObject({ status: 400, code: "unsafe_url" });
    await expect(assertSafeSellerUrl("https://nowhere.example.com", { demo: true, resolve: resolve({}) })).rejects.toThrow(/resolve/);
    await expect(
      assertSafeSellerUrl("https://localhost.example.com", { demo: true, resolve: resolve({ "localhost.example.com": ["::1"] }) }),
    ).rejects.toThrow(/not a public address/);
  });

  it("refuses to connect when DNS answers with a private address at request time", async () => {
    const lookup = guardedLookup(false);
    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) =>
      lookup("localhost", { all: true }, (err) => resolve({ err })),
    );
    expect(result.err?.code).toBe("EADDRBLOCKED");
    const allowed = await new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
      guardedLookup(true)("localhost", {}, (err, address) => resolve({ err, address })),
    );
    expect(allowed.err).toBeNull();
    expect(isLoopbackAddress(String(allowed.address))).toBe(true);
  });
});

describe("seller key vault", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "p402-vault-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("seals with AES-256-GCM bound to the seller id", () => {
    const vault = createKeyVault(parseMasterKey("ab".repeat(32)));
    const sealed = vault.encrypt("demo-key", "acme");
    expect(sealed.split(".")).toHaveLength(3);
    expect(sealed).not.toContain("demo-key");
    expect(vault.encrypt("demo-key", "acme")).not.toBe(sealed); // fresh IV each time
    expect(vault.decrypt(sealed, "acme")).toBe("demo-key");
    expect(() => vault.decrypt(sealed, "other-seller")).toThrow();
    const [iv, tag, ct] = sealed.split(".");
    expect(() => vault.decrypt([iv, tag, Buffer.from("tampered").toString("base64")].join("."), "acme")).toThrow();
    expect(() => createKeyVault(parseMasterKey("cd".repeat(32))).decrypt(sealed, "acme")).toThrow();
    void ct;
  });

  it("parses hex and base64 master keys and generates data/master.key once with 0600", () => {
    expect(parseMasterKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
    expect(parseMasterKey(Buffer.alloc(32, 7).toString("base64url"))).toHaveLength(32);
    expect(() => parseMasterKey("too-short")).toThrow(/32 bytes/);
    const first = loadMasterKey({ masterKey: null, dataDir: dir, ephemeral: false });
    const file = join(dir, "master.key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadMasterKey({ masterKey: null, dataDir: dir, ephemeral: false }).equals(first)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(first.toString("hex"));
  });

  it("keeps a fingerprint, never the key, and warns when the key changes", () => {
    const ctx = createTestContext({ config: { masterKey: "11".repeat(32), dataDir: dir } });
    const vault = keyVault(ctx);
    const stored = ctx.db.prepare("SELECT value FROM kv WHERE key = 'seller_vault.key_fingerprint'").get() as { value: string };
    expect(stored.value).toBe(vault.fingerprint);
    expect(stored.value).not.toContain("1111");
  });
});

describe("seller registry", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ withSeller: false });
  });
  afterEach(async () => {
    await h.close();
  });

  it("lists a seller, seals its key and never returns it", async () => {
    const created = await injectJson<SellerDTO>(h.app, "POST", "/api/sellers", acmeListing(h.seller.url));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "acme",
      hasApiKey: true,
      authHeader: "x-api-key",
      gatewayUrl: "http://localhost:4020/s/acme",
      status: "active",
      voidRules: { timeoutMs: 400, emptyResultPaths: ["products"], on5xx: true, requireJson: true },
      stats: { calls: 0, voids: 0, grossMicros: 0 },
    });
    expect(created.body.endpoints).toHaveLength(5);
    expect(JSON.stringify(created.body)).not.toContain(ACME_API_KEY);
    const row = getSellerRow(h.ctx, "acme")!;
    expect(row.api_key_enc).not.toContain(ACME_API_KEY);
    expect(sellerAuth(h.ctx, row)).toEqual({ header: "x-api-key", value: ACME_API_KEY });
    const listed = await injectJson<SellerDTO[]>(h.app, "GET", "/api/sellers");
    expect(JSON.stringify(listed.body)).not.toContain(ACME_API_KEY);
  });

  it("validates listings", async () => {
    const bad = async (overrides: Record<string, unknown>) =>
      injectJson<{ error: string; message: string }>(h.app, "POST", "/api/sellers", { ...acmeListing(h.seller.url), ...overrides });
    expect((await bad({ id: "Bad Id!" })).body.error).toBe("invalid_request");
    expect((await bad({ paypalEmail: "nope" })).body.error).toBe("invalid_request");
    expect((await bad({ endpoints: [] })).body.error).toBe("invalid_request");
    expect((await bad({ endpoints: Array.from({ length: 51 }, (_, i) => ({ method: "GET", path: `/e${i}`, priceMicros: 1 })) })).status).toBe(400);
    expect((await bad({ endpoints: [{ method: "GET", path: "/x", priceMicros: 10_000_001 }] })).status).toBe(400);
    expect((await bad({ endpoints: [{ method: "GET", path: "/x", priceMicros: 0 }] })).status).toBe(400);
    expect((await bad({ endpoints: [{ method: "PUT", path: "/x", priceMicros: 5 }] })).status).toBe(400);
    expect((await bad({ endpoints: [{ method: "GET", path: "/../x", priceMicros: 5 }] })).status).toBe(400);
    expect((await bad({ endpoints: [{ method: "GET", path: "/x", priceMicros: 5 }, { method: "GET", path: "/x", priceMicros: 6 }] })).status).toBe(400);
    expect((await bad({ endpoints: [{ method: "GET", path: "/x", priceMicros: 5, responseSchema: { type: "nonsense" } }] })).body.message).toMatch(/JSON Schema/);
    expect((await bad({ authHeader: undefined })).body.message).toMatch(/authHeader/);
    expect((await bad({ authHeader: "Host" })).status).toBe(400);
    expect((await bad({ apiKey: "line\nbreak" })).status).toBe(400);
    expect((await bad({ voidRules: { timeoutMs: 5 } })).status).toBe(400);
    expect((await bad({ baseUrl: "http://api.example.com" })).body).toMatchObject({ error: "unsafe_url" });
    expect((await bad({ baseUrl: "https://192.168.0.10" })).body).toMatchObject({ error: "unsafe_url" });
    expect((await injectJson(h.app, "POST", "/api/sellers", acmeListing(h.seller.url))).status).toBe(201);
    expect((await injectJson(h.app, "POST", "/api/sellers", acmeListing(h.seller.url))).body).toMatchObject({ error: "seller_exists" });
  });

  it("only allows localhost sellers in demo mode", async () => {
    const strict = await createHarness({ withSeller: false, config: { demo: false, adminToken: "t0ken" } });
    try {
      const res = await injectJson(strict.app, "POST", "/api/sellers", acmeListing(strict.seller.url), { "x-p402-admin": "t0ken" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "unsafe_url" });
    } finally {
      await strict.close();
    }
  });

  it("pauses a seller, reprices endpoints and shows them in the catalog", async () => {
    await registerSeller(h.ctx, acmeListing(h.seller.url));
    const updates: string[] = [];
    h.ctx.bus.on("seller.updated", (e) => updates.push(e.data.status));
    const seller = (await injectJson<SellerDTO[]>(h.app, "GET", "/api/sellers")).body[0]!;
    const search = seller.endpoints.find((e) => e.path === "/v1/search")!;
    const patched = await injectJson<SellerDTO>(h.app, "PATCH", "/api/sellers/acme", { endpoints: [{ id: search.id, priceMicros: 7_000 }] });
    expect(patched.body.endpoints.find((e) => e.id === search.id)?.priceMicros).toBe(7_000);
    expect((await injectJson(h.app, "PATCH", "/api/sellers/acme", { endpoints: [{ id: "ep_nope", priceMicros: 1 }] })).status).toBe(400);
    expect((await injectJson(h.app, "PATCH", "/api/sellers/nobody", { status: "paused" })).status).toBe(404);

    let catalog = (await injectJson<CatalogEntryDTO[]>(h.app, "GET", "/api/catalog")).body;
    expect(catalog).toEqual([expect.objectContaining({ sellerId: "acme", sellerName: "Acme Data", gatewayUrl: "http://localhost:4020/s/acme" })]);
    expect(catalog[0]!.endpoints.find((e) => e.path === "/v1/search")?.priceMicros).toBe(7_000);
    await injectJson(h.app, "PATCH", "/api/sellers/acme", { status: "paused" });
    catalog = (await injectJson<CatalogEntryDTO[]>(h.app, "GET", "/api/catalog")).body;
    expect(catalog).toEqual([]);
    expect(updates).toEqual(["active", "paused"]);
  });

  it("re-listing (seeding) updates the listing and keeps endpoint ids", async () => {
    const first = await registerSeller(h.ctx, acmeListing(h.seller.url));
    const listing = acmeListing(h.seller.url, { name: "Acme Data v2" });
    listing.endpoints[0]!.priceMicros = 6_000;
    const second = await registerSeller(h.ctx, listing, { upsert: true });
    expect(second.name).toBe("Acme Data v2");
    expect(second.endpoints.map((e) => e.id).sort()).toEqual(first.endpoints.map((e) => e.id).sort());
    expect(second.endpoints.find((e) => e.path === "/v1/search")?.priceMicros).toBe(6_000);
  });

  it("reports a seller's earnings from settlement lines and payouts", async () => {
    await registerSeller(h.ctx, acmeListing(h.seller.url));
    const db = h.ctx.db;
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('co', 'Co', 1)").run();
    db.prepare("INSERT INTO tabs (id, company_id, status, policy, hold_cents, enroll_token_hash, created_at) VALUES ('t1', 'co', 'settled', '{}', 5000, 'h', 1)").run();
    db.prepare("INSERT INTO settlements (id, tab_id, status, charged_cents, paypal_fee_cents, created_at) VALUES ('s1', 't1', 'completed', 100, 52, 10)").run();
    db.prepare("INSERT INTO settlement_lines VALUES ('s1', 'acme', 1000000, 520000, 480000, 200)").run();
    db.prepare("INSERT INTO payouts (id, status, total_cents, fee_cents, created_at) VALUES ('p1', 'success', 23, 25, 20)").run();
    db.prepare("INSERT INTO payout_items VALUES ('p1', 'acme', 23, 25, 'ITEM1', 'SUCCESS')").run();
    const earnings = await injectJson<SellerEarningsDTO>(h.app, "GET", "/api/sellers/acme/earnings");
    expect(earnings.body.lines).toEqual([
      { sellerId: "acme", sellerName: "Acme Data", grossMicros: 1_000_000, feeShareMicros: 520_000, netMicros: 480_000, calls: 200, settlementId: "s1", tabId: "t1", createdAt: 10 },
    ]);
    expect(earnings.body.payouts).toEqual([
      { sellerId: "acme", sellerName: "Acme Data", amountCents: 23, feeCents: 25, paypalItemId: "ITEM1", status: "SUCCESS", payoutId: "p1", createdAt: 20 },
    ]);
    expect((await injectJson(h.app, "GET", "/api/sellers/nobody/earnings")).status).toBe(404);
  });
});
