// T10-B2 §2 — product-safe user-facing error text.
//
// A raw thrown Error / ApiError `.message` may carry stack traces, database
// details, internal service names, authorization internals, tenant ids,
// provider internals, raw validation internals, or HTTP implementation
// details. It is therefore NEVER surfaced to users, even when the frontend
// caught it (a generic Error.message is not product-safe merely because it was
// caught).
//
// Governed, per-code product copy is the job of each module's `error-messages`
// mapper (which reads the ApiError `{ code, details }` surface and returns
// approved copy). This helper is the single, greppable SAFE FALLBACK for
// unmapped / unknown / internal errors:
//
//   KNOWN GOVERNED CODE / SAFE ENUM  → module mapper produces approved copy
//   UNKNOWN / UNMAPPED / INTERNAL     → safeErrorMessage(err, fallback)
//
// An error MAY opt in to safe copy by carrying an explicit `userMessage`
// string (a field a governed layer sets deliberately); nothing does today, so
// unknown errors fall back. This is intentionally NOT a global error taxonomy
// and never inspects `.message` or message substrings.

export function safeErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { userMessage?: unknown }).userMessage === 'string'
  ) {
    return (error as { userMessage: string }).userMessage;
  }
  return fallback;
}
