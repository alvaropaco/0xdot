-- M5: persistent MCP server definitions. The runtime connects to these at
-- startup (best effort), so a server the user added once keeps making its
-- tools available to the agent across restarts. `args` and `env` are JSON;
-- `env` may hold secret values that live only in this local app-data file.
CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
