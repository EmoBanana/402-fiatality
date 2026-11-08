/**
 * Gateway configuration from the root `.env` (see `.env.example`).
 *
 * `loadDotEnv()` is called once by the entry point; values already in the shell environment win over the
 * file. `loadConfig(env)` is pure: it parses whatever env object it is given, so tests never touch `.env`.
 * Never log the secret fields (PayPal client secret, API keys, admin token, master key).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PaypalMode } from "@p402/shared";

/** Repo root, resolved from this file so it works from any working directory. */
export const ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));

export const APP_VERSION: string = readVersion();

export type LlmProvider = "ollama" | "openai" | "mock";

export interface LlmConfig {
  provider: LlmProvider;
  /** Ollama: http://localhost:11434. openai: an OpenAI-compatible origin (requests go to {baseUrl}/v1/...). */
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

export interface PaypalConfig {
  mode: PaypalMode;
  clientId: string | null;
  clientSecret: string | null;
  /** Record each settled tab as a paid PayPal invoice (PAYPAL_INVOICE_RECORDS=1). */
  invoiceRecords: boolean;
}

export interface SellerEmails {
  channel3: string | null;
  pricewatch: string | null;
  reviews: string | null;
}

export interface AppConfig {
  rootDir: string;
  /** `<root>/data`: SQLite file, generated master key. Gitignored. */
  dataDir: string;
  /** SQLite path, or ":memory:" in tests. */
  dbPath: string;
  nodeEnv: "development" | "production" | "test";
  /** `npm start`: serve packages/web/dist with SPA fallback. */
  serveWeb: boolean;
  webDistDir: string;
  /** "localhost" listens on both IPv4 and IPv6 loopback. */
  host: string;
  port: number;
  sellersPort: number;
  /** Origin the gateway is reachable at (PayPal return URLs, paywall URLs). No trailing slash. */
  publicBaseUrl: string;
  /** Origin of the web app (CORS, post-approval redirects). No trailing slash. */
  webBaseUrl: string;
  /** Where the demo seller APIs listen. No trailing slash. */
  sellersBaseUrl: string;
  /** DEMO_MODE=1: demo seeding, fast-forward clock, http://localhost sellers, no admin token needed. */
  demo: boolean;
  /** Required header `x-p402-admin` on mutating /api routes when demo is off. */
  adminToken: string | null;
  logLevel: string;
  paypal: PaypalConfig;
  llm: LlmConfig;
  /** Total time for one three-role AI spend review before it escalates to a human (SPEC: 45 s). */
  reviewBudgetMs: number;
  /** Real Channel3 API instead of the built-in demo catalog seller. */
  channel3ApiKey: string | null;
  /** PayPal sandbox emails that receive the demo sellers' payouts. */
  sellerEmails: SellerEmails;
  /** MASTER_KEY as given (32 bytes, hex or base64). Null: the seller registry generates data/master.key. */
  masterKey: string | null;
  /** Share of flaky responses from the demo reviews seller, 0..1. */
  flakyRate: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const blankToUndefined = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const optionalText = z.preprocess(blankToUndefined, z.string().optional());
const port = (fallback: number) => z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(65_535).default(fallback));
const origin = z.preprocess(blankToUndefined, z.url({ protocol: /^https?$/ }).optional());
const flag = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(["1", "0", "true", "false", "yes", "no", "on", "off"])
      .optional()
      .transform((v) => (v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v))),
  );

