import { afterEach, describe, expect, it, vi } from "vitest";
import { listConnections, streamChat } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo API client", () => {
  it("parses normalized SSE events split across network chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","del'));
        controller.enqueue(
          encoder.encode(
            'ta":"Hello"}\n\ndata: {"type":"finish","reason":"stop"}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const events: unknown[] = [];

    await streamChat(
      {
        connectionId: "demo",
        modelId: "fixture-chat",
        maximumBoundary: "device",
        messages: [{ role: "user", text: "Hello" }],
      },
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: "text-delta", delta: "Hello" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("surfaces server error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Provider refused the route." } }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(listConnections()).rejects.toThrow(
      "Provider refused the route.",
    );
  });
});
