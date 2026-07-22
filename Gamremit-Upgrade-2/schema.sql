-- schema.sql — GamRemit D1 schema
-- Stores persistent, growing business data (users, transactions, KYC, etc.)
-- in Cloudflare D1 instead of KV, since D1's free tier (5M reads/day,
-- 100K writes/day, no separate list() cap) is dramatically more generous
-- than KV's (100K reads/day, but only 1,000 writes/day AND 1,000 list()
-- calls/day — the exact limit that broke KYC/transactions listing).
--
-- Each table stores a JSON blob in `data` alongside a few indexed columns
-- for fast lookups, preserving the existing flexible object shapes used
-- throughout the app without a full relational rewrite.

CREATE TABLE IF NOT EXISTS users (
  email             TEXT PRIMARY KEY,
  id                TEXT UNIQUE NOT NULL,
  circle_wallet_id  TEXT,
  data              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(circle_wallet_id);

CREATE TABLE IF NOT EXISTS wallet_map (
  wallet_id TEXT PRIMARY KEY,
  email     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  reference  TEXT PRIMARY KEY,
  user_id    TEXT,
  created_at TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

CREATE TABLE IF NOT EXISTS kyc (
  user_id TEXT PRIMARY KEY,
  data    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  user_id    TEXT NOT NULL,
  notif_id   TEXT NOT NULL,
  created_at TEXT,
  data       TEXT NOT NULL,
  PRIMARY KEY (user_id, notif_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  created_at TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);

CREATE TABLE IF NOT EXISTS compliance_notes (
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (user_id, note_id)
);

CREATE TABLE IF NOT EXISTS bridges (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridges_user ON bridges(user_id);

CREATE TABLE IF NOT EXISTS swaps (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swaps_user ON swaps(user_id);

CREATE TABLE IF NOT EXISTS payroll (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payroll_user ON payroll(user_id);

CREATE TABLE IF NOT EXISTS payment_requests (
  id           TEXT PRIMARY KEY,
  code         TEXT UNIQUE,
  sender_id    TEXT,
  recipient_id TEXT,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_code ON payment_requests(code);
CREATE INDEX IF NOT EXISTS idx_pr_sender ON payment_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_pr_recipient ON payment_requests(recipient_id);

CREATE TABLE IF NOT EXISTS saved_accounts (
  user_id TEXT PRIMARY KEY,
  data    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arc_names (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rates (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
