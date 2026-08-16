// T8-CONNECTOR-A — secret-safe redaction for logs/audit (directive §25/§48,
// Architect check on secret handling). The workspace structured logger spreads
// payloads verbatim, so connector code MUST route any object that could carry
// credential material through this redactor before logging. Keys matching
// connector credential concepts are replaced with a sentinel; strings are
// bounded so a wholesale provider response body can never be dumped.

export const REDACTED = '[REDACTED]';
const MAX_STRING = 500;
const MAX_DEPTH = 6;

/** Keys whose VALUES must never be logged (directive §25). */
const SECRET_KEY_RE =
  /(authorization|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|webhook[_-]?secret|password|secret|credential|bearer)/i;

/** Bound a string so provider bodies/PII are never dumped wholesale. */
export function redactString(value: string, maxLen: number = MAX_STRING): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}…[truncated]` : value;
}

/**
 * Deep-redact a value for logging: secret-like KEYS → sentinel, long strings
 * bounded, cycles/over-depth collapsed. Never mutates the input.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[Object]';
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactForLog(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactForLog(v, depth + 1);
  }
  return out;
}
