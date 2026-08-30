export const CONTRACT_VERSION = "0.1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AdapterId = string;
export type ConnectionId = string;
export type ModelId = string;

export interface ModelRef {
  connectionId: ConnectionId;
  modelId: ModelId;
}

export type DataBoundary =
  "device" | "local-network" | "private-remote" | "public-cloud";

export type Capability =
  | "provider-health"
  | "model-listing"
  | "text-generation"
  | "text-streaming"
  | "structured-output"
  | "tool-calling"
  | "reasoning-events"
  | "embeddings"
  | "transcription"
  | "speech-generation"
  | "image-understanding"
  | "image-generation"
  | "image-editing"
  | "video-generation"
  | "video-editing"
  | "agent-execution";

export type StructuredOutputSupport =
  "native-schema" | "json-only" | "best-effort" | "unsupported";

export interface ConnectionInfo {
  id: ConnectionId;
  adapterId: AdapterId;
  label: string;
  boundary: DataBoundary;
  capabilities: Capability[];
}

export interface ModelInfo {
  id: ModelId;
  name?: string;
  capabilities: Capability[];
  contextWindow?: number;
  structuredOutput?: StructuredOutputSupport;
  metadata?: JsonObject;
}

export type AvailabilityReason =
  | "available"
  | "unreachable"
  | "authentication-failed"
  | "not-configured"
  | "executable-not-found"
  | "incompatible-version"
  | "model-not-ready"
  | "unknown";

export interface HealthResult {
  available: boolean;
  reason: AvailabilityReason;
  message: string;
  checkedAt: string;
  latencyMs?: number;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: JsonValue;
  isError?: boolean;
}

export interface MediaInput {
  mimeType: string;
  data?: Uint8Array;
  url?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media: MediaInput }
  | { type: "audio"; media: MediaInput }
  | { type: "file"; media: MediaInput }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; result: ToolResult };

export interface Message {
  role: Role;
  content: ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: JsonObject;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface RequestContext {
  requestId?: string;
  model: ModelRef;
  maximumBoundary?: DataBoundary;
  timeoutMs?: number;
  metadata?: JsonObject;
  providerOptions?: Record<string, JsonObject>;
  signal?: AbortSignal;
}

export interface TextRequest extends RequestContext {
  messages: Message[];
  maxOutputTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

export type CostSource =
  "provider-reported" | "sdk-estimated" | "host-supplied" | "unavailable";

export interface Cost {
  amount?: string;
  currency?: string;
  source: CostSource;
  pricingVersion?: string;
  calculatedAt?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  requests?: number;
  cost?: Cost;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "cancelled"
  | "error"
  | "unknown";

export interface TextResult {
  requestId: string;
  model: ModelRef;
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: Usage;
  providerMetadata?: JsonObject;
}

export type StreamEvent =
  | { type: "start"; requestId: string; model: ModelRef }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-start"; callId: string; name: string }
  | { type: "tool-call-delta"; callId: string; argumentsDelta: string }
  | { type: "tool-call"; call: ToolCall }
  | {
      type: "citation";
      citation: { title?: string; url?: string; providerMetadata?: JsonObject };
    }
  | { type: "usage"; usage: Usage }
  | { type: "warning"; code: string; message: string }
  | {
      type: "finish";
      reason: FinishReason;
      usage?: Usage;
      providerMetadata?: JsonObject;
    };

export interface ObjectRequest extends TextRequest {
  schema: JsonObject;
  schemaName?: string;
  repairAttempts?: number;
}

export interface ObjectResult<T extends JsonValue = JsonValue> extends Omit<
  TextResult,
  "text"
> {
  value: T;
  rawText: string;
}

export interface EmbeddingRequest extends RequestContext {
  input: string[];
  inputMode?: "query" | "document" | "unspecified";
}

export interface EmbeddingResult {
  vectors: number[][];
  model: ModelRef;
  dimensions: number;
  normalized?: boolean;
  inputMode?: "query" | "document" | "unspecified";
  usage?: Usage;
}

export interface TranscriptionRequest extends Omit<RequestContext, "model"> {
  model: ModelRef;
  audio: MediaInput;
  language?: string;
  prompt?: string;
}

export interface TranscriptionSegment {
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface TranscriptionResult {
  text: string;
  segments?: TranscriptionSegment[];
  model: ModelRef;
  usage?: Usage;
  providerMetadata?: JsonObject;
}

export interface AgentPermissions {
  read: boolean;
  edit: boolean;
  shell: boolean;
  network: boolean;
  outsideWorkspace: boolean;
}

export interface AgentRequest extends Omit<RequestContext, "model"> {
  agent: ModelRef;
  prompt: string;
  workspace: string;
  sessionId?: string;
  permissions: AgentPermissions;
}

export type AgentEvent =
  | { type: "start"; requestId: string; agent: ModelRef; workspace: string }
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "command"; command: string; status: string; output?: string }
  | { type: "file-change"; path: string; kind: string }
  | { type: "warning"; code: string; message: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason; usage?: Usage };

export interface ContractEnvelope<T extends JsonValue = JsonValue> {
  contractVersion: typeof CONTRACT_VERSION;
  kind:
    | "text-request"
    | "stream-events"
    | "object-result"
    | "error"
    | "embedding-result"
    | "transcription-result"
    | "agent-request"
    | "agent-events";
  value: T;
}

export function textMessage(role: Role, text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

export function messageText(message: Message): string {
  return message.content
    .filter(
      (part): part is Extract<ContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}
