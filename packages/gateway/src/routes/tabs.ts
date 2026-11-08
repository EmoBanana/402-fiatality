/** Companies, plain-English policies, tabs (holds), agent key enrollment and human resume/freeze. */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  alarmRulesSchema,
  newId,
  normalizePolicy,
  policySchema,
  type CompanyDTO,
  type OkDTO,
  type TabDetailDTO,
  type TabStatus,
} from "@p402/shared";
import { z } from "zod";
import { AppError, type RoutePlugin } from "../context";
import { coreOf } from "../core";
import { stmt } from "../db/db";
import {
  alarmDTO,
  channelDTO,
  companyDTO,
  getTabDTO,
  listTabDTOs,
  reviewDTO,
  settlementDTO,
  type AlarmRow,
  type ChannelRow,
  type CompanyRow,
  type ReviewRow,
  type SettlementRow,
} from "../db/dto";
import { conflict, notFound, parseInput } from "../http/errors";
import { catalog } from "../sellers/registry";
import { getTabRow } from "../tabs/state";

const TAB_STATUSES = ["pending_approval", "active", "paused", "frozen", "closing", "settled", "cancelled", "failed"] as const;
/** A company has one tab at a time: these block opening another. */
const OPEN_TAB_STATUSES: TabStatus[] = ["active", "paused", "frozen", "closing"];
/** Agents may enroll while the hold awaits approval or the tab can spend. */
const ENROLLABLE: TabStatus[] = ["pending_approval", "active", "paused"];

const companyCreateSchema = z.object({ name: z.string().trim().min(1).max(80) });

const policyParseSchema = z.object({ text: z.string().trim().min(1).max(2_000) });

/** Partial policies are merged over DEFAULT_POLICY by normalizePolicy, which validates the result with policySchema. */
const tabCreateSchema = z.object({
  companyId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80).optional(),
  policy: policySchema.partial().extend({ alarms: alarmRulesSchema.partial().optional() }),
  policyText: z.string().trim().max(4_000).optional(),
});

const tabListQuery = z.object({
  companyId: z.string().min(1).max(64).optional(),
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()) : undefined))
    .pipe(z.array(z.enum(TAB_STATUSES)).optional()),
});

const keyRegisterSchema = z.object({
  agentId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, "letters, digits and . _ : - only (max 64)"),
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "must be a base64url raw 32-byte Ed25519 public key")
    .refine((k) => Buffer.from(k, "base64url").length === 32, "must decode to 32 bytes"),
  enrollToken: z.string().min(1).max(512),
});

type IdParams = { Params: { id: string } };

function enrollTokenMatches(token: string, expectedHex: string): boolean {
  const given = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === given.length && timingSafeEqual(given, expected);
}

export const tabRoutes: RoutePlugin = async (app, { ctx }) => {
  app.get("/api/companies", async () =>
    (stmt(ctx.db, "SELECT * FROM companies ORDER BY created_at, id").all() as CompanyRow[]).map(companyDTO),
  );

  app.post("/api/companies", async (request, reply) => {
    const { name } = parseInput(companyCreateSchema, request.body);
    const company: CompanyDTO = { id: newId("co"), name, createdAt: ctx.clock.now() };
    stmt(ctx.db, "INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)").run(company.id, company.name, company.createdAt);
    return reply.code(201).send(company);
  });

  app.post("/api/policy/parse", async (request) => {
    const { text } = parseInput(policyParseSchema, request.body);
    return ctx.ai.parsePolicy(text, catalog(ctx));
  });

  app.post("/api/tabs", async (request, reply) => {
    const input = parseInput(tabCreateSchema, request.body);
    // normalizePolicy merges partial alarms at runtime; its parameter type only spells out the top level.
    const policy = normalizePolicy(input.policy as Parameters<typeof normalizePolicy>[0]);
    if (!stmt(ctx.db, "SELECT 1 FROM companies WHERE id = ?").get(input.companyId)) throw notFound("Company", input.companyId);
    const open = stmt(
      ctx.db,
      `SELECT id, status FROM tabs WHERE company_id = ? AND status IN (${OPEN_TAB_STATUSES.map(() => "?").join(", ")}) LIMIT 1`,
    ).get(input.companyId, ...OPEN_TAB_STATUSES) as { id: string; status: TabStatus } | undefined;
    if (open) {
      throw conflict("tab_already_open", `This company already has an open tab (${open.id}, ${open.status}). Close it first.`, { tabId: open.id });
    }
    const created = await ctx.settlement.createHold({
      companyId: input.companyId,
      policy,
      ...(input.label ? { label: input.label } : {}),
      ...(input.policyText ? { policyText: input.policyText } : {}),
    });
    return reply.code(201).send(created);
  });

  app.get("/api/tabs", async (request) => {
    const query = parseInput(tabListQuery, request.query);
    return listTabDTOs(ctx.db, ctx.clock.now(), { companyId: query.companyId, statuses: query.status });
  });

  app.get<IdParams>("/api/tabs/:id", async (request): Promise<TabDetailDTO> => {
    const tab = getTabDTO(ctx.db, request.params.id, ctx.clock.now());
    if (!tab) throw notFound("Tab", request.params.id);
    const db = ctx.db;
    return {
      ...tab,
      channels: (stmt(db, "SELECT * FROM channels WHERE tab_id = ? ORDER BY seller_id").all(tab.id) as ChannelRow[]).map(channelDTO),
      alarms: (stmt(db, "SELECT * FROM alarms WHERE tab_id = ? ORDER BY created_at DESC").all(tab.id) as AlarmRow[]).map(alarmDTO),
      reviews: (stmt(db, "SELECT * FROM reviews WHERE tab_id = ? ORDER BY created_at DESC").all(tab.id) as ReviewRow[]).map(reviewDTO),
      settlements: (stmt(db, "SELECT * FROM settlements WHERE tab_id = ? ORDER BY created_at DESC").all(tab.id) as SettlementRow[]).map((row) =>
        settlementDTO(db, row),
      ),
    };
  });

  app.post<IdParams>("/api/tabs/:id/keys", async (request): Promise<OkDTO> => {
    const input = parseInput(keyRegisterSchema, request.body);
    const tab = getTabRow(ctx, request.params.id);
    if (!tab) throw notFound("Tab", request.params.id);
    if (!ENROLLABLE.includes(tab.status)) {
      throw conflict("tab_not_enrollable", `Agents can't enroll on a ${tab.status.replace("_", " ")} tab.`);
    }
    if (!enrollTokenMatches(input.enrollToken, tab.enroll_token_hash)) {
      throw new AppError(403, "invalid_enroll_token", "That enroll token does not belong to this tab.");
    }
    const existing = stmt(ctx.db, "SELECT public_key FROM agent_keys WHERE tab_id = ? AND agent_id = ?").get(tab.id, input.agentId) as
      | { public_key: string }
      | undefined;
    if (existing) {
      if (existing.public_key === input.publicKey) return { ok: true };
      throw conflict("agent_exists", `Agent ${input.agentId} is already enrolled on this tab with another key.`);
    }
    stmt(ctx.db, "INSERT INTO agent_keys (tab_id, agent_id, public_key, created_at) VALUES (?, ?, ?, ?)").run(
      tab.id,
      input.agentId,
      input.publicKey,
      ctx.clock.now(),
    );
    return { ok: true };
  });

  app.post<IdParams>("/api/tabs/:id/resume", async (request) => coreOf(ctx).reviews.humanAction(request.params.id, "resume"));

  app.post<IdParams>("/api/tabs/:id/freeze", async (request) => coreOf(ctx).reviews.humanAction(request.params.id, "freeze"));
};
