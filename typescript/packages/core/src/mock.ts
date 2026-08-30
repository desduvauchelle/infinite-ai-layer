import type { ProviderAdapter } from "./adapter.js";
import { AiError } from "./errors.js";
import {
  messageText,
  type ConnectionInfo,
  type HealthResult,
  type ModelInfo,
  type StreamEvent,
  type TextRequest,
  type TextResult,
} from "./types.js";

export interface MockAdapterOptions {
  id?: string;
  label?: string;
  response?: string;
  reasoning?: string;
  delayMs?: number;
  failAfterChunks?: number;
}

export class MockAdapter implements ProviderAdapter {
  readonly connection: ConnectionInfo;
  readonly #response: string;
  readonly #reasoning?: string;
  readonly #delayMs: number;
  readonly #failAfterChunks?: number;

  constructor(options: MockAdapterOptions = {}) {
    const id = options.id ?? "mock";
    this.connection = {
      id,
      adapterId: "mock",
      label: options.label ?? "Demo line",
      boundary: "device",
      capabilities: [
        "provider-health",
        "model-listing",
        "text-generation",
        "text-streaming",
        "reasoning-events",
      ],
    };
    this.#response =
      options.response ??
      "The demo route is working. Configure Ollama or a cloud provider when you are ready to switch lines.";
    if (options.reasoning !== undefined) this.#reasoning = options.reasoning;
    this.#delayMs = options.delayMs ?? 16;
    if (options.failAfterChunks !== undefined)
      this.#failAfterChunks = options.failAfterChunks;
  }

  async health(): Promise<HealthResult> {
    return {
      available: true,
      reason: "available",
      message: "Deterministic demo adapter is ready.",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "fixture-chat",
        name: "Fixture Chat",
        capabilities: ["text-generation", "text-streaming", "reasoning-events"],
        structuredOutput: "unsupported",
      },
    ];
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const requestId = request.requestId ?? crypto.randomUUID();
    return {
      requestId,
      model: request.model,
      text: this.#responseFor(request),
      ...(this.#reasoning === undefined ? {} : { reasoning: this.#reasoning }),
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 8,
        outputTokens: 15,
        totalTokens: 23,
        cost: { source: "unavailable" },
      },
    };
  }

  async *streamText(request: TextRequest): AsyncIterable<StreamEvent> {
    const requestId = request.requestId ?? crypto.randomUUID();
    yield { type: "start", requestId, model: request.model };
    if (this.#reasoning !== undefined)
      yield { type: "reasoning-delta", delta: this.#reasoning };
    const chunks = this.#responseFor(request).match(/.{1,12}(?:\s|$)/g) ?? [
      this.#responseFor(request),
    ];
    for (const [index, chunk] of chunks.entries()) {
      if (request.signal?.aborted === true)
        throw new AiError("cancelled", "The request was cancelled.");
      if (
        this.#failAfterChunks !== undefined &&
        index >= this.#failAfterChunks
      ) {
        throw new AiError(
          "provider-error",
          "The mock stream failed after partial output.",
          { retryable: true },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
      yield { type: "text-delta", delta: chunk };
    }
    const usage = {
      inputTokens: 8,
      outputTokens: 15,
      totalTokens: 23,
      cost: { source: "unavailable" as const },
    };
    yield { type: "usage", usage };
    yield { type: "finish", reason: "stop", usage };
  }

  #responseFor(request: TextRequest): string {
    const latest = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt = latest === undefined ? "" : messageText(latest);
    return prompt.trim() === ""
      ? this.#response
      : `${this.#response}\n\nYou sent: “${prompt.trim()}”`;
  }
}
