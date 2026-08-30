import type { ProviderAdapter } from "./adapter.js";
import { AiError } from "./errors.js";
import type {
  AgentEvent,
  AgentRequest,
  Capability,
  ConnectionInfo,
  DataBoundary,
  EmbeddingRequest,
  EmbeddingResult,
  HealthResult,
  ModelInfo,
  ObjectRequest,
  ObjectResult,
  RequestContext,
  StreamEvent,
  TextRequest,
  TextResult,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types.js";

const BOUNDARY_RANK: Record<DataBoundary, number> = {
  device: 0,
  "local-network": 1,
  "private-remote": 2,
  "public-cloud": 3,
};

export interface ObserverEvent {
  type: "request-start" | "request-finish" | "request-error";
  operation: string;
  requestId?: string;
  connectionId: string;
  modelId?: string;
  durationMs?: number;
  errorCode?: string;
}

export type Observer = (event: ObserverEvent) => void;

function isAbsoluteWorkspace(workspace: string): boolean {
  return (
    workspace.startsWith("/") ||
    workspace.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(workspace)
  );
}

export class AiClient {
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #models = new Map<string, Map<string, ModelInfo>>();
  readonly #observer?: Observer;

  constructor(
    options: { adapters?: ProviderAdapter[]; observer?: Observer } = {},
  ) {
    if (options.observer !== undefined) this.#observer = options.observer;
    for (const adapter of options.adapters ?? []) this.register(adapter);
  }

  register(adapter: ProviderAdapter): this {
    if (
      adapter.connection.id.trim() === "" ||
      adapter.connection.adapterId.trim() === "" ||
      adapter.connection.label.trim() === ""
    ) {
      throw new AiError(
        "invalid-request",
        "Connections require non-empty id, adapterId, and label values.",
      );
    }
    if (!Object.hasOwn(BOUNDARY_RANK, adapter.connection.boundary)) {
      throw new AiError(
        "invalid-request",
        `Connection '${adapter.connection.id}' has an unknown data boundary.`,
      );
    }
    if (this.#adapters.has(adapter.connection.id)) {
      throw new AiError(
        "invalid-request",
        `Connection '${adapter.connection.id}' is already registered.`,
      );
    }
    this.#adapters.set(adapter.connection.id, adapter);
    return this;
  }

  unregister(connectionId: string): boolean {
    this.#models.delete(connectionId);
    return this.#adapters.delete(connectionId);
  }

  connections(): ConnectionInfo[] {
    return [...this.#adapters.values()].map((adapter) =>
      structuredClone(adapter.connection),
    );
  }

  async health(connectionId: string): Promise<HealthResult> {
    return this.#adapter(connectionId).health();
  }

  async listModels(connectionId: string): Promise<ModelInfo[]> {
    const models = await this.#adapter(connectionId).listModels();
    this.#models.set(
      connectionId,
      new Map(models.map((model) => [model.id, model])),
    );
    return models;
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const adapter = this.#preflightText(request, "text-generation");
    if (adapter.generateText === undefined)
      this.#unsupported(request, "text-generation");
    return this.#observe("generateText", request, () =>
      adapter.generateText!(request),
    );
  }

  async *streamText(request: TextRequest): AsyncIterable<StreamEvent> {
    const adapter = this.#preflightText(request, "text-streaming");
    if (adapter.streamText === undefined)
      this.#unsupported(request, "text-streaming");
    const started = performance.now();
    this.#observer?.({
      type: "request-start",
      operation: "streamText",
      connectionId: request.model.connectionId,
      modelId: request.model.modelId,
      ...(request.requestId === undefined
        ? {}
        : { requestId: request.requestId }),
    });
    try {
      for await (const event of adapter.streamText!(request)) yield event;
      this.#observer?.({
        type: "request-finish",
        operation: "streamText",
        connectionId: request.model.connectionId,
        modelId: request.model.modelId,
        durationMs: performance.now() - started,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
      });
    } catch (error) {
      const normalized =
        error instanceof AiError
          ? error
          : new AiError(
              "provider-error",
              error instanceof Error
                ? error.message
                : "Provider stream failed.",
            );
      this.#observer?.({
        type: "request-error",
        operation: "streamText",
        connectionId: request.model.connectionId,
        modelId: request.model.modelId,
        durationMs: performance.now() - started,
        errorCode: normalized.code,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
      });
      throw normalized;
    }
  }

  async generateObject(request: ObjectRequest): Promise<ObjectResult> {
    const adapter = this.#preflightText(request, "structured-output");
    if (adapter.generateObject === undefined)
      this.#unsupported(request, "structured-output");
    return this.#observe("generateObject", request, () =>
      adapter.generateObject!(request),
    );
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.input.length === 0) {
      throw new AiError("invalid-request", "Embedding input cannot be empty.", {
        connectionId: request.model.connectionId,
        modelId: request.model.modelId,
      });
    }
    const adapter = this.#preflight(request, "embeddings");
    if (adapter.embed === undefined) this.#unsupported(request, "embeddings");
    return this.#observe("embed", request, () => adapter.embed!(request));
  }

  async transcribe(
    request: TranscriptionRequest,
  ): Promise<TranscriptionResult> {
    if (request.audio.mimeType.trim() === "") {
      throw new AiError(
        "invalid-request",
        "Transcription audio requires a MIME type.",
      );
    }
    if (
      (request.audio.data === undefined) ===
      (request.audio.url === undefined)
    ) {
      throw new AiError(
        "invalid-request",
        "Media input requires exactly one of data or url.",
      );
    }
    const adapter = this.#preflight(request, "transcription");
    if (adapter.transcribe === undefined)
      this.#unsupported(request, "transcription");
    return this.#observe("transcribe", request, () =>
      adapter.transcribe!(request),
    );
  }

  async *runAgent(request: AgentRequest): AsyncIterable<AgentEvent> {
    const context: RequestContext = { ...request, model: request.agent };
    if (request.prompt.trim() === "") {
      throw new AiError("invalid-request", "An agent prompt is required.", {
        connectionId: request.agent.connectionId,
        modelId: request.agent.modelId,
      });
    }
    if (request.workspace.trim() === "") {
      throw new AiError(
        "invalid-request",
        "The agent workspace must be an absolute path.",
        {
          connectionId: request.agent.connectionId,
          modelId: request.agent.modelId,
        },
      );
    }
    if (!isAbsoluteWorkspace(request.workspace)) {
      throw new AiError(
        "invalid-request",
        "The agent workspace must be an absolute path.",
        {
          connectionId: request.agent.connectionId,
          modelId: request.agent.modelId,
        },
      );
    }
    const adapter = this.#preflight(context, "agent-execution");
    if (adapter.runAgent === undefined)
      this.#unsupported(context, "agent-execution");
    const started = performance.now();
    this.#observer?.({
      type: "request-start",
      operation: "runAgent",
      connectionId: request.agent.connectionId,
      modelId: request.agent.modelId,
      ...(request.requestId === undefined
        ? {}
        : { requestId: request.requestId }),
    });
    try {
      for await (const event of adapter.runAgent!(request)) yield event;
      this.#observer?.({
        type: "request-finish",
        operation: "runAgent",
        connectionId: request.agent.connectionId,
        modelId: request.agent.modelId,
        durationMs: performance.now() - started,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
      });
    } catch (error) {
      const normalized =
        error instanceof AiError
          ? error
          : new AiError(
              "provider-error",
              error instanceof Error ? error.message : "Agent request failed.",
            );
      this.#observer?.({
        type: "request-error",
        operation: "runAgent",
        connectionId: request.agent.connectionId,
        modelId: request.agent.modelId,
        durationMs: performance.now() - started,
        errorCode: normalized.code,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
      });
      throw normalized;
    }
  }

  #adapter(connectionId: string): ProviderAdapter {
    const adapter = this.#adapters.get(connectionId);
    if (adapter === undefined) {
      throw new AiError(
        "invalid-request",
        `Connection '${connectionId}' is not registered.`,
        { connectionId },
      );
    }
    return adapter;
  }

  #preflight(request: RequestContext, capability: Capability): ProviderAdapter {
    if (
      request.model.connectionId.trim() === "" ||
      request.model.modelId.trim() === ""
    ) {
      throw new AiError(
        "invalid-request",
        "A non-empty connection ID and model ID are required.",
      );
    }
    if (request.requestId !== undefined && request.requestId.trim() === "") {
      throw new AiError("invalid-request", "requestId cannot be empty.");
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
    ) {
      throw new AiError(
        "invalid-request",
        "timeoutMs must be a positive integer.",
      );
    }
    if (
      request.maximumBoundary !== undefined &&
      !Object.hasOwn(BOUNDARY_RANK, request.maximumBoundary)
    ) {
      throw new AiError(
        "invalid-request",
        `Unknown data boundary '${String(request.maximumBoundary)}'.`,
      );
    }
    if (request.signal?.aborted === true)
      throw new AiError(
        "cancelled",
        "The request was cancelled before dispatch.",
      );
    const adapter = this.#adapter(request.model.connectionId);
    if (
      request.maximumBoundary !== undefined &&
      BOUNDARY_RANK[adapter.connection.boundary] >
        BOUNDARY_RANK[request.maximumBoundary]
    ) {
      throw new AiError(
        "data-boundary-violation",
        `Connection '${adapter.connection.id}' is classified as ${adapter.connection.boundary}, beyond the request limit ${request.maximumBoundary}.`,
        { connectionId: adapter.connection.id, modelId: request.model.modelId },
      );
    }
    if (!adapter.connection.capabilities.includes(capability))
      this.#unsupported(request, capability);
    this.#assertModelCapability(adapter, request, capability);
    return adapter;
  }

  #preflightText(
    request: TextRequest,
    capability: Capability,
  ): ProviderAdapter {
    if (request.messages.length === 0) {
      throw new AiError(
        "invalid-request",
        "At least one message is required.",
        {
          connectionId: request.model.connectionId,
          modelId: request.model.modelId,
        },
      );
    }
    if (
      request.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maxOutputTokens) ||
        request.maxOutputTokens <= 0)
    ) {
      throw new AiError(
        "invalid-request",
        "maxOutputTokens must be a positive integer.",
      );
    }
    if (
      request.temperature !== undefined &&
      !Number.isFinite(request.temperature)
    ) {
      throw new AiError("invalid-request", "temperature must be finite.");
    }
    const toolNames = request.tools?.map((tool) => tool.name.trim()) ?? [];
    if (
      toolNames.some((name) => name === "") ||
      new Set(toolNames).size !== toolNames.length
    ) {
      throw new AiError(
        "invalid-request",
        "Tool names must be non-empty and unique.",
      );
    }
    const adapter = this.#preflight(request, capability);
    if (
      (request.tools?.length ?? 0) > 0 ||
      request.toolChoice !== undefined ||
      request.messages.some((message) =>
        message.content.some(
          (part) => part.type === "tool-call" || part.type === "tool-result",
        ),
      )
    ) {
      this.#assertCapability(adapter, request, "tool-calling");
    }
    if (
      request.toolChoice !== undefined &&
      (request.tools?.length ?? 0) === 0
    ) {
      throw new AiError(
        "invalid-request",
        "toolChoice requires at least one tool definition.",
        {
          connectionId: request.model.connectionId,
          modelId: request.model.modelId,
        },
      );
    }
    const namedToolChoice =
      typeof request.toolChoice === "object"
        ? request.toolChoice.name
        : undefined;
    if (
      namedToolChoice !== undefined &&
      !request.tools?.some((tool) => tool.name === namedToolChoice)
    ) {
      throw new AiError(
        "invalid-request",
        `Named tool choice '${namedToolChoice}' is not present in tools.`,
        {
          connectionId: request.model.connectionId,
          modelId: request.model.modelId,
        },
      );
    }
    for (const message of request.messages) {
      for (const part of message.content) {
        if (part.type === "image") {
          this.#assertCapability(adapter, request, "image-understanding");
          continue;
        }
        if (part.type === "audio" || part.type === "file") {
          throw new AiError(
            "unsupported-capability",
            `${part.type} message parts are not supported by this connection.`,
            {
              connectionId: request.model.connectionId,
              modelId: request.model.modelId,
            },
          );
        }
      }
    }
    return adapter;
  }

  #assertCapability(
    adapter: ProviderAdapter,
    request: RequestContext,
    capability: Capability,
  ): void {
    if (!adapter.connection.capabilities.includes(capability))
      this.#unsupported(request, capability);
    this.#assertModelCapability(adapter, request, capability);
  }

  #assertModelCapability(
    adapter: ProviderAdapter,
    request: RequestContext,
    capability: Capability,
  ): void {
    const known = this.#models
      .get(adapter.connection.id)
      ?.get(request.model.modelId);
    if (known === undefined || known.capabilities.length === 0) return;
    if (!known.capabilities.includes(capability)) {
      throw new AiError(
        "unsupported-capability",
        `Model '${request.model.modelId}' on connection '${request.model.connectionId}' does not support ${capability}.`,
        {
          connectionId: request.model.connectionId,
          modelId: request.model.modelId,
        },
      );
    }
  }

  #unsupported(request: RequestContext, capability: Capability): never {
    throw new AiError(
      "unsupported-capability",
      `Connection '${request.model.connectionId}' does not support ${capability}.`,
      {
        connectionId: request.model.connectionId,
        modelId: request.model.modelId,
      },
    );
  }

  async #observe<T>(
    operation: string,
    request: RequestContext,
    call: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    this.#observer?.({
      type: "request-start",
      operation,
      connectionId: request.model.connectionId,
      modelId: request.model.modelId,
      ...(request.requestId === undefined
        ? {}
        : { requestId: request.requestId }),
    });
    try {
      const result = await call();
      this.#observer?.({
        type: "request-finish",
        operation,
        connectionId: request.model.connectionId,
        modelId: request.model.modelId,
        durationMs: performance.now() - started,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
      });
      return result;
    } catch (error) {
      const normalized =
        error instanceof AiError
          ? error
          : new AiError(
              "provider-error",
              error instanceof Error
                ? error.message
                : "Provider request failed.",
            );
      this.#observer?.({
        type: "request-error",
        operation,
        connectionId: request.model.connectionId,
        modelId: request.model.modelId,
        durationMs: performance.now() - started,
        errorCode: normalized.code,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
      });
      throw normalized;
    }
  }
}
