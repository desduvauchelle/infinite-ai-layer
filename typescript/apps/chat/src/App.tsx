import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  Cloud,
  Cpu,
  Menu,
  MessageSquarePlus,
  Network,
  Plus,
  Radio,
  Send,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DataBoundary, ModelInfo, Usage } from "@infinite-ai/core";
import {
  checkHealth,
  listConnections,
  listModels,
  removeConnection,
  saveConnection,
  streamChat,
  type ChatEvent,
  type ConnectionInput,
  type ConnectionKind,
  type ConnectionSummary,
} from "./api.js";

type Page = "chat" | "settings";
type MessageStatus = "done" | "streaming" | "error" | "cancelled";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  status: MessageStatus;
  connectionId?: string;
  modelId?: string;
  usage?: Usage;
  error?: string;
}

interface Conversation {
  id: string;
  title: string;
  connectionId: string;
  modelId: string;
  messages: ChatMessage[];
  updatedAt: number;
}

const storageKey = "infinite-ai-layer.demo.chats.v1";

function newConversation(
  connectionId = "demo",
  modelId = "fixture-chat",
): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "Untitled route",
    connectionId,
    modelId,
    updatedAt: Date.now(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Choose a connection and model, then send a message. The selected route is fixed before dispatch.",
        status: "done",
        connectionId: "demo",
        modelId: "fixture-chat",
      },
    ],
  };
}

function storedConversations(): Conversation[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    ) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0)
      return parsed as Conversation[];
  } catch {
    // Start with a clean local demo when old browser state is not compatible.
  }
  return [newConversation()];
}

function routeColor(kind?: ConnectionKind): string {
  if (kind === "ollama" || kind === "lm-studio" || kind === "llama-cpp")
    return "var(--route-green)";
  if (kind === "openai") return "var(--cobalt)";
  if (kind === "openrouter") return "var(--amber)";
  if (kind === "vercel-ai-gateway" || kind === "custom")
    return "var(--scarlet)";
  return "var(--porcelain)";
}

function boundaryLabel(boundary: DataBoundary): string {
  return boundary === "device"
    ? "On device"
    : boundary === "local-network"
      ? "Local network"
      : boundary === "private-remote"
        ? "Private remote"
        : "Public cloud";
}

function providerLabel(kind: ConnectionKind): string {
  if (kind === "vercel-ai-gateway") return "Vercel AI Gateway";
  if (kind === "openrouter") return "OpenRouter";
  if (kind === "openai") return "OpenAI";
  if (kind === "ollama") return "Ollama";
  if (kind === "lm-studio") return "LM Studio";
  if (kind === "llama-cpp") return "llama.cpp";
  if (kind === "custom") return "Custom compatible";
  return "Deterministic mock";
}

function connectionIcon(kind: ConnectionKind) {
  if (
    kind === "ollama" ||
    kind === "lm-studio" ||
    kind === "llama-cpp" ||
    kind === "mock"
  )
    return <Cpu aria-hidden="true" />;
  return <Cloud aria-hidden="true" />;
}

function usageText(usage?: Usage): string | undefined {
  if (usage === undefined) return undefined;
  const total =
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const cost =
    usage.cost?.amount === undefined
      ? "cost unavailable"
      : `${usage.cost.amount} ${usage.cost.currency ?? ""}`.trim();
  return `${total.toLocaleString()} tokens · ${cost}`;
}

