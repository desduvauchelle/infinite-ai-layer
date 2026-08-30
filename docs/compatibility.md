# Compatibility

## Toolchain baseline

The current workspace is verified with:

- Rust 1.96 and Cargo 1.96.
- Node.js 22.22.
- pnpm 11.17.
- macOS for the initial local and terminal-agent target.

The portable Rust core and HTTP adapters are intended for macOS and Linux. The TypeScript core and HTTP adapters use web-standard APIs, but credential-bearing provider adapters are intended for trusted server runtimes. Other versions and runtimes are not yet part of the tested support matrix.

## Adapter matrix

| Connection or adapter     | TypeScript | Rust | Implemented operations                                                                        | Verification status                          |
| ------------------------- | ---------- | ---- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Deterministic mock        | Yes        | Yes  | Core text and streaming fixtures                                                              | Automated tests                              |
| Ollama                    | Yes        | Yes  | Health, models, text, stream, reasoning, structured output, tools, embeddings                 | Mocked HTTP/NDJSON tests                     |
| OpenAI                    | Yes        | Yes  | Health, models, text, stream, reasoning, structured output, tools, embeddings, speech-to-text | Mocked HTTP/SSE tests                        |
| OpenRouter                | Yes        | Yes  | OpenAI-compatible surface plus provider-reported cost when returned                           | Mocked compatibility tests                   |
| Vercel AI Gateway         | Yes        | Yes  | OpenAI-compatible surface                                                                     | Constructor and shared compatibility tests   |
| LM Studio                 | Yes        | Yes  | OpenAI-compatible local server                                                                | Configuration path implemented; live pending |
| llama.cpp server          | Yes        | Yes  | OpenAI-compatible local server                                                                | Configuration path implemented; live pending |
| Custom OpenAI-compatible  | Yes        | Yes  | Configured base URL and common compatible operations                                          | Mocked compatibility tests                   |
| Codex CLI                 | Yes        | Yes  | Health/version, read-only text, streaming, permissioned agent execution                       | Fake-process tests; live CLI 0.139 smoke     |
| Claude Code CLI           | Yes        | Yes  | Health/version, read-only text, streaming, permissioned agent execution                       | Fake-process tests; live install pending     |
| Apple Intelligence        | No         | No   | Planned native adapter                                                                        | Deferred                                     |
| Gemini terminal CLI       | No         | No   | Planned terminal adapter                                                                      | Deferred                                     |
| Speech/image/video output | No         | No   | Contract capability names are reserved                                                        | Deferred                                     |

“OpenAI-compatible” does not mean every server or model implements every endpoint or parameter. Connection-level capabilities describe the adapter surface. Model capability metadata returned by upstream list endpoints is advisory unless the upstream explicitly supplies it.

## Terminal CLIs

The Rust and TypeScript adapters accept Codex CLI `0.100.0` and later in the current `0.x` line. They were version-probed against `codex-cli 0.139.0`. Claude Code accepts a semantic version reported by its CLI. Both are classified as `public-cloud`, require an absolute workspace for native agent execution, default to read-only, reject outside-workspace and explicit network permission, and terminate the process group on timeout or cancellation. The host may explicitly grant edit and shell permissions for native `runAgent`; regular text/chat calls remain read-only.

Live provider smoke tests are intentionally opt-in and are not part of the credential-free default check.
