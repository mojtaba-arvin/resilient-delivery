export interface ResilientClientOptions {
  primaryOrigin: string;
  fallbackOrigins?: readonly string[];
  maxAttempts?: number;
  onObservation?: (observation: DeliveryObservation) => void;
  telemetryConsent?: boolean;
  now?: () => number;
  random?: () => number;
  fetch?: typeof globalThis.fetch;
}
export interface DeliveryObservation {
  schemaVersion: 1;
  routeIndex: number;
  outcome: "success" | "network_error" | "http_error";
  durationMs: number;
  status?: number;
}
export interface RouteScore { readonly alpha: number; readonly beta: number; }
