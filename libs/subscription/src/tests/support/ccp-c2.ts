import { BillingCommandService } from '../../lib/billing/billing-command.service.js';
import { BillingWebhookInboxService } from '../../lib/billing/billing-webhook-inbox.service.js';
import { SubscriptionLifecycleService } from '../../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../../lib/capacity.service.js';
import { CommercialAuditRepository } from '../../lib/commercial/commercial-audit.repository.js';
import { CommercialConversionLedger } from '../../lib/commercial/commercial-conversion.ledger.js';
import { CommercialConversionService } from '../../lib/commercial/commercial-conversion.service.js';
import { CommercialOperatorRepository } from '../../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyRepository } from '../../lib/commercial/commercial-policy.repository.js';
import type { PrismaService } from '../../lib/prisma/prisma.service.js';

import { type C1Harness, c1Harness } from './ccp-c1.js';

// CCP-C2 — ONE shared harness for the C2 specs (CLAUDE.md: one shared test helper): the C1 harness
// (change requests, A6 apply, the fake Stripe with the command port and its no-transaction probe)
// with the lifecycle, command service and inbox re-wired to the conversion ledger, as
// SubscriptionModule binds them, plus the conversion apply service. All on one Prisma client; no
// network, no key.

export interface C2Harness extends C1Harness {
  ledger: CommercialConversionLedger;
  conversions: CommercialConversionService;
}

export function c2Harness(prisma: PrismaService, now: () => Date): C2Harness {
  const base = c1Harness(prisma, now);
  const audit = new CommercialAuditRepository(prisma);
  const policies = new CommercialPolicyRepository(prisma);
  const operators = new CommercialOperatorRepository(prisma, audit, policies);
  const ledger = new CommercialConversionLedger(audit);
  const lifecycle = new SubscriptionLifecycleService(prisma, base.allowance, base.billing, new CapacityService(prisma), undefined, undefined, base.orgProfile, base.billing, ledger);
  const commands = new BillingCommandService(prisma, base.billing, lifecycle, base.billing);
  const inbox = new BillingWebhookInboxService(prisma, base.billing, lifecycle);
  const conversions = new CommercialConversionService(prisma, audit, operators, base.changeRequests, ledger, commands, lifecycle, now);
  return { ...base, lifecycle, commands, inbox, ledger, conversions };
}
