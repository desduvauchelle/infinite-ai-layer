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
  type Usage,
} from "@infinite-ai/core";
import { checkedFetch, cleanBaseUrl, ndjson, requestSignal } from "./http.js";

export interface OllamaOptions {
  id: string;
  baseUrl?: string;
  label?: string;
  boundary?: DataBoundary;
}

interface OllamaChunk {
  model?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function ollamaMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const toolResult = message.content.find(
      (part) => part.type === "tool-result",
    );
    if (message.role === "tool" && toolResult?.type === "tool-result") {
      return {
        role: "tool",
        content: JSON.stringify(toolResult.result.result),
        tool_name: toolResult.result.name,
      };
    }
    const toolCalls = message.content
      .filter((part) => part.type === "tool-call")
      .map((part) => ({
        function: {
          name: part.type === "tool-call" ? part.call.name : "",
          arguments: part.type === "tool-call" ? part.call.arguments : {},
        },
      }));
    return {
      role: message.role,
      content: messageText(message),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  });
}

function usage(chunk: OllamaChunk): Usage {
  const inputTokens = chunk.prompt_eval_count ?? 0;
  const outputTokens = chunk.eval_count ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cost: { source: "unavailable" },
  };
}

function modelCapabilities(upstream?: string[]): Capability[] {
  if (upstream === undefined) {
    return [
      "text-generation",
      "text-streaming",
      "reasoning-events",
      "structured-output",
      "tool-calling",
      "embeddings",
    ];
  }
  const capabilities: Capability[] = [];
  if (upstream.includes("completion"))
    capabilities.push("text-generation", "text-streaming", "structured-output");
  if (upstream.includes("thinking")) capabilities.push("reasoning-events");
  if (upstream.includes("tools")) capabilities.push("tool-calling");
  if (upstream.includes("embedding")) capabilities.push("embeddings");
  return capabilities;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly connection: ConnectionInfo;
  readonly #baseUrl: string;

  constructor(options: OllamaOptions) {
    this.#baseUrl = cleanBaseUrl(options.baseUrl ?? "http://127.0.0.1:11434");
    this.connection = {
      id: options.id,
      adapterId: "ollama",
      label: options.label ?? "Ollama",
      boundary: options.boundary ?? "device",
      capabilities: [
        "provider-health",
        "model-listing",
        "text-generation",
        "text-streaming",
        "reasoning-events",
        "structured-output",
        "tool-calling",
        "embeddings",
      ],
    };
  }

  async health(): Promise<HealthResult> {
    const started = performance.now();
    try {
      await checkedFetch(
        `${this.#baseUrl}/api/version`,
        { signal: requestSignal(undefined, 4_000) },
        this.connection.id,
      );
      return {
        available: true,
        reason: "available",
        message: "Ollama is reachable.",
        checkedAt: new Date().toISOString(),
        latencyMs: performance.now() - started,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Ollama is not reachable.";
      return {
        available: false,
        reason: "unreachable",
        message,
        checkedAt: new Date().toISOString(),
        latencyMs: performance.now() - started,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await checkedFetch(
      `${this.#baseUrl}/api/tags`,
      { signal: requestSignal(undefined, 8_000) },
      this.connection.id,
    );
    const data = (await response.json()) as {
      models?: Array<{
        name?: string;
        model?: string;
        details?: Record<string, unknown>;
        size?: number;
        capabilities?: string[];
      }>;
    };
    return (data.models ?? []).flatMap((model) => {
      const id = model.model ?? model.name;
      if (id === undefined) return [];
      const capabilities = modelCapabilities(model.capabilities);
      return [
        {
          id,
          name: model.name ?? id,
          capabilities,
          structuredOutput: capabilities.includes("structured-output")
            ? ("native-schema" as const)
            : ("unsupported" as const),
          metadata: {
            capabilitySource:
              model.capabilities === undefined
                ? "connection-default"
                : "provider-reported",
            ...(model.capabilities === undefined
              ? {}
              : { upstreamCapabilities: model.capabilities }),
            ...(model.size === undefined ? {} : { size: model.size }),
            ...(model.details === undefined
              ? {}
              : {
                  details: JSON.parse(JSON.stringify(model.details)) as never,
                }),
          },
        },
      ];
    });
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    this.#validateToolChoice(request);
    const requestId = request.requestId ?? crypto.randomUUID();
    const response = await checkedFetch(
      `${this.#baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: requestSignal(request.signal, request.timeoutMs),
        body: JSON.stringify({
          model: request.model.modelId,
          messages: ollamaMessages(request.messages),
          stream: false,
          ...(request.temperature === undefined &&
          request.maxOutputTokens === undefined
            ? {}
            : {
                options: {
                  ...(request.temperature === undefined
                    ? {}
                    : { temperature: request.temperature }),
                  ...(request.maxOutputTokens === undefined
                    ? {}
                    : { num_predict: request.maxOutputTokens }),
                },
              }),
          ...(request.tools === undefined
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: tool,
                })),
              }),
          ...(request.providerOptions?.ollama ?? {}),
        }),
      },
      this.connection.id,
      request.model.modelId,
    );
    const data = (await response.json()) as OllamaChunk;
    const toolCalls: ToolCall[] = (data.message?.tool_calls ?? []).flatMap(
      (item, index) => {
        const name = item.function?.name;
        if (name === undefined) return [];
        return [
          {
            id: `ollama-${requestId}-${index}`,
            name,
            arguments: (item.function?.arguments ?? null) as never,
          },
        ];
      },
    );
    return {
      requestId,
      model: request.model,
      text: data.message?.content ?? "",
      ...(data.message?.thinking === undefined
        ? {}
        : { reasoning: data.message.thinking }),
      toolCalls,
      finishReason:
        toolCalls.length > 0
          ? "tool-calls"
          : data.done_reason === "length"
            ? "length"
            : "stop",
      usage: usage(data),
      providerMetadata: {
        ...(data.model === undefined ? {} : { upstreamModel: data.model }),
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
    const result = await this.generateText({
      ...request,
      providerOptions: {
        ...(request.providerOptions ?? {}),
        ollama: {
          ...(request.providerOptions?.ollama ?? {}),
          format: request.schema,
        },
      },
    });
    let value: JsonValue;
    try {
      value = JSON.parse(result.text) as JsonValue;
    } catch (error) {
      throw new AiError(
        "schema-validation-failed",
        "Ollama returned invalid JSON.",
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
        "Ollama output does not match the requested schema.",
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

  async *streamText(request: TextRequest): AsyncIterable<StreamEvent> {
    this.#validateToolChoice(request);
    const requestId = request.requestId ?? crypto.randomUUID();
    yield { type: "start", requestId, model: request.model };
    const response = await checkedFetch(
      `${this.#baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: requestSignal(request.signal, request.timeoutMs),
        body: JSON.stringify({
          model: request.model.modelId,
          messages: ollamaMessages(request.messages),
          stream: true,
          ...(request.temperature === undefined &&
          request.maxOutputTokens === undefined
            ? {}
            : {
                options: {
                  ...(request.temperature === undefined
                    ? {}
                    : { temperature: request.temperature }),
                  ...(request.maxOutputTokens === undefined
                    ? {}
                    : { num_predict: request.maxOutputTokens }),
                },
              }),
          ...(request.tools === undefined
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: tool,
                })),
              }),
          ...(request.providerOptions?.ollama ?? {}),
        }),
      },
      this.connection.id,
      request.model.modelId,
    );

    for await (const value of ndjson(response)) {
      const chunk = value as OllamaChunk;
      if (
        chunk.message?.thinking !== undefined &&
        chunk.message.thinking !== ""
      )
        yield { type: "reasoning-delta", delta: chunk.message.thinking };
      if (chunk.message?.content !== undefined && chunk.message.content !== "")
        yield { type: "text-delta", delta: chunk.message.content };
      for (const [index, item] of (chunk.message?.tool_calls ?? []).entries()) {
        const name = item.function?.name;
        if (name === undefined) continue;
        yield {
          type: "tool-call",
          call: {
            id: `ollama-${requestId}-${index}`,
            name,
            arguments: (item.function?.arguments ?? null) as never,
          },
        };
      }
      if (chunk.done === true) {
        const finalUsage = usage(chunk);
        yield { type: "usage", usage: finalUsage };
        yield {
          type: "finish",
          reason:
            (chunk.message?.tool_calls?.length ?? 0) > 0
              ? "tool-calls"
              : chunk.done_reason === "length"
                ? "length"
                : "stop",
          usage: finalUsage,
          providerMetadata: {
            ...(chunk.model === undefined
              ? {}
              : { upstreamModel: chunk.model }),
          },
        };
      }
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const response = await checkedFetch(
      `${this.#baseUrl}/api/embed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      embeddings?: number[][];
      prompt_eval_count?: number;
    };
    const vectors = data.embeddings ?? [];
    const dimensions = vectors[0]?.length ?? 0;
    if (
      vectors.length !== request.input.length ||
      vectors.some((vector) => vector.length !== dimensions)
    ) {
      throw new AiError(
        "provider-error",
        "Ollama returned incompatible embedding dimensions.",
        { connectionId: this.connection.id, modelId: request.model.modelId },
      );
    }
    return {
      vectors,
      model: request.model,
      dimensions,
      ...(request.inputMode === undefined
        ? {}
        : { inputMode: request.inputMode }),
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        totalTokens: data.prompt_eval_count ?? 0,
        cost: { source: "unavailable" },
      },
    };
  }

  #validateToolChoice(request: TextRequest): void {
    if (request.toolChoice !== undefined && request.toolChoice !== "auto") {
      throw new AiError(
        "unsupported-capability",
        "Ollama does not expose portable required or named tool-choice semantics.",
        {
          connectionId: this.connection.id,
          modelId: request.model.modelId,
        },
      );
    }
  }
}
