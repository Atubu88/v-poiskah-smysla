CREATE TABLE IF NOT EXISTS telegram_progress (
  telegram_id INTEGER PRIMARY KEY,
  completed_stage_count INTEGER NOT NULL DEFAULT 0,
  completed_task_count INTEGER NOT NULL DEFAULT 0,
  first_progress_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_completed_stages (
  telegram_id INTEGER NOT NULL,
  stage_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (telegram_id, stage_id)
);

CREATE TABLE IF NOT EXISTS telegram_completed_tasks (
  telegram_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (telegram_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_progress_updated_at
  ON telegram_progress(updated_at);

CREATE INDEX IF NOT EXISTS idx_telegram_completed_stages_stage_id
  ON telegram_completed_stages(stage_id);
