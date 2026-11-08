/**
 * Console state that must outlive a component (creating a tab navigates to ?tab=… mid-approval):
 * PayPal approval windows in flight, and enroll tokens from tabs created in this page session (memory only,
 * never stored). The tab / purchase status from the gateway stays the source of truth; an approval entry only
 * shapes the "waiting for PayPal" UI.
 */
import { useSyncExternalStore } from "react";
import type { PaypalApproval } from "../../lib/paypal";

export type ApprovalPhase = "waiting" | "blocked" | "closed" | "approved" | "cancelled" | "failed";

export interface ApprovalEntry {
  kind: "tab" | "purchase";
  ref: string;
  url: string;
  phase: ApprovalPhase;
  message?: string;
  approval: PaypalApproval | null;
}

const approvals = new Map<string, ApprovalEntry>();
const tokens = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Start tracking a PayPal window for a tab hold or a purchase. */
export function trackApproval(kind: ApprovalEntry["kind"], ref: string, url: string, approval: PaypalApproval): void {
  approvals.get(ref)?.approval?.cancel();
  const entry: ApprovalEntry = { kind, ref, url, phase: approval.window ? "waiting" : "blocked", approval };
  approvals.set(ref, entry);
  emit();
  void approval.result.then((result) => {
    if (approvals.get(ref) !== entry) return;
    const next: ApprovalEntry =
      result.type === "p402:paypal-closed"
        ? { ...entry, phase: result.status === "blocked" ? "blocked" : "closed", approval: null }
        : { ...entry, phase: result.status, message: result.message, approval: null };
    approvals.set(ref, next);
    emit();
  });
}

export function clearApproval(ref: string): void {
  if (approvals.delete(ref)) emit();
}

export function useApproval(ref: string | null | undefined): ApprovalEntry | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return ref ? (approvals.get(ref) ?? null) : null;
}

export function rememberEnrollToken(tabId: string, token: string): void {
  tokens.set(tabId, token);
  emit();
}

export function useEnrollToken(tabId: string): string | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return tokens.get(tabId) ?? null;
}
