//! SQLite persistence for the local chat runtime (migration plan M1).
//!
//! sqlx with checked-in migrations; document-shaped values stay JSON columns
//! where the server used JSONB. The pool lives in the app data directory so a
//! thread survives an app restart, which is the M1 acceptance bar.

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
    pub created_at: String,
}

#[derive(Clone)]
pub struct ChatStore {
    pool: SqlitePool,
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
        let rows = sqlx::query("SELECT id, thread_id, role, content, failed, created_at FROM messages WHERE thread_id = ? ORDER BY created_at, id")
            .bind(thread_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(rows.iter().map(message_from_row).collect())
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
