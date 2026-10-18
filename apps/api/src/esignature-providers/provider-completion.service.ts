import { Inject, Injectable } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { DocumentExecutedWriteBackService } from '@aramo/documents';
import { SignatureRoutingRepository } from '@aramo/signature-routing';

import type { ExternalProviderKey, ExternalSignatureAdapter } from './external-signature-adapter.js';
import { ProviderCredentialStore } from './provider-credential-store.js';

// Multi-Provider directive §F — external completions converge into the established
// Documents write-back (Document -> EXECUTED; the RTR gate reads only that). A
// provider callback is a HINT, never the authority:
//   1. the envelope must map to a request this platform routed to that provider;
//   2. the callback's provider account must be the account that tenant connected;
//   3. completion is confirmed by reading the envelope from the provider API.
// Idempotent per provider envelope (duplicate callbacks write nothing new).

export const EXTERNAL_SIGNATURE_ADAPTERS = 'EXTERNAL_SIGNATURE_ADAPTERS';
export type CompletionOutcome = 'PROCESSED' | 'IGNORED';

const logger = createAramoLogger('ProviderCompletionService');

@Injectable()
export class ProviderCompletionService {
  constructor(
    private readonly routing: SignatureRoutingRepository,
    private readonly credentials: ProviderCredentialStore,
    private readonly writeBack: DocumentExecutedWriteBackService,
    @Inject(EXTERNAL_SIGNATURE_ADAPTERS) private readonly adapters: readonly ExternalSignatureAdapter[],
  ) {}

  /**
   * @param provider_account_id the account the callback names, when the provider signs it
   *   (DocuSign); null when it does not (Adobe) — then the binding is the route plus the
   *   read with that tenant's own token.
   */
  async handle(input: { provider: ExternalProviderKey; provider_account_id: string | null; envelope_ref: string; requestId: string }): Promise<CompletionOutcome> {
    const route = await this.routing.findRouteByEnvelope(input.provider, input.envelope_ref);
    if (route === null) return 'IGNORED';
    if (input.provider_account_id !== null && !(await this.credentials.accountMatches(route.tenant_id, input.provider, input.provider_account_id))) {
      logger.warn({ event: 'esignature.callback_account_mismatch', provider: input.provider, tenant_id: route.tenant_id });
      return 'IGNORED';
    }
    const adapter = this.adapters.find((a) => a.provider === input.provider);
    if (adapter === undefined) return 'IGNORED';
    const completion = await adapter.fetchCompletion(route.tenant_id, input.envelope_ref);
    if (completion === null) return 'IGNORED';
    await this.writeBack.storeProviderExecuted({
      tenant_id: route.tenant_id,
      document_id: route.document_id,
      revision_id: route.document_revision_id,
      executed_bytes: completion.executed_pdf,
      evidence_bytes: completion.evidence_pdf,
      provider: input.provider,
      provider_envelope_ref: input.envelope_ref,
      evidence_kind: completion.evidence_kind,
      actor_id: route.tenant_id, // system actor for the service-driven write-back
      requestId: input.requestId,
      idempotency_key: `${input.provider}-writeback:${input.envelope_ref}`,
    });
    logger.log({ event: 'esignature.provider_completion_stored', provider: input.provider, tenant_id: route.tenant_id, document_id: route.document_id });
    return 'PROCESSED';
  }
}
