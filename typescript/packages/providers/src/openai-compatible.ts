import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  AiError,
  messageText,
  type Capability,
  type ConnectionInfo,
  type DataBoundary,
  type EmbeddingRequest,
  type EmbeddingResult,
  type HealthResult,
  type JsonObject,
  type JsonValue,
  type Message,
  type ModelInfo,
  type ObjectRequest,
  type ObjectResult,
  type ProviderAdapter,
  type StreamEvent,
  type TextRequest,
  type TextResult,
  type ToolCall,
  type TranscriptionRequest,
  type TranscriptionResult,
  type Usage,
} from "@infinite-ai/core";
import { checkedFetch, cleanBaseUrl, requestSignal, sseData } from "./http.js";

export type OpenAICompatibleKind =
  | "openai"
  | "openrouter"
  | "vercel-ai-gateway"
  | "lm-studio"
  | "llama-cpp"
  | "custom";

export interface OpenAICompatibleOptions {
  id: string;
  apiKey?: string;
  kind?: OpenAICompatibleKind;
  baseUrl?: string;
  label?: string;
  boundary?: DataBoundary;
  headers?: Record<string, string>;
  capabilities?: Capability[];
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number | string;
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: ChatUsage;
}

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: ChatCompletion["usage"];
}

function defaultBaseUrl(kind: OpenAICompatibleKind): string {
  if (kind === "openrouter") return "https://openrouter.ai/api/v1";
  if (kind === "vercel-ai-gateway") return "https://ai-gateway.vercel.sh/v1";
  if (kind === "lm-studio") return "http://127.0.0.1:1234/v1";
  if (kind === "llama-cpp") return "http://127.0.0.1:8080/v1";
  return "https://api.openai.com/v1";
}

function defaultLabel(kind: OpenAICompatibleKind): string {
  if (kind === "vercel-ai-gateway") return "Vercel AI Gateway";
  if (kind === "openrouter") return "OpenRouter";
  if (kind === "lm-studio") return "LM Studio";
  if (kind === "llama-cpp") return "llama.cpp";
  if (kind === "custom") return "OpenAI-compatible";
  return "OpenAI";
}

function defaultCapabilities(kind: OpenAICompatibleKind): Capability[] {
  const common: Capability[] = [
    "provider-health",
    "model-listing",
    "text-generation",
    "text-streaming",
    "structured-output",
    "tool-calling",
    "embeddings",
  ];
  return kind === "lm-studio" || kind === "llama-cpp"
    ? common
    : [...common, "reasoning-events", "transcription"];
}

