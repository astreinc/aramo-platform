// Aramo Sign Mobile redesign (M-A4 LOCKED, 2026-10-27): controls whose backend is
// authorized by the Lead ruling but specified in separate backend amendments. A
// control appears ONLY when its backend exists in this build (ruling §5: "Do not
// represent unfinished features as implemented"); the backend slices flip these in
// the same release that ships the backend. Never a disabled-looking placeholder.
// M-A5 (LOCKED 2026-10-27) ships recipient kinds, hosted and self-signing in this
// release, so selfSign, recipientRoles and hostedSigning are on (M-A5 §6.1).
export const FEATURES = {
  /** "Sign a document" — authenticated self-signing (A3). */
  selfSign: true,
  /** Recipient role chips Signs · In person · Copy (A1 RECEIVES_COPY). */
  recipientRoles: true,
  /** In-person / hosted signing session (A2). */
  hostedSigning: true,
  /** Name and Checkbox authoring tools (A6). */
  extraFieldTypes: true,
  /** Role binding when using a multi-role template (A4). */
  multiRoleTemplates: false,
} as const;

export type FeatureKey = keyof typeof FEATURES;
