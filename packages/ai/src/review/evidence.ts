/**
 * Review input -> two blocks: trusted facts we compute ourselves, and untrusted evidence (request/response
 * excerpts, the agent's task) fenced in <evidence> tags. Excerpts are flattened to one line and their angle
 * brackets replaced, so nothing inside can close the fence or fake a new speaker.
 */
import type { SpendReviewInput, SpendReviewVoucher } from "@p402/gateway/context";
import { formatCents, formatUsd, type VoidReason } from "@p402/shared";
import { oneLine, plural, truncate } from "../util/text";

/** Void reasons that mean the seller failed (not the agent's request). */
export const SELLER_FAILURES: ReadonlySet<VoidReason> = new Set<VoidReason>([
  "upstream_5xx",
  "upstream_unreachable",
  "timeout",
  "empty_result",
  "malformed_json",
  "schema_mismatch",
]);

export interface RepeatedRequest {
  label: string;
  sellerId: string;
  count: number;
  ids: string[];
}

export interface VoucherAnalysis {
  vouchers: SpendReviewVoucher[];
  mostRepeated: RepeatedRequest | null;
  distinctRequests: number;
  /** Voided by the quality guard for a seller-side reason. */
  sellerFailures: SpendReviewVoucher[];
  /** Accepted, but the response looks empty or like junk. */
  suspicious: SpendReviewVoucher[];
  /** Voided as 4xx: the seller rejected the agent's request. */
  rejected: SpendReviewVoucher[];
  acceptedMicros: number;
  spanSec: number;
}

