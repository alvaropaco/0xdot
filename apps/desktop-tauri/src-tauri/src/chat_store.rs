//! SQLite persistence for the local chat runtime (migration plan M1).
//!
//! sqlx with checked-in migrations; document-shaped values stay JSON columns
//! where the server used JSONB. The pool lives in the app data directory so a
//! thread survives an app restart, which is the M1 acceptance bar.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::path::Path;
use std::str::FromStr;

/// Settings keys the chat runtime resolves before a turn.
pub const KEY_BASE_URL: &str = "modelBaseUrl";
pub const KEY_API_KEY: &str = "modelApiKey";
pub const KEY_DEFAULT_MODEL: &str = "modelDefault";

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub model: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    /// `user` or `assistant`.
    pub role: String,
    pub content: String,
    /// True when the turn errored; the content carries the failure text.
    pub failed: bool,
    /// `chat` is conversation; `tool` and `approval` rows are M2 runtime
    /// activity that the UI renders inline but the model never replays.
    pub kind: String,
    /// JSON metadata for non-chat rows (tool name/arguments/decision).
    pub payload: String,
    pub created_at: String,
}

#[derive(Clone)]
pub struct ChatStore {
    pool: SqlitePool,
}

/// One FTS5 transcript hit (M3 local search).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub thread_id: String,
    pub bot_id: String,
    pub thread_title: String,
    pub message_id: String,
    pub kind: String,
    /// A short excerpt with the matched terms marked.
    pub snippet: String,
    pub created_at: String,
}

/// A scheduled routine (M4). Timestamps are RFC3339 text; `model` is a
/// per-routine override that falls back to the bot/default when empty.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRoutine {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub prompt: String,
    pub model: String,
    pub interval_seconds: i32,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: String,
    pub created_at: String,
}

/// Cumulative token usage across every recorded turn (M4).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub turns: i32,
    pub input_tokens: i32,
    pub output_tokens: i32,
}

