CREATE TABLE IF NOT EXISTS telegram_usage (
  telegram_id INTEGER PRIMARY KEY,
  bot_started_at TEXT,
  last_seen_at TEXT NOT NULL,
  miniapp_first_opened_at TEXT,
  miniapp_last_opened_at TEXT,
  miniapp_open_count INTEGER NOT NULL DEFAULT 0,
  last_launch_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_usage_bot_started_at
  ON telegram_usage(bot_started_at);

CREATE INDEX IF NOT EXISTS idx_telegram_usage_miniapp_last_opened_at
  ON telegram_usage(miniapp_last_opened_at);
