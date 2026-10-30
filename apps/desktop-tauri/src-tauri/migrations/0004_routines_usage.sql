-- M4: scheduled routines and local usage totals, in the same database as the
-- chat so a routine firing appends to a real thread and every turn's token
-- usage is recorded without a server. Timestamps are RFC3339 text.
CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    interval_seconds INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE usage (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX usage_created ON usage (created_at);
