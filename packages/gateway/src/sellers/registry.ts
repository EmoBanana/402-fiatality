/**
 * Seller registry (SPEC §5.2): validated listings, SSRF-checked base URLs, AES-GCM sealed API keys.
 * POST /api/sellers and the demo seeder both go through `registerSeller`.
 */
import {
  DEFAULT_VOID_RULES,
  newId,
  SELLER_ID_PATTERN,
  voidRulesSchema,
  type CatalogEntryDTO,
  type SellerCreateDTO,
  type SellerDTO,
  type SellerUpdateDTO,
} from "@p402/shared";
import { z } from "zod";
import { AppError, type AppContext } from "../context";
import { stmt, tx } from "../db/db";
import { catalogEntryDTO, getSellerDTO, sellerDTO, type EndpointRow, type SellerRow } from "../db/dto";
import { badRequest, conflict, notFound } from "../http/errors";
import { ENDPOINT_PATH_PATTERN } from "../paywall/match";
import { compileResponseSchema } from "../paywall/schemas";
import { assertSafeSellerUrl, type ResolveHost } from "./ssrf";
import { keyVault } from "./vault";

/** $10: the most one call may cost. */
export const MAX_PRICE_MICROS = 10_000_000;

/** Headers a seller may not ask us to inject (hop-by-hop, framing, our own protocol headers). */
const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "expect",
  "cookie",
  "accept-encoding",
]);

const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "must be a valid HTTP header name")
  .transform((h) => h.toLowerCase())
  .refine((h) => !RESERVED_HEADERS.has(h) && !h.startsWith("proxy-") && !h.startsWith("payment-") && !h.startsWith("x-p402-"), {
    message: "can't be a reserved header",
  });

const priceMicros = z.number().int().min(1).max(MAX_PRICE_MICROS);

const endpointSchema = z.object({
  method: z.enum(["GET", "POST"]),
  path: z.string().max(200).regex(ENDPOINT_PATH_PATTERN, 'must look like "/v1/products/:id"'),
  priceMicros,
  description: z.string().trim().max(500).nullish(),
  responseSchema: z.record(z.string(), z.unknown()).nullish(),
});

export const sellerCreateSchema = z
  .object({
    id: z.string().regex(SELLER_ID_PATTERN, "must be a lowercase slug (a-z, 0-9, dashes)"),
    name: z.string().trim().min(1).max(80),
    baseUrl: z
      .string()
      .trim()
      .max(500)
      .transform((u) => u.replace(/\/+$/, "")),
    authHeader: headerName.optional(),
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x20-\x7E]+$/, "must be printable ASCII")
      .optional(),
    paypalEmail: z.email().max(254),
    voidRules: voidRulesSchema.partial().optional(),
    endpoints: z.array(endpointSchema).min(1).max(50),
  })
  .superRefine((value, ctx) => {
    if (value.apiKey && !value.authHeader) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "is required when an apiKey is given" });
    }
    const seen = new Set<string>();
    value.endpoints.forEach((e, i) => {
      const key = `${e.method} ${e.path}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["endpoints", i, "path"], message: `duplicates ${key}` });
      seen.add(key);
    });
  });

export const sellerUpdateSchema = z.object({
  status: z.enum(["active", "paused"]).optional(),
  endpoints: z
    .array(z.object({ id: z.string().min(1).max(64), priceMicros }))
    .max(50)
    .optional(),
});

type SellerInput = z.output<typeof sellerCreateSchema>;

export interface RegisterOptions {
  /** Seeding: update an existing seller instead of failing with 409. */
  upsert?: boolean;
  /** DNS resolver override (tests). */
  resolve?: ResolveHost;
}

function checkSchemas(input: SellerInput): void {
  input.endpoints.forEach((e, i) => {
    if (!e.responseSchema) return;
    try {
      compileResponseSchema(e.responseSchema);
    } catch (err) {
      throw badRequest(`endpoints.${i}.responseSchema is not a valid JSON Schema: ${(err as Error).message}`);
    }
  });
}

/** Validate, SSRF-check and store a seller listing. Emits `seller.updated`. */
export async function registerSeller(ctx: AppContext, body: SellerCreateDTO | unknown, opts: RegisterOptions = {}): Promise<SellerDTO> {
  const input = sellerCreateSchema.parse(body);
  checkSchemas(input);
  await assertSafeSellerUrl(input.baseUrl, { demo: ctx.config.demo, resolve: opts.resolve });
  const voidRules = voidRulesSchema.parse({ ...DEFAULT_VOID_RULES, ...input.voidRules });
  const apiKeyEnc = input.apiKey ? keyVault(ctx).encrypt(input.apiKey, input.id) : null;
  const now = ctx.clock.now();

  tx(ctx.db, () => {
    const existing = stmt(ctx.db, "SELECT id FROM sellers WHERE id = ?").get(input.id);
    if (existing && !opts.upsert) throw conflict("seller_exists", `A seller with id "${input.id}" is already listed.`);
    if (existing) {
      stmt(
        ctx.db,
        `UPDATE sellers SET name = ?, base_url = ?, auth_header = ?, api_key_enc = ?, paypal_email = ?, void_rules = ?
          WHERE id = ?`,
      ).run(input.name, input.baseUrl, input.authHeader ?? null, apiKeyEnc, input.paypalEmail, JSON.stringify(voidRules), input.id);
    } else {
      stmt(
        ctx.db,
        `INSERT INTO sellers (id, name, base_url, auth_header, api_key_enc, paypal_email, void_rules, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(input.id, input.name, input.baseUrl, input.authHeader ?? null, apiKeyEnc, input.paypalEmail, JSON.stringify(voidRules), now);
    }
    for (const e of input.endpoints) {
      // Endpoints are never deleted (vouchers reference them); re-listing updates price and metadata.
      stmt(
        ctx.db,
        `INSERT INTO endpoints (id, seller_id, method, path, price_micros, description, response_schema)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (seller_id, method, path) DO UPDATE SET
           price_micros = excluded.price_micros, description = excluded.description, response_schema = excluded.response_schema`,
      ).run(
        newId("ep"),
        input.id,
        e.method,
        e.path,
        e.priceMicros,
        e.description ?? null,
        e.responseSchema ? JSON.stringify(e.responseSchema) : null,
      );
    }
  });

  const dto = getSellerDTO(ctx.db, input.id, ctx.config.publicBaseUrl) as SellerDTO;
  ctx.bus.emit("seller.updated", dto);
  return dto;
}

