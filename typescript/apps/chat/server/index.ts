import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  AiClient,
  AiError,
  MockAdapter,
  asAiError,
  textMessage,
  type DataBoundary,
  type Message,
} from "@infinite-ai/core";
import {
  OllamaAdapter,
  OpenAICompatibleAdapter,
  type OpenAICompatibleKind,
} from "@infinite-ai/providers";
import { ClaudeCliAdapter, CodexCliAdapter } from "@infinite-ai/agents";

type ConnectionKind =
  "mock" | "ollama" | "codex-cli" | "claude-cli" | OpenAICompatibleKind;

interface ConnectionConfig {
  id: string;
  kind: ConnectionKind;
  label: string;
  boundary: DataBoundary;
  baseUrl?: string;
  apiKey?: string;
  executable?: string;
  workspace?: string;
  modelId?: string;
}

const mockConfig: ConnectionConfig = {
  id: "demo",
  kind: "mock",
  label: "Demo line",
  boundary: "device",
};
const configs = new Map<string, ConnectionConfig>([
  [mockConfig.id, mockConfig],
]);
const client = new AiClient({
  adapters: [
    new MockAdapter({
      id: mockConfig.id,
      label: mockConfig.label,
      reasoning: "Confirming the normalized stream path before departure. ",
    }),
  ],
});

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    length += value.length;
    if (length > 1_000_000)
      throw new AiError("invalid-request", "Request body exceeds 1 MB.");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new AiError("invalid-request", "Request body must be valid JSON.", {
      cause: error,
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiError("invalid-request", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new AiError("invalid-request", `${name} is required.`);
  return value.trim();
}

function configFrom(value: unknown): ConnectionConfig {
  const input = record(value);
  const id = requiredString(input.id, "Connection ID");
  if (!/^[a-z0-9][a-z0-9-_]{1,39}$/i.test(id)) {
    throw new AiError(
      "invalid-request",
      "Connection ID must be 2–40 letters, numbers, hyphens, or underscores.",
    );
  }
  const kind = requiredString(input.kind, "Provider kind") as ConnectionKind;
  if (
    ![
      "ollama",
      "openai",
      "openrouter",
      "vercel-ai-gateway",
      "lm-studio",
      "llama-cpp",
      "custom",
      "codex-cli",
      "claude-cli",
    ].includes(kind)
  ) {
    throw new AiError("invalid-request", "Unsupported provider kind.");
  }
  const label = requiredString(input.label, "Connection label");
  const boundary = requiredString(
    input.boundary,
    "Data boundary",
  ) as DataBoundary;
  if (
    !["device", "local-network", "private-remote", "public-cloud"].includes(
      boundary,
    )
  ) {
    throw new AiError("invalid-request", "Unsupported data boundary.");
  }
  const baseUrl =
    typeof input.baseUrl === "string" && input.baseUrl.trim() !== ""
      ? input.baseUrl.trim()
      : undefined;
  const submittedApiKey =
    typeof input.apiKey === "string" && input.apiKey.trim() !== ""
      ? input.apiKey.trim()
      : undefined;
  const existing = configs.get(id);
  const apiKey =
    submittedApiKey ?? (existing?.kind === kind ? existing.apiKey : undefined);
  const executable =
    typeof input.executable === "string" && input.executable.trim() !== ""
      ? input.executable.trim()
      : undefined;
  const workspace =
    typeof input.workspace === "string" && input.workspace.trim() !== ""
      ? input.workspace.trim()
      : undefined;
  const modelId =
    typeof input.modelId === "string" && input.modelId.trim() !== ""
      ? input.modelId.trim()
      : undefined;
  if (
    kind !== "ollama" &&
    kind !== "lm-studio" &&
    kind !== "llama-cpp" &&
    kind !== "codex-cli" &&
    kind !== "claude-cli" &&
    apiKey === undefined
  )
    throw new AiError(
      "invalid-request",
      "An API key is required for this provider.",
    );
  if ((kind === "codex-cli" || kind === "claude-cli") && modelId === undefined)
    throw new AiError(
      "invalid-request",
      "Terminal CLI connections require an explicit model ID.",
    );
  return {
    id,
    kind,
    label,
    boundary,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(executable === undefined ? {} : { executable }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(modelId === undefined ? {} : { modelId }),
  };
}

function adapterFrom(
  config: ConnectionConfig,
):
  OllamaAdapter | OpenAICompatibleAdapter | CodexCliAdapter | ClaudeCliAdapter {
  if (config.kind === "ollama") {
    return new OllamaAdapter({
      id: config.id,
      label: config.label,
      boundary: config.boundary,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    });
  }
  if (config.kind === "mock")
    throw new AiError(
      "invalid-request",
      "The built-in demo connection cannot be replaced.",
    );
  if (config.kind === "codex-cli")
    return new CodexCliAdapter({
      id: config.id,
      label: config.label,
      boundary: config.boundary,
      ...(config.executable === undefined
        ? {}
        : { executable: config.executable }),
      ...(config.workspace === undefined
        ? {}
        : { workspace: config.workspace }),
      ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
    });
  if (config.kind === "claude-cli")
    return new ClaudeCliAdapter({
      id: config.id,
      label: config.label,
      boundary: config.boundary,
      ...(config.executable === undefined
        ? {}
        : { executable: config.executable }),
      ...(config.workspace === undefined
        ? {}
        : { workspace: config.workspace }),
      ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
    });
  return new OpenAICompatibleAdapter({
    id: config.id,
    kind: config.kind,
    label: config.label,
    apiKey: config.apiKey ?? "",
    boundary: config.boundary,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  });
}

function publicConnection(config: ConnectionConfig): Record<string, unknown> {
  const connection = client
    .connections()
    .find((candidate) => candidate.id === config.id);
  return {
    id: config.id,
    kind: config.kind,
    label: config.label,
    boundary: config.boundary,
    hasCredential: config.apiKey !== undefined,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.executable === undefined
      ? {}
      : { executable: config.executable }),
    ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
    ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
    capabilities: connection?.capabilities ?? [],
  };
}

function routeId(pathname: string, suffix: string): string | undefined {
  const match = new RegExp(`^/api/connections/([^/]+)/${suffix}$`).exec(
    pathname,
  );
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/connections") {
    json(response, 200, {
      connections: [...configs.values()].map(publicConnection),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/connections") {
    const config = configFrom(await body(request));
    if (config.id === mockConfig.id)
      throw new AiError(
        "invalid-request",
        "The built-in demo connection cannot be replaced.",
      );
    const adapter = adapterFrom(config);
    client.unregister(config.id);
    client.register(adapter);
    configs.set(config.id, config);
    json(response, 201, { connection: publicConnection(config) });
    return;
  }
  const modelsId = routeId(url.pathname, "models");
  if (request.method === "GET" && modelsId !== undefined) {
    json(response, 200, { models: await client.listModels(modelsId) });
    return;
  }
  const healthId = routeId(url.pathname, "health");
  if (request.method === "GET" && healthId !== undefined) {
    json(response, 200, { health: await client.health(healthId) });
    return;
  }
  const connectionMatch = /^\/api\/connections\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && connectionMatch?.[1] !== undefined) {
    const id = decodeURIComponent(connectionMatch[1]);
    if (id === mockConfig.id)
      throw new AiError(
        "permission-denied",
        "The demo connection cannot be removed.",
      );
    if (!configs.has(id))
      throw new AiError(
        "invalid-request",
        `Connection '${id}' is not registered.`,
      );
    configs.delete(id);
    client.unregister(id);
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    const input = record(await body(request));
    const connectionId = requiredString(input.connectionId, "Connection ID");
    const modelId = requiredString(input.modelId, "Model ID");
    const maximumBoundary = requiredString(
      input.maximumBoundary,
      "Maximum data boundary",
    ) as DataBoundary;
    if (
      !["device", "local-network", "private-remote", "public-cloud"].includes(
        maximumBoundary,
      )
    ) {
      throw new AiError("invalid-request", "Unsupported data boundary.");
    }
    if (!Array.isArray(input.messages))
      throw new AiError("invalid-request", "Messages must be an array.");
    const messages: Message[] = input.messages.map((message, index) => {
      const item = record(message);
      const role =
        item.role === "assistant" || item.role === "system"
          ? item.role
          : item.role === "user"
            ? "user"
            : undefined;
      if (role === undefined)
        throw new AiError(
          "invalid-request",
          `Message ${index + 1} has an unsupported role.`,
        );
      return textMessage(
        role,
        requiredString(item.text, `Message ${index + 1} text`),
      );
    });
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    try {
      for await (const event of client.streamText({
        model: { connectionId, modelId },
        messages,
        signal: controller.signal,
        timeoutMs: 120_000,
        maximumBoundary,
        ...(configs.get(connectionId)?.workspace === undefined
          ? {}
          : {
              providerOptions: {
                [connectionId]: {
                  workspace: configs.get(connectionId)!.workspace!,
                },
              },
            }),
      })) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const normalized = asAiError(error);
      response.write(
        `data: ${JSON.stringify({ type: "error", error: normalized.toJSON() })}\n\n`,
      );
    }
    response.end();
    return;
  }
  json(response, 404, {
    error: { code: "not-found", message: "Route not found." },
  });
}

const port = Number.parseInt(process.env.INFINITE_AI_DEMO_PORT ?? "8787", 10);
const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    const normalized = asAiError(error, "invalid-request");
    if (response.headersSent) {
      response.end();
      return;
    }
    json(
      response,
      normalized.code === "invalid-request"
        ? 400
        : normalized.code === "permission-denied"
          ? 403
          : 500,
      { error: normalized.toJSON() },
    );
  });
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Infinite AI demo API listening on http://127.0.0.1:${port}\n`,
  );
});
