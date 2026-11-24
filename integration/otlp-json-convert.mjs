import { gunzipSync } from "node:zlib";

const MAX_BODY_BYTES = 64 * 1024;

export function decodeOtlpJson(body, contentEncoding = "identity") {
  let decoded;
  if (!Buffer.isBuffer(body)) throw new TypeError("OTLP body must be a Buffer");
  if (contentEncoding === "identity" || contentEncoding === undefined) {
    decoded = body;
  } else if (contentEncoding === "gzip") {
    decoded = gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
  } else {
    throw new TypeError("Unsupported OTLP content-encoding");
  }
  if (decoded.length > MAX_BODY_BYTES) throw new RangeError("OTLP body exceeds the 64 KiB decoded limit");
  return JSON.parse(decoded.toString("utf8"));
}

function attributeMap(record) {
  const result = new Map();
  for (const item of record.attributes ?? []) {
    if (item && typeof item.key === "string" && item.value && typeof item.value === "object") {
      result.set(item.key, item.value);
    }
  }
  return result;
}

function stringValue(value) {
  return typeof value?.stringValue === "string" ? value.stringValue : undefined;
}

function integerValue(value) {
  const raw = value?.intValue;
  const number = typeof raw === "string" ? Number(raw) : raw;
  return Number.isSafeInteger(number) ? number : undefined;
}

export function convertOtlp(input) {
  if (!input || !Array.isArray(input.resourceLogs)) {
    throw new TypeError("Expected OTLP ExportLogsServiceRequest.resourceLogs");
  }
  const events = [];
  for (const resource of input.resourceLogs) {
    for (const scope of resource.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const attrs = attributeMap(record);
        const routeIndex = integerValue(attrs.get("resilient.route_index"));
        const durationMs = integerValue(attrs.get("resilient.duration_ms"));
        const outcome = stringValue(attrs.get("resilient.outcome"));
        const status = integerValue(attrs.get("http.response.status_code"));
        if (
          routeIndex === undefined ||
          routeIndex < 0 ||
          routeIndex > 31 ||
          durationMs === undefined ||
          durationMs < 0 ||
          durationMs > 600000 ||
          !["success", "network_error", "http_error"].includes(outcome)
        ) {
          throw new TypeError("Each OTLP log record must include valid resilient.route_index, resilient.duration_ms, and resilient.outcome attributes");
        }
        if (status !== undefined && (status < 100 || status > 599)) {
          throw new TypeError("Invalid http.response.status_code attribute");
        }
        events.push({
          schemaVersion: 1,
          routeIndex,
          outcome,
          durationMs,
          ...(status === undefined ? {} : { status }),
        });
        if (events.length > 100) {
          throw new TypeError("OTLP request exceeds the 100-event collector batch limit");
        }
      }
    }
  }
  if (events.length === 0) {
    throw new TypeError("OTLP request contains no supported delivery records");
  }
  return { schemaVersion: 1, events };
}
