# Infinite AI Layer

Infinite AI Layer is a stateless, provider-neutral SDK with matching Rust and TypeScript contracts. An application registers the connections it permits, chooses a connection and model before dispatch, and uses one normalized API for local runtimes, cloud APIs, and supported terminal agents.

The repository currently contains a working version 0.1 alpha. It is suitable for integration testing, but its public API is not yet release-stable.

## Installation status

The packages are not published to npm or crates.io yet. For now, install from a local checkout as described below. Once releases are published, the intended package names are `@infinite-ai/core`, `@infinite-ai/providers`, `@infinite-ai/agents`, `infinite-ai-core`, `infinite-ai-providers`, and `infinite-ai-agents`.

### Requirements

The current tested toolchain is:

- Node.js 22.22 or later in the Node 22 line.
- pnpm 11.17.
- Rust and Cargo 1.96 for the Rust packages.
- macOS for the initial local-runtime and terminal-agent target. The portable HTTP SDK is also intended for Linux.

The SDK does not install or start Ollama, LM Studio, llama.cpp, Codex CLI, Claude Code CLI, or any cloud provider. Install, run, and authenticate the providers you choose before registering them with the SDK.

### Install this repository

Clone or download the repository, open its root directory, and run:

```bash
corepack enable
pnpm install
pnpm build:sdk
cargo build --workspace
```

`pnpm build:sdk` builds the TypeScript core, provider, and terminal-agent packages. `cargo build --workspace` builds the Rust core, providers, conformance package, and terminal-agent package.

### Install the TypeScript SDK in another project

Until the npm packages are published, build local package archives from this repository:

```bash
mkdir -p artifacts
pnpm --filter @infinite-ai/core pack --pack-destination artifacts
pnpm --filter @infinite-ai/providers pack --pack-destination artifacts
pnpm --filter @infinite-ai/agents pack --pack-destination artifacts
```

Then install both generated `.tgz` files in the consuming project:

```bash
pnpm add /absolute/path/to/infinite-ai-layer/artifacts/infinite-ai-core-0.1.0.tgz \
  /absolute/path/to/infinite-ai-layer/artifacts/infinite-ai-providers-0.1.0.tgz \
  /absolute/path/to/infinite-ai-layer/artifacts/infinite-ai-agents-0.1.0.tgz
```

After the public release, the equivalent command will be:

```bash
pnpm add @infinite-ai/core @infinite-ai/providers @infinite-ai/agents
```

Provider adapters contain credentials and make network requests. Use them in trusted Node.js server code or a desktop backend, not directly in a public browser bundle.

### Install the Rust SDK in another project

Reference the local checkout from the consuming application's `Cargo.toml`:

```toml
[dependencies]
infinite-ai-core = { path = "/absolute/path/to/infinite-ai-layer/rust/infinite-ai-core" }
infinite-ai-providers = { path = "/absolute/path/to/infinite-ai-layer/rust/infinite-ai-providers" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

Add the terminal-agent package only when the application needs Codex or Claude Code CLI execution:

```toml
infinite-ai-agents = { path = "/absolute/path/to/infinite-ai-layer/rust/infinite-ai-agents" }
```

After the crates are published, these path dependencies can be replaced with their released version numbers.

## What works

- Explicit registration of multiple connections with no machine scanning or provider installation.
- Health checks and model listing.
- Text generation and typed streaming events.
- Separate reasoning events.
- Structured output with JSON Schema validation.
- Tool definitions, named tool choice where supported, parallel streamed tool calls, and tool-result transport. The host executes tools.
- Embeddings and transcription.
- Normalized usage, provider-reported cost, finish reasons, errors, timeout, and cancellation.
- Pre-dispatch data-boundary enforcement.
- Ollama, OpenAI, OpenRouter, Vercel AI Gateway, LM Studio, llama.cpp, and custom OpenAI-compatible connections.
- Permissioned Codex and Claude Code CLI adapters in Rust and Node.js TypeScript.
- Shared JSON Schema fixtures checked by both language implementations.

The SDK stores no credentials, conversations, files, vectors, preferences, or usage history. It does not choose models, perform automatic fallback, execute application tools, or discover providers.

## TypeScript quick start

```ts
import { AiClient, textMessage } from "@infinite-ai/core";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@infinite-ai/providers";

const ai = new AiClient({
  adapters: [
    new OllamaAdapter({ id: "local" }),
    new OpenAICompatibleAdapter({
      id: "openrouter",
      kind: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
    }),
  ],
});

const selectedModel = {
  connectionId: "local",
  modelId: "qwen3:8b",
};

for await (const event of ai.streamText({
  model: selectedModel,
  maximumBoundary: "device",
  messages: [textMessage("user", "Explain this repository")],
})) {
  if (event.type === "text-delta") process.stdout.write(event.delta);
}
```

Changing `selectedModel` is the only routing change. The application remains responsible for configuration and secrets. Provider adapters should run in trusted server or desktop-backend code, not credential-bearing browser bundles.

### Terminal subscription agents in TypeScript

```ts
import { AiClient, textMessage } from "@infinite-ai/core";
import { ClaudeCliAdapter, CodexCliAdapter } from "@infinite-ai/agents";

const workspace = "/absolute/path/to/project";
const ai = new AiClient({
  adapters: [
    new CodexCliAdapter({ id: "codex", workspace }),
    new ClaudeCliAdapter({ id: "claude", workspace }),
  ],
});

