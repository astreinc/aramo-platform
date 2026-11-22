// Client Rule Consolidation C0-2 / C2-4 — the SIGN_DATE formatter lives in
// @aramo/sign-client (one copy: the server stamp and the web and mobile previews).
// Re-exported so libs/sign callers are unchanged.
export {
  SIGN_DATE_FORMATS,
  DEFAULT_SIGN_DATE_FORMAT,
  SIGN_DATE_FALLBACK_TIME_ZONE,
  formatSignDate,
  resolveSignerTimeZone,
} from '@aramo/sign-client';
export type { SignDateFormat } from '@aramo/sign-client';
