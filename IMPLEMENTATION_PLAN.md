# Infinite AI Layer — Implementation Plan

Status: implemented alpha; hardening remains
Source of truth: [SPEC.md](./SPEC.md)
Target: a tested version 0.1 in Rust and TypeScript

## 1. Delivery approach

Implementation will proceed as a sequence of vertical, reviewable phases. Rust and TypeScript advance together against the same serialized fixtures. A phase is complete only when its tests and exit gate pass; incomplete behavior is not carried forward as if it were finished.

The first release prioritizes a correct provider abstraction over adapter count. It will not include hidden provider discovery, storage, routing, tool execution, or application workflows.

Working technical baseline:

- Rust 1.96 with a Cargo workspace.
- Node.js 22 and pnpm 11 with a TypeScript workspace.
- JSON Schema 2020-12 for the language-neutral wire contract.
- Rust and TypeScript types are ergonomic, hand-maintained public APIs.
- Shared JSON fixtures verify that both APIs serialize and interpret the contract identically.
- Provider tests use mocked transports by default; live tests are explicit and opt-in.

Final package names and the open-source license can remain provisional during development, but must be decided before the release phase.

## 2. Phase map

| Phase | Outcome                                                      | Release status |
| ----- | ------------------------------------------------------------ | -------------- |
| 0     | Reproducible monorepo and quality gates                      | Complete       |
| 1     | Language-neutral contracts and parity harness                | Complete       |
| 2     | Working cross-language SDK core with mock adapters           | Complete       |
| 3     | Ollama text vertical slice in Rust and TypeScript            | Complete       |
| 4     | Cloud text adapters and gateway switching                    | Complete       |
| 5     | Structured output and host-controlled tool calls             | Alpha complete |
| 6     | Embeddings and transcription                                 | Alpha complete |
| 7     | Codex CLI text and agent execution in Rust                   | Alpha complete |
| 8     | Hardening, public extension kit, docs, and release candidate | In progress    |
| 9     | Standalone chat and configuration application                | Complete       |
| 10    | Apple-native and deferred media capabilities                 | Deferred       |

Phases 0–9 form the intended initial implementation program. Phase 10 begins only after v0.1 is stable.

## 3. Phase 0 — Repository foundation

### Objective

Create a reproducible monorepo in which Rust, TypeScript, schemas, fixtures, documentation, and examples can evolve together.

### Work

- Initialize Git locally and add a focused `.gitignore`.
- Add root project documentation:
  - `README.md`
  - `CONTRIBUTING.md`
  - `SECURITY.md`
  - `CHANGELOG.md`
- Add a root Cargo workspace containing initially empty core and conformance crates.
- Add a pnpm workspace containing initially empty core and conformance packages.
- Add strict formatting and static checks:
  - Rustfmt, Clippy, and Rust tests.
  - TypeScript strict mode, ESLint, formatting, and tests.
  - Markdown and JSON validation where practical.
- Add root commands for `format`, `lint`, `test`, `build`, and `check`.
- Add CI for macOS and Linux. Platform-specific live tests remain disabled.
- Record provisional runtime support in a compatibility file.
- Convert unresolved architectural choices into short ADRs rather than leaving them implicit.

### Planned structure

```text
Cargo.toml
package.json
pnpm-workspace.yaml
spec/
rust/
  infinite-ai-core/
  infinite-ai-conformance/
typescript/packages/
  core/
  conformance/
examples/
```

Additional adapter packages are created in the phase where they first contain working code.

### Tests and gate

- A clean checkout can install dependencies and run one root `check` command.
- Empty Rust and TypeScript packages compile without warnings.
- CI runs without credentials or provider software.
- No generated artifacts, credentials, or local model data enter source control.

### Not included

No provider, network, or CLI implementation is added in this phase.

## 4. Phase 1 — Shared contract and conformance foundation

### Objective

Make the cross-language behavioral contract executable before implementing a provider.

### Work

- Add versioned JSON Schemas for:
  - Adapter, connection, and model identities.
  - Connection and model capabilities.
  - Availability and health results.
  - Messages and typed content parts.
  - Tool definitions, calls, argument deltas, and results.
  - Requests and data-boundary policy.
  - Stream events and finish reasons.
  - Usage and cost provenance.
  - Normalized warnings and errors.
  - Embedding and transcription results.
  - Agent request and permission policy.
