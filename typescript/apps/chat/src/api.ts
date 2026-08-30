import type {
  DataBoundary,
  HealthResult,
  ModelInfo,
  StreamEvent,
} from "@infinite-ai/core";

export type ConnectionKind =
  | "mock"
  | "ollama"
  | "openai"
  | "openrouter"
  | "vercel-ai-gateway"
  | "lm-studio"
  | "llama-cpp"
  | "custom";

export interface ConnectionSummary {
  id: string;
  kind: ConnectionKind;
  label: string;
  boundary: DataBoundary;
  baseUrl?: string;
  hasCredential: boolean;
  capabilities: string[];
}

export interface ConnectionInput {
  id: string;
  kind: Exclude<ConnectionKind, "mock">;
  label: string;
  boundary: DataBoundary;
  baseUrl?: string;
  apiKey?: string;
}

export interface ChatInput {
  connectionId: string;
  modelId: string;
  maximumBoundary: DataBoundary;
  messages: Array<{ role: "system" | "user" | "assistant"; text: string }>;
}

export type ChatEvent =
  | StreamEvent
  | {
      type: "error";
      error: { code: string; message: string; retryable?: boolean };
    };

async function value<T>(response: Response): Promise<T> {
  const data = (await response.json()) as { error?: { message?: string } } & T;
  if (!response.ok)
    throw new Error(
      data.error?.message ?? `Request failed with status ${response.status}.`,
    );
  return data;
}

export async function listConnections(): Promise<ConnectionSummary[]> {
  const data = await value<{ connections: ConnectionSummary[] }>(
    await fetch("/api/connections"),
  );
  return data.connections;
}

export async function saveConnection(
  input: ConnectionInput,
): Promise<ConnectionSummary> {
  const data = await value<{ connection: ConnectionSummary }>(
    await fetch("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return data.connection;
}

export async function removeConnection(id: string): Promise<void> {
  const response = await fetch(`/api/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) await value(response);
}

export async function listModels(id: string): Promise<ModelInfo[]> {
  const data = await value<{ models: ModelInfo[] }>(
    await fetch(`/api/connections/${encodeURIComponent(id)}/models`),
  );
  return data.models;
}

export async function checkHealth(id: string): Promise<HealthResult> {
  const data = await value<{ health: HealthResult }>(
    await fetch(`/api/connections/${encodeURIComponent(id)}/health`),
  );
  return data.health;
}

export async function streamChat(
  input: ChatInput,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || response.body === null) {
    await value(response);
    throw new Error("The server did not return a stream.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    buffer += chunk;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data !== "") onEvent(JSON.parse(data) as ChatEvent);
    }
  }
}
