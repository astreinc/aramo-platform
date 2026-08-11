import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type {
  DeliveryInput,
  DeliveryProvider,
  DeliveryResult,
} from './delivery-provider.interface.js';

// M5 PR-6 §4.3 — SendStubDeliveryProvider (Ruling 3 Q7-Stub).
// In-process no-op adapter: returns a synthetic delivery_id + delivered_at
// without performing any network I/O. NO SES / SendGrid calls. Real
// adapters land at a future PR.
//
// The stub never fails. AramoError pass-through in the controller (per
// directive §4.1 step 7) handles the future case where a real adapter
// surfaces transport / auth / rate-limit failures.

@Injectable()
export class SendStubDeliveryProvider implements DeliveryProvider {
  async deliver(input: DeliveryInput): Promise<DeliveryResult> {
    void input;
    return {
      delivered: true,
      delivered_at: new Date(),
      delivery_id: randomUUID(),
      delivery_channel: 'email',
    };
  }
}