export function App() {
  const [page, setPage] = useState<Page>("chat");
  const [railOpen, setRailOpen] = useState(false);
  const [conversations, setConversations] =
    useState<Conversation[]>(storedConversations);
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? "");
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const active =
    conversations.find((conversation) => conversation.id === activeId) ??
    conversations[0];
  const activeConnection = connections.find(
    (connection) => connection.id === active?.connectionId,
  );

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    void listConnections()
      .then((next) => {
        setConnections(next);
        setConversations((current) =>
          current.map((conversation) => {
            if (
              next.some(
                (connection) => connection.id === conversation.connectionId,
              )
            )
              return conversation;
            const fallback = next[0];
            return fallback === undefined
              ? conversation
              : {
                  ...conversation,
                  connectionId: fallback.id,
                  modelId: "",
                };
          }),
        );
        setConnectionError(undefined);
      })
      .catch((error: unknown) =>
        setConnectionError(
          error instanceof Error
            ? error.message
            : "Could not reach the local demo server.",
        ),
      );
  }, []);

  useEffect(() => {
    if (active?.connectionId === undefined) return;
    let current = true;
    setModelsLoading(true);
    void listModels(active.connectionId)
      .then((next) => {
        if (!current) return;
        setModels(next);
        setConnectionError(undefined);
        if (
          next.length > 0 &&
          !next.some((model) => model.id === active.modelId)
        ) {
          updateConversation(active.id, (conversation) => ({
            ...conversation,
            modelId: next[0]?.id ?? "",
          }));
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        setModels([]);
        setConnectionError(
          error instanceof Error ? error.message : "Could not list models.",
        );
      })
      .finally(() => {
        if (current) setModelsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active?.connectionId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [activeId, active?.messages.length, active?.messages.at(-1)?.text]);

  useEffect(() => {
    if (!railOpen) return;
    function closeOnEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") setRailOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [railOpen]);

  function updateConversation(
    id: string,
    update: (conversation: Conversation) => Conversation,
  ): void {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? update(conversation) : conversation,
      ),
    );
  }

  function addConversation(): void {
    const conversation = newConversation(active?.connectionId, active?.modelId);
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setPage("chat");
    setRailOpen(false);
  }

  function deleteConversation(id: string): void {
    setConversations((current) => {
      const next = current.filter((conversation) => conversation.id !== id);
      const resolved = next.length === 0 ? [newConversation()] : next;
      if (id === activeId) setActiveId(resolved[0]?.id ?? "");
      return resolved;
    });
  }

  async function sendMessage(): Promise<void> {
    const prompt = draft.trim();
    if (
      prompt === "" ||
      active === undefined ||
      active.modelId === "" ||
      sending
    )
      return;
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: prompt,
      status: "done",
    };
    const assistantId = crypto.randomUUID();
    const assistant: ChatMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      reasoning: "",
      status: "streaming",
      connectionId: active.connectionId,
      modelId: active.modelId,
    };
    const priorMessages = active.messages.filter(
      (message) => message.text.trim() !== "",
    );
    updateConversation(active.id, (conversation) => ({
      ...conversation,
      title:
        conversation.title === "Untitled route"
          ? prompt.slice(0, 48)
          : conversation.title,
      messages: [...conversation.messages, user, assistant],
      updatedAt: Date.now(),
    }));
    setDraft("");
    setSending(true);
    setConnectionError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        {
          connectionId: active.connectionId,
          modelId: active.modelId,
          maximumBoundary: "public-cloud",
          messages: [...priorMessages, user].map((message) => ({
            role: message.role,
            text: message.text,
          })),
        },
        (event) => handleChatEvent(active.id, assistantId, event),
        controller.signal,
      );
      updateMessage(active.id, assistantId, (message) =>
        message.status === "streaming"
          ? { ...message, status: "done" }
          : message,
      );
    } catch (error) {
      const cancelled = controller.signal.aborted;
      updateMessage(active.id, assistantId, (message) => ({
        ...message,
        status: cancelled ? "cancelled" : "error",
        error: cancelled
          ? "Generation stopped."
          : error instanceof Error
            ? error.message
            : "The stream failed.",
      }));
    } finally {
      setSending(false);
      abortRef.current = undefined;
    }
  }

  function updateMessage(
    conversationId: string,
    messageId: string,
    update: (message: ChatMessage) => ChatMessage,
  ): void {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.id === messageId ? update(message) : message,
      ),
      updatedAt: Date.now(),
    }));
  }

  function handleChatEvent(
    conversationId: string,
    messageId: string,
    event: ChatEvent,
  ): void {
    if (event.type === "text-delta")
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        text: message.text + event.delta,
      }));
    if (event.type === "reasoning-delta")
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        reasoning: (message.reasoning ?? "") + event.delta,
      }));
    if (event.type === "usage")
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        usage: event.usage,
      }));
    if (event.type === "finish")
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        status: event.reason === "cancelled" ? "cancelled" : "done",
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      }));
    if (event.type === "error")
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        status: "error",
        error: event.error.message,
      }));
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div
      className="app-shell"
      style={
        {
          "--active-route": routeColor(activeConnection?.kind),
        } as React.CSSProperties
      }
    >
      <a className="skip-link" href="#main-content">
        Skip to conversation
      </a>
      <button
        className="mobile-menu icon-button"
        type="button"
        aria-label="Open conversations"
        aria-controls="route-rail"
        aria-expanded={railOpen}
        onClick={() => setRailOpen(true)}
      >
        <Menu aria-hidden="true" />
      </button>
      {railOpen && (
        <button
          className="rail-scrim"
          type="button"
          aria-label="Close conversations"
          onClick={() => setRailOpen(false)}
        />
      )}
      <aside
        id="route-rail"
        className={`route-rail ${railOpen ? "is-open" : ""}`}
        aria-label="Conversation routes"
      >
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>Infinite AI</strong>
            <span>Route control · 0.1</span>
          </div>
          <button
            className="mobile-close icon-button"
            type="button"
            aria-label="Close conversations"
            onClick={() => setRailOpen(false)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <button className="new-route" type="button" onClick={addConversation}>
          <MessageSquarePlus aria-hidden="true" />
          New route
        </button>
        <nav className="conversation-list" aria-label="Chats">
          <div className="rail-label">Conversations</div>
          {[...conversations]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((conversation) => (
              <div
                className={`conversation-stop ${page === "chat" && conversation.id === activeId ? "active" : ""}`}
                key={conversation.id}
              >
                <button
                  className="conversation-select"
                  type="button"
                  onClick={() => {
                    setActiveId(conversation.id);
                    setPage("chat");
                    setRailOpen(false);
                  }}
                >
                  <span className="stop-node" aria-hidden="true" />
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>{conversation.modelId || "No model selected"}</small>
                  </span>
                </button>
                <button
                  className="delete-chat"
                  type="button"
                  aria-label={`Delete ${conversation.title}`}
                  onClick={() => deleteConversation(conversation.id)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            ))}
        </nav>
        <button
          className={`settings-terminus ${page === "settings" ? "active" : ""}`}
          type="button"
          onClick={() => {
            setPage("settings");
            setRailOpen(false);
          }}
        >
          <span className="terminus-node" aria-hidden="true" />
          <Settings aria-hidden="true" />
          Connections
        </button>
      </aside>

      <main id="main-content" className="workspace">
        {page === "settings" ? (
          <ConnectionsPage
            connections={connections}
            onConnectionsChange={setConnections}
          />
        ) : active === undefined ? null : (
          <>
            <header className="route-header">
              <div className="route-title">
                <span className="eyebrow">Active corridor</span>
                <h1>{active.title}</h1>
              </div>
              <div
                className="route-controls"
                aria-label="Model route selection"
              >
                <label>
                  <span>Connection</span>
                  <div className="select-shell">
                    <select
                      aria-label="Connection"
                      value={active.connectionId}
                      disabled={sending}
                      onChange={(event) =>
                        updateConversation(active.id, (conversation) => ({
                          ...conversation,
                          connectionId: event.target.value,
                          modelId: "",
                        }))
                      }
                    >
                      {connections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </label>
                <label>
                  <span>Model</span>
                  <div className="select-shell">
                    <select
                      aria-label="Model"
                      value={active.modelId}
                      disabled={sending || modelsLoading || models.length === 0}
                      onChange={(event) =>
                        updateConversation(active.id, (conversation) => ({
                          ...conversation,
                          modelId: event.target.value,
                        }))
                      }
                    >
                      {models.length === 0 && (
                        <option value="">
                          {modelsLoading ? "Reading line…" : "No models"}
                        </option>
                      )}
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name ?? model.id}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </label>
                <div
                  className="boundary-status"
                  title={activeConnection?.boundary}
                >
                  <Network aria-hidden="true" />
                  <span>
                    {activeConnection === undefined
                      ? "No line"
                      : boundaryLabel(activeConnection.boundary)}
                  </span>
                </div>
              </div>
            </header>

            {connectionError !== undefined && (
              <div className="route-alert" role="alert">
                <Radio aria-hidden="true" />
                <div>
                  <strong>Route unavailable</strong>
                  <span>{connectionError}</span>
                </div>
                <button type="button" onClick={() => setPage("settings")}>
                  Check connections
                </button>
              </div>
            )}

            <section
              className="message-platform"
              aria-label="Conversation"
              aria-live="polite"
            >
              <div className="platform-line" aria-hidden="true" />
              {active.messages.map((message) => (
                <article
                  className={`message-row ${message.role}`}
                  key={message.id}
                >
                  <div className="message-node" aria-hidden="true">
                    {message.role === "assistant" ? <Bot /> : <span>YOU</span>}
                  </div>
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>
                        {message.role === "assistant"
                          ? message.connectionId === "demo"
                            ? "Route guide"
                            : (activeConnection?.label ?? "Assistant")
                          : "You"}
                      </strong>
                      {message.modelId !== undefined && (
                        <code>{message.modelId}</code>
                      )}
                      {message.status === "streaming" && (
                        <span className="live-status">Streaming</span>
                      )}
                    </div>
                    {showReasoning &&
                      message.reasoning !== undefined &&
                      message.reasoning !== "" && (
                        <details className="reasoning" open>
                          <summary>Reasoning event</summary>
                          <p>{message.reasoning}</p>
                        </details>
                      )}
                    <div className="message-text">
                      {message.text === "" && message.status === "streaming" ? (
                        <span className="waiting">Waiting at provider…</span>
                      ) : (
                        message.text
                      )}
                    </div>
                    {message.error !== undefined && (
                      <div className={`message-error ${message.status}`}>
                        {message.error}
                      </div>
                    )}
                    {usageText(message.usage) !== undefined && (
                      <div className="usage-line">
                        {usageText(message.usage)}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              <div
                ref={messageEndRef}
                className="message-end"
                aria-hidden="true"
              />
            </section>

            <footer className="composer-dock">
              <div className="composer-options">
                <span>
                  <span className="connection-dot" aria-hidden="true" />
                  {activeConnection?.label ?? "No connection"} /{" "}
                  {active.modelId || "no model"}
                </span>
                <label className="reasoning-toggle">
                  <input
                    type="checkbox"
                    checked={showReasoning}
                    onChange={(event) => setShowReasoning(event.target.checked)}
                  />
                  Show reasoning events
                </label>
              </div>
              <div className="composer-box">
                <textarea
                  aria-label="Message"
                  value={draft}
                  rows={2}
                  enterKeyHint="send"
                  placeholder="Message the selected model…"
                  disabled={sending}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKey}
                />
                {sending ? (
                  <button
                    className="send-button stop"
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <CircleStop aria-hidden="true" />
                    Stop
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="button"
                    disabled={draft.trim() === "" || active.modelId === ""}
                    onClick={() => void sendMessage()}
                  >
                    <Send aria-hidden="true" />
                    Send
                  </button>
                )}
              </div>
              <p>
                Enter sends · Shift + Enter adds a line · selection is locked
                before dispatch
              </p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

interface ConnectionsPageProps {
  connections: ConnectionSummary[];
  onConnectionsChange: (connections: ConnectionSummary[]) => void;
}

function ConnectionsPage({
  connections,
  onConnectionsChange,
}: ConnectionsPageProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<ConnectionInput["kind"]>("ollama");
  const [label, setLabel] = useState("My Ollama");
  const [id, setId] = useState("local-ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434");
  const [apiKey, setApiKey] = useState("");
  const [boundary, setBoundary] = useState<DataBoundary>("device");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [health, setHealth] = useState<
    Record<
      string,
      { state: "checking" | "available" | "failed"; message: string }
    >
  >({});

  const configured = useMemo(
    () => connections.filter((connection) => connection.kind !== "mock"),
    [connections],
  );

  function changeKind(next: ConnectionInput["kind"]): void {
    setKind(next);
    if (next === "ollama" || next === "lm-studio" || next === "llama-cpp") {
      setLabel(
        next === "ollama"
          ? "My Ollama"
          : next === "lm-studio"
            ? "My LM Studio"
            : "My llama.cpp",
      );
      setId(`local-${next}`);
      setBaseUrl(
        next === "ollama"
          ? "http://127.0.0.1:11434"
          : next === "lm-studio"
            ? "http://127.0.0.1:1234/v1"
            : "http://127.0.0.1:8080/v1",
      );
      setBoundary("device");
    } else {
      setLabel(providerLabel(next));
      setId(next.replace("-ai-gateway", "-gateway"));
      setBaseUrl("");
      setBoundary("public-cloud");
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setFormError(undefined);
    try {
      const saved = await saveConnection({
        id,
        kind,
        label,
        boundary,
        ...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
      });
      onConnectionsChange([
        ...connections.filter((connection) => connection.id !== saved.id),
        saved,
      ]);
      setFormOpen(false);
      setApiKey("");
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not save the connection.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(connection: ConnectionSummary): Promise<void> {
    setHealth((current) => ({
      ...current,
      [connection.id]: { state: "checking", message: "Checking…" },
    }));
    try {
      const result = await checkHealth(connection.id);
      setHealth((current) => ({
        ...current,
        [connection.id]: {
          state: result.available ? "available" : "failed",
          message: result.message,
        },
      }));
    } catch (error) {
      setHealth((current) => ({
        ...current,
        [connection.id]: {
          state: "failed",
          message:
            error instanceof Error ? error.message : "Connection check failed.",
        },
      }));
    }
  }

  async function remove(connection: ConnectionSummary): Promise<void> {
    try {
      await removeConnection(connection.id);
      onConnectionsChange(
        connections.filter((candidate) => candidate.id !== connection.id),
      );
    } catch (error) {
      setHealth((current) => ({
        ...current,
        [connection.id]: {
          state: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not remove connection.",
        },
      }));
    }
  }

  return (
    <div className="connections-page">
      <header className="settings-header">
        <div>
          <span className="eyebrow">Line operations</span>
          <h1>Connections</h1>
          <p>
            Register only the providers this application should expose. Nothing
            is scanned or installed.
          </p>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setFormOpen((current) => !current)}
        >
          {formOpen ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
          {formOpen ? "Close form" : "Add connection"}
        </button>
      </header>

      {formOpen && (
        <form
          className="connection-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="form-route" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="form-heading">
            <span className="eyebrow">New interchange</span>
            <h2>Register a provider</h2>
            <p>
              Credentials stay in this local server process and are never
              returned to the browser.
            </p>
          </div>
          <div className="form-grid">
            <label>
              <span>Provider</span>
              <select
                value={kind}
                onChange={(event) =>
                  changeKind(event.target.value as ConnectionInput["kind"])
                }
              >
                <option value="ollama">Ollama</option>
                <option value="lm-studio">LM Studio</option>
                <option value="llama-cpp">llama.cpp server</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="vercel-ai-gateway">Vercel AI Gateway</option>
                <option value="custom">Custom OpenAI-compatible</option>
              </select>
            </label>
            <label>
              <span>Display name</span>
              <input
                value={label}
                required
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label>
              <span>Connection ID</span>
              <input
                value={id}
                required
                pattern="[A-Za-z0-9][A-Za-z0-9-_]{1,39}"
                onChange={(event) => setId(event.target.value)}
              />
              <small>Stable reference used by application code.</small>
            </label>
            <label>
              <span>Base URL {kind === "ollama" ? "" : "(optional)"}</span>
              <input
                type="url"
                value={baseUrl}
                placeholder={
                  kind === "custom"
                    ? "https://provider.example/v1"
                    : "Use provider default"
                }
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            {kind !== "ollama" &&
              kind !== "lm-studio" &&
              kind !== "llama-cpp" && (
                <label>
                  <span>API key</span>
                  <input
                    type="password"
                    value={apiKey}
                    required
                    autoComplete="off"
                    placeholder="Stored in memory only"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
              )}
            <label>
              <span>Declared data boundary</span>
              <select
                value={boundary}
                onChange={(event) =>
                  setBoundary(event.target.value as DataBoundary)
                }
              >
                <option value="device">On device</option>
                <option value="local-network">Local network</option>
                <option value="private-remote">Private remote</option>
                <option value="public-cloud">Public cloud</option>
              </select>
            </label>
          </div>
          {formError !== undefined && (
            <div className="form-error" role="alert">
              {formError}
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? (
                <Activity className="spin" aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              {saving ? "Registering…" : "Register connection"}
            </button>
          </div>
        </form>
      )}

      <section className="connection-board" aria-label="Registered connections">
        <div className="board-heading">
          <span>{connections.length} lines registered</span>
          <span>{configured.length} configured by this app</span>
        </div>
        {connections.map((connection) => {
          const state = health[connection.id];
          return (
            <article
              className="connection-row"
              key={connection.id}
              style={
                {
                  "--row-route": routeColor(connection.kind),
                } as React.CSSProperties
              }
            >
              <div className="connection-track" aria-hidden="true">
                <span />
              </div>
              <div className="connection-icon">
                {connectionIcon(connection.kind)}
              </div>
              <div className="connection-copy">
                <div className="connection-name">
                  <h2>{connection.label}</h2>
                  <code>{connection.id}</code>
                </div>
                <p>
                  {providerLabel(connection.kind)} ·{" "}
                  {boundaryLabel(connection.boundary)}
                </p>
                {connection.baseUrl !== undefined && (
                  <small>{connection.baseUrl}</small>
                )}
                {state !== undefined && (
                  <div className={`health-result ${state.state}`} role="status">
                    {state.state === "available" ? (
                      <Check aria-hidden="true" />
                    ) : state.state === "checking" ? (
                      <Activity className="spin" aria-hidden="true" />
                    ) : (
                      <X aria-hidden="true" />
                    )}{" "}
                    {state.message}
                  </div>
                )}
              </div>
              <div className="connection-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void testConnection(connection)}
                >
                  Test line
                </button>
                {connection.kind !== "mock" && (
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={`Remove ${connection.label}`}
                    onClick={() => void remove(connection)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
