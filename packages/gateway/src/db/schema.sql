-- 402 Fiatality ledger (SPEC §4). Applied by db.ts on open; every statement must stay idempotent.
-- Money columns are integer micro-dollars unless the name ends in _cents. Times are epoch ms (gateway clock).
-- JSON columns hold TEXT. Bump SCHEMA_VERSION in db.ts whenever a table changes.

CREATE TABLE IF NOT EXISTS companies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sellers (
  id           TEXT PRIMARY KEY,                -- slug, SELLER_ID_PATTERN
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  auth_header  TEXT,                            -- header the gateway injects, e.g. x-api-key
  api_key_enc  TEXT,                            -- AES-256-GCM "iv.tag.ciphertext" (base64 parts); never returned
  paypal_email TEXT NOT NULL,
  void_rules   TEXT NOT NULL,                   -- JSON VoidRules
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS endpoints (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
  path            TEXT NOT NULL,                -- may contain :params, e.g. /v1/products/:id
  price_micros    INTEGER NOT NULL CHECK (price_micros > 0),
  description     TEXT,
  response_schema TEXT,                         -- JSON Schema the response must match to be billable, or NULL
  UNIQUE (seller_id, method, path)
);

CREATE TABLE IF NOT EXISTS tabs (
  id                      TEXT PRIMARY KEY,
  company_id              TEXT NOT NULL REFERENCES companies(id),
  label                   TEXT,
  status                  TEXT NOT NULL CHECK (status IN
                            ('pending_approval', 'active', 'paused', 'frozen', 'closing', 'settled', 'cancelled', 'failed')),
  policy                  TEXT NOT NULL,        -- JSON Policy (normalized)
  policy_text             TEXT,                 -- the plain-English budget it was parsed from
  hold_cents              INTEGER NOT NULL,
  enroll_token_hash       TEXT NOT NULL,        -- lowercase hex SHA-256 of the enroll token
  paypal_order_id         TEXT,
  approve_url             TEXT,                 -- PayPal payer-action link (or the mock approval page)
  authorization_id        TEXT,
  authorized_at           INTEGER,
  honor_until             INTEGER,              -- end of the current 3-day honor window
  expires_at              INTEGER,              -- authorization expiry (29 days)
  reauthorize_at          INTEGER,              -- planned: day 4, or day 25 for small tabs
  reauthorized_at         INTEGER,
  reauth_authorization_id TEXT,
  close_at                INTEGER,              -- planned charge: day 7, or day 28 for small tabs
  carry_in_micros         INTEGER NOT NULL DEFAULT 0,  -- sub-cent remainder from the company's previous tab
  created_at              INTEGER NOT NULL,
  closed_at               INTEGER
);
CREATE INDEX IF NOT EXISTS tabs_company ON tabs (company_id, created_at);
CREATE INDEX IF NOT EXISTS tabs_status ON tabs (status);

CREATE TABLE IF NOT EXISTS agent_keys (
  tab_id     TEXT NOT NULL REFERENCES tabs(id),
  agent_id   TEXT NOT NULL,
  public_key TEXT NOT NULL,                     -- Ed25519, base64url raw 32 bytes
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tab_id, agent_id)
);

-- One payment channel per (tab, seller): the last accepted IOU's sequence number and running total.
CREATE TABLE IF NOT EXISTS channels (
  tab_id                 TEXT NOT NULL REFERENCES tabs(id),
  seller_id              TEXT NOT NULL REFERENCES sellers(id),
  last_seq               INTEGER NOT NULL DEFAULT 0,
  last_cumulative_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tab_id, seller_id)
);

-- status 'pending' = verified and forwarded, response not judged yet. Pending rows count toward policy
-- limits but are never billable and never exposed through the API or events.
CREATE TABLE IF NOT EXISTS vouchers (
  id                TEXT PRIMARY KEY,
  tab_id            TEXT NOT NULL REFERENCES tabs(id),
  seller_id         TEXT NOT NULL REFERENCES sellers(id),
  endpoint_id       TEXT REFERENCES endpoints(id),
  seq               INTEGER NOT NULL,
  price_micros      INTEGER NOT NULL,
  cumulative_micros INTEGER NOT NULL,
  req_hash          TEXT NOT NULL,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,              -- path + query relative to /s/:sellerId
  agent_id          TEXT,
  task_id           TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'voided')),
  void_reason       TEXT,                       -- VoidReason
  http_status       INTEGER,
  latency_ms        INTEGER,
  response_bytes    INTEGER,
  response_excerpt  TEXT,                       -- first 2 KB of the seller's response (untrusted)
  request_excerpt   TEXT,                       -- method + path + first 500 chars of the body (untrusted)
  signature         TEXT NOT NULL,              -- the signed voucher as received, base64 JSON of SignedVoucher
  review_id         TEXT,
  settlement_id     TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (tab_id, seller_id, seq)
);
CREATE INDEX IF NOT EXISTS vouchers_tab_created ON vouchers (tab_id, created_at);
CREATE INDEX IF NOT EXISTS vouchers_seller_settlement ON vouchers (seller_id, settlement_id);
CREATE INDEX IF NOT EXISTS vouchers_tab_req_hash ON vouchers (tab_id, req_hash, created_at);
CREATE INDEX IF NOT EXISTS vouchers_created ON vouchers (created_at);

