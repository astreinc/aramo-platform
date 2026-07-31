import { v7 as uuidv7 } from 'uuid';

import type { PolicyDecisionInputs } from './decision-inputs.js';

// insertPolicyDecisionRecordInTx — the cross-schema, in-transaction write for
// §D17a decision provenance. Mirrors @aramo/activity insertActivityInTx: it
// returns the $executeRaw promise the CALLER composes into its own
// $transaction, so the PolicyDecisionRecord row commits IFF the caller's
// mutation commits (atomicity — §D10 fail-closed). Because the program uses
// ONE Postgres database for all schemas, the raw INSERT into
// policy_store."PolicyDecisionRecord" runs in the caller's PG transaction on
// the caller's own Prisma client — no second connection, no cross-client
// coordination.
//
// It is a raw helper (not a PolicyDecisionRecordStore method) for the same
// reason activity uses one: the write must land on the CALLER's Prisma client
// (the pipeline PrismaService), not on policy-store's own client, so it can
// share the mutation transaction. The append-only PolicyDecisionRecordStore
// remains the API for standalone reads/writes elsewhere.

export interface InsertPolicyDecisionRecordInput {
  readonly tenant_id: string;
  readonly decision: string;
  readonly policy_version: string;
  readonly rule_id: string;
  readonly reason_code: string;
  readonly resource: string;
  readonly action: string;
  readonly inputs: PolicyDecisionInputs;
  readonly actor_id: string;
  readonly origin: string;
  readonly correlation_id: string;
}

interface PrismaRawCapable {
  $executeRaw: (template: TemplateStringsArray, ...values: unknown[]) => unknown;
}

export function insertPolicyDecisionRecordInTx<T extends PrismaRawCapable>(
  prisma: T,
  input: InsertPolicyDecisionRecordInput,
): ReturnType<T['$executeRaw']> {
  const id = uuidv7();
  const inputsJson = JSON.stringify(input.inputs);
  return prisma.$executeRaw`
    INSERT INTO policy_store."PolicyDecisionRecord" (
      id, tenant_id, decision, policy_version, rule_id, reason_code,
      resource, action, inputs, actor_id, origin, correlation_id, occurred_at
    ) VALUES (
      ${id}::uuid,
      ${input.tenant_id}::uuid,
      ${input.decision},
      ${input.policy_version},
      ${input.rule_id},
      ${input.reason_code},
      ${input.resource},
      ${input.action},
      ${inputsJson}::jsonb,
      ${input.actor_id},
      ${input.origin},
      ${input.correlation_id},
      NOW()
    )
  ` as ReturnType<T['$executeRaw']>;
}