for await (const event of ai.streamText({
  model: { connectionId: "codex", modelId: "default" },
  maximumBoundary: "public-cloud",
  messages: [textMessage("user", "Explain this project")],
})) {
  if (event.type === "text-delta") process.stdout.write(event.delta);
}
```

These Node.js adapters use the CLI's existing user-owned login. They do not read tokens or call private subscription APIs. Native `runAgent()` additionally accepts explicit read/edit/shell permissions, an absolute workspace, session resumption, timeout, and cancellation.

### Configure a provider

Register only the providers the host application permits. The built-in defaults are:

| Provider                 | Adapter configuration                | Default endpoint                  | Authentication       |
| ------------------------ | ------------------------------------ | --------------------------------- | -------------------- |
| Ollama                   | `new OllamaAdapter({ id: "local" })` | `http://127.0.0.1:11434`          | None                 |
| LM Studio                | `kind: "lm-studio"`                  | `http://127.0.0.1:1234/v1`        | Usually none         |
| llama.cpp                | `kind: "llama-cpp"`                  | `http://127.0.0.1:8080/v1`        | Usually none         |
| OpenAI                   | `kind: "openai"`                     | `https://api.openai.com/v1`       | API key              |
| OpenRouter               | `kind: "openrouter"`                 | `https://openrouter.ai/api/v1`    | API key              |
| Vercel AI Gateway        | `kind: "vercel-ai-gateway"`          | `https://ai-gateway.vercel.sh/v1` | API key              |
| Custom compatible server | `kind: "custom", baseUrl: "…"`       | Application supplied              | Application supplied |
| Codex CLI                | `new CodexCliAdapter({ … })`         | `codex` executable                | Existing CLI login   |
| Claude Code CLI          | `new ClaudeCliAdapter({ … })`        | `claude` executable               | Existing CLI login   |

The application selects the exact `connectionId` and `modelId` before every request. `ai.listModels(connectionId)` lists models from one registered connection; it does not scan the machine.

## Rust quick start

```rust,no_run
use std::sync::Arc;
use infinite_ai_core::{AiClient, DataBoundary, Message, ModelRef, Role, TextRequest};
use infinite_ai_providers::OllamaAdapter;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let mut ai = AiClient::new();
ai.register(Arc::new(OllamaAdapter::new(
    "local",
    "http://127.0.0.1:11434/",
    DataBoundary::Device,
)?))?;

let result = ai.generate_text(TextRequest::new(
    ModelRef {
        connection_id: "local".into(),
        model_id: "qwen3:8b".into(),
    },
    vec![Message::text(Role::User, "Explain this repository")],
)).await?;

println!("{}", result.text);
# Ok(())
# }
```

See [the SDK guide](./docs/quickstart.md) for streaming, structured output, tools, embeddings, transcription, boundary policy, and terminal-agent examples. See [compatibility](./docs/compatibility.md) for the exact tested matrix.

## Demo acceptance app

The intentionally small chat app is a functional harness for registering connections, listing models, switching the selected route before dispatch, streaming a response, and showing reasoning/usage/cost.

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. Use **Connections** to register an already-running local provider, cloud provider, Codex CLI, or Claude Code CLI; optionally choose an absolute workspace for a CLI; test it; choose its model; and return to the chat. CLI chat calls are read-only. Connection credentials live only in the local Node demo process and are never returned to browser code. Restarting the demo server clears registered connections. Chat history is demo-only browser state, not SDK state.

The demo requires an explicit terminal model ID instead of silently inheriting a CLI default. It starts Codex connections with the currently tested `gpt-5.6-sol` value and Claude Code connections with the documented `sonnet` alias; both remain editable before registration.

The demo starts two local processes:

- The Vite interface at `http://127.0.0.1:5173`.
- The credential-holding demo API at `http://127.0.0.1:8787`.

### Typical integration flow

1. Create provider adapters from application-owned configuration.
2. Register them with `AiClient` during application startup.
3. Show `connections()` and `listModels(connectionId)` in the application's own UI.
4. Save the user's selected `connectionId + modelId` in application state.
5. Call `generateText`, `streamText`, `generateObject`, `embed`, or `transcribe` with that exact model reference.
6. Handle normalized stream, usage, cost, finish, cancellation, and error information. The host remains responsible for persistence and tool execution.

## Verification

```bash
pnpm check
pnpm build
```

The root check runs TypeScript compilation and tests, shared conformance fixtures, formatting, Rustfmt, Clippy with warnings denied, and all Rust tests. Provider tests use mocked transports; they do not need credentials or installed model servers.

## Current limits

- `repairAttempts` must remain `0`; automatic object repair and usage aggregation are not implemented yet.
- SDK-supplied price estimation and automatic retries are not implemented. Unknown cost is reported as unavailable, never as zero.
- Apple Intelligence, speech generation, image generation/editing, video generation/editing, and Gemini CLI are planned follow-on adapters.
- LM Studio and llama.cpp use their OpenAI-compatible servers; a specific model/server build may support fewer operations than the connection adapter. Applications should treat provider model metadata as advisory and handle normalized unsupported/provider errors.

The architectural contract is in [SPEC.md](./SPEC.md), and the implementation history is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
