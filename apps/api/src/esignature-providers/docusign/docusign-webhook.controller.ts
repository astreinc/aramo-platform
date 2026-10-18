import { randomUUID } from 'node:crypto';

import { Controller, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import type { Request, Response } from 'express';

import { ProviderCompletionService } from '../provider-completion.service.js';

import { parseDocuSignEvent, verifyDocuSignHmac } from './docusign-connect.js';
import { DOCUSIGN_CONFIG } from './docusign.tokens.js';
import type { DocuSignConfig } from './docusign.config.js';

// Multi-Provider directive §G — DocuSign Connect inbound webhook
// (POST /v1/webhooks/esignature/docusign). DELIBERATELY UN-GUARDED like the Zoom and
// Indeed webhooks: DocuSign calls with no Aramo session. The SOLE authority is the
// Connect HMAC over the raw body; the tenant is resolved only afterwards, and the
// completion is confirmed against the DocuSign API (ProviderCompletionService).
// Bare statuses (external machine ingress, not the Aramo client error contract):
//   503 — DocuSign not configured in this environment (dark by construction)
//   401 — missing or invalid HMAC
//   400 — malformed body after a valid HMAC
//   204 — accepted (processed, duplicate, not completed, unknown or foreign envelope:
//         uniform, so no existence oracle)
//   500 — transient failure while storing; DocuSign retries
const logger = createAramoLogger('DocuSignWebhookController');

@Controller('v1/webhooks/esignature')
export class DocuSignWebhookController {
  constructor(
    private readonly completion: ProviderCompletionService,
    @Optional() @Inject(DOCUSIGN_CONFIG) private readonly config: DocuSignConfig | null,
  ) {}

  @Post('docusign')
  async docusign(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (this.config === null || this.config === undefined) {
      res.status(503);
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyDocuSignHmac(raw, req.headers, this.config.connectHmacKey)) {
      res.status(401);
      return;
    }
    const event = parseDocuSignEvent(raw);
    if (event === null) {
      res.status(400);
      return;
    }
    if (event.event !== 'envelope-completed') {
      res.status(204);
      return;
    }
    try {
      await this.completion.handle({ provider: 'docusign', provider_account_id: event.account_id, envelope_ref: event.envelope_id, requestId: randomUUID() });
      res.status(204);
    } catch (err) {
      logger.warn({ event: 'esignature.docusign_completion_failed', message: (err as Error).message });
      res.status(500);
    }
  }
}