impl ChatStore {
    /// Opens (creating when needed) the chat database and runs migrations.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.as_ref().display()))
            .map_err(|e| e.to_string())?
            .create_if_missing(true)
            .foreign_keys(true);
        Self::connect(options).await
    }

    #[cfg(test)]
    async fn in_memory() -> Result<Self, String> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .map_err(|e| e.to_string())?
            .foreign_keys(true);
        // One connection keeps the private in-memory database alive for the
        // whole test.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::migrate!("./migrations").run(&pool).await.map_err(|e| e.to_string())?;
        Ok(Self { pool })
    }

    async fn connect(options: SqliteConnectOptions) -> Result<Self, String> {
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::migrate!("./migrations").run(&pool).await.map_err(|e| e.to_string())?;
        Ok(Self { pool })
    }

    fn now() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    pub async fn create_bot(&self, name: &str, system_prompt: &str, model: &str) -> Result<Bot, String> {
        let bot = Bot {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            system_prompt: system_prompt.to_string(),
            model: model.to_string(),
            created_at: Self::now(),
        };
        sqlx::query("INSERT INTO bots (id, name, system_prompt, model, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&bot.id)
            .bind(&bot.name)
            .bind(&bot.system_prompt)
            .bind(&bot.model)
            .bind(&bot.created_at)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(bot)
    }

    pub async fn bots(&self) -> Result<Vec<Bot>, String> {
        let rows = sqlx::query("SELECT id, name, system_prompt, model, created_at FROM bots ORDER BY created_at")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(bot_from_row).collect())
    }

    pub async fn bot(&self, id: &str) -> Result<Bot, String> {
        let row = sqlx::query("SELECT id, name, system_prompt, model, created_at FROM bots WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("bot not found: {id}"))?;
        Ok(bot_from_row(&row))
    }

    pub async fn create_thread(&self, bot_id: &str, title: &str) -> Result<ChatThread, String> {
        let now = Self::now();
        let thread = ChatThread {
            id: uuid::Uuid::new_v4().to_string(),
            bot_id: bot_id.to_string(),
            title: title.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        sqlx::query("INSERT INTO threads (id, bot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&thread.id)
            .bind(&thread.bot_id)
            .bind(&thread.title)
            .bind(&thread.created_at)
            .bind(&thread.updated_at)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(thread)
    }

    pub async fn delete_bot(&self, id: &str) -> Result<(), String> {
        // Foreign keys are enabled per connection, so the cascade clears the
        // bot's threads and messages.
        sqlx::query("DELETE FROM bots WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn threads(&self, bot_id: &str) -> Result<Vec<ChatThread>, String> {
        let rows = sqlx::query("SELECT id, bot_id, title, created_at, updated_at FROM threads WHERE bot_id = ? ORDER BY updated_at DESC")
            .bind(bot_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(thread_from_row).collect())
    }

    pub async fn thread(&self, id: &str) -> Result<ChatThread, String> {
        let row = sqlx::query("SELECT id, bot_id, title, created_at, updated_at FROM threads WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("thread not found: {id}"))?;
        Ok(thread_from_row(&row))
    }

    /// Inserts a message and bumps the thread's recency; the title defaults to
    /// the first user message like the server threads do.
    pub async fn append_message(&self, thread_id: &str, role: &str, content: &str, failed: bool) -> Result<ChatMessage, String> {
        let message = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            failed,
            kind: "chat".to_string(),
            payload: String::new(),
            created_at: Self::now(),
        };
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO messages (id, thread_id, role, content, failed, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&message.id)
            .bind(&message.thread_id)
            .bind(&message.role)
            .bind(&message.content)
            .bind(message.failed)
            .bind(&message.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE threads SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
            .bind(&message.created_at)
            .bind(title_seed(role, content))
            .bind(thread_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(message)
    }

    pub async fn messages(&self, thread_id: &str) -> Result<Vec<ChatMessage>, String> {
        let rows = sqlx::query("SELECT id, thread_id, role, content, failed, kind, payload, created_at FROM messages WHERE thread_id = ? ORDER BY created_at, id")
            .bind(thread_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(message_from_row).collect())
    }

    /// Conversation rows only (`kind = 'chat'`), oldest first - the shape the
    /// model replays. Tool and approval activity is excluded so it never reads
    /// as a turn.
    pub async fn transcript(&self, thread_id: &str) -> Result<Vec<ChatMessage>, String> {
        let rows = sqlx::query("SELECT id, thread_id, role, content, failed, kind, payload, created_at FROM messages WHERE thread_id = ? AND kind = 'chat' ORDER BY created_at, id")
            .bind(thread_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(message_from_row).collect())
    }

    /// Writes a runtime-activity row (`tool` or `approval`) without touching
    /// the thread title or the model transcript. The `content` is a short label
    /// the UI shows; structured detail lives in `payload`.
    pub async fn record_event(&self, thread_id: &str, kind: &str, content: &str, payload: &str) -> Result<ChatMessage, String> {
        let message = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: "assistant".to_string(),
            content: content.to_string(),
            failed: false,
            kind: kind.to_string(),
            payload: payload.to_string(),
            created_at: Self::now(),
        };
        sqlx::query("INSERT INTO messages (id, thread_id, role, content, failed, kind, payload, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
            .bind(&message.id)
            .bind(&message.thread_id)
            .bind(&message.role)
            .bind(&message.content)
            .bind(&message.kind)
            .bind(&message.payload)
            .bind(&message.created_at)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(message)
    }

    /// Updates an activity row's status payload in place (e.g. an approval from
    /// `pending` to `approved`/`rejected`), keeping its position in the
    /// timeline.
    pub async fn set_event_payload(&self, id: &str, payload: &str) -> Result<(), String> {
        sqlx::query("UPDATE messages SET payload = ? WHERE id = ?")
            .bind(payload)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Full-text search across the transcript via the FTS5 index. The query is
    /// treated as a single phrase (each token quoted) so user input can never
    /// be read as FTS5 operators.
    pub async fn search(&self, query: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
        let tokens: Vec<String> = query.split_whitespace().map(|token| format!("\"{}\"", token.replace('"', "\"\""))).collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let match_query = tokens.join(" ");
        let rows = sqlx::query(
            "SELECT m.thread_id, t.bot_id, t.title AS thread_title, m.id AS message_id, m.kind, snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet, m.created_at \
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN threads t ON t.id = m.thread_id \
             WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .bind(&match_query)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .iter()
            .map(|row| SearchHit {
                thread_id: row.get("thread_id"),
                bot_id: row.get("bot_id"),
                thread_title: row.get("thread_title"),
                message_id: row.get("message_id"),
                kind: row.get("kind"),
                snippet: row.get("snippet"),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn setting(&self, key: &str) -> Result<Option<String>, String> {
        let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(value)
    }

    /// Resolves the model for a turn: the bot's own model when set, otherwise
    /// the stored default.
    pub async fn resolve_model(&self, bot: &Bot) -> Result<String, String> {
        if !bot.model.trim().is_empty() {
            return Ok(bot.model.clone());
        }
        self.setting(KEY_DEFAULT_MODEL)
            .await?
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "no model configured; set a default model in settings".into())
    }

    pub async fn connection(&self) -> Result<Option<(String, String)>, String> {
        let base = self.setting(KEY_BASE_URL).await?;
        let key = self.setting(KEY_API_KEY).await?;
        Ok(base.zip(key).map(|(base, key)| (base.trim_end_matches('/').to_string(), key)))
    }

    pub async fn create_routine(
        &self,
        bot_id: &str,
        name: &str,
        prompt: &str,
        model: &str,
        interval_seconds: i32,
    ) -> Result<ScheduledRoutine, String> {
        self.bot(bot_id).await?;
        let interval_seconds = interval_seconds.max(1);
        let now = Utc::now();
        let routine = ScheduledRoutine {
            id: uuid::Uuid::new_v4().to_string(),
            bot_id: bot_id.to_string(),
            name: name.to_string(),
            prompt: prompt.to_string(),
            model: model.to_string(),
            interval_seconds,
            enabled: true,
            last_run_at: None,
            next_run_at: (now + Duration::seconds(interval_seconds as i64)).to_rfc3339(),
            created_at: now.to_rfc3339(),
        };
        sqlx::query("INSERT INTO routines (id, bot_id, name, prompt, model, interval_seconds, enabled, last_run_at, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&routine.id)
            .bind(&routine.bot_id)
            .bind(&routine.name)
            .bind(&routine.prompt)
            .bind(&routine.model)
            .bind(routine.interval_seconds)
            .bind(routine.enabled)
            .bind(&routine.last_run_at)
            .bind(&routine.next_run_at)
            .bind(&routine.created_at)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(routine)
    }

    pub async fn routines(&self) -> Result<Vec<ScheduledRoutine>, String> {
        let rows = sqlx::query("SELECT id, bot_id, name, prompt, model, interval_seconds, enabled, last_run_at, next_run_at, created_at FROM routines ORDER BY created_at")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(routine_from_row).collect())
    }

    pub async fn set_routine_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        sqlx::query("UPDATE routines SET enabled = ? WHERE id = ?")
            .bind(enabled)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn remove_routine(&self, id: &str) -> Result<bool, String> {
        let result = sqlx::query("DELETE FROM routines WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(result.rows_affected() > 0)
    }

    /// Returns the enabled routines whose `next_run_at` has come due, and for
    /// each one records this run and schedules the next. The scheduler owns the
    /// tick clock, so the store stays a thin persistence seam.
    pub async fn take_due_routines(&self, now: DateTime<Utc>) -> Result<Vec<ScheduledRoutine>, String> {
        let due = self.routines().await?.into_iter().filter(|routine| {
            routine.enabled && DateTime::parse_from_rfc3339(&routine.next_run_at).map(|next| next <= now).unwrap_or(false)
        });
        let mut fired = Vec::new();
        for routine in due {
            let next = now + Duration::seconds(routine.interval_seconds as i64);
            sqlx::query("UPDATE routines SET last_run_at = ?, next_run_at = ? WHERE id = ?")
                .bind(now.to_rfc3339())
                .bind(next.to_rfc3339())
                .bind(&routine.id)
                .execute(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            fired.push(ScheduledRoutine { last_run_at: Some(now.to_rfc3339()), next_run_at: next.to_rfc3339(), ..routine });
        }
        Ok(fired)
    }

    pub async fn log_usage(&self, thread_id: &str, bot_id: &str, model: &str, input_tokens: i64, output_tokens: i64) -> Result<(), String> {
        sqlx::query("INSERT INTO usage (id, thread_id, bot_id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(thread_id)
            .bind(bot_id)
            .bind(model)
            .bind(input_tokens)
            .bind(output_tokens)
            .bind(Self::now())
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn usage_totals(&self) -> Result<UsageTotals, String> {
        let row = sqlx::query("SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM usage")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(UsageTotals {
            turns: row.get::<i64, _>("turns") as i32,
            input_tokens: row.get::<i64, _>("input") as i32,
            output_tokens: row.get::<i64, _>("output") as i32,
        })
    }
}

fn routine_from_row(row: &sqlx::sqlite::SqliteRow) -> ScheduledRoutine {
    ScheduledRoutine {
        id: row.get("id"),
        bot_id: row.get("bot_id"),
        name: row.get("name"),
        prompt: row.get("prompt"),
        model: row.get("model"),
        interval_seconds: row.get::<i32, _>("interval_seconds"),
        enabled: row.get::<i64, _>("enabled") != 0,
        last_run_at: row.get("last_run_at"),
        next_run_at: row.get("next_run_at"),
        created_at: row.get("created_at"),
    }
}

fn title_seed(role: &str, content: &str) -> String {
    if role != "user" {
        return String::new();
    }
    let trimmed = content.trim();
    let cut = trimmed.char_indices().nth(48).map(|(i, _)| i).unwrap_or(trimmed.len());
    trimmed[..cut].to_string()
}

fn bot_from_row(row: &sqlx::sqlite::SqliteRow) -> Bot {
    Bot {
        id: row.get("id"),
        name: row.get("name"),
        system_prompt: row.get("system_prompt"),
        model: row.get("model"),
        created_at: row.get("created_at"),
    }
}

fn thread_from_row(row: &sqlx::sqlite::SqliteRow) -> ChatThread {
    ChatThread {
        id: row.get("id"),
        bot_id: row.get("bot_id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn message_from_row(row: &sqlx::sqlite::SqliteRow) -> ChatMessage {
    ChatMessage {
        id: row.get("id"),
        thread_id: row.get("thread_id"),
        role: row.get("role"),
        content: row.get("content"),
        failed: row.get::<i64, _>("failed") != 0,
        kind: row.get("kind"),
        payload: row.get("payload"),
        created_at: row.get("created_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bots_threads_and_messages_round_trip() {
        let store = ChatStore::in_memory().await.unwrap();
        let bot = store.create_bot("Chief", "stay terse", "gpt-test").await.unwrap();
        let thread = store.create_thread(&bot.id, "").await.unwrap();
        store.append_message(&thread.id, "user", "hello world", false).await.unwrap();
        store.append_message(&thread.id, "assistant", "hi!", false).await.unwrap();
        let messages = store.messages(&thread.id).await.unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        let threads = store.threads(&bot.id).await.unwrap();
        assert_eq!(threads[0].title, "hello world");
        assert_eq!(store.bots().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn routine_due_tick_reschedules_and_usage_totals_accumulate() {
        let store = ChatStore::in_memory().await.unwrap();
        let bot = store.create_bot("Chief", "", "m").await.unwrap();
        store.create_routine(&bot.id, "Standup", "summarize yesterday", "", 60).await.unwrap();

        // A routine created 60s in the future is not due yet.
        assert!(store.take_due_routines(Utc::now()).await.unwrap().is_empty());

        // One minute later exactly one fires, rescheduled by its interval.
        let fired = store.take_due_routines(Utc::now() + Duration::seconds(61)).await.unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].name, "Standup");
        assert!(fired[0].last_run_at.is_some());
        assert!(store.take_due_routines(Utc::now() + Duration::seconds(62)).await.unwrap().is_empty());

        store.set_routine_enabled(&fired[0].id, false).await.unwrap();
        assert!(!store.routines().await.unwrap()[0].enabled);

        store.log_usage("t1", &bot.id, "gpt-mini", 100, 30).await.unwrap();
        store.log_usage("t2", &bot.id, "gpt-mini", 5, 2).await.unwrap();
        let totals = store.usage_totals().await.unwrap();
        assert_eq!(totals, UsageTotals { turns: 2, input_tokens: 105, output_tokens: 32 });
    }

    #[tokio::test]
    async fn full_text_search_ranks_and_snippets() {
        let store = ChatStore::in_memory().await.unwrap();
        let bot = store.create_bot("Chief", "", "m").await.unwrap();
        let thread = store.create_thread(&bot.id, "").await.unwrap();
        store.append_message(&thread.id, "user", "deploy the postgres backup", false).await.unwrap();
        store.append_message(&thread.id, "assistant", "the backup finished", false).await.unwrap();
        store.append_message(&thread.id, "user", "unrelated weather today", false).await.unwrap();

        let hits = store.search("postgres backup", 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_id, thread.id);
        assert!(hits[0].snippet.contains("postgres"));

        // Operators in user text are treated as plain words, never FTS syntax.
        assert!(store.search("backup AND weather", 10).await.unwrap().is_empty());
        assert_eq!(store.search("", 10).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn transcript_excludes_events_and_events_update_in_place() {
        let store = ChatStore::in_memory().await.unwrap();
        let bot = store.create_bot("Chief", "", "m").await.unwrap();
        let thread = store.create_thread(&bot.id, "").await.unwrap();
        store.append_message(&thread.id, "user", "do it", false).await.unwrap();
        let approval = store.record_event(&thread.id, "approval", "run host.computer.run", r#"{"status":"pending"}"#).await.unwrap();
        store.record_event(&thread.id, "tool", "host.computer.run", r#"{"exit":0}"#).await.unwrap();
        store.append_message(&thread.id, "assistant", "done", false).await.unwrap();

        // The model transcript is conversation only; the UI timeline is full.
        let transcript = store.transcript(&thread.id).await.unwrap();
        assert_eq!(transcript.len(), 2);
        assert!(transcript.iter().all(|m| m.kind == "chat"));
        assert_eq!(store.messages(&thread.id).await.unwrap().len(), 4);

        store.set_event_payload(&approval.id, r#"{"status":"approved"}"#).await.unwrap();
        let refreshed = store.messages(&thread.id).await.unwrap();
        let row = refreshed.iter().find(|m| m.id == approval.id).unwrap();
        assert_eq!(row.kind, "approval");
        assert_eq!(row.payload, r#"{"status":"approved"}"#);
    }

    #[tokio::test]
    async fn deleting_a_bot_cascades_to_its_threads() {
        let store = ChatStore::in_memory().await.unwrap();
        let bot = store.create_bot("Scout", "", "").await.unwrap();
        let thread = store.create_thread(&bot.id, "t").await.unwrap();
        store.append_message(&thread.id, "user", "x", false).await.unwrap();
        store.delete_bot(&bot.id).await.unwrap();
        assert!(store.bots().await.unwrap().is_empty());
        assert!(store.threads(&bot.id).await.unwrap().is_empty());
        assert!(store.messages(&thread.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn settings_round_trip_and_model_resolution() {
        let store = ChatStore::in_memory().await.unwrap();
        store.set_setting(KEY_BASE_URL, "http://127.0.0.1:4000/").await.unwrap();
        store.set_setting(KEY_API_KEY, "sk-test").await.unwrap();
        assert_eq!(store.connection().await.unwrap().unwrap().0, "http://127.0.0.1:4000");
        let bot = store.create_bot("Chief", "", "").await.unwrap();
        assert!(store.resolve_model(&bot).await.is_err());
        store.set_setting(KEY_DEFAULT_MODEL, "gpt-default").await.unwrap();
        assert_eq!(store.resolve_model(&bot).await.unwrap(), "gpt-default");
        let owned = store.create_bot("Chief", "", "gpt-own").await.unwrap();
        assert_eq!(store.resolve_model(&owned).await.unwrap(), "gpt-own");
    }

    #[tokio::test]
    async fn restart_reopens_the_same_file_and_keeps_history() {
        let dir = std::env::temp_dir().join(format!("rakazo-chat-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.db");
        let bot_id = {
            let store = ChatStore::open(&path).await.unwrap();
            let bot = store.create_bot("Chief", "sys", "m").await.unwrap();
            let thread = store.create_thread(&bot.id, "").await.unwrap();
            store.append_message(&thread.id, "user", "persist me", false).await.unwrap();
            bot.id
        };
        let store = ChatStore::open(&path).await.unwrap();
        let threads = store.threads(&bot_id).await.unwrap();
        let messages = store.messages(&threads[0].id).await.unwrap();
        assert_eq!(messages[0].content, "persist me");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_messages_keep_the_flag() {
        let store = ChatStore::in_memory().await.unwrap();
        let bot = store.create_bot("Chief", "", "m").await.unwrap();
        let thread = store.create_thread(&bot.id, "").await.unwrap();
        store.append_message(&thread.id, "assistant", "provider exploded", true).await.unwrap();
        let messages = store.messages(&thread.id).await.unwrap();
        assert!(messages[0].failed);
    }
}
