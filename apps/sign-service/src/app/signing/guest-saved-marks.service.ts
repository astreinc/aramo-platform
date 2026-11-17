import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  GuestSavedMarksRepository,
  SignSavedSignatureRepository,
  SignUserProfileRepository,
  type SavedSignatureRow,
  type SavedSignatureSlot,
  type SessionContext,
} from '@aramo/sign';

import { validateSavedSignature } from '../me/signature/saved-signature.service.js';

// Aramo-Sign-Mobile-Amendment-M-A15-Guest-Saved-Signature-v1_0 §4 — the saved signature
// on the web signing page, decided by the server from the signing session alone (the
// guest page stays session-free, S-2 §4.1.3).

export interface GuestSavedMarkView {
  kind: 'TYPED' | 'DRAWN';
  typed_name: string | null;
  image_data_url: string;
}

export interface GuestSavedMarks {
  signature: GuestSavedMarkView | null;
  initials: GuestSavedMarkView | null;
  // §4.1 — true only for a signed-in (INBOX / SELF) session (§3.1).
  can_save: boolean;
}

function markView(r: SavedSignatureRow | undefined): GuestSavedMarkView | null {
  return r === undefined ? null : { kind: r.kind, typed_name: r.typed_name, image_data_url: r.image_data_url };
}

export function savedMarkNotAllowed(requestId: string): AramoError {
  return new AramoError('INSUFFICIENT_PERMISSIONS', 'Saving a default signature isn’t available on this signing link', 403, {
    requestId,
    details: { reason: 'saved_mark_not_allowed' },
  });
}

@Injectable()
export class GuestSavedMarksService {
  private readonly logger = new Logger('GuestSavedMarksService');

  constructor(
    private readonly bindings: GuestSavedMarksRepository,
    private readonly saved: SignSavedSignatureRepository,
    private readonly settings: SignUserProfileRepository,
  ) {}

  /**
   * §4.1 — the view's `saved_marks`. Call only after the signer-view gates passed.
   * Never fails the view: a lookup error is logged and reads as nothing offered.
   */
  async viewFor(ctx: SessionContext): Promise<GuestSavedMarks | null> {
    try {
      const b = await this.bindings.bindingFor(ctx);
      if (b === null) return null;
      // §3.3 — the user's opt-out applies to emailed links (§3.2) only.
      if (b.kind === 'email_match' && !(await this.settings.offersSavedSignatureOnLinks(b.tenant_id, b.user_id))) return null;
      const rows = await this.saved.list(b.tenant_id, b.user_id);
      const signature = markView(rows.find((r) => r.slot === 'signature'));
      const initials = markView(rows.find((r) => r.slot === 'initials'));
      const can_save = b.kind === 'signed_in';
      // An emailed link with nothing saved has nothing to offer.
      if (!can_save && signature === null && initials === null) return null;
      return { signature, initials, can_save };
    } catch (e) {
      this.logger.warn(`saved marks lookup failed: ${(e as Error).name}`);
      return null;
    }
  }

  /** M-A16 §3 — offer "Save to my Aramo inbox" (emailed-link sessions only). Never fails the view. */
  async inboxSaveAvailable(ctx: SessionContext): Promise<boolean> {
    try {
      return await this.bindings.inboxSaveAvailable(ctx);
    } catch (e) {
      this.logger.warn(`inbox save lookup failed: ${(e as Error).name}`);
      return false;
    }
  }

  /** §4.2 — save as my default, from a signed-in (INBOX / SELF) session only. */
  async save(ctx: SessionContext, body: unknown, requestId: string): Promise<GuestSavedMarkView> {
    const o = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const slot = o?.['slot'];
    if (slot !== 'signature' && slot !== 'initials') {
      throw new AramoError('VALIDATION_ERROR', 'slot must be signature or initials', 400, { requestId, details: { reason: 'invalid_slot', field: 'slot' } });
    }
    const b = await this.bindings.bindingFor(ctx);
    if (b === null || b.kind !== 'signed_in') throw savedMarkNotAllowed(requestId);
    // The mark itself: everything but the routing keys (slot, token).
    const mark = Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => k !== 'slot' && k !== 'token'));
    const value = validateSavedSignature(mark, requestId);
    await this.saved.put(b.tenant_id, b.user_id, slot as SavedSignatureSlot, value);
    return { kind: value.kind, typed_name: value.typed_name, image_data_url: value.image_data_url };
  }
}
