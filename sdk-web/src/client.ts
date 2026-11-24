import { RouteBandit } from "./bandit.js";
import type { DeliveryObservation, ResilientClientOptions } from "./types.js";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

function originOf(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    throw new TypeError("Origins must use HTTPS");
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new TypeError("Expected an origin, not a URL with path or credentials");
  }
  return u.origin;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

export class ResilientClient {
  private origins: readonly string[];
  private bandit: RouteBandit;
  private maxAttempts: number;
  private timeoutMs: number;
  private retryBaseDelayMs: number;
  private retryMaxDelayMs: number;
  private fetcher: typeof globalThis.fetch;
  private now: () => number;
  private random: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private options: ResilientClientOptions) {
    this.origins = [options.primaryOrigin, ...(options.fallbackOrigins ?? [])].map(originOf);
    if (new Set(this.origins).size !== this.origins.length) throw new TypeError("Origins must be unique");

    const requestedAttempts = options.maxAttempts ?? this.origins.length;
    if (!Number.isFinite(requestedAttempts) || !Number.isInteger(requestedAttempts) || requestedAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    this.maxAttempts = Math.min(this.origins.length, requestedAttempts);
    this.timeoutMs = positiveFinite(options.timeoutMs ?? 10_000, "timeoutMs");
    this.retryBaseDelayMs = positiveFinite(options.retryBaseDelayMs ?? 50, "retryBaseDelayMs");
    this.retryMaxDelayMs = positiveFinite(options.retryMaxDelayMs ?? 500, "retryMaxDelayMs");
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) throw new RangeError("retryMaxDelayMs must be >= retryBaseDelayMs");

    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.bandit = new RouteBandit(this.origins.length, options.random);
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const requested = new URL(input.toString(), this.origins[0]!);
    if (!this.origins.includes(requested.origin)) {
      throw new TypeError("Request origin is not in the configured allowlist");
    }
    if (requested.protocol !== "https:" && requested.hostname !== "localhost" && requested.hostname !== "127.0.0.1") {
      throw new TypeError("Only HTTPS requests are allowed");
    }
    if (requested.username || requested.password) throw new TypeError("URL credentials are not allowed");
    if (init.redirect === "follow") {
      throw new TypeError('redirect:"follow" is disabled because it can escape the origin allowlist');
    }

    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const streamingBody = typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream;
    const canRetry = !streamingBody && (IDEMPOTENT.has(method) || headers.has("Idempotency-Key"));
    const attempts = canRetry ? this.maxAttempts : 1;
    const tried = new Set<number>();
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
      const remaining = this.origins.map((_, i) => i).filter(i => !tried.has(i));
      if (!remaining.length) break;

      const routeIndex = this.bandit.choose(remaining);
      tried.add(routeIndex);
      const target = new URL(requested.pathname + requested.search, this.origins[routeIndex]);
      const started = this.now();
      const controller = new AbortController();
      let timedOut = false;
      const onCallerAbort = () => controller.abort(init.signal?.reason);
      init.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
      }, this.timeoutMs);

      try {
        const response = await this.fetcher(target, {
          ...init,
          method,
          headers,
          signal: controller.signal,
          // Do not silently follow redirects to origins outside the owner allowlist.
          redirect: init.redirect ?? "error",
        });
        const durationMs = Math.max(0, this.now() - started);
        const routeHealthy = !RETRYABLE.has(response.status);
        this.bandit.observe(routeIndex, routeHealthy);
        this.emit({
          schemaVersion: 1,
          routeIndex,
          outcome: response.ok ? "success" : "http_error",
          durationMs,
          status: response.status,
        });

        if (!RETRYABLE.has(response.status) || attempt === attempts - 1) return response;
        try {
          await response.body?.cancel();
        } catch {
          // A discarded response must not block failover.
        }
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason ?? error;
        lastError = error;
        this.bandit.observe(routeIndex, false);
        this.emit({
          schemaVersion: 1,
          routeIndex,
          outcome: "network_error",
          durationMs: Math.max(0, this.now() - started),
        });
        if (attempt === attempts - 1) throw error;
        // A timed-out attempt is eligible for failover; caller cancellation is not.
        if (!timedOut && error instanceof DOMException && error.name === "AbortError") throw error;
      } finally {
        clearTimeout(timeout);
        init.signal?.removeEventListener("abort", onCallerAbort);
      }

      if (attempt < attempts - 1) {
        const ceiling = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** attempt);
        const random = this.random();
        const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
        await this.sleep(ceiling * (0.5 + unit));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("All configured routes failed");
  }

  private emit(event: DeliveryObservation): void {
    if (this.options.telemetryConsent === true) {
      try {
        this.options.onObservation?.(event);
      } catch {
        // Observability must never break delivery.
      }
    }
  }

  getRouteScores() {
    return this.bandit.snapshot();
  }
}
