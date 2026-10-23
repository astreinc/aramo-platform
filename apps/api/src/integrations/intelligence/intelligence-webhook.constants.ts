// ATI-SEP-1 T8 — the TI → ATS webhook route (raw body, mounted before the JSON
// parser in main.ts so the HMAC verifies the exact signed bytes).
export const INTELLIGENCE_EVENTS_WEBHOOK_ROUTE = '/v1/integrations/intelligence/events';
export const INTELLIGENCE_EVENTS_MAX_BODY_BYTES = 64 * 1024;
