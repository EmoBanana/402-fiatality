/**
 * App frame: top nav (Console, Terminal, Jury, Sellers, Insights, Timeline), mode badges ("PayPal
 * sandbox|mock", "Gemma 4 · 12b"), live-connection dot and theme toggle, then the page. Mounts
 * <ToastProvider> and scroll restoration.
 *
 * Route handles (router.tsx):
 *   handle: { wide: true }          full-window width (terminal, insights, timeline)
 *   handle: { chrome: "landing" }   marketing header without live status, page draws its own sections
 * Below 900 px the nav and badges fold into a menu button (only the landing page is designed that narrow).
 */
import { useEffect, useId, useState } from "react";
import { NavLink, Outlet, ScrollRestoration, useLocation, useMatches, useNavigation } from "react-router";
import { isGatewayDown } from "../lib/api";
import { useGatewayConfig, useGatewayHealth } from "../lib/config";
import { useGatewayStatus } from "../lib/events";
import { modelLabel } from "../lib/format";
import { Badge } from "./Badge";
import { buttonClassName } from "./Button";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { ToastProvider } from "./Toast";

export const NAV_LINKS = [
  { to: "/console", label: "Console" },
  { to: "/terminal", label: "Terminal" },
  { to: "/jury", label: "Jury" },
  { to: "/sellers", label: "Sellers" },
  { to: "/insights", label: "Insights" },
  { to: "/timeline", label: "Timeline" },
] as const;

interface RouteHandle {
  wide?: boolean;
  chrome?: "app" | "landing";
}

function ModeBadges() {
  const { data: config, error } = useGatewayConfig();
  const health = useGatewayHealth().data;
  if (error && isGatewayDown(error)) {
    return (
      <Badge tone="danger" dot title="Start it with npm run dev">
        Gateway offline
      </Badge>
    );
  }
  if (!config) return null;
  const sandbox = config.paypalMode === "sandbox";
  const llmMock = config.llm.provider === "mock";
  const llmDown = !llmMock && health?.llm.reachable === false;
  return (
    <>
      <Badge tone={sandbox ? "accent" : "neutral"} dot title={sandbox ? "Holds, charges, invoices and payouts go through PayPal" : "Offline: nothing leaves this machine"}>
        PayPal
      </Badge>
      <Badge
        tone={llmDown ? "warning" : "neutral"}
        dot
        title={
          llmMock
            ? "Rule-based stand-in for the model"
            : llmDown
              ? `${health?.llm.detail ?? "The model isn't reachable"}. Policies use the fallback parser; reviews escalate to you.`
              : `${config.llm.provider} · ${config.llm.model}`
        }
      >
        {llmMock ? "Built-in rules" : modelLabel(config.llm.model)}
      </Badge>
    </>
  );
}

const CONNECTION_LABEL = { open: "Live updates on", connecting: "Connecting to live updates", closed: "Live updates offline" } as const;

function ConnectionDot() {
  const status = useGatewayStatus();
  return (
    <span className="ui-conn-wrap" title={CONNECTION_LABEL[status]}>
      <span className="ui-conn" data-status={status} role="img" aria-label={CONNECTION_LABEL[status]} />
    </span>
  );
}

function Nav() {
  return (
    <nav className="ui-nav" aria-label="Main">
      {NAV_LINKS.map((link) => (
        <NavLink key={link.to} to={link.to}>
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {open ? (
        <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M2.5 5h11M2.5 11h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function AppShell() {
  const matches = useMatches();
  const handles = matches.map((m) => (m.handle ?? {}) as RouteHandle);
  const wide = handles.some((h) => h.wide);
  const landing = handles.some((h) => h.chrome === "landing");
  const navigation = useNavigation();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <ToastProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="ui-shell">
        <header className={["ui-shell-header", landing && "ui-shell-header--landing"].filter(Boolean).join(" ")}>
          <div className="ui-shell-bar">
            <NavLink to="/" className="ui-brand" aria-label="402 Fiatality home">
              <Logo />
            </NavLink>
            <Nav />
            <div className="ui-shell-meta">
              {landing ? (
                <NavLink to="/console" className={buttonClassName({ variant: "secondary", size: "sm" })}>
                  Open console
                </NavLink>
              ) : (
                <>
                  <span className="ui-cluster ui-shell-badges">
                    <ModeBadges />
                  </span>
                  <ConnectionDot />
                </>
              )}
              <ThemeToggle />
              <button
                type="button"
                className="ui-btn ui-btn--ghost ui-btn--icon ui-menu-button"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <MenuIcon open={menuOpen} />
              </button>
            </div>
          </div>
          <div id={menuId} className="ui-menu-panel" data-open={menuOpen}>
            <Nav />
            {landing ? null : (
              <div className="ui-cluster">
                <ModeBadges />
              </div>
            )}
          </div>
          {navigation.state === "loading" ? <span className="ui-progress" aria-hidden="true" /> : null}
        </header>
        <main
          id="main"
          tabIndex={-1}
          className={["ui-shell-main", wide && "ui-shell-main--wide", landing && "ui-shell-main--bleed"].filter(Boolean).join(" ")}
        >
          <Outlet />
        </main>
      </div>
      <ScrollRestoration />
    </ToastProvider>
  );
}
