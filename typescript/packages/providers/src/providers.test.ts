import { afterEach, describe, expect, it, vi } from "vitest";
import { AiClient, textMessage } from "@infinite-ai/core";
import { OllamaAdapter, OpenAICompatibleAdapter } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("OllamaAdapter", () => {
  it("lists models and streams NDJSON", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "llama3.2",
                size: 10,
                capabilities: ["completion", "tools"],
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            '{"model":"llama3.2","message":{"content":"Hello "},"done":false}',
            '{"model":"llama3.2","message":{"content":"world"},"done":true,"prompt_eval_count":2,"eval_count":2}',
          ].join("\n"),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OllamaAdapter({ id: "local" });
    expect(await adapter.listModels()).toMatchObject([
      {
        capabilities: [
          "text-generation",
          "text-streaming",
          "structured-output",
          "tool-calling",
        ],
        metadata: { capabilitySource: "provider-reported" },
      },
    ]);
    const client = new AiClient({ adapters: [adapter] });
    const events = [];
    for await (const event of client.streamText({
      model: { connectionId: "local", modelId: "llama3.2" },
      messages: [textMessage("user", "Hi")],
    }))
      events.push(event);
    expect(events.filter((event) => event.type === "text-delta")).toHaveLength(
      2,
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it("requests and validates structured output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "demo",
          message: { content: '{"answer":42}' },
          done: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OllamaAdapter({ id: "local" });
    const result = await adapter.generateObject!({
      model: { connectionId: "local", modelId: "demo" },
      messages: [textMessage("user", "Return an answer")],
      schema: {
        type: "object",
        properties: { answer: { type: "integer" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    expect(result.value).toEqual({ answer: 42 });
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.format).toMatchObject({ type: "object" });
  });
});

describe("OpenAICompatibleAdapter", () => {
  it("normalizes SSE text and usage", async () => {
    const body = [
      'data: {"id":"one","model":"demo","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      "",
      'data: {"id":"one","model":"demo","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4,"cost":0.00012}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200 })),
    );
    const adapter = new OpenAICompatibleAdapter({
      id: "cloud",
      apiKey: "test-key",
    });
    const events = [];
    for await (const event of adapter.streamText!({
      model: { connectionId: "cloud", modelId: "demo" },
      messages: [textMessage("user", "Hi")],
    }))
      events.push(event);
    expect(events.filter((event) => event.type === "text-delta")).toHaveLength(
      2,
    );
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usage: {
        cost: {
          amount: "0.00012",
          currency: "USD",
          source: "provider-reported",
        },
      },
    });
  });

  it("round-trips tool calls and tool results", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "The weather is 20°C." },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({
      id: "cloud",
      apiKey: "test-key",
    });

    await adapter.generateText!({
      model: { connectionId: "cloud", modelId: "demo" },
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              call: {
                id: "call-1",
                name: "weather",
                arguments: { city: "Paris" },
              },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              result: {
                callId: "call-1",
                name: "weather",
                result: { temperature: 20 },
              },
            },
          ],
        },
      ],
      tools: [
        {
          name: "weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
      toolChoice: { name: "weather" },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<Record<string, unknown>>;
      tools: unknown[];
    };
    expect(request.messages[0]).toMatchObject({
      tool_calls: [
        {
          id: "call-1",
          function: { name: "weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(request.messages[1]).toMatchObject({ tool_call_id: "call-1" });
    expect(request.tools).toHaveLength(1);
    expect(request).toMatchObject({
      tool_choice: { type: "function", function: { name: "weather" } },
      tools: [{ function: { strict: true } }],
    });
  });

  it("does not copy embed or transcribe onto chat model ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4o" },
              { id: "text-embedding-3-small" },
              { id: "whisper-1" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = new OpenAICompatibleAdapter({
      id: "cloud",
      apiKey: "test-key",
    });
    const models = await adapter.listModels();
    const chat = models.find((model) => model.id === "gpt-4o");
    expect(chat?.capabilities).not.toContain("embeddings");
    expect(chat?.capabilities).not.toContain("transcription");
    expect(
      models.find((model) => model.id === "text-embedding-3-small")
        ?.capabilities,
    ).toEqual(["embeddings"]);
    expect(
      models.find((model) => model.id === "whisper-1")?.capabilities,
    ).toEqual(["transcription"]);
  });

  it("keys providerOptions by connection id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({
      id: "personal-openai",
      apiKey: "test-key",
    });
    await adapter.generateText!({
      model: { connectionId: "personal-openai", modelId: "gpt-4o" },
      messages: [textMessage("user", "Hi")],
      providerOptions: {
        openai: { temperature: 0 },
        "personal-openai": { user: "denis" },
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      user?: string;
      temperature?: number;
    };
    expect(body.user).toBe("denis");
    expect(body.temperature).toBeUndefined();
  });

  it("redacts authentication failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("Bearer secret", { status: 401 })),
    );
    const adapter = new OpenAICompatibleAdapter({
      id: "cloud",
      apiKey: "secret",
    });
    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "authentication-failed",
    });
  });
});
