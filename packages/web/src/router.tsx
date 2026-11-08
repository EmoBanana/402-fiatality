/**
 * Routes. Every page module default-exports its component and is loaded lazily, so the heavy pages
 * (AG Grid, AG Studio, Bryntum) never weigh down the landing page. `handle: { wide: true }` gives a page
 * the full window width inside AppShell.
 */
import type { ComponentType } from "react";
import { createBrowserRouter } from "react-router";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/Spinner";
import RouteError from "./pages/RouteError";

const page = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default });

function BootFallback() {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
      <Spinner size={20} />
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppShell,
    HydrateFallback: BootFallback,
    ErrorBoundary: RouteError,
    children: [
      { index: true, lazy: page(() => import("./pages/Landing")) },
      { path: "console", lazy: page(() => import("./pages/Console")) },
      { path: "terminal", handle: { wide: true }, lazy: page(() => import("./pages/Terminal")) },
      { path: "sellers", lazy: page(() => import("./pages/Sellers")) },
      { path: "insights", handle: { wide: true }, lazy: page(() => import("./pages/Insights")) },
      { path: "timeline", handle: { wide: true }, lazy: page(() => import("./pages/Timeline")) },
      { path: "statements/:tabId", lazy: page(() => import("./pages/Statement")) },
      { path: "*", lazy: page(() => import("./pages/NotFound")) },
    ],
  },
]);
