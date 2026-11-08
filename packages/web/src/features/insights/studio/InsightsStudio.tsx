/**
 * AG Studio over the ledger, with its AI assistant running on Gemma through /api/ai/chat.
 * Loaded lazily by the Insights page (AG Studio, AG Grid Enterprise and AG Charts Enterprise live in this
 * chunk only). Licensing: AG Studio through `AgStudioProvider licenseKey` (its documented API), AG Grid
 * Enterprise through `LicenseManager`. Live data arrives as transactions, so widgets update in place.
 */
import {
  type AgAiHarnessSetup,
  AgStudioAiModule,
  type AgPanelConfig,
  type AgStudioApi,
  type AgStudioErrorRaisedEvent,
  type AgStudioMode,
  createAiHarness,
} from "ag-studio";
import { LicenseManager } from "ag-grid-enterprise";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tokens } from "../tokens";
import { gemmaAdapter } from "./gemmaAdapter";
import { INITIAL_REPORT, PROMPT_STARTERS } from "./initialReport";
import { buildDataDefinition, buildRows, diffRows, type StudioRows, type StudioSnapshot } from "./studioData";
import { buildStudioTheme } from "./studioTheme";

const gridLicense = import.meta.env.VITE_AG_GRID_LICENSE_KEY;
if (gridLicense) LicenseManager.setLicenseKey(gridLicense);
const STUDIO_LICENSE = import.meta.env.VITE_AG_STUDIO_LICENSE_KEY || gridLicense || undefined;

const MODULES = [AgStudioAiModule];
const PANELS: AgPanelConfig = {
  edit: { left: ["data"], right: ["ai", "edit", "filters"] },
  view: { right: ["filters"] },
};

export interface InsightsStudioProps {
  snapshot: StudioSnapshot;
  tokens: Tokens;
  mode: AgStudioMode;
}

export default function InsightsStudio({ snapshot, tokens, mode }: InsightsStudioProps) {
  const studio = useRef<AgStudio>(null);
  const ready = useRef(false);
  const rows = useMemo(() => buildRows(snapshot), [snapshot]);
  const latest = useRef<StudioRows>(rows);
  latest.current = rows;
  /** The rows Studio holds right now; transactions are diffs against this. */
  const held = useRef<StudioRows>(rows);
  const [data, setData] = useState(() => buildDataDefinition(rows));

  const theme = useMemo(() => buildStudioTheme(tokens), [tokens]);
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api }) =>
        // The setup params type the API as the headless core; with a UI it is the full AgStudioApi.
        createAiHarness(api as AgStudioApi, { adapter: gemmaAdapter, primary: "lead", promptStarters: PROMPT_STARTERS }),
    [],
  );

  const sync = useCallback(() => {
    const engine = studio.current?.api?.getDataEngine();
    if (!ready.current || !engine?.applyTransaction) return;
    const next = latest.current;
    const transactions = diffRows(held.current, next);
    if (transactions.length === 0) return;
    held.current = next;
    engine.applyTransaction(transactions).catch((err: unknown) => {
      // Out of step with Studio: reload every table from scratch instead.
      console.warn("AG Studio transaction rejected; reloading data", err);
      held.current = latest.current;
      setData(buildDataDefinition(latest.current));
    });
  }, []);

  useEffect(sync, [rows, sync]);

  const onStudioReady = useCallback(() => {
    ready.current = true;
    sync();
  }, [sync]);

  const onErrorRaised = useCallback((event: AgStudioErrorRaisedEvent) => {
    console.warn("AG Studio error", event);
  }, []);

  return (
    <AgStudioProvider modules={MODULES} licenseKey={STUDIO_LICENSE}>
      <AgStudio
        ref={studio}
        data={data}
        mode={mode}
        theme={theme}
        ai={ai}
        panels={PANELS}
        initialState={INITIAL_REPORT}
        enableFilterEditingInViewMode
        onStudioReady={onStudioReady}
        onErrorRaised={onErrorRaised}
        style={{ width: "100%", height: "100%" }}
      />
    </AgStudioProvider>
  );
}