- Add a contract-version field to serialized envelopes.
- Define forward-compatibility rules:
  - Readers tolerate additive fields.
  - Unknown discriminated variants fail clearly unless explicitly modeled as extensions.
  - Provider-specific data lives under namespaced metadata/options.
- Implement matching public Rust and TypeScript value types.
- Create shared fixtures for success, failure, and edge cases.
- Build conformance runners in both languages that read the same fixture files.
- Add secret-redaction fixtures containing fake bearer tokens, keys, URLs, and CLI output.
- Document stable error codes and capability names separately from implementation code.

### Key design rule

JSON Schema defines the portable serialized contract. It does not force awkward generated types into either public SDK. Rust and TypeScript APIs may be idiomatic as long as their observable serialized behavior conforms.

### Tests and gate

- Both implementations accept every valid shared fixture.
- Both reject every invalid fixture with the expected normalized reason.
- Round trips preserve IDs, message content, event ordering, usage, and cost strings.
- Reasoning deltas remain separate from answer text.
- Fake secrets are removed from errors and diagnostics.
- Phase 1 exits only when both conformance runners produce the same result manifest.

## 5. Phase 2 — SDK core and mock vertical slice

### Objective

Deliver a usable provider-neutral core before adding real external integrations.

### Work

- Implement explicit connection registration.
- Implement multiple connections per adapter type.
- Add capability-specific Rust traits and TypeScript interfaces for:
  - Health.
  - Model listing.
  - Text generation.
  - Text streaming.
  - Structured output.
  - Embeddings.
  - Transcription.
  - Agent execution in the native contract.
- Implement the main client/facade in each language.
- Resolve operations strictly through `connectionId + modelId`.
- Add pre-dispatch checks for:
  - Unknown connection.
  - Unsupported capability.
  - Invalid request.
  - Data-boundary violation.
- Add normalized timeout and cancellation primitives.
- Add optional, content-free observability hooks.
- Add provider-option namespacing and redacted raw metadata.
- Build deterministic mock adapters that can emit:
  - Text and reasoning deltas.
  - Parallel tool calls.
  - Usage updates.
  - Warnings.
  - Successful and failed finishes.
  - Delayed output for cancellation tests.

### Tests and gate

- The same example request produces contract-equivalent Rust and TypeScript events.
- Multiple mock connections using the same adapter stay isolated.
- A device-only request aimed at a public-cloud mock is rejected before adapter invocation.
- Cancellation stops the mock stream.
- Partial stream failure retains partial metadata and never emits success.
- The core stores no conversations, credentials, defaults, or provider selection.

## 6. Phase 3 — Ollama text vertical slice

### Objective

Prove the abstraction against a real local runtime in both languages.

### Work

- Create official Ollama adapter packages for Rust and TypeScript.
- Support explicit base URL configuration; do not assume or scan localhost.
- Implement:
  - Health.
  - Installed model listing.
  - Text generation.
  - Text streaming.
  - Model capability metadata when Ollama exposes enough information.
- Add a shared NDJSON streaming parser test corpus.
- Normalize Ollama finish states, context errors, connection failures, and cancellation.
- Report token usage when provided and monetary cost as unavailable.
- Add a minimal Rust CLI and Node example using identical application-level inputs.

### Tests and gate

- Mock-server tests cover normal chunks, split chunks, malformed JSON, early disconnect, timeout, and cancellation.
- Live tests run only with an explicit environment flag and base URL.
- On a configured local Ollama instance, both SDKs can list models and stream a manually selected model.
- No request attempts to install, start, or configure Ollama.

## 7. Phase 4 — Cloud text adapters and gateways

### Objective

Prove explicit switching across local, direct-cloud, and gateway connections.

### Work

- Implement OpenAI in both Rust and TypeScript.
- Implement OpenRouter and Vercel AI Gateway in TypeScript.
- Keep transport details internal so upstream API evolution does not leak into the common contract.
- Verify current official APIs at implementation time before choosing endpoints and fields.
- Implement:
  - Health or credential validation where the provider safely supports it.
  - Model listing where reliable; otherwise document explicit model IDs.
  - Text generation and streaming.
  - Reasoning events when explicitly returned.
  - Provider-specific options.
  - Raw, redacted provider metadata.
  - Usage, request IDs, finish reasons, and provider-reported cost where available.
- Add injectable pricing resolution for estimates.
- Ensure unknown cost remains unavailable rather than zero.
- Add safe inference retry support, disabled by default.
- Never implement cross-provider fallback in the SDK.

