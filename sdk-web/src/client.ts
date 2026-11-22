import { RouteBandit } from "./bandit.js";
import type { DeliveryObservation, ResilientClientOptions } from "./types.js";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
function originOf(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new TypeError("Origins must use HTTPS");
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new TypeError("Expected an origin, not a URL with path or credentials");
  return u.origin;
}
export class ResilientClient {
  private origins: readonly string[];
  private bandit: RouteBandit;
  private maxAttempts: number;
  private fetcher: typeof globalThis.fetch;
  private now: () => number;
  private random: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(private options: ResilientClientOptions) {
    this.origins = [options.primaryOrigin, ...(options.fallbackOrigins ?? [])].map(originOf);
    if (new Set(this.origins).size !== this.origins.length) throw new TypeError("Origins must be unique");
    const requestedAttempts = options.maxAttempts ?? this.origins.length;
    if (!Number.isFinite(requestedAttempts) || !Number.isInteger(requestedAttempts) || requestedAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
    this.maxAttempts = Math.min(this.origins.length, requestedAttempts);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.bandit = new RouteBandit(this.origins.length, options.random);
  }
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const requested = new URL(input.toString(), this.origins[0]!);
    if (!this.origins.includes(requested.origin)) throw new TypeError("Request origin is not in the configured allowlist");
    if (requested.protocol !== "https:" && requested.hostname !== "localhost" && requested.hostname !== "127.0.0.1") throw new TypeError("Only HTTPS requests are allowed");
    const method = (init.method ?? "GET").toUpperCase(), headers = new Headers(init.headers);
    const streamingBody = typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream;
    const canRetry = !streamingBody && (IDEMPOTENT.has(method) || headers.has("Idempotency-Key"));
    const attempts = canRetry ? this.maxAttempts : 1, tried = new Set<number>();
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = this.origins.map((_, i) => i).filter(i => !tried.has(i));
      if (!remaining.length) break;
      const routeIndex = this.bandit.choose(remaining); tried.add(routeIndex);
      const target = new URL(requested.pathname + requested.search + requested.hash, this.origins[routeIndex]);
      const started = this.now();
      try {
        const response = await this.fetcher(target, {...init, method, headers});
        const durationMs = Math.max(0, this.now() - started), success = response.ok || !RETRYABLE.has(response.status);
        this.bandit.observe(routeIndex, success);
        this.emit({schemaVersion: 1, routeIndex, outcome: response.ok ? "success" : "http_error", durationMs, status: response.status});
        if (!RETRYABLE.has(response.status) || attempt === attempts - 1) return response;
        try { await response.body?.cancel(); } catch { /* A discarded response must not block failover. */ }
      } catch (error) {
        lastError = error; this.bandit.observe(routeIndex, false);
        this.emit({schemaVersion: 1, routeIndex, outcome: "network_error", durationMs: Math.max(0, this.now() - started)});
        if (attempt === attempts - 1) throw error;
      }
      if (attempt < attempts - 1) {
        const ceiling = Math.min(500, 50 * 2 ** attempt);
        await this.sleep(ceiling * (0.5 + this.random()));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All configured routes failed");
  }
  private emit(event: DeliveryObservation): void {
    if (this.options.telemetryConsent === true) {
      try { this.options.onObservation?.(event); } catch { /* Observability must never break delivery. */ }
    }
  }
  getRouteScores() { return this.bandit.snapshot(); }
}
