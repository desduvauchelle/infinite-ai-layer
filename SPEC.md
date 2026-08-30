# Infinite AI Layer — Architecture Specification

Status: approved design baseline
Target: version 0.1
Primary implementations: Rust and TypeScript
License: MIT OR Apache-2.0
Working package names: `infinite-ai-*` and `@infinite-ai/*`

## 1. Product definition

Infinite AI Layer is an open-source, stateless provider-adaptation SDK. It lets an application explicitly select a configured AI connection and use a consistent API across cloud providers, local runtimes, native platform models, and supported terminal AI tools.

The SDK normalizes provider communication. It is not an agent framework, workflow engine, model router, secret store, vector database, or provider installer.

The core promise is contract parity, not behavioral equivalence. The same supported operation has the same request shape, event model, error semantics, usage metadata, and cancellation behavior in Rust and TypeScript. Individual providers and runtimes may support different capabilities.

## 2. Goals

- Allow applications to switch explicitly between configured provider connections.
- Provide capability-specific APIs for text, structured output, tools, embeddings, transcription, media, and agents.
- Normalize streaming events, errors, usage, cost, finish reasons, and provider metadata.
- Support multiple connections using the same provider adapter.
- Preserve provider-specific features through deliberate overrides and raw metadata.
- Enforce host-supplied data-boundary restrictions before transmission.
- Support third-party adapters through public interfaces and conformance tests.
- Keep Rust and TypeScript behavior aligned through a language-neutral contract.
- Remain stateless and free of application-specific workflows.

## 3. Non-goals

The SDK does not:

- Discover, install, start, update, or authenticate providers automatically.
- Store credentials, conversations, prompts, outputs, files, model preferences, or usage history.
- Select defaults, favorites, providers, models, or fallbacks for the host.
- Automatically switch providers or models.
- Manage vector indexes or re-embed application data.
- Execute application-defined tools.
- Implement interview, note-taking, retrieval, content-production, or other product workflows.
- Provide a provider marketplace or dynamically download plugins.
- Promise that subscription CLIs behave like API plans.
- Expose cloud credentials to browser code.

The SDK may perform technical adapter logic: request translation, response parsing, validation, capability checks, cost estimation, explicitly requested retries, policy enforcement, cancellation, and secret redaction.

## 4. Runtime architecture

```text
Application
├── Host policy and state
│   ├── Credentials and consent
│   ├── Connection configuration
│   ├── Model selection and fallback
│   ├── Conversation and vector storage
│   ├── Tool execution
│   └── Product workflows
│
└── Infinite AI Layer
    ├── Shared behavioral contract
    ├── Capability-specific APIs
    ├── Normalization and validation
    ├── Data-boundary enforcement
    └── Provider adapters
        ├── Cloud HTTP
        ├── Local HTTP
        ├── Native platform bridge
        └── Terminal CLI
```

### Rust

The Rust SDK is the primary native implementation. It supports desktop backends, local services, cloud APIs, and terminal subprocesses. Tauri applications call it from Rust commands; TypeScript UI code does not directly handle provider credentials or subprocesses.

### TypeScript

The TypeScript provider SDK runs on servers and supported edge/serverless runtimes. Its core and HTTP adapters use web-standard APIs such as `fetch`, `ReadableStream`, `AbortSignal`, `Blob`, and standard JSON. Node-specific capabilities use separate entry points.

A separate browser-safe client may consume an application-owned endpoint, but it never contains provider credentials and is not itself a provider runtime.

### Future language support

Future SDKs implement the same language-neutral contract. An optional OpenAI-compatible local HTTP server may expose the Rust engine to Swift, Python, and other languages. SDK-specific operations, especially agent execution, use additional endpoints rather than being forced into an incompatible protocol.

## 5. Repository layout

Working layout; names may change before publication.

