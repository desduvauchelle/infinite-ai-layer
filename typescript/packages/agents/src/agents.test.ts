import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRequest } from "@infinite-ai/core";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCliAdapter, CodexCliAdapter } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  body: string,
): Promise<{ executable: string; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "infinite-ai-agent-"));
  temporaryDirectories.push(workspace);
  const executable = join(workspace, "agent-fixture");
  await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return { executable, workspace };
}

function request(connectionId: string, workspace: string): AgentRequest {
  return {
    agent: { connectionId, modelId: "default" },
    prompt: "Inspect the workspace",
    workspace,
    permissions: {
      read: true,
      edit: false,
      shell: false,
      network: false,
      outsideWorkspace: false,
    },
    maximumBoundary: "public-cloud",
  };
}

describe("terminal agent adapters", () => {
  it("normalizes Codex JSONL and usage", async () => {
    const { executable, workspace } = await fixture(`
if [ "$1" = "--version" ]; then echo "codex-cli 0.139.0"; exit 0; fi
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"codex-session"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"reasoning","text":"Checking."}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'
`);
    const adapter = new CodexCliAdapter({ id: "codex", executable });
    const events = [];
    for await (const event of adapter.runAgent(request("codex", workspace)))
      events.push(event);
    expect(events).toContainEqual({
      type: "session",
      sessionId: "codex-session",
    });
    expect(events).toContainEqual({
      type: "reasoning-delta",
      delta: "Checking.",
    });
    expect(events).toContainEqual({ type: "text-delta", delta: "Done." });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        usage: expect.objectContaining({ totalTokens: 3 }),
      }),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("exposes an explicitly configured CLI model for pre-dispatch selection", async () => {
    const adapter = new CodexCliAdapter({
      id: "codex",
      modelId: "gpt-5.5",
    });
    await expect(adapter.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "gpt-5.5" }),
    ]);
  });

  it("normalizes Claude Code stream-json events and provider cost", async () => {
    const { executable, workspace } = await fixture(`
if [ "$1" = "--version" ]; then echo "2.1.80 (Claude Code)"; exit 0; fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Checking."},{"type":"text","text":"Done."}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"claude-session","total_cost_usd":0.004,"usage":{"input_tokens":4,"output_tokens":2},"result":"Done."}'
`);
    const adapter = new ClaudeCliAdapter({ id: "claude", executable });
    const events = [];
    for await (const event of adapter.runAgent(request("claude", workspace)))
      events.push(event);
    expect(events).toContainEqual({
      type: "session",
      sessionId: "claude-session",
    });
    expect(events).toContainEqual({
      type: "reasoning-delta",
      delta: "Checking.",
    });
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", delta: "Done." },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        usage: expect.objectContaining({
          totalTokens: 6,
          cost: {
            amount: "0.004",
            currency: "USD",
            source: "provider-reported",
          },
        }),
      }),
    );
  });

  it("reports a missing executable through health", async () => {
    const adapter = new ClaudeCliAdapter({
      id: "claude",
      executable: "infinite-ai-missing-claude",
    });
    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      reason: "executable-not-found",
    });
  });

  it("rejects a relative workspace before spawning", async () => {
    const adapter = new CodexCliAdapter({ id: "codex" });
    const iterator = adapter
      .runAgent(request("codex", "relative"))
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "invalid-request",
    });
  });
});
