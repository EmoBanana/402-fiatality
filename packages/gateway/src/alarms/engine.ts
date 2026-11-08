/** Runs the detectors after each judged voucher: raise alarms, pause the tab, start the AI review (SPEC §5.4). */
import { DEFAULT_POLICY, newId, type AlarmDTO, type Policy } from "@p402/shared";
import type { AppContext } from "../context";
import { parseJson, stmt, tx } from "../db/db";
import { alarmDTO, type AlarmRow } from "../db/dto";
import type { ReviewRunner } from "../review/runner";
import { announceTab, getTabRow, transitionTab } from "../tabs/state";
import { detectBudgetThreshold, detectPausing, type AlarmFinding } from "./detectors";

function insertAlarm(ctx: AppContext, tabId: string, finding: AlarmFinding): AlarmDTO {
  const id = newId("alm");
  stmt(ctx.db, "INSERT INTO alarms (id, tab_id, kind, message, detail, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)").run(
    id,
    tabId,
    finding.kind,
    finding.message,
    JSON.stringify(finding.detail),
    ctx.clock.now(),
  );
  return alarmDTO(stmt(ctx.db, "SELECT * FROM alarms WHERE id = ?").get(id) as AlarmRow);
}

/** Notify-only alarm (budget threshold). */
export function raiseAlarm(ctx: AppContext, tabId: string, finding: AlarmFinding): AlarmDTO {
  const alarm = insertAlarm(ctx, tabId, finding);
  ctx.bus.emit("alarm.raised", alarm);
  return alarm;
}

/** Pause an active tab for `finding` and start its review. Null when the tab was no longer active. */
export function pauseForAlarm(ctx: AppContext, reviews: ReviewRunner, tabId: string, finding: AlarmFinding): AlarmDTO | null {
  const alarm = tx(ctx.db, () => (transitionTab(ctx, tabId, ["active"], "paused") ? insertAlarm(ctx, tabId, finding) : null));
  if (!alarm) return null;
  announceTab(ctx, tabId);
  ctx.bus.emit("alarm.raised", alarm);
  reviews.start(tabId, alarm.id);
  return alarm;
}

/** Evaluate every detector for a tab after a voucher was judged. `reqHash` is that voucher's request hash. */
export function evaluateAlarms(ctx: AppContext, reviews: ReviewRunner, tabId: string, reqHash: string | null): void {
  const tab = getTabRow(ctx, tabId);
  if (!tab) return;
  const policy = parseJson<Policy>(tab.policy, DEFAULT_POLICY);
  if (tab.status === "active" || tab.status === "paused") {
    const budget = detectBudgetThreshold(ctx.db, tab, policy);
    if (budget) raiseAlarm(ctx, tab.id, budget);
  }
  if (tab.status !== "active") return;
  const finding = detectPausing(ctx.db, tab, policy, ctx.clock.now(), reqHash);
  if (finding) pauseForAlarm(ctx, reviews, tab.id, finding);
}
