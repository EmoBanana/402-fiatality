/** In-process agent runs (SPEC §5.6). */
import { z } from "zod";
import type { RoutePlugin } from "../context";
import { coreOf } from "../core";
import { parseInput } from "../http/errors";

const listQuery = z.object({ tabId: z.string().min(1).max(64).optional() });

type IdParams = { Params: { id: string } };

export const agentRoutes: RoutePlugin = async (app, { ctx }) => {
  const runs = () => coreOf(ctx).agents;

  app.post("/api/agent/runs", async (request, reply) => reply.code(201).send(runs().start(request.body)));

  app.get("/api/agent/runs", async (request) => runs().list(parseInput(listQuery, request.query)));

  app.get<IdParams>("/api/agent/runs/:id", async (request) => runs().get(request.params.id));

  app.post<IdParams>("/api/agent/runs/:id/stop", async (request) => runs().stop(request.params.id));
};
