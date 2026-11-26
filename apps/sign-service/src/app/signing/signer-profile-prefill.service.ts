import { Injectable, Logger } from '@nestjs/common';
import { profilePrefill, type ProfilePrefill } from '@aramo/sign-client';
import { GuestSavedMarksRepository, SignUserProfileRepository, type SessionContext } from '@aramo/sign';

// Aramo-Sign-Field-Test-Batch-1 §2 SIG-3, as amended by A1 — the server decides who gets the
// signer's own profile values on the signing page (the page stays session-free).
//
//   - Only a signed-in session (SELF or INBOX: the M-A15 binding `signed_in`) gets
//     `profile_prefill`. An emailed link (`email_match`), a hosted session or a guest gets null
//     (D-2).
//   - The values come from the one shared rule (@aramo/sign-client profilePrefill): the user's
//     Sign profile, read under their OWN tenant (the saved-marks precedent), and the recipient
//     email the sender typed (D-5). The signer-name field is never among them (D-3).
//   - Read only: signing never writes back to the profile (A1-5).
//   - Never fails the view: a lookup error is logged and reads as nothing offered.

@Injectable()
export class SignerProfilePrefillService {
  private readonly logger = new Logger('SignerProfilePrefillService');

  constructor(
    private readonly bindings: GuestSavedMarksRepository,
    private readonly profiles: SignUserProfileRepository,
  ) {}

  /** The view's `profile_prefill`. Call only after the signer-view gates passed. */
  async prefillFor(ctx: SessionContext): Promise<ProfilePrefill | null> {
    try {
      const b = await this.bindings.bindingFor(ctx);
      if (b === null || b.kind !== 'signed_in') return null;
      const profile = await this.profiles.getProfile(b.tenant_id, b.user_id);
      const email = await this.bindings.recipientEmail(ctx);
      return profilePrefill(profile, email);
    } catch (e) {
      this.logger.warn(`profile prefill lookup failed: ${(e as Error).name}`);
      return null;
    }
  }
}