const envSchema = z.object({
  NODE_ENV: z.preprocess(blankToUndefined, z.enum(["development", "production", "test"]).default("development")),
  HOST: z.preprocess(blankToUndefined, z.string().default("localhost")),
  PORT: port(4020),
  SELLERS_PORT: port(4030),
  PUBLIC_BASE_URL: origin,
  WEB_BASE_URL: origin,
  SELLERS_BASE_URL: origin,
  DEMO_MODE: flag(true),
  ADMIN_TOKEN: optionalText,
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional()),
  PAYPAL_MODE: z.preprocess(blankToUndefined, z.enum(["mock", "sandbox"]).default("mock")),
  PAYPAL_CLIENT_ID: optionalText,
  PAYPAL_CLIENT_SECRET: optionalText,
  PAYPAL_INVOICE_RECORDS: flag(false),
  LLM_PROVIDER: z.preprocess(blankToUndefined, z.enum(["ollama", "openai", "mock"]).default("mock")),
  LLM_BASE_URL: origin,
  LLM_MODEL: z.preprocess(blankToUndefined, z.string().default("gemma4:12b")),
  LLM_API_KEY: optionalText,
  LLM_REVIEW_BUDGET_MS: z.preprocess(blankToUndefined, z.coerce.number().int().min(5_000).max(600_000).default(45_000)),
  CHANNEL3_API_KEY: optionalText,
  SELLER_PAYPAL_EMAIL_CHANNEL3: optionalText,
  SELLER_PAYPAL_EMAIL_PRICEWATCH: optionalText,
  SELLER_PAYPAL_EMAIL_REVIEWS: optionalText,
  MASTER_KEY: optionalText,
  FLAKY_RATE: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(1).default(0.3)),
});

const DEFAULT_LLM_BASE_URL: Record<LlmProvider, string> = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com",
  mock: "http://localhost:11434",
};

/** Load `<root>/.env` into process.env (shell variables take precedence). Returns false when there is no file. */
export function loadDotEnv(file = join(ROOT_DIR, ".env")): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

/** Parse and validate the environment. Throws ConfigError naming the bad keys (never their values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration in .env: ${problems}`);
  }
  const e = parsed.data;

  if (e.PAYPAL_MODE === "sandbox" && (!e.PAYPAL_CLIENT_ID || !e.PAYPAL_CLIENT_SECRET)) {
    throw new ConfigError("PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (or set PAYPAL_MODE=mock).");
  }
  if (!e.DEMO_MODE && !e.ADMIN_TOKEN) {
    throw new ConfigError("DEMO_MODE=0 needs ADMIN_TOKEN (sent as the x-p402-admin header on mutating /api calls).");
  }

  const dataDir = join(ROOT_DIR, "data");
  return {
    rootDir: ROOT_DIR,
    dataDir,
    dbPath: join(dataDir, "p402.sqlite"),
    nodeEnv: e.NODE_ENV,
    serveWeb: e.NODE_ENV === "production",
    webDistDir: join(ROOT_DIR, "packages", "web", "dist"),
    host: e.HOST,
    port: e.PORT,
    sellersPort: e.SELLERS_PORT,
    publicBaseUrl: trimSlash(e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`),
    webBaseUrl: trimSlash(e.WEB_BASE_URL ?? "http://localhost:5173"),
    sellersBaseUrl: trimSlash(e.SELLERS_BASE_URL ?? `http://localhost:${e.SELLERS_PORT}`),
    demo: e.DEMO_MODE,
    adminToken: e.ADMIN_TOKEN ?? null,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === "test" ? "silent" : "info"),
    paypal: {
      mode: e.PAYPAL_MODE,
      clientId: e.PAYPAL_CLIENT_ID ?? null,
      clientSecret: e.PAYPAL_CLIENT_SECRET ?? null,
      invoiceRecords: e.PAYPAL_INVOICE_RECORDS,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      baseUrl: trimSlash(e.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL[e.LLM_PROVIDER]),
      model: e.LLM_MODEL,
      apiKey: e.LLM_API_KEY ?? null,
    },
    reviewBudgetMs: e.LLM_REVIEW_BUDGET_MS,
    channel3ApiKey: e.CHANNEL3_API_KEY ?? null,
    sellerEmails: {
      channel3: e.SELLER_PAYPAL_EMAIL_CHANNEL3 ?? null,
      pricewatch: e.SELLER_PAYPAL_EMAIL_PRICEWATCH ?? null,
      reviews: e.SELLER_PAYPAL_EMAIL_REVIEWS ?? null,
    },
    masterKey: e.MASTER_KEY ?? null,
    flakyRate: e.FLAKY_RATE,
  };
}

/** Offline config for tests: mock PayPal and LLM, in-memory SQLite, demo on, silent logs. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ NODE_ENV: "test" }), dbPath: ":memory:", ...overrides };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
