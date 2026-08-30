import type { ConnectionId, JsonObject, ModelId } from "./types.js";

export type ErrorCode =
  | "invalid-request"
  | "unsupported-capability"
  | "provider-unavailable"
  | "authentication-failed"
  | "permission-denied"
  | "rate-limited"
  | "quota-exceeded"
  | "content-blocked"
  | "context-overflow"
  | "timeout"
  | "cancelled"
  | "executable-not-found"
  | "incompatible-version"
  | "schema-validation-failed"
  | "data-boundary-violation"
  | "provider-error";

export interface AiErrorOptions {
  retryable?: boolean;
  connectionId?: ConnectionId;
  modelId?: ModelId;
  retryAfterMs?: number;
  providerCode?: string;
  details?: JsonObject;
  cause?: unknown;
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}

export class AiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly connectionId?: ConnectionId;
  readonly modelId?: ModelId;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly details?: JsonObject;

  constructor(code: ErrorCode, message: string, options: AiErrorOptions = {}) {
    super(
      redactSecrets(message),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AiError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.connectionId !== undefined)
      this.connectionId = options.connectionId;
    if (options.modelId !== undefined) this.modelId = options.modelId;
    if (options.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
    if (options.providerCode !== undefined)
      this.providerCode = redactSecrets(options.providerCode);
    if (options.details !== undefined) this.details = options.details;
  }

  toJSON(): JsonObject {
    const value: JsonObject = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.connectionId !== undefined) value.connectionId = this.connectionId;
    if (this.modelId !== undefined) value.modelId = this.modelId;
    if (this.retryAfterMs !== undefined) value.retryAfterMs = this.retryAfterMs;
    if (this.providerCode !== undefined) value.providerCode = this.providerCode;
    if (this.details !== undefined) value.details = this.details;
    return value;
  }
}

export function asAiError(
  error: unknown,
  fallback: ErrorCode = "provider-error",
): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiError("cancelled", "The request was cancelled.", {
      cause: error,
    });
  }
  if (error instanceof Error)
    return new AiError(fallback, error.message, { cause: error });
  return new AiError(fallback, "The provider returned an unknown error.");
}
