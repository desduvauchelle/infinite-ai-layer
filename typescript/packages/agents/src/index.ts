import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { constants } from "node:fs";

import {
  AiError,
  asAiError,
  messageText,
  type AgentAdapter,
  type AgentEvent,
  type AgentPermissions,
  type AgentRequest,
  type ConnectionInfo,
  type DataBoundary,
  type HealthResult,
  type JsonObject,
  type JsonValue,
  type ModelInfo,
  type ProviderAdapter,
  type StreamEvent,
  type TextRequest,
  type TextResult,
  type Usage,
} from "@infinite-ai/core";

type CliKind = "codex-cli" | "claude-cli";

export interface CliAgentOptions {
  id: string;
  label?: string;
  executable?: string;
  workspace?: string;
  boundary?: DataBoundary;
  modelId?: string;
}

interface ParsedEvent {
  events: AgentEvent[];
  usage?: Usage;
}

abstract class CliAgentAdapter implements AgentAdapter, ProviderAdapter {
  readonly connection: ConnectionInfo;
  protected readonly executable: string;
  protected readonly defaultWorkspace: string | undefined;
  protected readonly configuredModelId: string;
  protected abstract readonly kind: CliKind;

  protected constructor(
    options: CliAgentOptions,
    defaults: { label: string; executable: string },
  ) {
    this.executable = options.executable ?? defaults.executable;
    this.defaultWorkspace = options.workspace;
    this.configuredModelId = options.modelId?.trim() || "default";
    this.connection = {
      id: options.id,
      adapterId: defaults.executable + "-cli",
      label: options.label ?? defaults.label,
      boundary: options.boundary ?? "public-cloud",
      capabilities: [
        "provider-health",
        "model-listing",
        "text-generation",
        "text-streaming",
        "reasoning-events",
        "agent-execution",
      ],
    };
  }

