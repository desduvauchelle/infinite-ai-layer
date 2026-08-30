import { describe, expect, it } from "vitest";
import {
  AiClient,
  AiError,
  MockAdapter,
  redactSecrets,
  textMessage,
} from "./index.js";

describe("AiClient", () => {
  it("streams normalized events", async () => {
    const client = new AiClient({
      adapters: [new MockAdapter({ response: "Route ready." })],
    });
    const events = [];
    for await (const event of client.streamText({
      model: { connectionId: "mock", modelId: "fixture-chat" },
      messages: [textMessage("user", "Hello")],
      maximumBoundary: "device",
    })) {
      events.push(event);
    }
    expect(events[0]?.type).toBe("start");
    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("rejects a boundary violation before invoking a provider", async () => {
    const adapter = new MockAdapter();
    adapter.connection.boundary = "public-cloud";
    const client = new AiClient({ adapters: [adapter] });
    await expect(
      client.generateText({
        model: { connectionId: "mock", modelId: "fixture-chat" },
        messages: [textMessage("user", "Private")],
        maximumBoundary: "device",
      }),
    ).rejects.toMatchObject({ code: "data-boundary-violation" });
  });

  it("supports multiple connections for one adapter", () => {
    const client = new AiClient({
      adapters: [
        new MockAdapter({ id: "one" }),
        new MockAdapter({ id: "two" }),
      ],
    });
    expect(client.connections().map(({ id }) => id)).toEqual(["one", "two"]);
  });

  it("rejects unsupported content before provider dispatch", async () => {
    const client = new AiClient({ adapters: [new MockAdapter()] });
    await expect(
      client.generateText({
        model: { connectionId: "mock", modelId: "fixture-chat" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                media: { mimeType: "image/png", data: new Uint8Array([1]) },
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("requires named tool choices to reference a declared tool", async () => {
    const adapter = new MockAdapter();
    adapter.connection.capabilities.push("tool-calling");
    const client = new AiClient({ adapters: [adapter] });
    await expect(
      client.generateText({
        model: { connectionId: "mock", modelId: "fixture-chat" },
        messages: [textMessage("user", "Use a tool")],
        tools: [{ name: "known", parameters: { type: "object" } }],
        toolChoice: { name: "missing" },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });
});

describe("redaction", () => {
  it("redacts common credentials", () => {
    expect(
      redactSecrets("Authorization: Bearer secret-value sk-1234567890abcdef"),
    ).not.toContain("secret-value");
  });

  it("serializes normalized errors", () => {
    const error = new AiError("provider-unavailable", "Bearer secret", {
      retryable: true,
      connectionId: "local",
    });
    expect(error.toJSON()).toMatchObject({
      code: "provider-unavailable",
      retryable: true,
      connectionId: "local",
    });
    expect(error.message).not.toContain("secret");
  });
});
