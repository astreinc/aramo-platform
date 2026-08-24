import { Injectable } from '@nestjs/common';
import { ConsentRepository } from '@aramo/consent';
import type { PipelineView } from '@aramo/pipeline';
import { TalentRecordRepository } from '@aramo/talent-record';

// Requisition-expander read-composer (LOCKED Aramo-Requisition-Expander-Talent-
// Rate-Columns v1.0). Lives in apps/api — the only layer allowed to know both
// libs/talent-record and libs/consent; libs/pipeline stays single-schema and
// never reads talent PII.
//
// HARD CONSTRAINT — BATCH, never loop: two set-based reads over the page's
// distinct talent-id set run concurrently; never a per-row fetch (no N+1).
//
// R-LAYERING (directive invariant) — TWO distinct gates, applied in order:
//   1. AUTHORIZATION (`talent:read`) decides whether the five enrichment fields
//      may EXIST at all. Absent ⇒ all five null, no reads issued.
//   2. CONSENT (`do_not_contact`) decides whether the CONTACT CHANNELS (email,
//      phone) may be disclosed. It suppresses ONLY email+phone — never
//      location / work_auth / desired_rate. Suppression is applied BEFORE the
//      channel is ever attached to the returned row.
@Injectable()
export class PipelineTalentEnrichmentService {
  constructor(
    private readonly talent: TalentRecordRepository,
    private readonly consent: ConsentRepository,
  ) {}

  async enrich(
    items: readonly PipelineView[],
    ctx: { tenant_id: string; canReadTalent: boolean },
  ): Promise<PipelineView[]> {
    if (items.length === 0) return [...items];

    // Gate 1 — AUTHZ gates existence. No talent:read ⇒ the fields do not exist;
    // issue NO PII read at all (defence in depth: nothing to leak).
    if (!ctx.canReadTalent) {
      return items.map((i) => ({
        ...i,
        email: null,
        phone: null,
        location: null,
        work_auth: null,
        desired_rate: null,
      }));
    }

    const ids = [...new Set(items.map((i) => i.talent_record_id))];
    const [contacts, consent] = await Promise.all([
      this.talent.findContactByIds(ctx.tenant_id, ids),
      this.consent.findContactingConsentSummaryForTalentIds({
        tenant_id: ctx.tenant_id,
        talent_record_ids: ids,
      }),
    ]);

    return items.map((i) => {
      const c = contacts.get(i.talent_record_id);
      if (c === undefined) {
        // Superseded / cross-tenant / missing live record ⇒ no enrichment.
        return {
          ...i,
          email: null,
          phone: null,
          location: null,
          work_auth: null,
          desired_rate: null,
        };
      }
      // Gate 2 — CONSENT gates contact-channel disclosure. Default-deny: no
      // positive contacting grant ⇒ do_not_contact ⇒ suppress email+phone.
      const suppressContact =
        (consent.get(i.talent_record_id) ?? 'do_not_contact') ===
        'do_not_contact';
      const location =
        [c.city, c.state].filter((p) => p != null && p !== '').join(', ') ||
        null;
      return {
        ...i,
        // Contact channels — suppressed BEFORE attach when do_not_contact.
        email: suppressContact ? null : c.email,
        phone: suppressContact ? null : c.phone,
        // Non-contact attributes — talent:read only; NEVER consent-suppressed.
        location,
        work_auth: c.work_authorization,
        desired_rate: c.desired_pay,
      };
    });
  }
}
