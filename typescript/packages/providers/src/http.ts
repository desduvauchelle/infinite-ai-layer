import { AiError, asAiError, redactSecrets } from "@infinite-ai/core";

export function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function requestSignal(
  signal?: AbortSignal,
  timeoutMs = 120_000,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export async function checkedFetch(
  url: string,
  init: RequestInit,
  connectionId: string,
  modelId?: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const normalized = asAiError(error, "provider-unavailable");
    if (normalized.code === "cancelled") throw normalized;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new AiError("timeout", "The provider request timed out.", {
        retryable: true,
        connectionId,
        ...(modelId === undefined ? {} : { modelId }),
        cause: error,
      });
    }
    throw new AiError(
      "provider-unavailable",
      `The provider at ${redactSecrets(url)} is not reachable.`,
      {
        retryable: true,
        connectionId,
        ...(modelId === undefined ? {} : { modelId }),
        cause: error,
      },
    );
  }

  if (response.ok) return response;
  const body = redactSecrets((await response.text()).slice(0, 2_000));
  const options = {
    connectionId,
    ...(modelId === undefined ? {} : { modelId }),
    providerCode: String(response.status),
  };
  if (response.status === 401)
    throw new AiError(
      "authentication-failed",
      "The provider rejected the configured credential.",
      options,
    );
  if (response.status === 403)
    throw new AiError(
      "permission-denied",
      "The provider denied this request.",
      options,
    );
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs =
      retryAfter === null || Number.isNaN(Number(retryAfter))
        ? undefined
        : Number(retryAfter) * 1_000;
    throw new AiError("rate-limited", "The provider rate limit was reached.", {
      ...options,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (response.status === 408 || response.status === 504)
    throw new AiError("timeout", "The provider timed out.", {
      ...options,
      retryable: true,
    });
  if (response.status === 413)
    throw new AiError(
      "context-overflow",
      "The provider rejected the request because it was too large.",
      options,
    );
  throw new AiError(
    "provider-error",
    body === ""
      ? `Provider request failed with HTTP ${response.status}.`
      : body,
    {
      ...options,
      retryable: response.status >= 500,
    },
  );
}

export async function* lines(response: Response): AsyncIterable<string> {
  if (response.body === null)
    throw new AiError(
      "provider-error",
      "The provider returned an empty response stream.",
    );
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim() !== "") yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export async function* ndjson(response: Response): AsyncIterable<unknown> {
  for await (const line of lines(response)) {
    if (line.trim() === "") continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch (error) {
      throw new AiError(
        "provider-error",
        "The provider returned malformed NDJSON.",
        { cause: error },
      );
    }
  }
}

export async function* sseData(response: Response): AsyncIterable<string> {
  let data: string[] = [];
  for await (const line of lines(response)) {
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length > 0) yield data.join("\n");
}
