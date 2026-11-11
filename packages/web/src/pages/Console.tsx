/**
 * Buyer console (SPEC §9.2): company -> plain-English budget -> AI policy -> PayPal hold -> agent runs ->
 * purchase approval -> one charge -> statement. The selected tab lives in the URL (?tab=<id>), which is also
 * where /paypal/return sends people when the popup can't talk back to this window.
 */
import type { TabCreatedDTO } from "@p402/shared";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../components/PageHeader";
import "../features/console/console.css";
import { NewTab } from "../features/console/NewTab";
import { TabList } from "../features/console/TabList";
import { TabWorkspace } from "../features/console/TabWorkspace";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";

const COMPANY_KEY = "p402.company";
const DEMO_COMPANY = "co_northwind";

function storedCompany(): string | null {
  try {
    return localStorage.getItem(COMPANY_KEY);
  } catch {
    return null;
  }
}

function storeCompany(id: string) {
  try {
    localStorage.setItem(COMPANY_KEY, id);
  } catch {
    // a convenience only
  }
}

function HowItWorks() {
  return (
    <section className="ui-card cs-explain" aria-labelledby="cs-explain-title">
      <header className="cs-aside-head">
        <h2 id="cs-explain-title">What you're approving</h2>
      </header>
      <ul>
        <li>
          <b>A hold, not a charge.</b> PayPal sets the amount aside; nothing moves until the tab closes.
        </li>
        <li>
          <b>Sub-cent IOUs.</b> Every paid call is checked against your policy before a seller sees it. Errors and empty answers are voided.
        </li>
        <li>
          <b>One charge.</b> At the spending limit or the end date, PayPal captures what was used and releases the rest.
        </li>
      </ul>
    </section>
  );
}

export default function Console() {
  const [params, setParams] = useSearchParams();
  const tabId = params.get("tab");
  const companies = useResource((signal) => api.companies.list(signal), []);
  const [companyId, setCompanyId] = useState<string | null>(() => storedCompany());

  // Default to the remembered company, then the demo company, then the first one.
  useEffect(() => {
    const list = companies.data;
    if (!list || list.length === 0) return;
    if (companyId && list.some((c) => c.id === companyId)) return;
    const fallback = list.find((c) => c.id === DEMO_COMPANY) ?? list[0]!;
    setCompanyId(fallback.id);
  }, [companies.data, companyId]);

  const changeCompany = (id: string) => {
    setCompanyId(id);
    storeCompany(id);
  };

  const onCreated = (created: TabCreatedDTO) => {
    storeCompany(created.tab.companyId);
    setParams({ tab: created.tab.id });
  };

  return (
    <div className="cs">
      {tabId ? (
        <TabWorkspace key={tabId} tabId={tabId} />
      ) : (
        <>
          <PageHeader
            eyebrow="Console"
            title="Open a tab"
            description="Describe a budget in plain English, approve one PayPal hold, then let agents spend against it."
          />
          <div className="cs-layout">
            <NewTab companies={companies} companyId={companyId} onCompanyChange={changeCompany} onCreated={onCreated} />
            <aside className="cs-aside" aria-label="About tabs">
              <HowItWorks />
              <TabList companyId={companyId} title="Recent tabs" />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