```text
/
├── SPEC.md
├── spec/
│   ├── schemas/                 # Language-neutral JSON Schemas
│   ├── fixtures/                # Shared conformance fixtures
│   ├── error-codes.md
│   └── capability-registry.md
├── rust/
│   ├── infinite-ai-core/        # Types, traits, streams, errors, policies
│   ├── infinite-ai-http/        # Shared HTTP transport helpers
│   ├── infinite-ai-providers/   # Official Rust adapters
│   ├── infinite-ai-agents/      # Terminal agent adapters
│   └── infinite-ai-conformance/ # Adapter test kit
├── typescript/
│   ├── packages/core/           # Web-standard contracts and utilities
│   ├── packages/server/         # Server facade and registration
│   ├── packages/client/         # Browser-safe application client
│   ├── packages/providers/      # Official HTTP adapters
│   ├── packages/node/           # Node-only integrations
│   └── packages/conformance/    # Adapter test kit
└── examples/
    ├── rust-cli/
    ├── tauri-desktop/
    ├── node-server/
    └── next-web/
```

Provider packages may be split further when independent releases become useful. The core packages must not depend on official provider packages.

## 6. Core identity model

An adapter type is distinct from a configured connection.

```ts
type AdapterId = string; // e.g. "ollama", "openai", "codex-cli"
type ConnectionId = string; // host-defined, e.g. "home-ollama"
type ModelId = string; // exact upstream identifier

interface ModelRef {
  connectionId: ConnectionId;
  modelId: ModelId;
}
```

The SDK supports multiple connections per adapter. It preserves upstream model IDs and does not invent aliases such as `best`, `cheap`, or `fast`. The host owns aliases and routing rules.

Providers are explicitly registered. The SDK never scans the machine for executables, ports, services, or credentials.

```ts
const ai = createAI({
  connections: [
    ollama({ id: "home-ollama", baseUrl: "http://127.0.0.1:11434" }),
    openAI({ id: "personal-openai", apiKey }),
  ],
});
```

The equivalent Rust builder accepts registered connection implementations.

## 7. Capabilities

There is no universal `generate()` method. Operations are explicit and capability-specific.

Initial capability registry:

```text
provider-health
model-listing
text-generation
text-streaming
structured-output
tool-calling
reasoning-events
embeddings
transcription
speech-generation
image-understanding
image-generation
image-editing
video-generation
video-editing
agent-execution
```

Each connection reports connection-level capabilities. Each model reports its more precise capabilities and limits. Capability metadata is descriptive; dispatch still validates the selected operation.

Structured-output support is classified as:

```text
native-schema | json-only | best-effort | unsupported
```

Availability is explicit and normalized. A supported adapter may still be unavailable because a server is unreachable, authentication failed, a CLI is missing, a CLI version is incompatible, required native assets are unavailable, or the selected model lacks the requested capability.

## 8. Public operation surface

Version 0.1 implements:

```text
health
listModels
generateText
streamText
generateObject
embed
transcribe
runAgent              # Native/Rust only
```

Tool calls are part of text generation and streaming, not a separate top-level generation mode.

Designed but deferred operations:

```text
generateSpeech
generateImage
editImage
generateVideo
editVideo
```

Adding a deferred operation must reuse the shared identity, capability, error, usage, policy, cancellation, and binary-content contracts.

## 9. Request contract

The language-neutral request envelope contains:

```ts
interface RequestContext {
  requestId?: string;
  model: ModelRef;
  maximumBoundary?: DataBoundary;
  timeoutMs?: number;
  metadata?: Record<string, JsonValue>;
  providerOptions?: Record<string, Record<string, JsonValue>>;
}
```

Common fields remain portable. `providerOptions` is a documented escape hatch with no portability guarantee. Adapters validate known provider options when practical and reject clearly invalid options rather than silently ignoring them.

Responses expose normalized data plus optional redacted raw provider metadata. Raw metadata is diagnostic and not covered by cross-provider portability guarantees.

### Messages and content

The common message model supports roles and typed content parts rather than assuming text-only strings.

