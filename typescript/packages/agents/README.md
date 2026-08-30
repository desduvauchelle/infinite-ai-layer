# `@infinite-ai/agents`

Node.js adapters for terminal agents that use an existing user-owned CLI login. The SDK does not install a CLI, read its credentials, or bypass its permissions.

Supported adapters:

- `CodexCliAdapter` for the `codex` CLI.
- `ClaudeCliAdapter` for the `claude` (Claude Code) CLI.

Both expose native `runAgent()` events and the common read-only `generateText()` / `streamText()` surface. Agent execution requires an explicit absolute workspace. Text calls accept a workspace through the adapter constructor or `providerOptions["codex-cli"].workspace` / `providerOptions["claude-cli"].workspace`.