  async health(): Promise<HealthResult> {
    const started = performance.now();
    try {
      const result = await runVersion(this.executable);
      return {
        available: result.code === 0 && this.versionCompatible(result.output),
        reason:
          result.code === 0 && this.versionCompatible(result.output)
            ? "available"
            : "incompatible-version",
        message:
          result.output.trim() ||
          `${this.connection.label} returned no version.`,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const missing = isMissingExecutable(error);
      if (!missing) throw asAiError(error, "provider-unavailable");
      return {
        available: false,
        reason: "executable-not-found",
        message: `${this.connection.label} was not found at '${this.executable}'.`,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: this.configuredModelId,
        name: `Configured ${this.connection.label} model`,
        capabilities: [
          "text-generation",
          "text-streaming",
          "reasoning-events",
          "agent-execution",
        ],
        structuredOutput: "unsupported",
      },
    ];
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    let text = "";
    let reasoning = "";
    let finishReason: TextResult["finishReason"] = "unknown";
    let usage: Usage | undefined;
    let providerMetadata: JsonObject | undefined;
    for await (const event of this.streamText(request)) {
      if (event.type === "text-delta") text += event.delta;
      if (event.type === "reasoning-delta") reasoning += event.delta;
      if (event.type === "usage") usage = event.usage;
      if (event.type === "finish") {
        finishReason = event.reason;
        usage = event.usage ?? usage;
        providerMetadata = event.providerMetadata;
      }
    }
    return {
      requestId: request.requestId ?? crypto.randomUUID(),
      model: request.model,
      text,
      ...(reasoning === "" ? {} : { reasoning }),
      toolCalls: [],
      finishReason,
      ...(usage === undefined ? {} : { usage }),
      ...(providerMetadata === undefined ? {} : { providerMetadata }),
    };
  }

  async *streamText(request: TextRequest): AsyncIterable<StreamEvent> {
    const workspace =
      workspaceOption(request.providerOptions, this.kind) ??
      this.defaultWorkspace ??
      process.cwd();
    const prompt = request.messages
      .map((message) => `${message.role}: ${messageText(message)}`)
      .join("\n\n");
    const agentRequest: AgentRequest = {
      agent: request.model,
      prompt,
      workspace,
      permissions: readOnlyPermissions(),
      ...(request.requestId === undefined
        ? {}
        : { requestId: request.requestId }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      ...(request.maximumBoundary === undefined
        ? {}
        : { maximumBoundary: request.maximumBoundary }),
      ...(request.providerOptions === undefined
        ? {}
        : { providerOptions: request.providerOptions }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    let sessionId: string | undefined;
    for await (const event of this.runAgent(agentRequest)) {
      switch (event.type) {
        case "start":
          yield {
            type: "start",
            requestId: event.requestId,
            model: event.agent,
          };
          break;
        case "session":
          sessionId = event.sessionId;
          break;
        case "text-delta":
        case "reasoning-delta":
        case "usage":
        case "warning":
          yield event;
          break;
        case "command":
          yield {
            type: "warning",
            code: "agent-command",
            message: `${this.connection.label} reported a read-only command with status '${event.status}'.`,
          };
          break;
        case "file-change":
          yield {
            type: "warning",
            code: "unexpected-file-change",
            message: `${this.connection.label} reported a file change during read-only text execution.`,
          };
          break;
        case "finish":
          yield {
            type: "finish",
            reason: event.reason,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(sessionId === undefined
              ? {}
              : { providerMetadata: { sessionId } }),
          };
          break;
      }
    }
  }

  async *runAgent(request: AgentRequest): AsyncIterable<AgentEvent> {
    await this.validate(request);
    const requestId = request.requestId ?? crypto.randomUUID();
    const child = this.spawn(request);
    const completion = exitCode(child);
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let settled = false;
    let timedOut = false;
    const stop = (): void => terminate(child);
    const abort = (): void => stop();
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop();
          }, request.timeoutMs);
    yield {
      type: "start",
      requestId,
      agent: request.agent,
      workspace: request.workspace,
    };
    try {
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        let value: JsonObject;
        try {
          value = JSON.parse(line) as JsonObject;
        } catch (error) {
          throw new AiError(
            "provider-error",
            `Invalid ${this.connection.label} JSONL event.`,
            {
              connectionId: request.agent.connectionId,
              modelId: request.agent.modelId,
              cause: error,
            },
          );
        }
        for (const event of this.parse(value).events) yield event;
      }
      const code = await completion;
      settled = true;
      if (timedOut)
        throw new AiError(
          "timeout",
          `${this.connection.label} exceeded the configured timeout.`,
        );
      if (request.signal?.aborted === true) {
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        throw new AiError(
          "provider-error",
          message || `${this.connection.label} exited with status ${code}.`,
        );
      }
      yield { type: "finish", reason: "stop" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (!settled) terminate(child);
    }
  }

  protected abstract args(request: AgentRequest): string[];
  protected abstract parse(value: JsonObject): ParsedEvent;
  protected abstract versionCompatible(version: string): boolean;

  private spawn(request: AgentRequest): ChildProcessWithoutNullStreams {
    try {
      const child = spawn(this.executable, this.args(request), {
        cwd: request.workspace,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Codex treats a piped stdin as additional prompt input and waits for EOF.
      // Close it immediately because this adapter passes the complete prompt as an argument.
      child.stdin.end();
      return child;
    } catch (error) {
      throw asAiError(error, "provider-unavailable");
    }
  }

  private async validate(request: AgentRequest): Promise<void> {
    if (request.prompt.trim() === "")
      throw new AiError("invalid-request", "An agent prompt is required.");
    if (!request.permissions.read)
      throw new AiError(
        "permission-denied",
        `${this.connection.label} requires workspace read permission.`,
      );
    if (request.permissions.outsideWorkspace)
      throw new AiError(
        "permission-denied",
        "CLI adapters never grant access outside the selected workspace.",
      );
    if (request.permissions.network)
      throw new AiError(
        "unsupported-capability",
        "Explicit CLI network permission is not exposed yet.",
      );
    if (request.permissions.edit && !request.permissions.shell)
      throw new AiError(
        "unsupported-capability",
        "Workspace editing requires shell permission for terminal agents.",
      );
    if (!isAbsolute(request.workspace))
      throw new AiError(
        "invalid-request",
        "The agent workspace must be an absolute path.",
      );
    try {
      await access(request.workspace, constants.R_OK);
    } catch (error) {
      throw new AiError(
        "invalid-request",
        "The agent workspace must be an existing readable directory.",
        { cause: error },
      );
    }
    if (
      request.maximumBoundary !== undefined &&
      boundaryRank(this.connection.boundary) >
        boundaryRank(request.maximumBoundary)
    )
      throw new AiError(
        "data-boundary-violation",
        `${this.connection.label} exceeds the request data boundary.`,
      );
  }
}

export class CodexCliAdapter extends CliAgentAdapter {
  protected readonly kind = "codex-cli" as const;

  constructor(options: CliAgentOptions) {
    super(options, { label: "Codex CLI", executable: "codex" });
  }

  protected args(request: AgentRequest): string[] {
    const args = [
      "--sandbox",
      request.permissions.edit ? "workspace-write" : "read-only",
      "--cd",
      request.workspace,
    ];
    if (
      request.agent.modelId !== "default" &&
      request.agent.modelId.trim() !== ""
    )
      args.push("--model", request.agent.modelId);
    args.push("exec");
    if (request.sessionId !== undefined)
      args.push("resume", "--json", "--skip-git-repo-check", request.sessionId);
    else args.push("--json", "--skip-git-repo-check");
    args.push(request.prompt);
    return args;
  }

  protected parse(value: JsonObject): ParsedEvent {
    return { events: parseCodex(value) };
  }

  protected versionCompatible(version: string): boolean {
    const match = /(?:^|\s)0\.(\d+)\./.exec(version);
    return match?.[1] !== undefined && Number(match[1]) >= 100;
  }
}

export class ClaudeCliAdapter extends CliAgentAdapter {
  protected readonly kind = "claude-cli" as const;

  constructor(options: CliAgentOptions) {
    super(options, { label: "Claude Code CLI", executable: "claude" });
  }

  protected args(request: AgentRequest): string[] {
    const args = [
      "--print",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (
      request.agent.modelId !== "default" &&
      request.agent.modelId.trim() !== ""
    )
      args.push("--model", request.agent.modelId);
    if (request.sessionId !== undefined)
      args.push("--resume", request.sessionId);
    if (request.permissions.edit) args.push("--permission-mode", "acceptEdits");
    else
      args.push(
        "--permission-mode",
        "plan",
        "--allowedTools",
        "Read,Glob,Grep",
        "--disallowedTools",
        "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
      );
    return args;
  }

  protected parse(value: JsonObject): ParsedEvent {
    return { events: parseClaude(value) };
  }

  protected versionCompatible(version: string): boolean {
    return /\d+\.\d+\.\d+/.test(version);
  }
}

function parseCodex(value: JsonObject): AgentEvent[] {
  if (value.type === "thread.started" && typeof value.thread_id === "string")
    return [{ type: "session", sessionId: value.thread_id }];
  if (value.type === "turn.completed" && isObject(value.usage)) {
    const usage = tokenUsage(value.usage);
    return usage === undefined ? [] : [{ type: "usage", usage }];
  }
  if (value.type === "error")
    return [
      {
        type: "warning",
        code: "codex-error",
        message: stringValue(value.message) ?? "Codex reported an error.",
      },
    ];
  if (
    !["item.started", "item.updated", "item.completed"].includes(
      String(value.type),
    ) ||
    !isObject(value.item)
  )
    return [];
  const item = value.item;
  if (item.type === "agent_message")
    return textEvent("text-delta", item.text ?? item.content);
  if (item.type === "reasoning")
    return textEvent("reasoning-delta", item.text ?? item.content);
  if (item.type === "command_execution")
    return [
      {
        type: "command",
        command: stringValue(item.command) ?? "",
        status: stringValue(item.status) ?? "unknown",
        ...(stringValue(item.aggregated_output ?? item.output) === undefined
          ? {}
          : { output: stringValue(item.aggregated_output ?? item.output)! }),
      },
    ];
  if (item.type === "file_change" && Array.isArray(item.changes))
    return item.changes.filter(isObject).flatMap((change) =>
      typeof change.path === "string"
        ? [
            {
              type: "file-change" as const,
              path: change.path,
              kind: stringValue(change.kind) ?? "changed",
            },
          ]
        : [],
    );
  return [];
}

function parseClaude(value: JsonObject): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (typeof value.session_id === "string")
    events.push({ type: "session", sessionId: value.session_id });
  if (
    value.type === "assistant" &&
    isObject(value.message) &&
    Array.isArray(value.message.content)
  ) {
    for (const block of value.message.content.filter(isObject)) {
      if (block.type === "text")
        events.push(...textEvent("text-delta", block.text));
      if (block.type === "thinking")
        events.push(...textEvent("reasoning-delta", block.thinking));
      if (block.type === "tool_use") {
        const name = stringValue(block.name) ?? "tool";
        const input = isObject(block.input) ? block.input : {};
        if (name === "Bash")
          events.push({
            type: "command",
            command: stringValue(input.command) ?? "",
            status: "started",
          });
        if (
          (name === "Edit" || name === "Write" || name === "NotebookEdit") &&
          typeof input.file_path === "string"
        )
          events.push({
            type: "file-change",
            path: input.file_path,
            kind: name.toLowerCase(),
          });
      }
    }
  }
  if (value.type === "result") {
    const usage = isObject(value.usage)
      ? tokenUsage(
          value.usage,
          typeof value.total_cost_usd === "number"
            ? value.total_cost_usd
            : undefined,
        )
      : undefined;
    if (usage !== undefined) events.push({ type: "usage", usage });
    if (value.is_error === true)
      events.push({
        type: "warning",
        code: "claude-error",
        message: stringValue(value.result) ?? "Claude Code reported an error.",
      });
  }
  return events;
}

function tokenUsage(value: JsonObject, cost?: number): Usage | undefined {
  const inputTokens = numberValue(value.input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cost === undefined
  )
    return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined && outputTokens === undefined
      ? {}
      : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
    cost:
      cost === undefined
        ? { source: "unavailable" }
        : {
            amount: cost.toString(),
            currency: "USD",
            source: "provider-reported",
          },
  };
}

function textEvent(
  type: "text-delta" | "reasoning-delta",
  value: JsonValue | undefined,
): AgentEvent[] {
  const delta = stringValue(value);
  return delta === undefined || delta === "" ? [] : [{ type, delta }];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOnlyPermissions(): AgentPermissions {
  return {
    read: true,
    edit: false,
    shell: false,
    network: false,
    outsideWorkspace: false,
  };
}

function workspaceOption(
  options: Record<string, JsonObject> | undefined,
  kind: CliKind,
): string | undefined {
  const value = options?.[kind]?.workspace;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function boundaryRank(boundary: DataBoundary): number {
  return ["device", "local-network", "private-remote", "public-cloud"].indexOf(
    boundary,
  );
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else child.kill("SIGKILL");
}

function exitCode(
  child: ChildProcessWithoutNullStreams,
): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function runVersion(
  executable: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, output: Buffer.concat(output).toString("utf8") }),
    );
  });
}

function isMissingExecutable(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}
