# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are application developers who need to use AI capabilities without coupling product code to one provider. The first proof application is a local developer-facing chat client used to configure explicit provider connections and verify model listing and streamed inference.

## Product Purpose

Infinite AI Layer provides one stateless, capability-aware interface across cloud APIs, local model runtimes, native platform models, and supported terminal AI tools. Success means a host can change a connection and model reference without rewriting its application-level request, while still receiving honest capability, usage, cost, and error information.

## Positioning

The product unifies provider APIs, local runtimes, and explicitly configured terminal agents under matching Rust and TypeScript contracts. It standardizes transport behavior without taking ownership of application storage, routing, tools, credentials, or workflows.

## Operating Context

The SDK runs inside Rust desktop backends and TypeScript servers. Browser interfaces communicate with an application-owned server and never receive stored provider credentials. Developers explicitly register connections, select a model before each request, and use conformance tests to validate third-party adapters.

The included proof application has a conversation list, a focused chat workspace, and a configuration surface for local and cloud connections. It stores demo conversations in the browser while the local server retains submitted credentials in memory only.

## Capabilities and Constraints

- Rust and TypeScript must expose contract-equivalent requests, stream events, errors, usage, and cost metadata.
- Version 0.1 covers health, model listing, text generation and streaming, structured output, tool-call transport, embeddings, and transcription contracts.
- Rust and Node.js TypeScript additionally support explicit Codex and Claude Code CLI agent execution.
- Connections are explicitly registered; the SDK does not scan, install, start, or authenticate providers.
- The SDK is stateless and performs no automatic provider routing or fallback.
- Host applications own persistence, tool execution, model preferences, vector indexes, consent, and workflows.
- Apple-native, speech-generation, image, and video adapters are later milestones.
- Final public package names and license remain open decisions until release preparation.

## Evidence on Hand

- The approved architecture is documented in `SPEC.md`.
- The approved phased execution plan is documented in `IMPLEMENTATION_PLAN.md`.
- No customers, benchmarks, pricing claims, logo, or established visual identity currently exist and must not be fabricated.

## Product Principles

1. Portability is explicit: common behavior is normalized; provider-specific behavior remains visibly provider-specific.
2. Capabilities are honest: unavailable, unsupported, estimated, and provider-reported states are never conflated.
3. The host stays in control: no hidden storage, provider selection, fallback, tool execution, or machine scanning.
4. Privacy is enforceable: declared data boundaries are checked before content leaves its permitted environment.
5. Extensibility is tested: third-party adapters use public interfaces and the same conformance fixtures as official adapters.

## Accessibility & Inclusion

The proof application must be keyboard operable, responsive, readable at browser zoom, honor reduced-motion preferences, expose streaming and error state to assistive technology, and meet WCAG AA contrast for core controls and content.
