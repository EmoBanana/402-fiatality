/**
 * Everything the jury page shows, kept live: spend reviews, PayPal disputes, and the tabs and alarms that
 * give each case its context. Reviews and disputes stream their debates (`review.message`,
 * `dispute.message`); a reconnect refetches everything because missed events are not replayed.
 *
 * Disputes come from a newer part of the gateway: a 404 (or 503 not_wired) there leaves the rogue-agent
 * cases working and `disputesReady` false.
 */
import type { AlarmDTO, DisputeDTO, ReviewDTO, TabDTO } from "@p402/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useGatewayEvents, useOnReconnect } from "../../lib/events";
import { addDisputeMessage, addReviewMessage, upsertDispute, upsertReview } from "./docket";

export interface Docket {
  reviews: ReviewDTO[] | undefined;
  disputes: DisputeDTO[] | undefined;
  /** False until GET /api/disputes answers (it may not exist on this gateway yet). */
  disputesReady: boolean;
  disputesError: unknown;
  tabs: Map<string, TabDTO>;
  alarms: Map<string, AlarmDTO>;
  /** Reviews or tabs failed to load: the page can't show the docket. */
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  applyDispute: (dispute: DisputeDTO) => void;
  applyReview: (review: ReviewDTO) => void;
}

function missingRoute(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405 || (err.status === 503 && err.code === "not_wired"));
}

function byId<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map((item) => [item.id, item]));
}

export function useDocket(): Docket {
  const [reviews, setReviews] = useState<ReviewDTO[] | undefined>(undefined);
  const [disputes, setDisputes] = useState<DisputeDTO[] | undefined>(undefined);
  const [disputesReady, setDisputesReady] = useState(false);
  const [disputesError, setDisputesError] = useState<unknown>(null);
  const [tabs, setTabs] = useState<Map<string, TabDTO>>(() => new Map());
  const [alarms, setAlarms] = useState<Map<string, AlarmDTO>>(() => new Map());
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    setLoading(true);
    setError(null);
    try {
      const [reviewList, tabList, alarmList, disputeResult] = await Promise.all([
        api.reviews.list({}, signal),
        api.tabs.list({}, signal),
        api.alarms.list({}, signal).catch(() => [] as AlarmDTO[]),
        api.disputes.list(signal).then(
          (list) => ({ list, error: null as unknown }),
          (err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            return { list: null, error: err };
          },
        ),
      ]);
      if (signal.aborted) return;
      setReviews(reviewList);
      setTabs(byId(tabList));
      setAlarms(byId(alarmList));
      if (disputeResult.list) {
        setDisputes(disputeResult.list);
        setDisputesReady(true);
        setDisputesError(null);
      } else {
        setDisputes((current) => current ?? []);
        setDisputesReady(false);
        setDisputesError(missingRoute(disputeResult.error) ? null : disputeResult.error);
      }
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      setError(err);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  useOnReconnect(() => void load());

  useGatewayEvents(["review.started", "review.finished"], (event) => setReviews((list) => upsertReview(list, event.data)));
  useGatewayEvents("review.message", (event) => setReviews((list) => addReviewMessage(list, event.data.reviewId, event.data.message)));
  useGatewayEvents("alarm.raised", (event) => setAlarms((map) => new Map(map).set(event.data.id, event.data)));
  useGatewayEvents("tab.updated", (event) => setTabs((map) => new Map(map).set(event.data.id, event.data)));
  useGatewayEvents("dispute.updated", (event) => {
    setDisputesReady(true);
    setDisputes((list) => upsertDispute(list, event.data));
  });
  useGatewayEvents("dispute.message", (event) => setDisputes((list) => addDisputeMessage(list, event.data.disputeId, event.data.message, event.at)));

  const applyDispute = useCallback((dispute: DisputeDTO) => {
    setDisputesReady(true);
    setDisputes((list) => upsertDispute(list, dispute));
  }, []);
  const applyReview = useCallback((review: ReviewDTO) => setReviews((list) => upsertReview(list, review)), []);

  return { reviews, disputes, disputesReady, disputesError, tabs, alarms, error, loading, reload: load, applyDispute, applyReview };
}

/** True when a POST answered with a dispute (some routes may answer with an ack instead). */
export function isDispute(value: unknown): value is DisputeDTO {
  return Boolean(value && typeof value === "object" && "id" in value && "status" in value && "amountCents" in value);
}
