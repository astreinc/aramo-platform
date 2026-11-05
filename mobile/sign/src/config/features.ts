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
  multiRoleTemplates: true,
  /** M-A12 W1-C.4 — First name, Last name, Email, Company and Title fields. */
  profileFieldTypes: true,
  /**
   * M-A12 W1-G — in-app purchase through the platform store. Built; the Plans screen still
   * shows prices and purchase controls ONLY while the server reports store billing as
   * available (`store_purchase_eligible` or plans with `store_products`).
   */
  storePurchase: true,
  /**
   * Kept hidden (M-A12 §3, D-4 HOLD and Wave 3): AI summary and AI field suggestion, cloud
   * storage tiles, email-in, offline signing and sounds. No control of these renders.
   */
  aiControls: false,
  cloudImports: false,
  emailIn: false,
  offlineSigning: false,
  sounds: false,
} as const;

export type FeatureKey = keyof typeof FEATURES;
