/**
 * Steps 1-3 of the console: pick the company, describe the budget in plain English (Gemma drafts the
 * policy), then approve the PayPal hold in a popup. Hands the created tab to the page, which switches to
 * ?tab=<id> while the PayPal window is still open.
 */
import { type CompanyDTO, DEFAULT_POLICY, type PolicyParseDTO, type TabCreatedDTO } from "@p402/shared";
import { type FormEvent, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Card } from "../../components/Card";
import { describeError, ErrorState } from "../../components/ErrorState";
import { Input, Select, Textarea } from "../../components/Field";
import { Money } from "../../components/Money";
import { Skeleton, SkeletonText } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { getGatewayConfig, useGatewayConfig } from "../../lib/config";
import { modelLabel } from "../../lib/format";
import { preparePaypalPopup } from "../../lib/paypal";
import { type Resource, useResource } from "../../lib/resource";
import { BUDGET_EXAMPLES, draftFromPolicy, type PolicyDraft, policyFromDraft } from "./policy";
import { PolicyEditor } from "./PolicyEditor";
import { rememberEnrollToken, trackApproval } from "./session";
import { StepSection } from "./StepSection";

export interface NewTabProps {
  companies: Resource<CompanyDTO[]>;
  companyId: string | null;
  onCompanyChange: (id: string) => void;
  onCreated: (created: TabCreatedDTO) => void;
}

