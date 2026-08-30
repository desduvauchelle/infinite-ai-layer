# Changelog

## Unreleased

- Model listings no longer copy connection-level embed/transcribe capabilities onto chat model IDs; `AiClient` preflight now checks known model capabilities.
- `AiClient.runAgent` is a top-level operation that looks up `request.agent.connectionId` with the same boundary and capability preflight as other calls. `streamText` remains read-only.
- `providerOptions` are keyed by connection ID rather than adapter kind.
- Shared conformance tests now cover over-advertised model capabilities, dropped content parts, tool `strict`, `generateObject` schema name `result`, stream `finish.providerMetadata`, and HTTP 401/403/429 mapping.
- Added matching Rust and TypeScript core contracts, routing, boundary enforcement, normalized errors, observability, timeout, and cancellation.
- Added Ollama and OpenAI-compatible adapters for text, streaming, tools, structured output, embeddings, transcription, and provider-reported cost where available.
- Added local presets for LM Studio and llama.cpp plus cloud presets for OpenAI, OpenRouter, and Vercel AI Gateway.
- Added Rust and TypeScript Codex and Claude Code CLI adapters with permission policy, structured events, version checks, usage/cost normalization, and process-group cleanup.
- Terminal adapters now keep stdin closed and surface structured provider failures without forwarding unrelated CLI stderr logs.
- Added shared JSON Schema conformance fixtures and a minimal chat/configuration acceptance app.
