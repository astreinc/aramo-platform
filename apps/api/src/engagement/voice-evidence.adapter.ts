import { Injectable } from '@nestjs/common';
import { CommunicationsRepository } from '@aramo/communications';
import type { EngagementEvidenceFact } from '@aramo/engagement';

// COMM-C3 — the apps/api evidence-gathering adapter (directive R13/R14). It reads
// Communications' OWN provider-neutral rows and derives the neutral facts the
// engagement evaluator consumes — attempted / two-way / evidence-strength — for
// the required channels. It NEVER surfaces a provider key/id and never leaves the
// composition root. A read failure is reported as `read_error` (fail-closed, R9),
// never coerced into "no evidence".

/** DI token for the voice-evidence reader used by the engagement gate. */
export const VOICE_EVIDENCE_READER = 'VoiceEvidenceReader';

export interface VoiceEvidenceReader {
  readFacts(
    tenantId: string,
    talentId: string,
    requisitionId: string,
  ): Promise<EngagementEvidenceFact[]>;
}

// R4-locked recruiter-attested two-way dispositions (mirrors the C2A projection;
// this set is directive-locked, so it is stable across the two read sites).
const QUALIFYING_TWO_WAY_DISPOSITIONS: ReadonlySet<string> = new Set([
  'connected',
  'interested',
  'callback_requested',
  'follow_up_required',
]);

@Injectable()
export class VoiceEvidenceReaderAdapter implements VoiceEvidenceReader {
  constructor(private readonly comms: CommunicationsRepository) {}

  async readFacts(
    tenantId: string,
    talentId: string,
    requisitionId: string,
  ): Promise<EngagementEvidenceFact[]> {
    const voice = await this.readVoice(tenantId, talentId, requisitionId);
    const email = await this.readEmail(tenantId, talentId, requisitionId);
    return [voice, email];
  }

  // COMM-C2B — provider-neutral email evidence: a Graph-accepted outbound send is
  // persisted as a channel=email CommunicationInteraction with terminal status
  // `completed`. `recorded_evidence` reflects ONLY that such an accepted send is
  // on record — never a response/contact signal ("email sent" ≠ "Talent
  // responded"). Fail-closed on a read error (R9). Zero provider/identity fields.
  private async readEmail(
    tenantId: string,
    talentId: string,
    requisitionId: string,
  ): Promise<EngagementEvidenceFact> {
    try {
      const rows = await this.comms.findChannelEvidenceInteractions(
        tenantId,
        talentId,
        requisitionId,
        'email',
      );
      return {
        channel: 'email',
        availability: 'available',
        // §16 ruling pt 5 — a provider-accepted send is provider provenance: require
        // evidence_authority=provider_verified, not status alone. Existing completed
        // sends default provider_verified (§19 unchanged); an attested inbound email
        // response (status `recorded`, recruiter_attested) is NOT a provider send.
        recorded_evidence: rows.some(
          (r) => r.status === 'completed' && r.evidence_authority === 'provider_verified',
        ),
      };
    } catch {
      return { channel: 'email', availability: 'read_error' };
    }
  }

  private async readVoice(
    tenantId: string,
    talentId: string,
    requisitionId: string,
  ): Promise<EngagementEvidenceFact> {
    try {
      const rows = await this.comms.findVoiceEvidenceInteractions(tenantId, talentId, requisitionId);
      // Recruiting-Journey §16 (I3), ruling pt 5 — PROVIDER_VERIFIED requires provider
      // PROVENANCE, not just a two-way call-status. `connected`/`completed` alone can
      // NEVER imply provider verification: the row must also carry
      // evidence_authority=provider_verified. Existing rows default provider_verified,
      // so provider-backed grading is unchanged (§19); a recruiter-attested callback
      // (recruiter_attested) can never be promoted to provider-verified.
      const providerTwoWay = rows.some(
        (r) =>
          r.evidence_authority === 'provider_verified' &&
          (r.status === 'connected' || r.status === 'completed'),
      );
      const recruiterTwoWay = rows.some((r) =>
        r.dispositions.some((d) => QUALIFYING_TWO_WAY_DISPOSITIONS.has(d.disposition)),
      );
      return {
        channel: 'voice',
        availability: 'available',
        two_way_conversation: providerTwoWay || recruiterTwoWay,
        evidence_strength: providerTwoWay
          ? 'PROVIDER_VERIFIED'
          : recruiterTwoWay
            ? 'RECRUITER_ATTESTED'
            : null,
      };
    } catch {
      // Fail-closed (R9): the evidence read failed → unavailable, NOT "no evidence".
      return { channel: 'voice', availability: 'read_error' };
    }
  }
}