function sameDraft(a: PolicyDraft, b: PolicyDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function NewTab({ companies, companyId, onCompanyChange, onCreated }: NewTabProps) {
  const toast = useToast();
  const config = useGatewayConfig().data;
  const catalog = useResource((signal) => api.catalog(signal), []);

  const [adding, setAdding] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [savingCompany, setSavingCompany] = useState(false);

  const [budget, setBudget] = useState<string>(BUDGET_EXAMPLES[0]);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<unknown>(null);
  const [parse, setParse] = useState<PolicyParseDTO | null>(null);
  const [baseDraft, setBaseDraft] = useState<PolicyDraft | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);

  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  const company = companies.data?.find((c) => c.id === companyId) ?? null;
  const checked = useMemo(() => (draft ? policyFromDraft(draft) : null), [draft]);
  const edited = Boolean(draft && baseDraft && !sameDraft(draft, baseDraft));
  // Starts a sentence wherever it is shown, hence the capital.
  const modelName = config ? (config.llm.provider === "mock" ? "The built-in rules" : modelLabel(config.llm.model)) : "Gemma 4";

  async function addCompany(e: FormEvent) {
    e.preventDefault();
    const name = companyName.trim();
    if (!name) return;
    setSavingCompany(true);
    try {
      const created = await api.companies.create({ name });
      companies.setData((list) => [...(list ?? []), created]);
      onCompanyChange(created.id);
      setAdding(false);
      setCompanyName("");
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't add the company") });
    } finally {
      setSavingCompany(false);
    }
  }

  function applyParse(result: PolicyParseDTO) {
    const next = draftFromPolicy(result.policy);
    setParse(result);
    setBaseDraft(next);
    setDraft(next);
  }

  async function draftPolicy() {
    const text = budget.trim();
    if (!text) return;
    setParsing(true);
    setParseError(null);
    try {
      applyParse(await api.policy.parse(text));
    } catch (err) {
      setParseError(err);
    } finally {
      setParsing(false);
    }
  }

  function applyDefaults() {
    setParseError(null);
    applyParse({
      policy: DEFAULT_POLICY,
      summary: [],
      model: "defaults",
      usedFallback: true,
    });
  }

  async function approveHold() {
    if (!companyId || !checked?.policy) return;
    // Open the window now, inside the click, so the browser doesn't block it after the await.
    const pending = preparePaypalPopup();
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.tabs.create({
        companyId,
        label: label.trim() || undefined,
        policy: checked.policy,
        policyText: budget.trim() || undefined,
      });
      rememberEnrollToken(created.tab.id, created.enrollToken);
      const origin = await getGatewayConfig()
        .then((c) => c.publicBaseUrl)
        .catch(() => location.origin);
      trackApproval("tab", created.tab.id, created.approveUrl, pending.open(created.approveUrl, origin));
      onCreated(created);
    } catch (err) {
      pending.close();
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  const companyStep = (() => {
    if (companies.error) return <ErrorState error={companies.error} onRetry={companies.reload} compact />;
    if (!companies.data) return <Skeleton height={38} width={320} />;
    if (adding || companies.data.length === 0) {
      return (
        <form className="cs-inline-form" onSubmit={addCompany}>
          <Input
            label="Company name"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Northwind Research"
            autoFocus={adding}
            maxLength={80}
          />
          <div className="cs-inline-actions">
            <Button type="submit" variant="primary" loading={savingCompany} disabled={!companyName.trim()}>
              Add company
            </Button>
            {companies.data.length > 0 ? (
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      );
    }
    return (
      <div className="cs-inline-form">
        <Select aria-label="Company" value={companyId ?? ""} onChange={(e) => onCompanyChange(e.target.value)} className="cs-company-select">
          {companies.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <div className="cs-inline-actions">
          <Button variant="ghost" onClick={() => setAdding(true)}>
            Add a company
          </Button>
        </div>
      </div>
    );
  })();

  const parsed = Boolean(parse && draft);
  const holdCents = checked?.policy?.holdCents ?? null;

  return (
    <div className="cs-steps">
      <StepSection n={1} title="Company" state={company ? "done" : "current"} description="One tab per company: all its agents share one PayPal hold.">
        {companyStep}
      </StepSection>

      <StepSection
        n={2}
        title="Budget"
        state={parsed ? "done" : company ? "current" : "upcoming"}
        description={`Say what agents may spend, in your own words. ${modelName} turns it into limits you can edit.`}
      >
        <div className="cs-budget">
          <Textarea
            label="Budget in plain English"
            rows={3}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            maxLength={1_000}
            placeholder="Up to $50 this week for product research, no call over 2 cents."
          />
          <div className="cs-examples">
            <span className="muted">Try</span>
            {BUDGET_EXAMPLES.map((example) => (
              <button key={example} type="button" className="cs-chip cs-chip--quiet" onClick={() => setBudget(example)} title={example}>
                {/* The first clause as the label; a click fills in the whole example. */}
                {example.split(/[.,]/)[0]}
              </button>
            ))}
          </div>
          <div className="cs-row">
            <Button variant={parsed ? "secondary" : "primary"} onClick={draftPolicy} loading={parsing} disabled={!budget.trim() || !company}>
              {parsed ? "Draft again" : "Draft policy"}
            </Button>
            {parsing ? <span className="muted cs-note">{modelName} is reading your budget…</span> : null}
          </div>
          {parseError ? (
            <Callout
              tone="danger"
              title={describeError(parseError, "Couldn't draft a policy").title}
              actions={
                <Button size="sm" onClick={applyDefaults}>
                  Use default limits
                </Button>
              }
            >
              {describeError(parseError).description}
            </Callout>
          ) : null}
          {parsing && !parse ? (
            <Card title="Policy" subtitle="Drafting…" aria-busy="true">
              <div className="cs-policy-grid">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="ui-stack" style={{ ["--stack-gap" as string]: "8px" }}>
                    <Skeleton width={90} height={12} />
                    <Skeleton height={38} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 24 }}>
                <SkeletonText lines={3} />
              </div>
            </Card>
          ) : null}
          {parse && draft ? (
            <PolicyEditor
              draft={draft}
              onChange={setDraft}
              errors={checked?.errors ?? {}}
              parse={parse}
              edited={edited}
              onReset={() => baseDraft && setDraft(baseDraft)}
              policy={checked?.policy ?? null}
              catalog={catalog.data ?? []}
            />
          ) : null}
        </div>
      </StepSection>

      <StepSection
        n={3}
        title="Hold"
        state={parsed ? "current" : "upcoming"}
        description="Approve one PayPal hold. Agents spend against it; you're charged once, for what they actually used."
      >
        {parsed ? (
          <div className="cs-hold">
            <Input
              label="Tab name"
              hint="Optional. Shows on the statement and in the terminal."
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Espresso machine research"
              maxLength={80}
              className="cs-tab-name"
            />
            <div className="cs-row">
              <Button variant="primary" size="lg" onClick={approveHold} loading={creating} disabled={!checked?.policy || !companyId}>
                Approve hold with PayPal
              </Button>
              {holdCents !== null ? (
                <span className="cs-note">
                  Hold <Money cents={holdCents} /> for {company?.name ?? "this company"}. PayPal opens in a new window.
                </span>
              ) : (
                <span className="cs-note ui-error">Fix the highlighted policy fields first.</span>
              )}
            </div>
            {createError ? (
              <Callout tone="danger" title={describeError(createError, "Couldn't open the tab").title}>
                {describeError(createError).description}
              </Callout>
            ) : null}
          </div>
        ) : (
          <p className="muted cs-note">Draft a policy first.</p>
        )}
      </StepSection>
    </div>
  );
}
