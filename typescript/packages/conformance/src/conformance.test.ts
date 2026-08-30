import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textMessage } from "@infinite-ai/core";
import { OpenAICompatibleAdapter } from "@infinite-ai/providers";
import { createContractValidator } from "./index.js";

async function json(relative: string): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`../../../../spec/${relative}`, import.meta.url),
  );
  return JSON.parse(await readFile(path, "utf8"));
}

describe("portable contract", () => {
  it("accepts every shared fixture", async () => {
    const schema = (await json("schemas/contract.schema.json")) as object;
    const validate = createContractValidator(schema);
    for (const fixture of [
      "fixtures/text-request.json",
      "fixtures/stream-events.json",
      "fixtures/object-result.json",
      "fixtures/error.json",
      "fixtures/embedding-result.json",
      "fixtures/transcription-result.json",
      "fixtures/agent-request.json",
      "fixtures/agent-events.json",
    ]) {
      const result = validate(await json(fixture));
      expect(result.errors, fixture).toEqual([]);
      expect(result.valid, fixture).toBe(true);
    }
  });

  it("rejects an invalid contract version", async () => {
    const schema = (await json("schemas/contract.schema.json")) as object;
    const validate = createContractValidator(schema);
    expect(
      validate({ contractVersion: "9", kind: "error", value: {} }).valid,
    ).toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("adapter behavior", () => {
  it("does not advertise embed or transcribe on chat model ids", async () => {
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
  });

  it("does not silently drop required image content parts", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
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
      model: { connectionId: "cloud", modelId: "gpt-4o" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            {
              type: "image",
              media: { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
            },
          ],
        },
      ],
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(Array.isArray(body.messages[0]?.content)).toBe(true);
    expect(body.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image_url" }),
        expect.objectContaining({ type: "text", text: "Look" }),
      ]),
    );
  });

  it("sends tool strict true and generateObject schemaName result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"answer":1}' }, finish_reason: "stop" },
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
      model: { connectionId: "cloud", modelId: "gpt-4o" },
      messages: [textMessage("user", "Hi")],
      tools: [{ name: "lookup", parameters: { type: "object" } }],
    });
    const toolBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ function: { strict?: boolean } }>;
    };
    expect(toolBody.tools[0]?.function.strict).toBe(true);

    await adapter.generateObject!({
      model: { connectionId: "cloud", modelId: "gpt-4o" },
      messages: [textMessage("user", "Return an answer")],
      schema: {
        type: "object",
        properties: { answer: { type: "integer" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    const objectBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { response_format?: { json_schema?: { name?: string } } };
    expect(objectBody.response_format?.json_schema?.name).toBe("result");
  });

  it("includes stream finish providerMetadata and maps HTTP auth errors", async () => {
    const sse = [
      'data: {"id":"one","model":"demo","choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse, { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("nope", { status: 403 }))
      .mockResolvedValueOnce(new Response("nope", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({
      id: "cloud",
      apiKey: "test-key",
    });
    const events = [];
    for await (const event of adapter.streamText!({
      model: { connectionId: "cloud", modelId: "demo" },
      messages: [textMessage("user", "Hi")],
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      providerMetadata: { requestId: "one", upstreamModel: "demo" },
    });
    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "authentication-failed",
    });
    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "rate-limited",
    });
  });
});