/** PATCH /api/sellers/:id: pause/resume a listing or change endpoint prices. */
export function updateSeller(ctx: AppContext, id: string, body: SellerUpdateDTO | unknown): SellerDTO {
  const input = sellerUpdateSchema.parse(body);
  tx(ctx.db, () => {
    if (!stmt(ctx.db, "SELECT id FROM sellers WHERE id = ?").get(id)) throw notFound("Seller", id);
    if (input.status) stmt(ctx.db, "UPDATE sellers SET status = ? WHERE id = ?").run(input.status, id);
    for (const e of input.endpoints ?? []) {
      const result = stmt(ctx.db, "UPDATE endpoints SET price_micros = ? WHERE id = ? AND seller_id = ?").run(e.priceMicros, e.id, id);
      if (result.changes === 0) throw badRequest(`Endpoint ${e.id} does not belong to seller ${id}.`);
    }
  });
  const dto = getSellerDTO(ctx.db, id, ctx.config.publicBaseUrl) as SellerDTO;
  ctx.bus.emit("seller.updated", dto);
  return dto;
}

export function listSellerDTOs(ctx: AppContext, filter: { activeOnly?: boolean } = {}): SellerDTO[] {
  const rows = stmt(
    ctx.db,
    filter.activeOnly
      ? "SELECT * FROM sellers WHERE status = 'active' ORDER BY created_at, id"
      : "SELECT * FROM sellers ORDER BY created_at, id",
  ).all() as SellerRow[];
  return rows.map((row) => sellerDTO(ctx.db, row, ctx.config.publicBaseUrl));
}

/** GET /api/catalog: what agents can buy, through the paywall, at which price. */
export function catalog(ctx: AppContext): CatalogEntryDTO[] {
  return listSellerDTOs(ctx, { activeOnly: true }).map(catalogEntryDTO);
}

export function getSellerRow(ctx: AppContext, id: string): SellerRow | undefined {
  return stmt(ctx.db, "SELECT * FROM sellers WHERE id = ?").get(id) as SellerRow | undefined;
}

export function sellerEndpoints(ctx: AppContext, sellerId: string): EndpointRow[] {
  return stmt(ctx.db, "SELECT * FROM endpoints WHERE seller_id = ?").all(sellerId) as EndpointRow[];
}

/** The header the gateway injects when forwarding, or null. Never logged or returned. */
export function sellerAuth(ctx: AppContext, seller: SellerRow): { header: string; value: string } | null {
  if (!seller.auth_header || !seller.api_key_enc) return null;
  try {
    return { header: seller.auth_header, value: keyVault(ctx).decrypt(seller.api_key_enc, seller.id) };
  } catch {
    throw new AppError(500, "seller_key_unreadable", `The stored API key for ${seller.id} can't be decrypted.`);
  }
}