### Tests and gate

- Mocked HTTP/SSE fixtures cover all adapters without network access.
- Authentication, rate-limit, quota, content-block, context, timeout, and malformed-stream errors normalize consistently.
- A TypeScript example changes only `ModelRef` to switch among OpenAI, OpenRouter, and Vercel AI Gateway.
- A Rust example changes only `ModelRef` to switch between Ollama and OpenAI.
- Retries occur only when explicitly enabled and are counted in usage metadata.

## 8. Phase 5 — Structured output and tool calls

### Objective

Add portable schema-driven generation and tool-call transport without turning the SDK into an execution framework.

### Work

- Implement `generateObject` in both languages.
- Support the four structured-output levels:
  - Native schema.
  - JSON-only.
  - Best effort.
  - Unsupported.
- Validate every final object against the supplied JSON Schema.
- Add explicit repair and retry policies with usage aggregation.
- Implement portable tool definitions and tool-choice settings.
- Parse streamed tool arguments and parallel calls.
- Preserve stable call IDs.
- Accept tool-result messages in subsequent stateless requests.
- Ensure the SDK never executes a host tool or maintains a hidden loop.

### Tests and gate

- Native, JSON-only, best-effort, invalid, and repair scenarios pass in both languages.
- Invalid objects never return as successful typed values.
- Parallel tool calls retain names, IDs, and complete JSON arguments despite arbitrary stream chunk boundaries.
- The host can execute a fixture tool, send the result in a new request, and continue generation.
- Every repair/retry request appears in usage and cost metadata.

## 9. Phase 6 — Embeddings and transcription

### Objective

Complete the non-agent v0.1 capability set.

### Work

- Implement embeddings for OpenAI in Rust and TypeScript.
- Implement Ollama embeddings where the runtime/model supports them.
- Report model reference, dimensions, normalization, and query/document mode.
- Reject incompatible or malformed vector dimensions within a response.
- Implement OpenAI transcription in Rust and TypeScript.
- Support byte/stream inputs with MIME type plus language-specific file/Blob helpers.
- Normalize timestamped segments only when a provider supplies them.
- Enforce data boundaries for media before upload.
- Define deterministic temporary-resource cleanup for adapters that require files.

### Tests and gate

- Embedding provenance is always present and vectors are never stored by the SDK.
- Mixed dimensions fail clearly.
- Transcription tests cover bytes, streams, cancellation, oversized input, unsupported MIME type, and provider errors.
- Both languages produce equivalent normalized results for the same mocked provider responses.
- At least one live opt-in transcription smoke test succeeds in each implementation.

## 10. Phase 7 — Codex CLI and native agent execution

### Objective

Add the native-only terminal adapter without weakening the safety or statelessness of regular inference.

### Work

- Verify the current official Codex CLI non-interactive and structured-output interfaces before implementation.
- Create a separate Rust agent adapter package.
- Add explicit executable-path configuration; do not scan the machine.
- Add version probing and a published compatibility range.
- Implement read-only text invocation for the common text interface where supported.
- Implement `runAgent` with:
  - Required absolute workspace.
  - Read-only default.
  - Explicit edit, shell, network, and outside-workspace permissions.
  - Explicit session create/resume/end handles.
  - Structured event parsing.
  - Process-group cancellation and timeout cleanup.
  - No automatic retry.
- Treat the existing CLI authentication session as user-owned.
- Never read private tokens, imitate internal APIs, or bypass provider controls.

### Tests and gate

- A fake CLI executable drives deterministic parser, version, permission, error, timeout, and cancellation tests.
- Default execution cannot request editing permissions from the adapter configuration.
- An invalid or incompatible CLI version returns a normalized error.
- Cancellation terminates the child process and descendants without leaving a session running.
- A live opt-in macOS test demonstrates read-only text and an explicitly permitted workspace edit.

## 11. Phase 8 — Hardening and v0.1 release candidate

### Objective

Turn the working implementation into a credible open-source SDK rather than a collection of internal adapters.

### Work

- Publish stable public adapter traits/interfaces.
- Package the Rust and TypeScript conformance kits for third-party adapters.
- Add API documentation and examples for:
  - Registration and multiple connections.
  - Text and streaming.
  - Reasoning events.
  - Tools.
  - Structured output.
  - Embeddings.
  - Transcription.
  - Data-boundary policy.
  - Codex agent execution.