```ts
type Role = "system" | "user" | "assistant" | "tool";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media: MediaInput }
  | { type: "audio"; media: MediaInput }
  | { type: "file"; media: MediaInput }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; result: ToolResult };

interface Message {
  role: Role;
  content: ContentPart[];
}
```

Unsupported content parts fail capability validation before provider dispatch.

## 10. Streaming contract

Streaming uses a typed event sequence. Reasoning is never mixed into answer text.

```ts
type StreamEvent =
  | { type: "start"; requestId: string; model: ModelRef }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-start"; callId: string; name: string }
  | { type: "tool-call-delta"; callId: string; argumentsDelta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "citation"; citation: Citation }
  | { type: "usage"; usage: Usage }
  | { type: "warning"; code: string; message: string }
  | {
      type: "finish";
      reason: FinishReason;
      usage?: Usage;
      providerMetadata?: JsonObject;
    };
```

Provider reasoning is emitted only when the provider exposes it and policy permits it. Applications decide whether to show, store, use, or discard reasoning events.

If a stream fails after emitting content, the stream terminates with a normalized error containing safe partial-result metadata. Truncated output is never represented as a successful finish.

Backpressure follows the native stream mechanism of each language. Cancellation must stop the upstream request and terminate owned child processes.

## 11. Tool calling

Version 0.1 supports:

- Tool definitions using JSON Schema.
- Provider tool-choice controls when supported.
- Incrementally streamed arguments.
- Multiple and parallel tool calls.
- Stable provider or SDK-normalized call IDs.
- Tool-result messages referencing the original call ID.

The SDK transports and normalizes tool calls. The host validates permissions, executes tools, and sends results in a new explicit request. The SDK stores no pending calls and runs no hidden tool loop.

Terminal agents are separate because they may manage their own tools and side effects under an explicit execution policy.

## 12. Structured output

`generateObject` accepts a language-neutral JSON Schema and always validates the final output.

- Native schema providers use their constrained-generation mechanism.
- JSON-only providers use JSON mode followed by validation.
- Best-effort providers may use prompting followed by validation.
- Invalid output never returns as successful structured data.
- Repair attempts and retries are opt-in.
- Every additional request created by repair or retry appears in usage and cost reporting.

The current 0.1 alpha validates native-schema output but rejects `repairAttempts > 0` until cross-language repair accounting is implemented.

Language-specific ergonomic helpers may convert Rust/TypeScript schemas to the language-neutral schema, but observable validation behavior must remain equivalent.

## 13. Embeddings

Embedding results include complete provenance:

```ts
interface EmbeddingResult {
  vectors: number[][];
  model: ModelRef;
  dimensions: number;
  normalized?: boolean;
  inputMode?: "query" | "document" | "unspecified";
  usage: Usage;
}
```

The SDK does not store vectors, mix embedding spaces, or re-index documents. The host must retain provenance and rebuild or partition indexes when changing incompatible models.

## 14. Media input and output

Core media APIs accept bytes or streams plus MIME type. Rust may provide file-path helpers. TypeScript may provide `Blob` helpers. URL inputs are explicit because provider-side fetching changes the data boundary.

The SDK may use temporary resources only when required by an adapter and must clean them up deterministically. It never provides permanent media storage.

## 15. Data boundaries

The host classifies every connection:

```text
device
local-network
private-remote
public-cloud
```

Each request may specify the maximum permitted boundary. The SDK rejects a request before transmitting content when the selected connection exceeds that boundary.

The SDK never infers that a custom endpoint is private. Classification is host-supplied. Redirects and provider-side URL fetching must not silently widen the declared boundary.

## 16. State and sessions

Normal inference is stateless. The host sends the message history required for each request.

When a provider offers server-side sessions, caches, or continuation handles, the SDK returns an opaque handle as metadata. The host owns its storage and lifecycle. Agent sessions are also created, resumed, and ended explicitly.

## 17. Agent execution

