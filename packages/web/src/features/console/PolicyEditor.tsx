/**
 * The AI-drafted policy as an editable card: limits, sellers, alarm rules, and the plain-English summary
 * (Gemma's bullets until you edit; then bullets rebuilt from your values).
 */
import type { CatalogEntryDTO, Policy, PolicyParseDTO } from "@p402/shared";
import type { ChangeEvent } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Card } from "../../components/Card";
import { Input } from "../../components/Field";
import { modelLabel } from "../../lib/format";
import { describePolicy, type PolicyDraft, type PolicyErrors } from "./policy";

export interface PolicyEditorProps {
  draft: PolicyDraft;
  onChange: (draft: PolicyDraft) => void;
  errors: PolicyErrors;
  parse: PolicyParseDTO;
  edited: boolean;
  onReset: () => void;
  /** The draft as a valid policy, or null while a field is invalid. */
  policy: Policy | null;
  catalog: CatalogEntryDTO[];
}

export function PolicyEditor({ draft, onChange, errors, parse, edited, onReset, policy, catalog }: PolicyEditorProps) {
  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => onChange({ ...draft, [key]: value });
  const text = (key: Exclude<keyof PolicyDraft, "allowedSellers">) => ({
    value: draft[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
    error: errors[key],
  });
  const sellerNames = Object.fromEntries(catalog.map((c) => [c.sellerId, c.sellerName]));
  const anySeller = draft.allowedSellers.includes("*");
  const toggleSeller = (id: string) => {
    if (id === "*") return set("allowedSellers", ["*"]);
    const current = draft.allowedSellers.filter((s) => s !== "*");
    const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
    set("allowedSellers", next.length ? next : ["*"]);
  };
  const defaults = parse.model === "defaults";
  const bullets = !edited && parse.summary.length ? parse.summary : policy ? describePolicy(policy, sellerNames) : null;
  const source = parse.usedFallback ? "the fallback parser" : modelLabel(parse.model);

  return (
    <Card
      title="Policy"
      subtitle={
        defaults
          ? "Default limits. Every limit below is enforced by the gateway on each call."
          : `Drafted by ${source}. Every limit below is enforced by the gateway on each call.`
      }
      actions={
        edited ? (
          <>
            <Badge tone="accent">Edited</Badge>
            <Button size="sm" variant="ghost" onClick={onReset}>
              Reset
            </Button>
          </>
        ) : null
      }
    >
      <div className="cs-policy">
        {parse.usedFallback && !defaults ? (
          <Callout tone="warning" title="Gemma wasn't reachable">
            A simple parser read your budget instead. Check the numbers before you approve the hold.
          </Callout>
        ) : null}

        <div className="cs-policy-grid">
          <Input label="Hold" prefix="$" mono inputMode="decimal" hint="Placed on PayPal when the tab opens" {...text("hold")} />
          <Input label="Charge at" prefix="$" mono inputMode="decimal" hint="Close the tab once spending reaches this" {...text("closeAt")} />
          <Input label="Charge after" suffix="days" mono inputMode="numeric" hint="Or close on this day, whichever comes first" {...text("closeAfterDays")} />
          <Input label="Most per call" prefix="$" mono inputMode="decimal" hint="Sub-cent amounts are fine: 0.005" {...text("perCallMax")} />
          <Input label="Daily cap" prefix="$" mono inputMode="decimal" hint="Across every seller, per UTC day" {...text("dailyCap")} />
          <Input label="Calls per minute" mono inputMode="numeric" hint="Hard rate limit for all agents" {...text("maxCallsPerMinute")} />
        </div>

        <fieldset className="cs-sellers">
          <legend className="ui-label">Sellers this tab may pay</legend>
          <div className="ui-cluster">
            <button type="button" className="cs-chip" aria-pressed={anySeller} onClick={() => toggleSeller("*")}>
              Any listed seller
            </button>
            {catalog.map((entry) => (
              <button
                key={entry.sellerId}
                type="button"
                className="cs-chip"
                aria-pressed={!anySeller && draft.allowedSellers.includes(entry.sellerId)}
                onClick={() => toggleSeller(entry.sellerId)}
              >
                {entry.sellerName}
              </button>
            ))}
          </div>
          {errors.allowedSellers ? <span className="ui-error">{errors.allowedSellers}</span> : null}
        </fieldset>

        <details className="cs-advanced">
          <summary>Alarm rules and renewal</summary>
          <div className="cs-policy-grid">
            <Input label="Repeated request" suffix="times" mono inputMode="numeric" hint="Same request this often pauses the tab" {...text("repeatRequestThreshold")} />
            <Input label="Within" suffix="seconds" mono inputMode="numeric" {...text("repeatWindowSec")} />
            <Input label="Voids in a row" mono inputMode="numeric" hint="This many failed calls pauses the tab" {...text("errorStreak")} />
            <Input label="Spend spike" suffix="× usual" mono inputMode="decimal" hint="Last minute against the ten before" {...text("spendSpikeMultiplier")} />
            <Input label="Warn at" suffix="% of hold" mono inputMode="numeric" hint="A notice only; nothing pauses" {...text("budgetWarnPct")} />
            <Input
              label="Small tab below"
              prefix="$"
              mono
              inputMode="decimal"
              hint="Under this on day 4, renew on day 25 instead"
              {...text("smallTabMin")}
            />
          </div>
        </details>

        <div className="cs-summary">
          <p className="cs-summary-title">
            In plain English{(edited || !parse.summary.length) && policy ? <span className="muted"> · from the values above</span> : null}
          </p>
          {bullets ? (
            <ul>
              {bullets.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Fix the highlighted fields to see the summary.</p>
          )}
        </div>
      </div>
    </Card>
  );
}