export function analyzeVouchers(vouchers: SpendReviewVoucher[]): VoucherAnalysis {
  const groups = new Map<string, RepeatedRequest>();
  for (const v of vouchers) {
    const label = requestLabel(v);
    const key = `${v.sellerId} ${label}`;
    const group = groups.get(key) ?? { label, sellerId: v.sellerId, count: 0, ids: [] };
    group.count += 1;
    group.ids.push(v.id);
    groups.set(key, group);
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  const times = vouchers.map((v) => v.createdAt);
  return {
    vouchers,
    mostRepeated: top && top.count >= 2 ? top : null,
    distinctRequests: groups.size,
    sellerFailures: vouchers.filter((v) => v.status === "voided" && v.voidReason && SELLER_FAILURES.has(v.voidReason)),
    suspicious: vouchers.filter((v) => v.status === "accepted" && looksLikeJunk(v.responseExcerpt)),
    rejected: vouchers.filter((v) => v.status === "voided" && v.voidReason === "upstream_4xx"),
    acceptedMicros: vouchers.filter((v) => v.status === "accepted").reduce((sum, v) => sum + v.priceMicros, 0),
    spanSec: times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0,
  };
}

/** "POST /v1/search {"query":"espresso"}" (the request excerpt already starts with method and path). */
export function requestLabel(v: SpendReviewVoucher): string {
  const excerpt = v.requestExcerpt ? clean(v.requestExcerpt, 90) : "";
  if (excerpt.toUpperCase().startsWith(v.method.toUpperCase())) return excerpt;
  return truncate(`${v.method} ${v.path}${excerpt ? ` ${excerpt}` : ""}`, 90);
}

/** Accepted responses that carry no usable data. Deliberately conservative. */
export function looksLikeJunk(excerpt: string | null | undefined): boolean {
  if (excerpt === null || excerpt === undefined) return false;
  const t = excerpt.trim();
  if (/^(?:|\{\s*\}|\[\s*\]|null|""|undefined)$/i.test(t)) return true;
  return /lorem ipsum|�|<html|internal server error|:\s*(?:NaN|undefined)\b/i.test(t);
}

/** Facts computed by us from the ledger. Trusted. */
export function buildFacts(input: SpendReviewInput, a: VoucherAnalysis = analyzeVouchers(input.vouchers)): string {
  const { tab, alarm } = input;
  const t = tab.totals;
  const p = tab.policy;
  const lines = [
    `Alarm: ${alarm.kind}: ${clean(alarm.message, 200)}`,
    `Tab: hold ${formatCents(tab.holdCents)}, billable ${formatUsd(t.billableMicros)} over ${plural(t.calls, "call")} ` +
      `(${t.accepted} accepted, ${t.voided} voided), ${formatUsd(t.remainingMicros)} left. ` +
      `Limits: ${formatUsd(p.perCallMaxMicros)} per call, ${formatUsd(p.dailyCapMicros)} per day, ${p.maxCallsPerMinute} calls a minute.`,
    `Shown below: the last ${plural(a.vouchers.length, "call")} over ${a.spanSec} s, ${formatUsd(a.acceptedMicros)} billable, ${a.distinctRequests} distinct requests.`,
  ];
  if (a.mostRepeated) {
    lines.push(`The same request went to ${a.mostRepeated.sellerId} ${a.mostRepeated.count} times: ${idList(a.mostRepeated.ids, 8)}.`);
  }
  if (a.sellerFailures.length > 0) {
    const failures = a.sellerFailures.map((v) => `${v.id} (${v.voidReason})`).join(", ");
    lines.push(`Voided by the gateway's quality guard (seller failures): ${failures}.`);
  }
  if (a.rejected.length > 0) lines.push(`Rejected by the seller as bad requests (4xx): ${idList(a.rejected.map((v) => v.id), 8)}.`);
  if (a.suspicious.length > 0) lines.push(`Accepted but empty or junk-looking responses: ${idList(a.suspicious.map((v) => v.id), 8)}.`);
  return `Facts from the gateway's ledger (trusted):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** The untrusted part, fenced. Most recent calls last; at most `maxCalls` of them. */
export function buildEvidence(input: SpendReviewInput, maxCalls = 20): string {
  const calls = input.vouchers.slice(-maxCalls);
  const lines: string[] = [];
  lines.push(`Agent task: ${input.task ? `"${clean(input.task, 300)}"` : "(unknown)"}`);
  const detail = Object.keys(input.alarm.detail ?? {}).length ? clean(JSON.stringify(input.alarm.detail), 300) : "";
  if (detail) lines.push(`Alarm detail: ${detail}`);
  lines.push("Calls (oldest first):");
  // Identical request + response pairs are shown once; repeats point back to the first (keeps prompts small).
  const firstSeen = new Map<string, string>();
  for (const v of calls) {
    const status = v.status === "voided" ? `voided (${v.voidReason ?? "unknown"})` : "accepted";
    const http = v.httpStatus ? ` · HTTP ${v.httpStatus}` : "";
    const head = `[${v.id}] ${v.sellerId} ${v.method} ${clean(v.path, 80)} · ${formatUsd(v.priceMicros)} · ${status}${http}`;
    const request = v.requestExcerpt ? clean(v.requestExcerpt, 140) : "(none)";
    const response = v.responseExcerpt ? clean(v.responseExcerpt, 160) : "(none)";
    const key = `${v.sellerId}\n${request}\n${response}\n${status}`;
    const first = firstSeen.get(key);
    if (first) {
      lines.push(`${head} · same request and response as [${first}]`);
      continue;
    }
    firstSeen.set(key, v.id);
    const latency = v.latencyMs !== null && v.latencyMs !== undefined ? ` · ${v.latencyMs} ms` : "";
    lines.push(`${head}${latency}`);
    lines.push(`  request: ${request}`);
    lines.push(`  response: ${response}`);
  }
  return `<evidence>\n${lines.join("\n")}\n</evidence>`;
}

/** One line, no angle brackets, capped. Used for every piece of untrusted text. */
export function clean(text: string, max: number): string {
  const flat = oneLine(text.replace(/[\u0000-\u001f\u007f]/g, " ")).replace(/</g, "‹").replace(/>/g, "›");
  return truncate(flat, max);
}

export function idList(ids: string[], max = 4): string {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} and ${ids.length - max} more`;
}
