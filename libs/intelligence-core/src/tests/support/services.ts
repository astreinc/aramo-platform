import {
  ContradictionResolutionService,
  DisputeService,
  GovIdTokenizer,
  IdentityMergeSplitService,
  IdentityResolutionService,
  IntelligenceOutboxDrainService,
  ProfileReadService,
  ProjectionService,
  ProposalService,
  TalentIngestService,
  VerificationCodeService,
  VerificationService,
  VerificationStatusService,
  type VerificationDeliveryPort,
  type VerificationDeliveryResult,
  type VerificationMessage,
  type WebhookTransport,
} from '../../index.js';

import { InMemoryIntelligence } from './in-memory-intelligence.js';

// Wires the TI services over the in-memory unit of work (unit specs).

export const ATS = { client_id: 'ats-client', source_system_id: 'ARAMO_ATS' };
export const CODE_KEY = 'c'.repeat(32);

export class RecordingDelivery implements VerificationDeliveryPort {
  sent: VerificationMessage[] = [];
  next: VerificationDeliveryResult = { status: 'SENT' };
  isAvailable(channel: string): boolean {
    return channel === 'EMAIL';
  }
  async deliver(m: VerificationMessage): Promise<VerificationDeliveryResult> {
    if (!this.isAvailable(m.channel)) return { status: 'NOT_AVAILABLE' };
    this.sent.push(m);
    return this.next;
  }
}

export class RecordingTransport implements WebhookTransport {
  posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  status = 204;
  fail: Error | null = null;
  async post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number }> {
    if (this.fail) throw this.fail;
    this.posts.push({ url, headers, body });
    return { status: this.status };
  }
}

export function services(mem = new InMemoryIntelligence()) {
  const projection = new ProjectionService(mem);
  const mergeSplit = new IdentityMergeSplitService(mem, projection);
  const ingest = new TalentIngestService(mem, new IdentityResolutionService(), GovIdTokenizer.withKey('g'.repeat(32)), projection);
  const codes = VerificationCodeService.withKey(CODE_KEY);
  const delivery = new RecordingDelivery();
  const verification = new VerificationService(mem, codes, delivery, mergeSplit, projection);
  const reads = new ProfileReadService(mem);
  const transport = new RecordingTransport();
  const drain = new IntelligenceOutboxDrainService(mem, delivery, codes, transport);
  const disputes = new DisputeService(mem, projection);
  const proposals = new ProposalService(mem);
  const contradictions = new ContradictionResolutionService(mem, projection);
  const verificationStatus = new VerificationStatusService(mem);
  return {
    mem,
    projection,
    mergeSplit,
    ingest,
    codes,
    delivery,
    verification,
    reads,
    transport,
    drain,
    disputes,
    proposals,
    contradictions,
    verificationStatus,
  };
}

/** The current code of a verification request (what the delivery port would send). */
export function codeOf(mem: InMemoryIntelligence, codes: VerificationCodeService, id: string): string {
  const row = mem.state.verifications.get(id);
  if (!row) throw new Error(`no verification ${id}`);
  return codes.codeFor(row.id, row.code_salt);
}

export function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}
