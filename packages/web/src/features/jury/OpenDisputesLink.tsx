/**
 * "2 open disputes" as a small pill linking to the jury's dispute cases. Renders nothing when there are none
 * or when the gateway doesn't serve disputes. Live from `dispute.updated`; refetched after a reconnect.
 *   <OpenDisputesLink />   (the terminal's header)
 */
import type { DisputeDTO } from "@p402/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../lib/api";
import { useGatewayEvents, useOnReconnect } from "../../lib/events";
import { formatUsd, plural } from "../../lib/format";
import { upsertDispute } from "./docket";

export function OpenDisputesLink() {
  const [disputes, setDisputes] = useState<DisputeDTO[] | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    api.disputes.list(current.signal).then(
      (list) => {
        if (!current.signal.aborted) setDisputes(list);
      },
      () => {
        if (!current.signal.aborted) setDisputes(null);
      },
    );
  }, []);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);
  useOnReconnect(load);
  useGatewayEvents("dispute.updated", (event) => setDisputes((list) => upsertDispute(list ?? [], event.data)));

  const open = (disputes ?? []).filter((d) => d.status !== "RESOLVED");
  if (open.length === 0) return null;
  const held = open.reduce((sum, d) => sum + d.heldMicros, 0);
  return (
    <Link
      to="/jury?show=disputes"
      className="ui-badge"
      data-tone="warning"
      title={held > 0 ? `${formatUsd(held)} held from sellers until they resolve` : "See the AI jury's cases"}
    >
      <span className="ui-badge-dot" aria-hidden="true" />
      {plural(open.length, "open dispute")}
    </Link>
  );
}
