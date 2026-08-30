# SDK guide

## Design rule: the host chooses first

Infinite AI Layer never discovers providers and never picks a model. The host registers allowed connections during startup and sends an exact `connectionId + modelId` with every request. Multiple connections may use the same adapter.

`listModels(connectionId)` asks one already-registered connection for its models. `connections()` returns registration metadata without probing the computer or network.

## TypeScript setup

```ts
import { AiClient } from "@infinite-ai/core";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@infinite-ai/providers";

const ai = new AiClient({
  adapters: [
    new OllamaAdapter({
      id: "mac-ollama",
      baseUrl: "http://127.0.0.1:11434",
      boundary: "device",
    }),
    new OpenAICompatibleAdapter({
      id: "personal-openrouter",
      kind: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      boundary: "public-cloud",
    }),
    new OpenAICompatibleAdapter({
      id: "studio",
      kind: "lm-studio",
    }),
  ],
});

const connections = ai.connections();
const localModels = await ai.listModels("mac-ollama");
```

### Stream text and reasoning separately

```ts
import { textMessage } from "@infinite-ai/core";

const controller = new AbortController();
const events = ai.streamText({
  model: { connectionId: "mac-ollama", modelId: "qwen3:8b" },
  messages: [textMessage("user", "Give me three release risks")],
  maximumBoundary: "device",
  timeoutMs: 60_000,
  signal: controller.signal,
});

for await (const event of events) {
  if (event.type === "text-delta") process.stdout.write(event.delta);
  if (event.type === "reasoning-delta") {
    // The application decides whether to show, discard, or use this event.
  }
  if (event.type === "usage") console.log(event.usage.cost);
}
```

The boundary check happens before adapter dispatch. A request capped at `device` cannot use a `public-cloud` connection.

### Structured output

```ts
const answer = await ai.generateObject({
  model: { connectionId: "mac-ollama", modelId: "qwen3:8b" },
  messages: [textMessage("user", "Return the two main risks")],
  schemaName: "risks",
  schema: {
    type: "object",
    properties: {
      risks: { type: "array", items: { type: "string" } },
    },
    required: ["risks"],
    additionalProperties: false,
  },
});
```

The final value is validated locally in both implementations. Automatic repair is intentionally rejected in this alpha; leave `repairAttempts` unset or set it to `0`.

### Tool-call transport

```ts
const first = await ai.generateText({
  model: { connectionId: "personal-openrouter", modelId: "your-model-id" },
  messages: [textMessage("user", "What is the weather in Paris?")],
  tools: [
    {
      name: "weather",
      description: "Read current weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  toolChoice: "auto",
});
```

The SDK returns `first.toolCalls`. The host validates permissions, executes a call, and sends a new stateless request containing an assistant `tool-call` part and a `tool` message with a `tool-result` part. There is no hidden tool loop.

### Embeddings and transcription

```ts
const embedded = await ai.embed({
  model: { connectionId: "mac-ollama", modelId: "nomic-embed-text" },
  input: ["first document", "second document"],
  inputMode: "document",
  maximumBoundary: "device",
});

const transcript = await ai.transcribe({
  model: {
    connectionId: "personal-openrouter",
    modelId: "your-transcription-model",
  },
  audio: { mimeType: "audio/wav", data: wavBytes },
  maximumBoundary: "public-cloud",
});
```

The SDK returns vectors and provenance but stores no index. Transcription requires audio bytes in the current adapters.

### Provider overrides

Portable fields remain at the request root. Non-portable fields go under the registered adapter namespace:

```ts
await ai.generateText({
  model: { connectionId: "personal-openrouter", modelId: "your-model-id" },
  messages: [textMessage("user", "Hello")],
  providerOptions: {
    openrouter: { transforms: ["middle-out"] },
  },
});
```

Overrides are sent only to that adapter and have no portability guarantee.

## Rust setup

```rust,no_run
use std::sync::Arc;
use infinite_ai_core::{AiClient, DataBoundary};
use infinite_ai_providers::{OllamaAdapter, OpenAiCompatibleAdapter};

# fn configure() -> Result<AiClient, infinite_ai_core::AiError> {
let mut ai = AiClient::new();
ai.register(Arc::new(OllamaAdapter::new(
    "mac-ollama",
    "http://127.0.0.1:11434/",
    DataBoundary::Device,
)?))?;
ai.register(Arc::new(OpenAiCompatibleAdapter::openrouter(
    "personal-openrouter",
    std::env::var("OPENROUTER_API_KEY").unwrap_or_default(),
)?))?;
# Ok(ai)
# }
```

Rust exposes the same normalized operations as `generate_text`, `stream_text`, `generate_object`, `embed`, and `transcribe`.

## Codex and Claude Code CLI agent execution in Rust

```rust,no_run
use futures_util::StreamExt;
use infinite_ai_agents::{ClaudeCliAdapter, CodexCliAdapter};
use infinite_ai_core::{AgentAdapter, AgentPermissions, AgentRequest, DataBoundary, ModelRef};

# async fn inspect() -> Result<(), infinite_ai_core::AiError> {
let codex = CodexCliAdapter::new("codex");
let claude = ClaudeCliAdapter::new("claude");
let mut request = AgentRequest::new(
    ModelRef {
        connection_id: "codex".into(),
        model_id: "default".into(),
    },
    "Inspect the project and summarize its architecture",
    "/absolute/path/to/project",
);
request.permissions = AgentPermissions::read_only();
request.maximum_boundary = Some(DataBoundary::PublicCloud);

let mut events = codex.run_agent(request).await?;
while let Some(event) = events.next().await {
    println!("{:?}", event?);
}
# Ok(())
# }
```

The CLI must already be installed and authenticated by the user. The adapter does not install it, extract credentials, or bypass its permissions.

Both adapters implement the same `AgentAdapter` contract. Change the adapter and `connection_id` to use Claude Code. They also implement the regular provider text interface in read-only mode. Set the text request workspace through the namespaced `provider_options["codex-cli"].workspace` or `provider_options["claude-cli"].workspace` value.
