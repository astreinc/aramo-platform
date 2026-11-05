import { Injectable, Logger, Optional } from '@nestjs/common';
import { SignContactRepository, SignSavedSignatureRepository, SignUserProfileRepository } from '@aramo/sign';

// Aramo Sign Mobile (M-A3 §9) — account close deletes this user's saved signatures
// and private contacts in the closing tenant (user-deletable convenience data).
// Signing evidence is untouched: executed field values were copied into the
// signing record at fill time. Idempotent (a second close deletes nothing) and
// audited with counts only.
@Injectable()
export class SavedDataPurgeService {
  private readonly log = new Logger(SavedDataPurgeService.name);

  constructor(
    private readonly signatures: SignSavedSignatureRepository,
    private readonly contacts: SignContactRepository,
    // Aramo Sign Mobile M-A12 W1-E — the Sign profile, settings, app-issue metadata and
    // template favorites are in the M-A8 deletion scope.
    @Optional() private readonly userData?: SignUserProfileRepository,
  ) {}

  async purgeForAccountClose(input: { tenant_id: string; user_id: string }): Promise<{ saved_signatures: number; contacts: number }> {
    const saved_signatures = await this.signatures.removeAllForUser(input.tenant_id, input.user_id);
    const contacts = await this.contacts.removeAllForUser(input.tenant_id, input.user_id);
    const own = await this.userData?.removeAllForUser(input.tenant_id, input.user_id);
    const profile = own === undefined ? '' : ` profiles=${own.profiles} settings=${own.settings} app_issue_reports=${own.app_issue_reports} template_favorites=${own.template_favorites}`;
    this.log.log(`account-close purge tenant=${input.tenant_id} user=${input.user_id} saved_signatures=${saved_signatures} contacts=${contacts}${profile}`);
    return { saved_signatures, contacts };
  }
}