Inference and agent execution are separate top-level operations.

```ts
interface AgentRequest extends RequestContext {
  agent: ModelRef;
  prompt: string;
  workspace: string;
  sessionId?: string;
  permissions: AgentPermissions;
}
```

Rules:

- `streamText` cannot edit files or execute provider-managed tools.
- `runAgent` requires an explicit absolute workspace.
- The default policy is read-only and denies unapproved network and shell side effects.
- Editing, shell execution, network access, and access outside the workspace require explicit policy.
- Agent requests are never automatically retried.
- Adapter implementations use only official documented CLI interfaces and existing authentication.
- Adapters do not extract credentials, imitate private APIs, bypass quotas, or weaken provider approvals and sandboxes.
- Tested CLI-version ranges are published; incompatible versions fail clearly.

CLI subscriptions are described as user-provided authenticated tools, never as free API access.

## 18. Retries, fallback, and cancellation

- The SDK never switches providers or models automatically.
- Cross-provider fallback belongs to the host.
- Safe inference retries require an explicit request policy.
- Agents are never retried automatically.
- Provider idempotency keys are used when available.
- Retry attempts are individually represented in usage and diagnostics.
- TypeScript supports `AbortSignal`; Rust exposes an equivalent cancellation mechanism.
- Explicit request timeouts override documented SDK defaults.

## 19. Usage and cost

Tokens and monetary cost are independent fields.

```ts
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  requests?: number;
  cost?: Cost;
}

interface Cost {
  amount: string; // decimal string, never binary floating point
  currency: string;
  source:
    "provider-reported" | "sdk-estimated" | "host-supplied" | "unavailable";
  pricingVersion?: string;
  calculatedAt?: string;
}
```

Unknown cost is `unavailable`, never a fabricated zero. Local execution and subscription usage may be unmetered from the SDK's perspective but are not described as free.

Pricing resolution is injectable. SDK estimates identify their source and version so pricing can be updated without changing provider behavior. Interrupted and failed requests may report partial or unavailable usage.

## 20. Errors

Stable normalized error codes:

```text
invalid-request
unsupported-capability
provider-unavailable
authentication-failed
permission-denied
rate-limited
quota-exceeded
content-blocked
context-overflow
timeout
cancelled
executable-not-found
incompatible-version
schema-validation-failed
data-boundary-violation
provider-error
```

Each error may include:

- Stable code and human-readable message.
- Request, adapter, connection, and model identity.
- Retryability and optional retry-after duration.
- Safe provider status or error code.
- Partial-output metadata.
- Redacted raw cause for diagnostics.

Credentials and authorization headers must never appear in errors, logs, or raw metadata.

## 21. Credentials and observability

Credentials are injected into configured connections and retained only as long as needed in memory. The SDK never persists them. Environment-variable helpers are explicit opt-in conveniences.

Optional observability hooks may emit:

- Request ID.
- Operation, adapter, connection, and model identity.
- Start time, duration, retries, and finish reason.
- Normalized usage and cost.
- Safe warnings and errors.

Prompts, responses, tool arguments, credentials, and media are not logged by default.

## 22. Provider extension model

Rust exposes public capability traits; TypeScript exposes corresponding adapter interfaces. External packages explicitly export adapters that hosts register.

An adapter must:

- Declare capabilities accurately.
- Translate requests without silently dropping required fields.
- Emit conforming stream events.
- Normalize errors and finish reasons.
- Respect cancellation and timeouts.
- Report usage and cost provenance honestly.
- Redact secrets.
- Pass the applicable shared conformance suite.

The core project guarantees only officially maintained adapters. Community adapters can use the public conformance kit but are versioned and supported independently.

## 23. Initial provider matrix

`Required` means part of the 0.1 release gate. `Planned` means represented in the capability design but not required for 0.1.

