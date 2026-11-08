/**
 * "List your API": a seller describes their API (base URL, auth header and key, PayPal email), prices each
 * endpoint (sub-cent allowed) and publishes the void rules that decide what isn't billable.
 * Renders inside a Drawer; the submit button lives in the drawer footer (form="list-api-form").
 */
import { DEFAULT_VOID_RULES, type HttpMethod, SELLER_ID_PATTERN, type SellerCreateDTO, type SellerDTO, slugify } from "@p402/shared";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { describeError } from "../../components/ErrorState";
import { Input, Select } from "../../components/Field";
import { IconClose, IconPlus } from "../../components/Icons";
import { Switch } from "../../components/Switch";
import { ApiError, api } from "../../lib/api";
import { parseDollars } from "../../lib/format";

export const LIST_API_FORM_ID = "list-api-form";

interface EndpointRow {
  key: number;
  method: HttpMethod;
  path: string;
  price: string;
  description: string;
}

type Errors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let rowKey = 0;
const newRow = (over: Partial<EndpointRow> = {}): EndpointRow => ({ key: ++rowKey, method: "GET", path: "", price: "", description: "", ...over });

export function ListApiForm({ onCreated, onBusyChange }: { onCreated: (seller: SellerDTO) => void; onBusyChange?: (busy: boolean) => void }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("x-api-key");
  const [apiKey, setApiKey] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [rows, setRows] = useState<EndpointRow[]>(() => [newRow({ method: "GET", path: "/v1/quote/:symbol", price: "0.002" })]);
  const [rules, setRules] = useState({ ...DEFAULT_VOID_RULES, timeoutMs: String(DEFAULT_VOID_RULES.timeoutMs), emptyResultPaths: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);

  const sellerId = idEdited ? id : slugify(name);

  function updateRow(key: number, patch: Partial<EndpointRow>) {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function validate(): { dto: SellerCreateDTO | null; errors: Errors } {
    const e: Errors = {};
    if (!name.trim()) e.name = "Give the API a name";
    if (!SELLER_ID_PATTERN.test(sellerId)) e.id = "Lowercase letters, numbers and dashes; 1-40 characters";
    try {
      const url = new URL(baseUrl.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") e.baseUrl = "Use an https:// address";
    } catch {
      e.baseUrl = "Enter the full address, like https://api.example.com";
    }
    if (!EMAIL.test(paypalEmail.trim())) e.paypalEmail = "Enter the PayPal email that receives payouts";
    if (apiKey && !authHeader.trim()) e.authHeader = "Name the header the key goes in";
    const timeout = Number(rules.timeoutMs);
    if (!/^\d+$/.test(rules.timeoutMs.trim()) || timeout < 250 || timeout > 60_000) e.timeoutMs = "Between 250 and 60,000 ms";
    const endpoints = rows.map((r) => {
      const micros = parseDollars(r.price);
      if (!r.path.trim().startsWith("/")) e[`path-${r.key}`] = "Starts with /";
      if (micros === null || micros < 1) e[`price-${r.key}`] = "Enter a price, like 0.005";
      else if (micros > 10_000_000) e[`price-${r.key}`] = "At most $10 a call";
      return { method: r.method, path: r.path.trim(), priceMicros: micros ?? 0, description: r.description.trim() || undefined };
    });
    if (rows.length === 0) e.endpoints = "Add at least one endpoint";
    const paths = rules.emptyResultPaths
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (Object.keys(e).length) return { dto: null, errors: e };
    return {
      errors: e,
      dto: {
        id: sellerId,
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        authHeader: apiKey ? authHeader.trim() : undefined,
        apiKey: apiKey || undefined,
        paypalEmail: paypalEmail.trim(),
        voidRules: {
          on5xx: rules.on5xx,
          on4xx: rules.on4xx,
          requireJson: rules.requireJson,
          emptyIsBillable: rules.emptyIsBillable,
          timeoutMs: timeout,
          emptyResultPaths: paths,
        },
        endpoints,
      },
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { dto, errors: found } = validate();
    setErrors(found);
    setSubmitError(null);
    if (!dto) {
      const first = document.querySelector<HTMLElement>(`#${LIST_API_FORM_ID} [aria-invalid="true"]`);
      first?.focus();
      return;
    }
    onBusyChange?.(true);
    try {
      onCreated(await api.sellers.create(dto));
    } catch (err) {
      setSubmitError(err);
      if (err instanceof ApiError && err.status === 409) setErrors((prev) => ({ ...prev, id: "That id is taken" }));
    } finally {
      onBusyChange?.(false);
    }
  }

  const described = submitError ? describeError(submitError, "Couldn't list the API") : null;

  return (
    <form id={LIST_API_FORM_ID} className="sl-form" onSubmit={submit} noValidate>
      {described ? (
        <Callout tone="danger" title={described.title} role="alert">
          {described.description}
        </Callout>
      ) : null}

      <fieldset className="sl-fieldset">
        <legend>Your API</legend>
        <div className="sl-grid">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ticker Quotes" error={errors.name} maxLength={80} autoFocus />
          <Input
            label="Seller id"
            mono
            value={sellerId}
            onChange={(e) => {
              setIdEdited(true);
              setId(e.target.value.toLowerCase());
            }}
            placeholder="ticker-quotes"
            error={errors.id}
            hint={sellerId ? `Agents pay at /s/${sellerId}/…` : "Used in the paid URL"}
            maxLength={40}
          />
        </div>
        <Input
          label="Base URL"
          mono
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com"
          error={errors.baseUrl}
          hint="Where the gateway forwards paid calls. https only (http://localhost works in demo mode)."
          inputMode="url"
        />
        <div className="sl-grid">
          <Input label="Auth header" mono value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} error={errors.authHeader} hint="The gateway adds your key here" />
          <Input
            label="API key"
            type="password"
            mono
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            hint="Optional. Encrypted at rest, never shown again."
          />
        </div>
        <Input
          label="PayPal email for payouts"
          type="email"
          value={paypalEmail}
          onChange={(e) => setPaypalEmail(e.target.value)}
          placeholder="you@example.com"
          error={errors.paypalEmail}
          autoComplete="email"
        />
      </fieldset>

      <fieldset className="sl-fieldset">
        <legend>Endpoints and prices</legend>
        <p className="sl-help">Price each call in dollars. Fractions of a cent are fine: agents pay exactly this, batched into one PayPal charge.</p>
        <ol className="sl-endpoints">
          {rows.map((row, i) => (
            <li key={row.key} className="sl-endpoint">
              <Select
                label={i === 0 ? "Method" : undefined}
                aria-label="Method"
                value={row.method}
                onChange={(e) => updateRow(row.key, { method: e.target.value as HttpMethod })}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </Select>
              <Input
                label={i === 0 ? "Path" : undefined}
                aria-label="Path"
                mono
                value={row.path}
                onChange={(e) => updateRow(row.key, { path: e.target.value })}
                placeholder="/v1/products/:id"
                error={errors[`path-${row.key}`]}
              />
              <Input
                label={i === 0 ? "Price" : undefined}
                aria-label="Price per call"
                mono
                prefix="$"
                inputMode="decimal"
                value={row.price}
                onChange={(e) => updateRow(row.key, { price: e.target.value })}
                placeholder="0.005"
                error={errors[`price-${row.key}`]}
              />
              <Button
                size="icon"
                variant="ghost"
                className="sl-remove"
                aria-label={`Remove endpoint ${row.path || i + 1}`}
                onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}
                disabled={rows.length === 1}
              >
                <IconClose size={14} />
              </Button>
              <Input
                className="sl-endpoint-desc"
                aria-label="Description"
                value={row.description}
                onChange={(e) => updateRow(row.key, { description: e.target.value })}
                placeholder="What it returns (optional)"
                maxLength={200}
              />
            </li>
          ))}
        </ol>
        {errors.endpoints ? <span className="ui-error">{errors.endpoints}</span> : null}
        <Button size="sm" variant="ghost" onClick={() => setRows((list) => [...list, newRow()])} disabled={rows.length >= 50} className="sl-add">
          <IconPlus size={14} /> Add endpoint
        </Button>
      </fieldset>

      <fieldset className="sl-fieldset">
        <legend>What isn't billable</legend>
        <p className="sl-help">Published with your listing, so a void is a contract term, not a judgment call. Agents never pay for these.</p>
        <div className="sl-rules">
          <Switch label="Seller errors (5xx)" checked={rules.on5xx} onChange={(on5xx) => setRules({ ...rules, on5xx })} />
          <Switch label="Rejected requests (4xx)" checked={rules.on4xx} onChange={(on4xx) => setRules({ ...rules, on4xx })} />
          <Switch label="Malformed JSON" checked={rules.requireJson} onChange={(requireJson) => setRules({ ...rules, requireJson })} />
          <Switch
            label="Empty results"
            hint="Empty bodies, [] and {}"
            checked={!rules.emptyIsBillable}
            onChange={(voidEmpty) => setRules({ ...rules, emptyIsBillable: !voidEmpty })}
          />
        </div>
        <div className="sl-grid">
          <Input
            label="Time out after"
            mono
            suffix="ms"
            inputMode="numeric"
            value={rules.timeoutMs}
            onChange={(e) => setRules({ ...rules, timeoutMs: e.target.value })}
            error={errors.timeoutMs}
            hint="Slower answers are voided"
          />
          <Input
            label="Result lists that must not be empty"
            mono
            value={rules.emptyResultPaths}
            onChange={(e) => setRules({ ...rules, emptyResultPaths: e.target.value })}
            placeholder="products, data.items"
            hint="Comma-separated paths in your JSON"
          />
        </div>
      </fieldset>
    </form>
  );
}
