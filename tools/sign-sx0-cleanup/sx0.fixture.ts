// SX-0 spec fixture: raw SQL inserts against the real sign schema (every migration
// applied), so the tool is proven against the true FKs, CHECKs and triggers.

import { randomUUID } from 'node:crypto';

import type { Queryable } from './sx0.lib.js';

const H = (c: string): string => c.repeat(64);

export interface FixtureEnvelope {
  id: string;
  tenant_id: string;
  status: string;
  ats: boolean;
  docIds: string[];
  signerIds: string[];
  keys: string[];
  executedIds: string[];
  notificationIds: string[];
}

export interface IntegrationRefs {
  applicationId: string;
  installationId: string;
  credentialId: string;
  subscriptionId: string;
}

export async function seedIntegration(db: Queryable, tenant: string): Promise<IntegrationRefs> {
  const applicationId = randomUUID();
  const installationId = randomUUID();
  const credentialId = randomUUID();
  const subscriptionId = randomUUID();
  await db.query(`INSERT INTO "sign"."SignApplication" (id, key, name, kind) VALUES ($1, $2, 'App', 'THIRD_PARTY')`, [applicationId, `app-${applicationId.slice(0, 8)}`]);
  await db.query(`INSERT INTO "sign"."SignInstallation" (id, tenant_id, application_id) VALUES ($1, $2, $3)`, [installationId, tenant, applicationId]);
  await db.query(`INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash) VALUES ($1, $2, $3, $4, $5)`, [credentialId, applicationId, installationId, `c-${credentialId}`, H('a')]);
  await db.query(
    `INSERT INTO "sign"."SignWebhookSubscription" (id, application_id, installation_id, tenant_id, target_url, secret_ciphertext) VALUES ($1, $2, $3, $4, 'https://hooks.test/x', 'ct')`,
    [subscriptionId, applicationId, installationId, tenant],
  );
  return { applicationId, installationId, credentialId, subscriptionId };
}

export async function seedUserLevel(db: Queryable, tenant: string, user: string): Promise<string> {
  await db.query(
    `INSERT INTO "sign"."SignSavedSignature" (id, tenant_id, user_id, slot, kind, typed_name, font_key, image_data_url) VALUES ($1, $2, $3, 'signature', 'TYPED', 'A User', 'caveat', 'data:image/png;base64,AA==')`,
    [randomUUID(), tenant, user],
  );
  await db.query(
    `INSERT INTO "sign"."SignContact" (id, tenant_id, owner_user_id, name, email, email_key) VALUES ($1, $2, $3, 'Contact', 'c@x.test', 'c@x.test')`,
    [randomUUID(), tenant, user],
  );
  await db.query(`INSERT INTO "sign"."SignNotificationPreference" (id, tenant_id, user_id) VALUES ($1, $2, $3)`, [randomUUID(), tenant, user]);
  const device = randomUUID();
  await db.query(
    `INSERT INTO "sign"."SignPushDevice" (id, tenant_id, user_id, device_session_id, platform, provider, app_version) VALUES ($1, $2, $3, $4, 'ios', 'apns', '1.0.0')`,
    [device, tenant, user, randomUUID()],
  );
  return device;
}

export interface EnvelopeSpec {
  tenant: string;
  user: string;
  status: 'DRAFT' | 'SENT' | 'COMPLETED' | 'VOIDED' | 'DECLINED';
  deletedDraft?: boolean;
  ats?: boolean;
  // ATS envelopes may also carry an OWNED document (its key must survive the S3 step).
  ownedDocument?: boolean;
  integration?: IntegrationRefs;
  pushDevice?: string;
  withEvents?: boolean;
}

