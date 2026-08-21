// Const + type-guard mirrors of the submittal_policy Prisma enums (L8-B1).
// The single source of the value space the port + policy API validate against.

export const SUBMITTAL_AUTHORITY_VALUES = [
  'CLIENT_VMS',
  'CLIENT_MANUAL',
  'ARAMO',
] as const;
export type SubmittalAuthorityValue = (typeof SUBMITTAL_AUTHORITY_VALUES)[number];

export const SUBMITTAL_WINDOW_STATUS_VALUES = ['OPEN', 'CLOSED', 'PAUSED'] as const;
export type SubmittalWindowStatusValue =
  (typeof SUBMITTAL_WINDOW_STATUS_VALUES)[number];

export const SUBMITTAL_POLICY_REASON_VALUES = [
  'SHORTLISTING_STARTED',
  'CLIENT_DEADLINE',
  'QUOTA_EXHAUSTED',
  'MANUAL',
  'VMS_SUSPENDED',
  'OTHER',
] as const;
export type SubmittalPolicyReasonValue =
  (typeof SUBMITTAL_POLICY_REASON_VALUES)[number];

export function isSubmittalAuthority(v: unknown): v is SubmittalAuthorityValue {
  return (
    typeof v === 'string' &&
    (SUBMITTAL_AUTHORITY_VALUES as readonly string[]).includes(v)
  );
}

export function isSubmittalWindowStatus(
  v: unknown,
): v is SubmittalWindowStatusValue {
  return (
    typeof v === 'string' &&
    (SUBMITTAL_WINDOW_STATUS_VALUES as readonly string[]).includes(v)
  );
}

export function isSubmittalPolicyReason(
  v: unknown,
): v is SubmittalPolicyReasonValue {
  return (
    typeof v === 'string' &&
    (SUBMITTAL_POLICY_REASON_VALUES as readonly string[]).includes(v)
  );
}