CREATE TABLE IF NOT EXISTS alarms (
  id         TEXT PRIMARY KEY,
  tab_id     TEXT NOT NULL REFERENCES tabs(id),
  kind       TEXT NOT NULL CHECK (kind IN ('repeat_request', 'error_streak', 'spend_spike', 'velocity', 'budget_threshold')),
  message    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',        -- JSON
  status     TEXT NOT NULL CHECK (status IN ('open', 'reviewing', 'resolved')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alarms_tab ON alarms (tab_id, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  id                 TEXT PRIMARY KEY,
  tab_id             TEXT NOT NULL REFERENCES tabs(id),
  alarm_id           TEXT REFERENCES alarms(id),
  status             TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  verdict            TEXT CHECK (verdict IN ('resume', 'void', 'freeze', 'escalate')),
  fault              TEXT CHECK (fault IN ('seller', 'agent', 'none')),
  confidence         REAL,
  reason             TEXT,
  voided_voucher_ids TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  transcript         TEXT NOT NULL DEFAULT '[]',  -- JSON ReviewMessageDTO[]
  model              TEXT,
  decided_by         TEXT CHECK (decided_by IN ('ai', 'human')),
  created_at         INTEGER NOT NULL,
  finished_at        INTEGER
);
CREATE INDEX IF NOT EXISTS reviews_tab ON reviews (tab_id, created_at);

CREATE TABLE IF NOT EXISTS settlements (
  id               TEXT PRIMARY KEY,
  tab_id           TEXT NOT NULL REFERENCES tabs(id),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  billable_micros  INTEGER NOT NULL DEFAULT 0,   -- accepted vouchers + carry-in
  charged_cents    INTEGER NOT NULL DEFAULT 0,
  carry_out_micros INTEGER NOT NULL DEFAULT 0,   -- sub-cent remainder for the company's next tab
  paypal_fee_cents INTEGER NOT NULL DEFAULT 0,
  capture_id       TEXT,
  naive_fee_cents  INTEGER NOT NULL DEFAULT 0,   -- fees if every call had been its own PayPal payment
  call_count       INTEGER NOT NULL DEFAULT 0,
  void_count       INTEGER NOT NULL DEFAULT 0,
  voided_micros    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS settlements_tab ON settlements (tab_id, created_at);

-- Invariant per completed settlement: SUM(net_micros) + SUM(fee_share_micros) = charged_cents * 10000.
CREATE TABLE IF NOT EXISTS settlement_lines (
  settlement_id    TEXT NOT NULL REFERENCES settlements(id),
  seller_id        TEXT NOT NULL REFERENCES sellers(id),
  gross_micros     INTEGER NOT NULL,
  fee_share_micros INTEGER NOT NULL,
  net_micros       INTEGER NOT NULL,
  calls            INTEGER NOT NULL,
  PRIMARY KEY (settlement_id, seller_id)
);

CREATE TABLE IF NOT EXISTS seller_balances (
  seller_id        TEXT PRIMARY KEY REFERENCES sellers(id),
  available_micros INTEGER NOT NULL DEFAULT 0,
  paid_out_micros  INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id              TEXT PRIMARY KEY,              -- also the PayPal sender_batch_id
  paypal_batch_id TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'partial')),
  total_cents     INTEGER NOT NULL DEFAULT 0,
  fee_cents       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS payout_items (
  payout_id      TEXT NOT NULL REFERENCES payouts(id),
  seller_id      TEXT NOT NULL REFERENCES sellers(id),
  amount_cents   INTEGER NOT NULL,
  fee_cents      INTEGER NOT NULL,
  paypal_item_id TEXT,
  status         TEXT NOT NULL,                  -- PayPal transaction_status, e.g. SUCCESS, UNCLAIMED
  PRIMARY KEY (payout_id, seller_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id                   TEXT PRIMARY KEY,
  tab_id               TEXT REFERENCES tabs(id),
  title                TEXT NOT NULL,
  amount_cents         INTEGER NOT NULL,
  merchant             TEXT,
  product_url          TEXT,
  image_url            TEXT,
  paypal_order_id      TEXT,
  approve_url          TEXT,
  capture_id           TEXT,
  status               TEXT NOT NULL CHECK (status IN ('proposed', 'awaiting_approval', 'captured', 'cancelled', 'failed')),
  research_cost_micros INTEGER NOT NULL DEFAULT 0,
  reasoning            TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_tab ON purchases (tab_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  tab_id       TEXT NOT NULL REFERENCES tabs(id),
  agent_id     TEXT NOT NULL,
  task         TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('llm', 'scripted', 'runaway')),
  status       TEXT NOT NULL CHECK (status IN ('running', 'finished', 'stopped', 'failed')),
  spent_micros INTEGER NOT NULL DEFAULT 0,
  result       TEXT,                             -- JSON { summary, purchaseId }
  error        TEXT,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS agent_runs_tab ON agent_runs (tab_id, created_at);

CREATE TABLE IF NOT EXISTS agent_steps (
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  idx    INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  text   TEXT NOT NULL,
  data   TEXT,                                   -- JSON: the AgentStepDTO's optional fields
  at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, idx)
);

-- Append-only audit trail of every GatewayEvent except metrics snapshots.
CREATE TABLE IF NOT EXISTS events_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  tab_id     TEXT,
  payload    TEXT NOT NULL,                      -- JSON GatewayEvent["data"]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_log_tab ON events_log (tab_id, id);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
