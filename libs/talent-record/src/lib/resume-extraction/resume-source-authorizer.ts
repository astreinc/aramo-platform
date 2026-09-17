import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { parseResumeObjectKey, RESUME_KEY_DOCUMENT_TYPE } from '@aramo/object-storage';

import {
  RESUME_ATTACHMENT_RESOLVER,
  type AuthorizedExtractionContext,
  type ResumeAttachmentResolver,
  type ResumeExtractionSource,
} from './resume-source.types.js';

// TALENT-INTEL-1 (TI-1B, ruling 15 FIX_NOW) — the SINGLE authorization seam for
// résumé bytes. Every path that reads a résumé object (governed-LLM AND the
// deterministic parser; CREATE AND EDIT) resolves its storage_key through here
// FIRST. The extraction core never decides authorization from an arbitrary key.
@Injectable()
export class ResumeSourceAuthorizer {
  constructor(
    // The ATTACHMENT (EDIT/re-extraction) resolver is dependency-inverted: its
    // concrete impl lives in `libs/attachment` (attachment→talent-record edge
    // already exists; the reverse would cycle) and is bound at the composition
    // layer that owns the EDIT consumer. OPTIONAL so the CREATE path (the only
    // live consumer today) boots without it; an ATTACHMENT request with no
    // bound resolver fails loudly rather than silently reading bytes.
    @Optional()
    @Inject(RESUME_ATTACHMENT_RESOLVER)
    private readonly attachmentResolver?: ResumeAttachmentResolver,
  ) {}

  /**
   * Resolve an AUTHORIZED source form to its storage_key. Authorization always
   * precedes the returned key; a raw/foreign/malformed reference is rejected
   * here, before any object-storage access.
   */
  async authorize(
    source: ResumeExtractionSource,
    ctx: AuthorizedExtractionContext,
  ): Promise<{ storage_key: string }> {
    if (source.kind === 'CREATE_DRAFT_UPLOAD') {
      return this.authorizeCreateDraftUpload(source.storage_key, ctx);
    }
    return this.authorizeAttachment(source.attachment_id, source.talent_id, ctx);
  }

  /**
   * CREATE fresh-upload authorization (Option A — deterministic, not mere
   * string-prefix trust). Establishes that the key:
   *   - matches the A8-3a résumé convention (5-segment parse succeeds), and
   *   - is inside the approved résumé-upload namespace (document_type=resume),
   *     with a structurally valid draft partition UUID, and
   *   - sits under the AUTHENTICATED tenant's prefix (closes cross-tenant read).
   *
   * Honest boundary (per the PO): what this proves is EXACTLY "an Aramo-
   * convention-compliant résumé key inside the authenticated tenant's
   * namespace" — NOT that this precise upload was issued to this caller. With no
   * persisted draft_partition_id↔caller link in today's substrate, NO per-caller
   * cryptographic binding is asserted.
   * SITE: résumé objects are tenant-scoped by design (A8-3a — no site segment in
   * the key); the route's @RequireSiteMatch() is inert (no site_id param/query),
   * matching the established stored-attachment download path. Site isolation of
   * the object itself is not part of the current model.
   */
  authorizeCreateDraftUpload(
    storage_key: string,
    ctx: AuthorizedExtractionContext,
  ): { storage_key: string } {
    const parsed = parseResumeObjectKey(storage_key);
    if (parsed === null) {
      // Not an Aramo-issued A8-3a résumé key (malformed / non-Aramo / wrong
      // shape). Refuse before any object access.
      throw this.unauthorized(ctx.requestId, 'not_aramo_resume_key');
    }
    if (parsed.document_type !== RESUME_KEY_DOCUMENT_TYPE) {
      // Aramo key, but OUTSIDE the résumé-upload namespace.
      throw this.unauthorized(ctx.requestId, 'not_resume_namespace');
    }
    if (parsed.tenant_id !== ctx.tenant_id) {
      // Cross-tenant key — the exact hole ruling 15 closes.
      throw this.unauthorized(ctx.requestId, 'tenant_mismatch');
    }
    return { storage_key };
  }

  /**
   * EDIT/re-extraction authorization: resolve an owned attachment_id via the
   * tenant-scoped attachment repository, verifying owner_type=talent +
   * owner_id=talent_id + is_resume, yielding the storage_key internally.
   */
  private async authorizeAttachment(
    attachment_id: string,
    talent_id: string,
    ctx: AuthorizedExtractionContext,
  ): Promise<{ storage_key: string }> {
    if (this.attachmentResolver === undefined) {
      // The ATTACHMENT path was invoked without a bound resolver — an internal
      // wiring misconfiguration, never a client condition. Fail loudly (never
      // fall back to trusting a raw key).
      throw new AramoError(
        'INTERNAL_ERROR',
        'résumé attachment resolution is not available in this context',
        500,
        { requestId: ctx.requestId, details: { reason: 'resume_attachment_resolver_unwired' } },
      );
    }
    return this.attachmentResolver.resolveOwnedResumeStorageKey({
      attachment_id,
      talent_id,
      tenant_id: ctx.tenant_id,
      requestId: ctx.requestId,
    });
  }

  private unauthorized(requestId: string, reason: string): AramoError {
    return new AramoError(
      'RESUME_SOURCE_UNAUTHORIZED',
      'résumé source is not authorized for this request',
      403,
      { requestId, details: { reason } },
    );
  }
}
