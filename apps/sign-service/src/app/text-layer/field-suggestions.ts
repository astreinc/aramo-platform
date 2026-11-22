// Aramo Sign Mobile M-A14 R-3 / §2 — "Auto suggest fields", and FIELD-PARITY-1 §5 P2-4
// ("Auto-detect suggestions everywhere"). The detector moved to @aramo/sign-fields
// (field-detect.ts) so the console's fixed-form route uses the SAME one; this module keeps the
// names Sign has always used, re-exported unchanged:
//   suggestFields   the M-A14 signature-block mode (SIGNATURE / SIGN_DATE, at most 6, the
//                   signature pages last-first) — the route's default, unchanged;
//   detectFields    the P2-4 detector (labels, underscore lines, empty boxes and table cells,
//                   checkbox glyphs; every page; at most DETECT_LIMIT) — `?detect=all`.
// No model, no network; nothing here logs text.

export {
  DETECT_LIMIT,
  SUGGESTED_SIZE,
  SUGGESTION_LIMIT,
  detectFields,
  suggestSignatureBlock as suggestFields,
  type DetectedField,
  type DetectPageFrame as PageFrame,
  type DetectResult,
  type SignatureBlockSuggestion as FieldSuggestion,
  type SkippedPage,
  type SuggestedFieldType,
} from '@aramo/sign-fields';