- Add a provider/runtime compatibility matrix.
- Add security documentation covering credentials, logging, URLs, redirects, media, and subprocesses.
- Add benchmarks for stream overhead and large message/event handling.
- Test supported Node, Rust, macOS, and Linux combinations.
- Exercise at least one compatible edge runtime for the web-standard TypeScript core.
- Decide final project/package names and license.
- Prepare changelog, migration policy, contribution workflow, and release artifacts.

### Tests and gate

- All 16 acceptance tests in `SPEC.md` pass or have an explicit, approved exception.
- A clean environment can run mocked tests with no secrets.
- Live test documentation states exactly what may incur cost or consume subscription allowance.
- Public API docs contain no PFFC-specific types or policies.
- Crates and npm packages build in publish dry-run mode.
- No unresolved high-severity security or correctness issue remains.

## 12. Phase 9 — Standalone chat application

### Objective

Validate the SDK through a small, polished application that makes provider configuration and model switching directly observable.

### Work

- Build a TypeScript server using the server SDK and official adapters.
- Build a responsive browser UI with:
  - A conversation list on the left.
  - A streamed chat workspace on the right.
  - A configuration page for explicit provider connections.
  - Provider and model selectors.
  - Visible connection health, usage, cost source, finish, and error states.
- Keep cloud credentials in local server memory only and return redacted configuration status to the browser.
- Store demo conversation history in browser storage as host-owned application state.
- Support Ollama without credentials and cloud providers when the user supplies a key.
- Include a deterministic mock connection so the application always has a no-cost test path.

### Tests and gate

- The application starts with one documented command.
- A user can create, rename, switch, and remove local demo chats.
- A user can configure a connection, test health, list models, choose one, and stream a response.
- The mock connection works without credentials or provider software.
- A reachable Ollama connection passes an opt-in live chat test.
- Browser tests cover empty, loading, streaming, success, cancellation, and failure states.
- The app owns its history and settings behavior; the SDK remains stateless.

After this adoption gate passes, version 0.1 is ready to tag and publish, subject to explicit release approval.

## 13. Phase 10 — Apple-native and deferred media work

This phase is intentionally outside the v0.1 release gate.

Order:

1. Design and test a narrow versioned Swift bridge.
2. Add Apple Foundation Models for supported text, streaming, structured output, tools, and multimodal input.
3. Add Apple Speech for live and prerecorded transcription.
4. Add speech generation when a provider implementation is selected.
5. Add image generation/editing.
6. Add video generation/editing.

Each operation reuses the existing identity, capability, policy, streaming, error, usage, and media contracts. Apple availability errors must distinguish unsupported hardware, disabled Apple Intelligence, unavailable assets, unsupported locale, and unsupported OS where the native API makes that distinction available.

## 14. Testing strategy across every phase

The testing pyramid is fixed:

1. Pure unit tests for normalization, validation, redaction, and policy.
2. Shared contract fixtures consumed by Rust and TypeScript.
3. Deterministic mocked transport/process tests for each adapter.
4. Example-level integration tests.
5. Explicit live smoke tests, never part of the default test command.

Every defect found against a real provider first receives a deterministic regression fixture whenever reproducible.

Provider calls are never used merely to discover whether unit tests pass.

## 15. Implementation rules

- Build Rust and TypeScript behavior together for every shared capability.
- Do not add automatic provider discovery or implicit environment-variable loading.
- Do not add provider fallback to the core.
- Do not let adapter-specific response types leak into the portable result.
- Do not silently ignore unsupported normalized request fields.
- Do not represent unknown cost as zero.
- Do not log prompts, outputs, tool arguments, media, or credentials by default.
- Do not make a provider call after a data-boundary or capability check fails.
- Do not execute tools in the core.
- Do not retry agents.
- Keep live tests opt-in and clearly label their external effects.
- Add a conformance fixture before expanding a shared public contract.

## 16. Approval and execution sequence

When this plan is approved, implementation starts with Phase 0 and proceeds in order. At the end of each phase, the handoff will include:

- What was implemented.
- Which files and public APIs changed.
- Exact test and build results.
- Any deviation from this plan and why.
- The next phase's concrete starting point.

Work pauses only when a required external choice, credential, provider installation, or unsafe scope expansion cannot be resolved from the repository. Live-provider failures do not block mocked contract work; they are reported separately.