| Adapter                 |                 Rust 0.1 | TypeScript 0.1 | Runtime         | Initial capabilities                                                                         |
| ----------------------- | -----------------------: | -------------: | --------------- | -------------------------------------------------------------------------------------------- |
| Ollama                  |                 Required |       Required | Local HTTP      | Health, models, text, streaming, embeddings where model supports them                        |
| OpenAI API              |                 Required |       Required | Cloud HTTP      | Models where available, text, streaming, structured output, tools, embeddings, transcription |
| Codex CLI               |                 Required |       Required | Native terminal | Read-only text mode plus explicit agent execution                                            |
| Claude Code CLI         |                 Required |       Required | Native terminal | Read-only text mode plus explicit agent execution                                            |
| OpenRouter              | Planned after core proof |       Required | Cloud HTTP      | Capability-dependent gateway access                                                          |
| Vercel AI Gateway       | Planned after core proof |       Required | Cloud HTTP      | Capability-dependent gateway access                                                          |
| Apple Foundation Models |                  Planned | Not applicable | Apple native    | Text, streaming, structured output, tools, supported multimodal input                        |
| Apple Speech            |                  Planned | Not applicable | Apple native    | Live and prerecorded transcription                                                           |

Provider documentation and live capability responses remain authoritative. The matrix is verified and versioned rather than assumed permanent.

## 24. Apple platform design

Apple support consists of separate native adapters:

- Apple Foundation Models for supported generative-model capabilities.
- Apple Speech for transcription and speech analysis.

The Rust implementation uses a small Swift bridge, FFI layer, or bundled helper with a narrow versioned protocol. Availability errors distinguish device eligibility, Apple Intelligence disabled, model/assets not ready, unsupported locale, and unsupported OS version where the native APIs expose those causes.

Apple models advertise only capabilities actually exposed to the application. The SDK does not claim access to private system features or hidden reasoning. Apple adapters are unavailable in browser and non-Apple runtimes.

## 25. Conformance strategy

The shared specification owns observable behavior. JSON Schemas and fixtures cover:

- Connection and model identity.
- Capability declarations.
- Message/content conversion.
- Text and reasoning deltas.
- Parallel tool-call streams and tool results.
- Finish reasons.
- Structured-output success and validation failure.
- Embedding provenance.
- Usage and cost sources.
- Error mapping and redaction.
- Cancellation, timeout, and partial-stream failure.
- Data-boundary rejection before transport.

Every official adapter has:

1. Deterministic mocked transport tests.
2. Shared conformance fixtures.
3. Opt-in live smoke tests.
4. A published runtime/provider compatibility entry.

Live tests never run implicitly because they may incur cost, require local software, or consume subscription allowances.

## 26. Versioning

- The shared behavioral contract has its own version.
- Rust crates and TypeScript packages follow semantic versioning.
- Additive provider capabilities are non-breaking when existing behavior is preserved.
- Removing or changing normalized fields, events, or error semantics is breaking.
- Raw provider metadata is outside portability guarantees.
- Experimental adapters and capabilities are labeled explicitly.
- CLI compatibility changes may update the compatibility matrix without breaking the core API.

## 27. Implementation milestones

### Milestone 0 — Contract foundation

- Create schemas for identity, capabilities, messages, events, errors, usage, cost, tools, embeddings, and policies.
- Create shared fixtures and the first Rust/TypeScript conformance runners.
- Establish formatting, linting, CI, release, and security-redaction checks.

Exit criterion: Rust and TypeScript decode and validate the same fixtures identically.

### Milestone 1 — Text vertical slice

- Implement registration, health, model listing, `generateText`, and `streamText`.
- Rust adapters: Ollama, OpenAI, Codex CLI, and Claude Code CLI read-only text mode.
- TypeScript adapters: Ollama, OpenAI, OpenRouter, Vercel AI Gateway.
- Normalize cancellation, partial failures, errors, usage, and cost.

Exit criterion: manual connection/model selection produces the same event contract across all required adapters.

### Milestone 2 — Structured output and tools

