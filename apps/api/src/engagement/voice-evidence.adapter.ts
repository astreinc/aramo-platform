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
    // Email has a domain channel + association substrate but NO producer yet (R7/§7).
    const email: EngagementEvidenceFact = { channel: 'email', availability: 'no_producer' };
    return [voice, email];
  }

  private async readVoice(
    tenantId: string,
    talentId: string,
    requisitionId: string,
  ): Promise<EngagementEvidenceFact> {
    try {
      const rows = await this.comms.findVoiceEvidenceInteractions(tenantId, talentId, requisitionId);
      const providerTwoWay = rows.some((r) => r.status === 'connected' || r.status === 'completed');
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
