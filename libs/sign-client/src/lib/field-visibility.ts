// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-4 —
// the ONE visibility rule: given one signer's fields and their current values, which fields are
// shown. The server (fill, clear-on-hide, completion), the sign-web guest page and the Aramo Sign
// app call it from here.
//
// B-7 — the rule itself lives in @aramo/sign-fields (lib/field-visibility.ts), so the shared web
// placement editor (scope:shared, which cannot reach this scope:sign library) previews the same
// rule; this module re-exports it unchanged. One copy, no client keeps its own.
export {
  fieldConditionOf,
  conditionMetBy,
  shownFields,
  isFieldShown,
  hiddenFilledFields,
  type VisibilityFieldLike,
} from '@aramo/sign-fields';