- Implement schema validation and declared support levels.
- Add explicit repair/retry policy.
- Add normalized tool definitions, streamed calls, parallel calls, and result messages.

Exit criterion: shared fixtures prove identical object validation and host-controlled tool continuation in both languages.

### Milestone 3 — Embeddings and transcription

- Add embedding provenance and query/document modes.
- Add streaming/file transcription contracts and OpenAI-backed implementations.
- Add Ollama embeddings where supported.

Exit criterion: both languages return contract-equivalent metadata, errors, and usage for supported adapters.

### Milestone 4 — Native agent execution

- Implement explicit workspace and permission policies.
- Add Codex and Claude Code CLI compatibility checks, cancellation, streaming, sessions, and redaction.
- Prohibit automatic retries.

Exit criterion: macOS agent tests demonstrate read-only defaults, explicit editing permission, safe cancellation, and clear incompatible-version errors.

### Milestone 5 — PFFC migration

- Extract reusable provider transport from PFFC without importing PFFC storage or Tauri types.
- Replace PFFC provider dispatch with the Rust SDK.
- Keep PFFC ownership of credentials, consent, defaults, favorites, history, costs, retrieval, and workflows.

Exit criterion: PFFC's provider behavior and tests pass through the extracted SDK with no duplicated provider implementation.

### Milestone 6 — Native Apple adapters and deferred media

- Add the versioned Swift bridge.
- Implement Apple Foundation Models and Apple Speech.
- Add speech, image, and video operation traits as provider implementations justify them.

Exit criterion: capability-gated native operations pass platform-specific conformance tests and fail precisely on unsupported devices.

## 28. Version 0.1 acceptance tests

Version 0.1 is complete only when all applicable tests pass:

1. On macOS, a host explicitly registers Ollama, OpenAI, Codex CLI, and Claude Code CLI connections without automatic scanning.
2. The host manually selects a connection and model before each request.
3. Ollama, OpenAI, and Codex read-only text requests emit the normalized stream contract.
4. `runAgent` requires an explicit workspace and is read-only unless stronger permissions are explicitly supplied.
5. A TypeScript server switches explicitly among OpenAI, OpenRouter, and Vercel AI Gateway without changing the application-level request shape.
6. Rust and TypeScript pass identical fixtures for messages, text/reasoning events, tools, errors, usage, cost, and finish reasons.
7. Tool calls are returned to the host; the SDK executes no application tools and stores no pending call state.
8. Invalid structured output fails validation; repair occurs only when requested and every repair request is reported.
9. Embedding results include model, connection, dimensions, normalization, and mode metadata.
10. Transcription returns normalized results in both languages through at least one required adapter.
11. A device-only request targeting a public-cloud connection fails before any network transmission.
12. Cancellation stops an HTTP stream and a CLI child process.
13. A failed stream preserves partial-result metadata and never emits a successful finish.
14. Unknown cost returns `unavailable`; reported and estimated cost remain distinguishable.
15. Secrets are absent from logs, errors, snapshots, fixtures, and raw metadata.
16. No SDK operation writes application state or silently selects a different provider/model.

## 29. Deferred decisions

These decisions do not block architecture or implementation:

- Final project, crate, and npm package names.
- License selection.
- Exact minimum Rust and Node versions.
- Exact OpenAI-compatible local-server protocol and schedule.
- Swift bridge mechanism: direct FFI, XPC, or bundled helper.
- First image, speech-generation, and video adapters.
- Governance rules for promoting community adapters to official status.

They must be resolved before their relevant release milestone, not embedded as accidental assumptions in the core contract.

## 30. Native Apple references

- [Foundation Models framework](https://developer.apple.com/documentation/foundationmodels/)
- [Foundation Models availability guidance](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models)
- [Speech framework](https://developer.apple.com/documentation/speech/)
- [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)

Provider documentation and tested runtime behavior must be revalidated when implementing or updating an adapter; this specification does not freeze external provider capabilities.
