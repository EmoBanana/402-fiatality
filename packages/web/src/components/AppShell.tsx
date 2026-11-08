/**
 * App frame: top nav, mode badges ("PayPal sandbox|mock", "Gemma 4 · 12b"), live-connection dot and theme
 * toggle, then the page. Routes opt into full-width layout with `handle: { wide: true }` (terminal,
 * insights, timeline). Mounts <ToastProvider>.
 */
import type { ConfigDTO } from "@p402/shared";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useMatches } from "react-router";
import { api } from "../lib/api";
import { useGatewayStatus } from "../lib/events";
import { modelLabel } from "../lib/format";
import { type ThemePreference, useTheme } from "../lib/theme";
import { Badge } from "./Badge";
import { ToastProvider } from "./Toast";

export const NAV_LINKS = [
  { to: "/console", label: "Console" },
  { to: "/terminal", label: "Terminal" },
  { to: "/sellers", label: "Sellers" },
  { to: "/insights", label: "Insights" },
  { to: "/timeline", label: "Timeline" },
] as const;

const NEXT_THEME: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<ThemePreference, string> = { system: "Auto", light: "Light", dark: "Dark" };

function useConfig(): { config: ConfigDTO | null; offline: boolean } {
  const [state, setState] = useState<{ config: ConfigDTO | null; offline: boolean }>({ config: null, offline: false });
  useEffect(() => {
    const controller = new AbortController();
    api
      .config(controller.signal)
      .then((config) => setState({ config, offline: false }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ config: null, offline: true });
        if (!(err instanceof DOMException)) console.warn("gateway config unavailable", err);
      });
    return () => controller.abort();
  }, []);
  return state;
}

function ModeBadges() {
  const { config, offline } = useConfig();
  if (offline) return <Badge tone="danger">Gateway offline</Badge>;
  if (!config) return null;
  return (
    <>
      <Badge tone={config.paypalMode === "sandbox" ? "accent" : "neutral"}>PayPal {config.paypalMode}</Badge>
      <Badge>{config.llm.provider === "mock" ? "LLM mock" : modelLabel(config.llm.model)}</Badge>
    </>
  );
}

export function AppShell() {
  const status = useGatewayStatus();
  const { preference, setPreference } = useTheme();
  const wide = useMatches().some((m) => (m.handle as { wide?: boolean } | undefined)?.wide);

  return (
    <ToastProvider>
      <div className="ui-shell">
        <header className="ui-shell-header">
          <NavLink to="/" className="ui-brand" aria-label="PayPal 402 home">
            <span className="ui-monogram" aria-hidden="true">
              402
            </span>
            PayPal 402
          </NavLink>
          <nav className="ui-nav" aria-label="Main">
            {NAV_LINKS.map((link) => (
              <NavLink key={link.to} to={link.to}>
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="ui-shell-meta">
            <ModeBadges />
            <span className="ui-conn" data-status={status} title={`Live events: ${status}`} aria-label={`Live events ${status}`} />
            <button
              type="button"
              className="ui-btn ui-btn--ghost ui-btn--sm"
              onClick={() => setPreference(NEXT_THEME[preference])}
              title="Switch theme"
            >
              {THEME_LABEL[preference]}
            </button>
          </div>
        </header>
        <main className={["ui-shell-main", wide && "ui-shell-main--wide"].filter(Boolean).join(" ")}>
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}
