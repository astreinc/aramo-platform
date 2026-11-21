// Client Rule Consolidation C2-4 (Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED)
// — the M-A6 §2 field completion rules now live in @aramo/sign-client, the one copy the
// server and both Sign clients use. Re-exported here so libs/sign callers are unchanged.
export {
  SIGNER_NAME_MODES,
  CHECKBOX_GROUP_RULES,
  CHECK_FIELD_TYPES,
  PAYMENT_FIELD_TYPE,
  PROFILE_TEXT_FIELD_TYPES,
  PROFILE_TEXT_MAX,
  isProfileTextField,
  profileTextValueRefusal,
  isPaymentField,
  isServerFilledName,
  evaluateSignerFieldRules,
} from '@aramo/sign-client';
export type { SignerNameMode, CheckboxGroupRule, FieldRuleRow, ProfileTextFieldType, FieldRuleViolation } from '@aramo/sign-client';
