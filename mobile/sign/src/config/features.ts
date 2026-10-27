// Aramo Sign Mobile redesign (M-A4 LOCKED, 2026-10-27): controls whose backend is
// authorized by the Lead ruling but specified in separate backend amendments. A
// control appears ONLY when its backend exists in this build (ruling §5: "Do not
// represent unfinished features as implemented"); the backend slices flip these in
// the same release that ships the backend. Never a disabled-looking placeholder.
export const FEATURES = {
  /** "Sign a document" — authenticated self-signing (A3). */
  selfSign: false,
  /** Recipient role chips Signs · In person · Copy (A1 RECEIVES_COPY). */
  recipientRoles: false,
  /** In-person / hosted signing session (A2). */
  hostedSigning: false,
  /** Name and Checkbox authoring tools (A6). */
  extraFieldTypes: true,
  /** Role binding when using a multi-role template (A4). */
  multiRoleTemplates: true,
} as const;

export type FeatureKey = keyof typeof FEATURES;
