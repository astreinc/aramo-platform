import { Module } from '@nestjs/common';
import { CommunicationsModule } from '@aramo/communications';
import { EngagementPolicyService, ENGAGEMENT_POLICY_GATEWAY } from '@aramo/engagement';
import { PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import {
  EngagementPolicyGatewayAdapter,
  ENGAGEMENT_POLICY_DB,
} from './engagement-policy-gateway.adapter.js';
import { VoiceEvidenceReaderAdapter, VOICE_EVIDENCE_READER } from './voice-evidence.adapter.js';
import { EngagementGateService } from './engagement-gate.service.js';

// COMM-C3 — the composition root for the Engagement gate + policy admin (directive
// R3/R12/R13). Binds the raw-SQL StoredPolicyVersion gateway (over the policy-store
// connection), the pure EngagementPolicyService, the provider-neutral voice-evidence
// reader (over the Communications repository), and the EngagementGateService the
// SubmitTalent orchestrator + admin API consume. NO libs/engagement → communications
// or → pipeline edge exists — all cross-domain I/O is composed here.
@Module({
  imports: [CommunicationsModule],
  providers: [
    PolicyStorePrismaService,
    { provide: ENGAGEMENT_POLICY_DB, useExisting: PolicyStorePrismaService },
    EngagementPolicyGatewayAdapter,
    { provide: ENGAGEMENT_POLICY_GATEWAY, useExisting: EngagementPolicyGatewayAdapter },
    EngagementPolicyService,
    VoiceEvidenceReaderAdapter,
    { provide: VOICE_EVIDENCE_READER, useExisting: VoiceEvidenceReaderAdapter },
    EngagementGateService,
  ],
  exports: [EngagementGateService, EngagementPolicyService],
})
export class EngagementGateModule {}
