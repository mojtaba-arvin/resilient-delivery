const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createResilientClient(options) {
  const origins = [...new Set([options.primaryOrigin, ...(options.fallbackOrigins ?? [])].map(value => new URL(value).origin))];
  if (!origins.length || origins.some(origin => !origin.startsWith("https://") && process.env.NODE_ENV === "production")) {
    throw new TypeError("Production origins must use HTTPS");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A Fetch implementation is required");
  const requestedAttempts = Math.max(1, Math.min(options.maxAttempts ?? origins.length, origins.length));
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 5000, 60000));

  return async function resilientFetch(path, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const safe = ["GET", "HEAD", "OPTIONS"].includes(method) || headers.has("idempotency-key");
    if (!safe && requestedAttempts > 1) throw new TypeError("Retries for non-idempotent requests require an Idempotency-Key");
    const body = init.body;
    const replayableBody = body == null || typeof body === "string" ||
      body instanceof URLSearchParams || body instanceof Blob ||
      body instanceof ArrayBuffer || ArrayBuffer.isView(body);
    if (!replayableBody && requestedAttempts > 1) {
      throw new TypeError("Retrying streaming request bodies is not supported");
    }
    const attempts = replayableBody ? requestedAttempts : 1;
    let lastError;
    for (let index = 0; index < attempts; index += 1) {
      const origin = origins[index];
      const target = new URL(path, origin);
      if (target.origin !== origin) throw new TypeError("Request path escaped configured origin");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("request deadline exceeded")), timeoutMs);
      try {
        const response = await fetchImpl(target, {
          ...init,
          method,
          headers,
          signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
          redirect: "error",
        });
        if (!RETRYABLE.has(response.status) || index === attempts - 1) return response;
        lastError = new Error(`retryable HTTP status ${response.status}`);
      } catch (error) {
        lastError = error;
        if (init.signal?.aborted || index === attempts - 1) throw error;
      } finally {
        clearTimeout(timer);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100 * (2 ** index), 1000)));
    }
    throw lastError ?? new Error("request failed");
  };
}
