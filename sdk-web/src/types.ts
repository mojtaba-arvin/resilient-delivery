export interface ResilientClientOptions {
  /** Primary HTTPS origin controlled by the application owner. */
  primaryOrigin: string;
  /** Additional owner-configured HTTPS origins; no discovery is performed. */
  fallbackOrigins?: readonly string[];
  /** Total attempts, bounded by the number of configured origins. */
  maxAttempts?: number;
  /** Per-origin request deadline in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Base retry delay in milliseconds. Defaults to 50ms. */
  retryBaseDelayMs?: number;
  /** Maximum retry delay in milliseconds. Defaults to 500ms. */
  retryMaxDelayMs?: number;
  /** Called only when telemetryConsent is explicitly true. */
  onObservation?: (observation: DeliveryObservation) => void;
  telemetryConsent?: boolean;
  /** Injectable clock/random/sleep/fetch make policy behavior deterministic in tests. */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}
export interface DeliveryObservation {
  schemaVersion: 1;
  /** Zero-based configured route index; the collector contract supports 0–31. */
  routeIndex: number;
  outcome: "success" | "network_error" | "http_error";
  /** Integer milliseconds, rounded and capped to the collector's 0–600000 range. */
  durationMs: number;
  status?: number;
}
export interface RouteScore { readonly alpha: number; readonly beta: number; }