const EXCLUSIVE_MODEL_CAPABILITIES: Capability[] = [
  "embeddings",
  "transcription",
  "speech-generation",
  "image-generation",
  "image-editing",
  "video-generation",
  "video-editing",
];

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function openaiImagePart(media: {
  mimeType: string;
  data?: Uint8Array;
  url?: string;
}): Record<string, unknown> {
  if (media.url !== undefined && media.url.trim() !== "") {
    return { type: "image_url", image_url: { url: media.url } };
  }
  if (media.data !== undefined) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${media.mimeType};base64,${bytesToBase64(media.data)}`,
      },
    };
  }
  throw new AiError(
    "invalid-request",
    "Image parts require either bytes or a URL.",
  );
}

function apiContent(message: Message): unknown {
  const mediaParts = message.content.filter(
    (part) =>
      part.type === "image" || part.type === "audio" || part.type === "file",
  );
  if (mediaParts.length === 0) return messageText(message);
  const content: Array<Record<string, unknown>> = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") content.push(openaiImagePart(part.media));
    else if (part.type === "tool-call" || part.type === "tool-result") continue;
    else {
      throw new AiError(
        "unsupported-capability",
        `${part.type} message parts cannot be sent by this adapter.`,
      );
    }
  }
  return content;
}

function apiMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((message): Record<string, unknown> => {
    const toolResult = message.content.find(
      (part) => part.type === "tool-result",
    );
    if (message.role === "tool" && toolResult?.type === "tool-result") {
      return {
        role: "tool",
        content: JSON.stringify(toolResult.result.result),
        tool_call_id: toolResult.result.callId,
      };
    }
    const toolCalls = message.content
      .filter((part) => part.type === "tool-call")
      .map((part) => ({
        id: part.type === "tool-call" ? part.call.id : "",
        type: "function",
        function: {
          name: part.type === "tool-call" ? part.call.name : "",
          arguments: JSON.stringify(
            part.type === "tool-call" ? part.call.arguments : {},
          ),
        },
      }));
    return {
      role: message.role,
      content: apiContent(message),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  });
}

function isEmbeddingModelId(id: string): boolean {
  const value = id.toLowerCase();
  return value.includes("embedding") || value.includes("embed-");
}

function isTranscriptionModelId(id: string): boolean {
  const value = id.toLowerCase();
  return (
    value.includes("whisper") ||
    value.includes("transcribe") ||
    value.includes("speech-to-text")
  );
}

export function advertisedOpenAiModelCapabilities(
  id: string,
  connectionCapabilities: Capability[],
): Capability[] {
  const surface = connectionCapabilities.filter(
    (capability) =>
      capability !== "provider-health" && capability !== "model-listing",
  );
  if (isEmbeddingModelId(id))
    return surface.filter((capability) => capability === "embeddings");
  if (isTranscriptionModelId(id))
    return surface.filter((capability) => capability === "transcription");
  return surface.filter(
    (capability) => !EXCLUSIVE_MODEL_CAPABILITIES.includes(capability),
  );
}

function normalizedUsage(value?: ChatUsage): Usage | undefined {
  if (value === undefined) return undefined;
  return {
    inputTokens: value.prompt_tokens ?? 0,
    outputTokens: value.completion_tokens ?? 0,
    totalTokens:
      value.total_tokens ??
      (value.prompt_tokens ?? 0) + (value.completion_tokens ?? 0),
    reasoningTokens: value.completion_tokens_details?.reasoning_tokens ?? 0,
    cost:
      value.cost === undefined
        ? { source: "unavailable" }
        : {
            amount: String(value.cost),
            currency: "USD",
            source: "provider-reported",
          },
  };
}

function finishReason(value?: string | null): TextResult["finishReason"] {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "tool_calls") return "tool-calls";
  if (value === "content_filter") return "content-filter";
  return "unknown";
}

function parseArguments(value?: string): JsonValue {
  if (value === undefined || value === "") return {};
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return { raw: value };
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly connection: ConnectionInfo;
  readonly #apiKey?: string;
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #kind: OpenAICompatibleKind;

  constructor(options: OpenAICompatibleOptions) {
    this.#kind = options.kind ?? "openai";
    if (options.apiKey !== undefined) this.#apiKey = options.apiKey;
    this.#baseUrl = cleanBaseUrl(options.baseUrl ?? defaultBaseUrl(this.#kind));
    this.#headers = options.headers ?? {};
    this.connection = {
      id: options.id,
      adapterId: this.#kind,
      label: options.label ?? defaultLabel(this.#kind),
      boundary:
        options.boundary ??
        (this.#kind === "lm-studio" || this.#kind === "llama-cpp"
          ? "device"
          : "public-cloud"),
      capabilities:
        options.capabilities === undefined
          ? defaultCapabilities(this.#kind)
          : [...options.capabilities],
    };
  }

  #authHeaders(json = true): Record<string, string> {
    return {
      ...(this.#apiKey === undefined || this.#apiKey === ""
        ? {}
        : { authorization: `Bearer ${this.#apiKey}` }),
      ...(json ? { "content-type": "application/json" } : {}),
      ...this.#headers,
    };
  }

  async health(): Promise<HealthResult> {
    const started = performance.now();
    try {
      await checkedFetch(
        `${this.#baseUrl}/models`,
        {
          headers: this.#authHeaders(false),
          signal: requestSignal(undefined, 8_000),
        },
        this.connection.id,
      );
      return {
        available: true,
        reason: "available",
        message: `${this.connection.label} is reachable and authenticated.`,
        checkedAt: new Date().toISOString(),
        latencyMs: performance.now() - started,
      };
    } catch (error) {
      const code =
        error instanceof AiError ? error.code : "provider-unavailable";
      return {
        available: false,
        reason:
          code === "authentication-failed"
            ? "authentication-failed"
            : "unreachable",
        message:
          error instanceof Error
            ? error.message
            : `${this.connection.label} is unavailable.`,
        checkedAt: new Date().toISOString(),
        latencyMs: performance.now() - started,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await checkedFetch(
      `${this.#baseUrl}/models`,
      {
        headers: this.#authHeaders(false),
        signal: requestSignal(undefined, 15_000),
      },
      this.connection.id,
    );
    const data = (await response.json()) as {
      data?: Array<{ id?: string; name?: string; context_length?: number }>;
    };
    return (data.data ?? []).flatMap((model) => {
      if (model.id === undefined) return [];
      const capabilities = advertisedOpenAiModelCapabilities(
        model.id,
        this.connection.capabilities,
      );
      const specialized =
        isEmbeddingModelId(model.id) || isTranscriptionModelId(model.id);
      return [
        {
          id: model.id,
          name: model.name ?? model.id,
          capabilities,
          structuredOutput: capabilities.includes("structured-output")
            ? ("native-schema" as const)
            : ("unsupported" as const),
          ...(model.context_length === undefined
            ? {}
            : { contextWindow: model.context_length }),
          metadata: {
            capabilitySource: specialized
              ? "model-id-heuristic"
              : "adapter-surface",
          },
        },
      ];
    });
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const requestId = request.requestId ?? crypto.randomUUID();
    const response = await checkedFetch(
      `${this.#baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.#authHeaders(),
        signal: requestSignal(request.signal, request.timeoutMs),
        body: JSON.stringify(this.#body(request, false)),
      },
      this.connection.id,
      request.model.modelId,
    );
    const data = (await response.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).flatMap(
      (call, index) => {
        const name = call.function?.name;
        if (name === undefined) return [];
        return [
          {
            id: call.id ?? `${requestId}-${index}`,
            name,
            arguments: parseArguments(call.function?.arguments),
          },
        ];
      },
    );
    const resultUsage = normalizedUsage(data.usage);
    const result: TextResult = {
      requestId,
      model: request.model,
      text: choice?.message?.content ?? "",
      ...(choice?.message?.reasoning === undefined ||
      choice.message.reasoning === null
        ? {}
        : { reasoning: choice.message.reasoning }),
      toolCalls,
      finishReason:
        toolCalls.length > 0
          ? "tool-calls"
          : finishReason(choice?.finish_reason),
      ...(resultUsage === undefined ? {} : { usage: resultUsage }),
      providerMetadata: {
        ...(data.id === undefined ? {} : { requestId: data.id }),
        ...(data.model === undefined ? {} : { upstreamModel: data.model }),
      },
    };
    return result;
  }

  async *streamText(request: TextRequest): AsyncIterable<StreamEvent> {
    const requestId = request.requestId ?? crypto.randomUUID();
    yield { type: "start", requestId, model: request.model };
    const response = await checkedFetch(
      `${this.#baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.#authHeaders(),
        signal: requestSignal(request.signal, request.timeoutMs),
        body: JSON.stringify(this.#body(request, true)),
      },
      this.connection.id,
      request.model.modelId,
    );

    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let lastUsage: Usage | undefined;
    let lastReason: TextResult["finishReason"] = "unknown";
    let providerId: string | undefined;
    let upstreamModel: string | undefined;
    for await (const dataLine of sseData(response)) {
      if (dataLine === "[DONE]") break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(dataLine) as ChatChunk;
      } catch (error) {
        throw new AiError(
          "provider-error",
          "The provider returned malformed SSE JSON.",
          {
            cause: error,
            connectionId: this.connection.id,
            modelId: request.model.modelId,
          },
        );
      }
      providerId ??= chunk.id;
      upstreamModel ??= chunk.model;
      const choice = chunk.choices?.[0];
      const reasoning =
        choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
      if (reasoning !== undefined && reasoning !== null && reasoning !== "")
        yield { type: "reasoning-delta", delta: reasoning };
      if (
        choice?.delta?.content !== undefined &&
        choice.delta.content !== null &&
        choice.delta.content !== ""
      )
        yield { type: "text-delta", delta: choice.delta.content };
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const existing = calls.get(index);
        const id = call.id ?? existing?.id ?? `${requestId}-${index}`;
        const name = `${existing?.name ?? ""}${call.function?.name ?? ""}`;
        const argumentsDelta = call.function?.arguments ?? "";
        if (existing === undefined)
          yield { type: "tool-call-start", callId: id, name };
        if (argumentsDelta !== "")
          yield { type: "tool-call-delta", callId: id, argumentsDelta };
        calls.set(index, {
          id,
          name,
          arguments: `${existing?.arguments ?? ""}${argumentsDelta}`,
        });
      }
      lastReason = finishReason(choice?.finish_reason);
      const nextUsage = normalizedUsage(chunk.usage);
      if (nextUsage !== undefined) {
        lastUsage = nextUsage;
        yield { type: "usage", usage: nextUsage };
      }
    }
    for (const call of calls.values())
      yield {
        type: "tool-call",
        call: {
          id: call.id,
          name: call.name,
          arguments: parseArguments(call.arguments),
        },
      };
    yield {
      type: "finish",
      reason:
        calls.size > 0
          ? "tool-calls"
          : lastReason === "unknown"
            ? "stop"
            : lastReason,
      ...(lastUsage === undefined ? {} : { usage: lastUsage }),
      providerMetadata: {
        ...(providerId === undefined ? {} : { requestId: providerId }),
        ...(upstreamModel === undefined ? {} : { upstreamModel }),
      },
    };
  }

  async generateObject(request: ObjectRequest): Promise<ObjectResult> {
    if ((request.repairAttempts ?? 0) > 0) {
      throw new AiError(
        "unsupported-capability",
        "Automatic structured-output repair is not implemented; set repairAttempts to 0 and retry explicitly in the host when appropriate.",
        {
          connectionId: this.connection.id,
          modelId: request.model.modelId,
        },
      );
    }
    const providerOptions = {
      ...(request.providerOptions ?? {}),
      [this.connection.id]: {
        ...(request.providerOptions?.[this.connection.id] ?? {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName ?? "result",
            strict: true,
            schema: request.schema,
          },
        },
      },
    };
    const result = await this.generateText({ ...request, providerOptions });
    let value: JsonValue;
    try {
      value = JSON.parse(result.text) as JsonValue;
    } catch (error) {
      throw new AiError(
        "schema-validation-failed",
        "The provider returned invalid JSON.",
        {
          cause: error,
          connectionId: this.connection.id,
          modelId: request.model.modelId,
        },
      );
    }
    let validate: ValidateFunction;
    try {
      validate = new Ajv2020({ allErrors: true, strict: false }).compile(
        request.schema,
      );
    } catch (error) {
      throw new AiError(
        "schema-validation-failed",
        "The requested JSON Schema is invalid.",
        {
          cause: error,
          connectionId: this.connection.id,
          modelId: request.model.modelId,
        },
      );
    }
    if (!validate(value)) {
      throw new AiError(
        "schema-validation-failed",
        "The provider output does not match the requested schema.",
        {
          connectionId: this.connection.id,
          modelId: request.model.modelId,
          details: {
            validationErrors: JSON.parse(
              JSON.stringify(validate.errors ?? []),
            ) as never,
          },
        },
      );
    }
    const { text: rawText, ...rest } = result;
    return { ...rest, value, rawText };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const response = await checkedFetch(
      `${this.#baseUrl}/embeddings`,
      {
        method: "POST",
        headers: this.#authHeaders(),
        signal: requestSignal(request.signal, request.timeoutMs),
        body: JSON.stringify({
          model: request.model.modelId,
          input: request.input,
        }),
      },
      this.connection.id,
      request.model.modelId,
    );
    const data = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
      usage?: ChatCompletion["usage"];
    };
    const vectors = [...(data.data ?? [])]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding ?? []);
    const dimensions = vectors[0]?.length ?? 0;
    if (
      vectors.length !== request.input.length ||
      vectors.some((vector) => vector.length !== dimensions)
    ) {
      throw new AiError(
        "provider-error",
        "The provider returned incompatible embedding dimensions.",
        { connectionId: this.connection.id, modelId: request.model.modelId },
      );
    }
    const resultUsage = normalizedUsage(data.usage);
    return {
      vectors,
      model: request.model,
      dimensions,
      ...(request.inputMode === undefined
        ? {}
        : { inputMode: request.inputMode }),
      ...(resultUsage === undefined ? {} : { usage: resultUsage }),
    };
  }

  async transcribe(
    request: TranscriptionRequest,
  ): Promise<TranscriptionResult> {
    if (request.audio.data === undefined)
      throw new AiError(
        "invalid-request",
        "Transcription requires audio bytes for this adapter.",
      );
    const form = new FormData();
    const bytes = request.audio.data.slice().buffer;
    form.set(
      "file",
      new Blob([bytes], { type: request.audio.mimeType }),
      "audio",
    );
    form.set("model", request.model.modelId);
    if (request.language !== undefined) form.set("language", request.language);
    if (request.prompt !== undefined) form.set("prompt", request.prompt);
    const response = await checkedFetch(
      `${this.#baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: this.#authHeaders(false),
        signal: requestSignal(request.signal, request.timeoutMs),
        body: form,
      },
      this.connection.id,
      request.model.modelId,
    );
    const data = (await response.json()) as {
      text?: string;
      segments?: Array<{ text?: string; start?: number; end?: number }>;
    };
    return {
      text: data.text ?? "",
      model: request.model,
      ...(data.segments === undefined
        ? {}
        : {
            segments: data.segments.map((segment) => ({
              text: segment.text ?? "",
              ...(segment.start === undefined
                ? {}
                : { startMs: Math.round(segment.start * 1_000) }),
              ...(segment.end === undefined
                ? {}
                : { endMs: Math.round(segment.end * 1_000) }),
            })),
          }),
    };
  }

  #body(request: TextRequest, stream: boolean): JsonObject {
    const ownOptions = request.providerOptions?.[this.connection.id] ?? {};
    return {
      model: request.model.modelId,
      messages: apiMessages(request.messages) as never,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.temperature === undefined
        ? {}
        : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_tokens: request.maxOutputTokens }),
      ...(request.tools === undefined
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { ...tool, strict: true },
            })) as never,
          }),
      ...(request.toolChoice === undefined
        ? {}
        : {
            tool_choice:
              typeof request.toolChoice === "string"
                ? request.toolChoice
                : {
                    type: "function",
                    function: { name: request.toolChoice.name },
                  },
          }),
      ...ownOptions,
    };
  }
}
