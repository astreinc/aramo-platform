// CI-B3 — the consent-neutral, fail-closed transcription-authorization seam
// (directive §4 / §4.5). B3 does NOT implement consent and MUST NOT import any
// unmerged CI-B1 enum/type, copy consent scope strings, or infer transcription
// permission from contact/recording (directive §4.2). It preserves the
// architectural rule that transcript acquisition requires an authorization
// established by the SOLE Consent authority (`libs/consent`, directive §3.2).
//
// Pattern: the acquisition service accepts an ALREADY-AUTHORIZED command. The
// composition root calls the Consent authority for the `transcription` operation
// FIRST and, only on ALLOW, stamps `transcription_authorized: true` onto the
// command. B3 stays fail-closed: no proof => no acquisition.

/**
 * Proof — supplied by the composition root AFTER the Consent authority allows
 * the `transcription` operation — that transcript acquisition is authorized.
 * B3 treats anything other than `transcription_authorized === true` as denied.
 */
export interface TranscriptionAuthorization {
  readonly transcription_authorized: boolean;
  /** Optional opaque reference to the consent decision (provenance, not a scope). */
  readonly consent_decision_ref?: string;
}

/**
 * Optional DI token for a later composition-root binding that PRODUCES a
 * {@link TranscriptionAuthorization} by calling the Consent authority. Declared
 * here so B3 marks the seam without binding anything (no consent dependency in
 * B3). The concrete resolver lives at apps/api, never inside this lib.
 */
export const TRANSCRIPTION_AUTHORIZATION_RESOLVER =
  'TRANSCRIPTION_AUTHORIZATION_RESOLVER';

/** True iff the supplied proof authorizes transcript acquisition (fail-closed). */
export function isTranscriptionAuthorized(
  authorization: TranscriptionAuthorization | undefined,
): boolean {
  return authorization?.transcription_authorized === true;
}