export async function seedEnvelope(db: Queryable, s: EnvelopeSpec): Promise<FixtureEnvelope> {
  const id = randomUUID();
  const t = s.tenant;
  const execution_mode = 'SINGLE_SIGNATURE';
  const cols: Record<string, unknown> = { sent_at: null, completed_at: null, voided_at: null, declined_at: null };
  if (s.status !== 'DRAFT') cols['sent_at'] = new Date();
  if (s.status === 'COMPLETED') cols['completed_at'] = new Date();
  if (s.status === 'VOIDED') cols['voided_at'] = new Date();
  if (s.status === 'DECLINED') cols['declined_at'] = new Date();
  await db.query(
    `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, updated_at, sent_at, completed_at, voided_at, declined_at, source_application)
     VALUES ($1, $2, 'Agreement', $3, $4, $5, now(), $6, $7, $8, $9, $10)`,
    [id, t, s.status, execution_mode, s.user, cols['sent_at'], cols['completed_at'], cols['voided_at'], cols['declined_at'], s.ats === true ? 'aramo-ats' : 'aramo-sign'],
  );
  const env: FixtureEnvelope = { id, tenant_id: t, status: s.status, ats: s.ats === true, docIds: [], signerIds: [], keys: [], executedIds: [], notificationIds: [] };

  let prev: string | null = null;
  const event = async (event_type: string, signer: string | null = null): Promise<void> => {
    const h = randomUUID().replace(/-/g, '').padEnd(64, '0');
    await db.query(
      `INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, signer_id, event_type, actor_type, previous_event_hash, event_hash) VALUES ($1, $2, $3, $4, $5, 'SYSTEM', $6, $7)`,
      [randomUUID(), t, id, signer, event_type, prev, h],
    );
    prev = h;
  };
  if (s.withEvents !== false) await event('ENVELOPE_CREATED');

  if (s.deletedDraft === true) {
    // A deleted draft is a scrubbed tombstone: no documents, recipients or fields remain.
    await db.query(`UPDATE "sign"."SignatureEnvelope" SET deleted_at = now() WHERE id = $1`, [id]);
    return env;
  }

  const addDoc = async (mode: 'OWNED' | 'CORE_REF', ordinal: number): Promise<string> => {
    const docId = randomUUID();
    const key = mode === 'OWNED' ? `esign/source/${t}/${id}/${randomUUID()}` : null;
    await db.query(
      `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, source_mode, document_ref, document_revision_ref, source_object_key, content_type, byte_size, title, source_sha256, ordinal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Doc', $10, $11)`,
      [docId, t, id, mode, mode === 'CORE_REF' ? randomUUID() : null, mode === 'CORE_REF' ? randomUUID() : null, key, mode === 'OWNED' ? 'application/pdf' : null, mode === 'OWNED' ? 100 : null, H('b'), ordinal],
    );
    env.docIds.push(docId);
    if (key !== null) env.keys.push(key);
    await db.query(`INSERT INTO "sign"."SignEnvelopeDocumentPages" (envelope_document_id, tenant_id, pages) VALUES ($1, $2, '[{"w":612,"h":792}]')`, [docId, t]);
    return docId;
  };
  const docId = await addDoc(s.ats === true ? 'CORE_REF' : 'OWNED', 0);
  if (s.ats === true && s.ownedDocument === true) await addDoc('OWNED', 1);

  const signer = randomUUID();
  await db.query(
    `INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1, $2, $3, $4, 'Signer', 1, $5)`,
    [signer, t, id, `s.${id.slice(0, 8)}@x.test`, s.status === 'COMPLETED' ? 'SIGNED' : 'PENDING'],
  );
  env.signerIds.push(signer);
  await db.query(
    `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, signer_id, field_type, page_number, x, y, width, height) VALUES ($1, $2, $3, $4, 'SIGNATURE', 0, 10, 10, 40, 20)`,
    [randomUUID(), t, docId, signer],
  );
  // A draft is never sent: it has no sessions, deliveries or evidence.
  if (s.status === 'DRAFT') return env;

  await event('ENVELOPE_SENT');
  const session = randomUUID();
  await db.query(
    `INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at) VALUES ($1, $2, $3, $4, $5, 'ISSUED', now() + interval '1 day')`,
    [session, t, id, signer, randomUUID()],
  );
  await db.query(
    `INSERT INTO "sign"."SignerDisclosureAcceptance" (id, tenant_id, signer_id, disclosure_version, disclosure_text_hash, session_id) VALUES ($1, $2, $3, 'v1', $4, $5)`,
    [randomUUID(), t, signer, H('c'), session],
  );
  await db.query(
    `INSERT INTO "sign"."NotificationDelivery" (id, tenant_id, envelope_id, signer_id, notification_kind, status) VALUES ($1, $2, $3, $4, 'SIGNATURE_REQUEST', 'SENT')`,
    [randomUUID(), t, id, signer],
  );
  await db.query(
    `INSERT INTO "sign"."SignRecipientBinding" (id, envelope_tenant_id, envelope_id, signer_id, user_id, user_tenant_id, email) VALUES ($1, $2, $3, $4, $5, $2, 'r@x.test')`,
    [randomUUID(), t, id, signer, s.user],
  );
  await db.query(
    `INSERT INTO "sign"."AbuseReport" (id, tenant_id, envelope_id, signer_id, reporter_key, reporter_domain, severity, independence, credibility, weight) VALUES ($1, $2, $3, $4, $5, 'x.test', 1, 1, 1, 1)`,
    [randomUUID(), t, id, signer, H('d')],
  );
  const outboxId = randomUUID();
  await db.query(
    `INSERT INTO "sign"."SignNotificationOutbox" (id, tenant_id, envelope_id, signer_id, kind, actor_type) VALUES ($1, $2, $3, $4, 'SIGNATURE_NEEDED', 'SYSTEM')`,
    [outboxId, t, id, signer],
  );
  const notification = randomUUID();
  await db.query(
    `INSERT INTO "sign"."SignUserNotification" (id, tenant_id, user_id, type, audience, envelope_id, envelope_subject, dedupe_key, source_outbox_id) VALUES ($1, $2, $3, 'SIGNATURE_NEEDED', 'SENDER', $4, 'Agreement', $5, $6)`,
    [notification, t, s.user, id, `d-${notification}`, outboxId],
  );
  env.notificationIds.push(notification);
  if (s.pushDevice !== undefined) {
    await db.query(
      `INSERT INTO "sign"."SignPushJob" (id, tenant_id, user_id, device_id, notification_id, payload_kind) VALUES ($1, $2, $3, $4, $5, 'GENERIC')`,
      [randomUUID(), t, s.user, s.pushDevice, notification],
    );
  }
  await db.query(
    `INSERT INTO "sign"."SignIdempotencyKey" (id, tenant_id, actor_id, operation, key, request_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), t, s.user, `remind:${id}`, randomUUID(), H('e')],
  );
  await db.query(
    `INSERT INTO "sign"."IdempotencyKey" (id, tenant_id, key, request_hash, response_status, response_body) VALUES ($1, $2, $3, $4, 201, $5)`,
    [randomUUID(), t, randomUUID(), H('f'), JSON.stringify({ id, status: 'SENT' })],
  );
  await db.query(
    `INSERT INTO "sign"."OutboxEvent" (id, tenant_id, event_type, event_payload) VALUES ($1, $2, 'esign.envelope.sent', $3)`,
    [randomUUID(), t, JSON.stringify({ envelope_id: id, correlation_id: randomUUID() })],
  );
  if (s.integration !== undefined) {
    const eventId = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignWebhookDelivery" (id, subscription_id, event_id, tenant_id, envelope_id, event_type, payload) VALUES ($1, $2, $3, $4, $5, 'envelope.sent', '{}')`,
      [randomUUID(), s.integration.subscriptionId, eventId, t, id],
    );
    await db.query(
      `INSERT INTO "sign"."SignAccessToken" (id, token_hash, credential_id, installation_id, tenant_id, mode, subject_id, scopes, audience, expires_at, grant_kind, envelope_id, event_id)
       VALUES ($1, $2, $3, $4, $5, 'APPLICATION', $6, ARRAY['sign:envelopes:read'], 'sign', now() + interval '1 hour', 'EVENT_ARTIFACT', $7, $8)`,
      [randomUUID(), randomUUID(), s.integration.credentialId, s.integration.installationId, t, s.integration.applicationId, id, eventId],
    );
  }

  if (s.status === 'COMPLETED') {
    await event('ENVELOPE_COMPLETED', signer);
    const exe = randomUUID();
    await db.query(
      `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes) VALUES ($1, $2, $3, $4, $5, $6, 3, '\\x010203')`,
      [exe, t, id, docId, H('b'), createSha(exe)],
    );
    env.executedIds.push(exe);
    await db.query(
      `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes) VALUES ($1, $2, $3, $4, 2, '\\x0102')`,
      [randomUUID(), t, id, createSha(id)],
    );
    await db.query(
      `INSERT INTO "sign"."ExecutedAccessGrant" (id, tenant_id, envelope_id, signer_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [randomUUID(), t, id, signer, randomUUID()],
    );
  }
  return env;
}

function createSha(seed: string): string {
  return seed.replace(/-/g, '').padEnd(64, '9');
}
