/**
 * The company's tabs, newest first, kept live from `tab.updated`. The selected one is marked; pass `live`
 * (the selected tab as the workspace sees it) so its row follows spending between status changes.
 */
import type { TabDTO } from "@p402/shared";
import { Link } from "react-router";
import { TabStatusBadge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { Skeleton } from "../../components/Skeleton";
import { api } from "../../lib/api";
import { useGatewayEvents } from "../../lib/events";
import { formatDate } from "../../lib/format";
import { upsertById, useResource } from "../../lib/resource";

export function TabList({ companyId, selectedId, live, title = "Tabs" }: { companyId: string | null; selectedId?: string | null; live?: TabDTO; title?: string }) {
  const tabs = useResource((signal) => api.tabs.list(companyId ? { companyId } : {}, signal), [companyId], { enabled: Boolean(companyId) });
  useGatewayEvents("tab.updated", (event) => {
    if (event.data.companyId === companyId) tabs.setData((list) => upsertById(list, event.data));
  });

  const own = (tabs.data ?? []).filter((t) => t.companyId === companyId);
  const merged = live && tabs.data ? upsertById(own, live) : own;
  const list = [...merged].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);

  return (
    <section className="ui-card cs-tablist" aria-labelledby="cs-tablist-title">
      <header className="cs-aside-head">
        <h2 id="cs-tablist-title">{title}</h2>
      </header>
      {!companyId ? (
        <EmptyState compact title="No company yet" description="Its tabs show up here once you pick or add one." />
      ) : tabs.error ? (
        <ErrorState error={tabs.error} onRetry={tabs.reload} compact />
      ) : !tabs.data ? (
        <div className="cs-tablist-skeleton" aria-busy="true">
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState compact title="No tabs yet" description="Approve a hold to open this company's first tab." />
      ) : (
        <ul className="cs-tablist-items">
          {list.map((tab: TabDTO) => (
            <li key={tab.id}>
              <Link to={`/console?tab=${encodeURIComponent(tab.id)}`} aria-current={tab.id === selectedId ? "page" : undefined}>
                <span className="cs-tablist-main">
                  <span className="cs-tablist-label">{tab.label || "Untitled tab"}</span>
                  <span className="cs-tablist-meta">
                    {formatDate(tab.createdAt)} · <Money micros={tab.totals.billableMicros} />
                  </span>
                </span>
                <TabStatusBadge status={tab.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
