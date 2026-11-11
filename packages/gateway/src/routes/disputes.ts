/**
 * PayPal disputes on tab charges (Disputes API v1): list, sync, the AI jury, the seller's responses, the demo-only
 * settle, and (mock mode only) the buyer opening a dispute. Writes go through the admin guard like every /api write.
 */
import type { DisputeDTO, DisputeSyncResultDTO } from "@p402/shared";
import { z } from "zod";
import type { RoutePlugin } from "../context";
import { DISPUTE_ID_PATTERN, disputesOf } from "../disputes";

const disputeId = z.string().regex(DISPUTE_ID_PATTERN, "Invalid dispute id");
const params = z.object({ id: disputeId });
const syncBody = z.object({ disputeId: disputeId.optional() });
const listQuery = z.object({
  tabId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id").optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const note = z.string().trim().min(1).max(2_000);
const cents = z.number().int().min(1).max(100_000_000);
const actionBody = z.object({
  kind: z.enum(["send_evidence", "make_offer", "accept_claim"]),
  note: note.optional(),
  amountCents: cents.optional(),
});
const adjudicateBody = z.object({ outcome: z.enum(["buyer", "seller"]) });
const mockBody = z.object({
  settlementId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  reason: z
    .enum([
      "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      "UNAUTHORISED",
      "CREDIT_NOT_PROCESSED",
      "DUPLICATE_TRANSACTION",
      "INCORRECT_AMOUNT",
      "PAYMENT_BY_OTHER_MEANS",
      "CANCELED_RECURRING_BILLING",
      "PROBLEM_WITH_REMITTANCE",
      "OTHER",
    ])
    .optional(),
  message: z.string().trim().max(2_000).optional(),
  amountCents: cents.optional(),
});

export const disputeRoutes: RoutePlugin = async (app, { ctx }) => {
  const disputes = disputesOf(ctx);
  app.addHook("onClose", async () => disputes.shutdown());

  app.get("/api/disputes", async (req): Promise<DisputeDTO[]> => {
    const { tabId, limit } = listQuery.parse(req.query);
    return disputes.list({ tabId, limit });
  });

  app.get("/api/disputes/:id", async (req): Promise<DisputeDTO> => disputes.get(params.parse(req.params).id));

  app.post("/api/disputes/sync", async (req): Promise<DisputeSyncResultDTO> => disputes.sync(syncBody.parse(req.body ?? {})));

  app.post("/api/disputes/mock", async (req, reply) => {
    const dispute = await disputes.openMock(mockBody.parse(req.body ?? {}));
    return reply.code(201).send(dispute);
  });

  app.post("/api/disputes/:id/jury", async (req): Promise<DisputeDTO> => disputes.startJury(params.parse(req.params).id));

  app.post("/api/disputes/:id/actions", async (req): Promise<DisputeDTO> => {
    const { id } = params.parse(req.params);
    return disputes.act(id, actionBody.parse(req.body ?? {}));
  });

  app.post("/api/disputes/:id/adjudicate", async (req): Promise<DisputeDTO> => {
    const { id } = params.parse(req.params);
    return disputes.adjudicate(id, adjudicateBody.parse(req.body ?? {}));
  });
};
