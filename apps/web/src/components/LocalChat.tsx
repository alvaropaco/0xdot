import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import {
  type Bot,
  type ChatMessage,
  type ChatThread,
  chat,
  onChatActivity,
  onChatDelta,
  onChatDone,
  onChatFailed,
  type Screenshot,
  type SearchHit,
} from "../lib/tauri/chat-bridge";
import { Shimmer } from "./ai/primitives";

interface Connection {
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
}

/** Structured `payload` for tool and approval timeline rows (see chat.rs). */
interface ActivityPayload {
  status?: string;
  taskId?: string;
  tool?: string;
  success?: boolean;
}

function parsePayload(raw: string): ActivityPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ActivityPayload;
  } catch {
    return {};
  }
}

/**
 * The local-first chat on the embedded Rust runtime (migration plan M1/M2).
 * Conversation, tool activity and approval requests are all read back from the
 * SQLite transcript; mutating host tools block on the approval gate until the
 * user decides, so the agent's use of the computer is visible and gated.
 */
export function LocalChat() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [newBotName, setNewBotName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState<{ path: string; content: string } | null>(null);

  // Events fire from the native runtime; a ref keeps the handlers reading the
  // thread the user is actually looking at, not the one they were captured on.
  const activeThread = useRef<string | null>(null);
  activeThread.current = threadId;
  // A search hit from another bot: the bot effect selects it once threads load.
  const jumpTarget = useRef<string | null>(null);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let active = true;
    const register = (promise: Promise<() => void>) => {
      void promise.then((un) => active && unlisteners.push(un)).catch(() => undefined);
    };
    void register(
      onChatDelta((payload) => {
        if (payload.threadId === activeThread.current)
          setStreaming((current) => (current ?? "") + payload.text);
      }),
    );
    void register(
      onChatActivity((message) => {
        if (message.threadId !== activeThread.current) return;
        // Idempotent append: the final reload after done returns the same rows.
        setMessages((current) =>
          current.some((row) => row.id === message.id) ? current : [...current, message],
        );
      }),
    );
    void register(
      onChatDone((payload) => {
        if (payload.threadId === activeThread.current) {
          setStreaming(null);
          void chat.listMessages(payload.threadId).then((rows) => active && setMessages(rows));
        }
      }),
    );
    void register(
      onChatFailed((payload) => {
        if (payload.threadId === activeThread.current) {
          setStreaming(null);
          setError(payload.message);
          void chat.listMessages(payload.threadId).then((rows) => active && setMessages(rows));
        }
      }),
    );
    return () => {
      active = false;
      for (const un of unlisteners) un();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [settings, botList] = await Promise.all([chat.getSettings(), chat.listBots()]);
      if (!active) return;
      setConnection(settings);
      setBots(botList);
      setBaseUrl(settings.baseUrl);
      setDefaultModel(settings.defaultModel);
      const firstBot = botList[0];
      if (firstBot) setBotId((current) => current ?? firstBot.id);
      if (!settings.baseUrl || !settings.hasApiKey) setShowSettings(true);
    })().catch((cause: Error) => active && setError(cause.message));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!botId) return;
    let active = true;
    void chat
      .listThreads(botId)
      .then(async (rows) => {
        if (!active) return;
        if (rows.length === 0) {
          const created = await chat.createThread(botId);
          if (!active) return;
          setThreads([created]);
          setThreadId(created.id);
        } else {
          setThreads(rows);
          const target = jumpTarget.current
            ? rows.find((row) => row.id === jumpTarget.current)
            : undefined;
          jumpTarget.current = null;
          setThreadId(target?.id ?? rows[0]?.id ?? null);
        }
      })
      .catch((cause: Error) => active && setError(cause.message));
    return () => {
      active = false;
    };
  }, [botId]);

  useEffect(() => {
    if (!threadId) return;
    let active = true;
    setStreaming(null);
    void chat
      .listMessages(threadId)
      .then((rows) => active && setMessages(rows))
      .catch((cause: Error) => active && setError(cause.message));
    return () => {
      active = false;
    };
  }, [threadId]);

  const createBot = async () => {
    if (!newBotName.trim()) return;
    const bot = await chat.createBot(newBotName.trim(), "", "");
    setBots((current) => [...current, bot]);
    setNewBotName("");
    setBotId(bot.id);
  };

  const openThread = async () => {
    if (!botId) return;
    const thread = await chat.createThread(botId);
    setThreads((current) => [thread, ...current]);
    setThreadId(thread.id);
  };

  const saveSettings = async () => {
    await chat.setSettings(baseUrl, apiKey, defaultModel);
    const settings = await chat.getSettings();
    setConnection(settings);
    setShowSettings(false);
    setError(null);
  };

  const send = async () => {
    if (!threadId || !draft.trim()) return;
    const content = draft.trim();
    setDraft("");
    setError(null);
    setStreaming("");
    await chat.send(threadId, content);
    void chat.listMessages(threadId).then(setMessages);
  };

  const capture = async () => {
    try {
      setShot(await chat.screenshot());
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const runSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setHits(null);
      return;
    }
    try {
      setHits(await chat.search(query, 20));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const openHit = (hit: SearchHit) => {
    setHits(null);
    setSearchQuery("");
    if (hit.botId === botId) {
      setThreadId(hit.threadId);
      return;
    }
    jumpTarget.current = hit.threadId;
    setBotId(hit.botId);
  };

  const toggleFiles = async () => {
    const next = !showFiles;
    setShowFiles(next);
    setFileContent(null);
    if (next && botId) {
      try {
        setFiles(await chat.workspaceFiles(botId));
      } catch (cause) {
        setError((cause as Error).message);
      }
    }
  };

  const openFile = async (path: string) => {
    if (!botId) return;
    try {
      setFileContent({ path, content: await chat.workspaceRead(botId, path) });
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const decide = (taskId: string, approved: boolean) => {
    void chat.decide(taskId, approved).catch((cause: Error) => setError(cause.message));
  };

  const needsConnection = connection !== null && (!connection.baseUrl || !connection.hasApiKey);

  return (
    <main
      className="mx-auto flex min-h-screen w-[min(46rem,94vw)] flex-col py-6"
      data-testid="local-chat"
    >
      <header className="flex items-center gap-2 border-b border-border pb-3">
        {bots.map((bot) => (
          <Button
            key={bot.id}
            size="sm"
            variant={bot.id === botId ? "default" : "ghost"}
            onClick={() => setBotId(bot.id)}
          >
            {bot.name}
          </Button>
        ))}
        <div className="flex items-center gap-1">
          <Input
            className="h-8 w-40"
            placeholder="Search"
            aria-label="Search transcripts"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void runSearch()}
          />
          <Input
            className="h-8 w-36"
            placeholder="New bot"
            aria-label="New bot name"
            value={newBotName}
            onChange={(event) => setNewBotName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void createBot()}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void createBot()}
            disabled={!newBotName.trim()}
          >
            Add
          </Button>
        </div>
        <div className="ms-auto flex items-center gap-1">
          {threads.map((thread) => (
            <Button
              key={thread.id}
              size="sm"
              variant={thread.id === threadId ? "secondary" : "ghost"}
              onClick={() => setThreadId(thread.id)}
            >
              {thread.title || "New"}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void openThread()}>
            +
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void capture()}
            aria-label="Capture screen"
          >
            Capture
          </Button>
          <Button
            size="sm"
            variant={showFiles ? "secondary" : "ghost"}
            onClick={() => void toggleFiles()}
          >
            Files
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowSettings((current) => !current)}>
            Model
          </Button>
        </div>
      </header>

      {showSettings && (
        <section className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3">
          <Input
            aria-label="Base URL"
            placeholder="Base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="w-56"
          />
          <Input
            aria-label="API key"
            placeholder="API key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="w-44"
          />
          <Input
            aria-label="Model"
            placeholder="Model"
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
            className="w-40"
          />
          <Button size="sm" onClick={() => void saveSettings()}>
            Save
          </Button>
        </section>
      )}

      {hits && (
        <section
          className="mt-3 flex flex-col gap-1 rounded-lg border border-border bg-card p-2"
          data-testid="search-results"
        >
          {hits.length === 0 && <p className="text-sm text-muted-foreground">No matches.</p>}
          {hits.map((hit) => (
            <Button
              key={hit.messageId}
              size="sm"
              variant="ghost"
              className="justify-start text-left"
              onClick={() => openHit(hit)}
            >
              <span className="font-medium">{hit.threadTitle || "Thread"}</span>
              <span className="ms-2 text-xs text-muted-foreground">{hit.snippet}</span>
            </Button>
          ))}
        </section>
      )}

      {showFiles && (
        <section
          className="mt-3 flex gap-3 rounded-lg border border-border bg-card p-2"
          data-testid="files-panel"
        >
          <div className="flex w-48 flex-col gap-1">
            {files.length === 0 && <p className="text-sm text-muted-foreground">No files.</p>}
            {files.map((file) => (
              <Button
                key={file}
                size="sm"
                variant={fileContent?.path === file ? "secondary" : "ghost"}
                className="justify-start font-mono text-xs"
                onClick={() => void openFile(file)}
              >
                {file}
              </Button>
            ))}
          </div>
          {fileContent && (
            <pre
              data-testid="file-content"
              className="flex-1 overflow-auto rounded bg-muted p-2 text-xs"
            >
              {fileContent.content}
            </pre>
          )}
        </section>
      )}

      {shot && (
        <section className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-card p-2">
          <img
            src={`data:${shot.mime};base64,${shot.base64}`}
            alt="Screen"
            className="max-h-40 rounded border border-border object-contain"
            data-testid="screenshot-preview"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShot(null)}
            aria-label="Dismiss screenshot"
          >
            Dismiss
          </Button>
        </section>
      )}

      <section className="flex flex-1 flex-col gap-3 overflow-y-auto py-4">
        {messages.map((message) => {
          if (message.kind === "chat") {
            return (
              <div
                key={message.id}
                data-testid={`message-${message.role}${message.failed ? "-failed" : ""}`}
                className={
                  message.role === "user"
                    ? "self-end max-w-[85%] rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap"
                    : message.failed
                      ? "self-start max-w-[85%] rounded-xl border border-destructive px-3 py-2 text-sm text-destructive whitespace-pre-wrap"
                      : "self-start max-w-[85%] rounded-xl border border-border bg-card px-3 py-2 text-sm whitespace-pre-wrap"
                }
              >
                {message.content}
              </div>
            );
          }
          if (message.kind === "approval") {
            const payload = parsePayload(message.payload);
            const pending = payload.status === "requested" && payload.taskId;
            return (
              <div
                key={message.id}
                data-testid={`activity-${message.kind}`}
                className="self-stretch flex items-center gap-2 rounded-lg border border-warning/40 bg-card px-3 py-2 text-sm"
              >
                <span className="text-warning">{message.content}</span>
                {pending && (
                  <span className="ms-auto flex gap-1">
                    <Button size="sm" onClick={() => decide(payload.taskId as string, true)}>
                      Allow
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decide(payload.taskId as string, false)}
                    >
                      Deny
                    </Button>
                  </span>
                )}
              </div>
            );
          }
          // kind === "tool"
          const payload = parsePayload(message.payload);
          return (
            <div
              key={message.id}
              data-testid={`activity-${message.kind}`}
              className={`self-start rounded px-2 py-1 text-xs font-mono ${
                payload.success === false ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {message.content}
            </div>
          );
        })}
        {streaming !== null && (
          <div
            data-testid="message-streaming"
            className="self-start max-w-[85%] rounded-xl border border-border bg-card px-3 py-2 text-sm whitespace-pre-wrap"
          >
            {streaming ? streaming : <Shimmer>Thinking…</Shimmer>}
          </div>
        )}
        {needsConnection && !showSettings && (
          <p className="text-sm text-muted-foreground text-center">
            Add a model connection to start chatting.
          </p>
        )}
      </section>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <footer className="flex gap-2 pb-2">
        <Input
          placeholder="Message"
          aria-label="Message"
          value={draft}
          disabled={!threadId || needsConnection}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          onClick={() => void send()}
          disabled={!threadId || needsConnection || !draft.trim()}
        >
          Send
        </Button>
      </footer>
    </main>
  );
}
