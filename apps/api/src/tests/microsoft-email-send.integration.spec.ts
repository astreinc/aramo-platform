import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommunicationsPrismaService, CommunicationsRepository } from '@aramo/communications';
import {
  MicrosoftReauthRequiredError,
  assertNoTokenMaterial,
  type GraphSendMailArgs,
  type MicrosoftGraphPort,
  type UsableToken,
} from '@aramo/microsoft-graph';
import type { AuthContextType } from '@aramo/auth';

import { MicrosoftEmailService } from '../microsoft/microsoft-email.service.js';
import { EmailConsentDeniedError, type EmailConsentGate } from '../microsoft/email-consent-gate.port.js';
import {
  TalentEmailUnavailableError,
  type EmailRecipientResolver,
} from '../microsoft/email-recipient-resolver.port.js';
import type { MicrosoftConfigResolver } from '../microsoft/microsoft-config.resolver.js';
import { VoiceEvidenceReaderAdapter } from '../engagement/voice-evidence.adapter.js';

// COMM-C2B §C2B-4 — recruiter email execution proofs on real Postgres 17.
// Real CommunicationsRepository (evidence SoR) + fakes for the Graph client,
// consent gate, delegated-credential resolver, and connection config, so the
// email-send behavior is isolated. Proves: consent-gated, bound-recruiter-only,
// failed-send→no-evidence, provider-neutral CommunicationInteraction linked to
// Talent×Requisition(+Pipeline), no provider id leak, idempotent, token-free.

const ROOT = resolve(__dirname, '../../../..');
const TOKEN = 'ACCESS-TOKEN-SECRET';
const MS_OID = 'ms-oid-SECRET';
// COMM-C4 — the authoritative recipient the backend resolves from the Talent
// record. A caller can never supply or override it.
const TALENT_EMAIL = 'authoritative@talent.example';

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

class FakeGraph implements MicrosoftGraphPort {
  sendCount = 0;
  failSend = false;
  lastToEmail: string | null = null;
  async getMe(): Promise<{ ms_object_id: string; ms_tenant_id: string; user_principal_name: string; display_name: string }> {
    return { ms_object_id: MS_OID, ms_tenant_id: 'ms-tid', user_principal_name: 'recruiter@contoso.example', display_name: 'R' };
  }
  async sendMail(args: GraphSendMailArgs): Promise<void> {
    this.sendCount += 1;
    this.lastToEmail = args.toEmail;
    if (this.failSend) {
      throw new Error('graph sendMail failed: 500');
    }
  }
  async createOnlineMeeting(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeConsent implements EmailConsentGate {
  deny = false;
  async assertEmailContactAllowed(): Promise<void> {
    if (this.deny) {
      throw new EmailConsentDeniedError('denied');
    }
  }
}

// COMM-C4 — server-side recipient authority. Returns the Talent's authoritative
// email; `email=null` models a Talent with no email1 (fail-closed).
class FakeRecipients implements EmailRecipientResolver {
  email: string | null = TALENT_EMAIL;
  calls = 0;
  async resolveRecipientEmail(req: { tenant_id: string; talent_record_id: string }): Promise<string> {
    this.calls += 1;
    if (this.email === null) {
      throw new TalentEmailUnavailableError(req.talent_record_id);
    }
    return this.email;
  }
}

// COMM-C4 / Recruiting-Journey §5 — authoritative pipeline read/act for the
// acceptance→CONTACT orchestration. Records the evidence-bearing calls (to prove the
// advance goes through recordContactEvidence with communication_interaction
// provenance, NEVER a naked action) and the resolution inputs (tenant/visibility).
class FakePipelines {
  status: 'no_contact' | 'contacted' = 'no_contact';
  requisitionId = '';
  talentId = '';
  present = true;
  version = 3;
  failApply = false;
  contactEvidenceCalls: Array<{ kind: string; id: string }> = [];
  findCalls: Array<{ tenant_id: string; visible: ReadonlySet<string> | null }> = [];
  async findByIdForActor(a: { tenant_id: string; id: string; visible_requisition_ids: ReadonlySet<string> | null }) {
    this.findCalls.push({ tenant_id: a.tenant_id, visible: a.visible_requisition_ids });
    if (!this.present) return null;
    return { id: a.id, requisition_id: this.requisitionId, talent_record_id: this.talentId, status: this.status, version: this.version };
  }
  async recordContactEvidence(a: { id: string; expected_version: number; evidence: { kind: string; id: string } }) {
    this.contactEvidenceCalls.push(a.evidence);
    if (this.failApply) throw new Error('pipeline CAS conflict');
    return { id: a.id, status: 'contacted', version: this.version + 1 };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-C2B recruiter email send — real Postgres 17 (C2B-4)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: CommunicationsPrismaService;
    let repo: CommunicationsRepository;
    let graph: FakeGraph;
    let consent: FakeConsent;
    let recipients: FakeRecipients;
    let pipelines: FakePipelines;
    let svc: MicrosoftEmailService;

    const TENANT = randomUUID();
    const CONN = randomUUID();
    const RECRUITER = randomUUID();
    const RECRUITER_UNBOUND = randomUUID();
    const TALENT = randomUUID();
    const REQ = randomUUID();
    const PIPELINE = randomUUID();

    const authContext = { sub: RECRUITER, tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;
    // COMM-C4 — a caller who additionally holds pipeline:change-status authorizes
    // the governed no_contact→contacted advance on acceptance.
    const authWithPipelineScope = {
      sub: RECRUITER,
      tenant_id: TENANT,
      scopes: ['pipeline:change-status'],
    } as unknown as AuthContextType;

    function baseArgs(over: Record<string, unknown> = {}) {
      return {
        tenant_id: TENANT,
        recruiter_id: RECRUITER,
        connection_id: CONN,
        talent_record_id: TALENT,
        requisition_id: REQ,
        pipeline_id: PIPELINE,
        subject: 'Hello',
        body: 'Body',
        idempotency_key: randomUUID(),
        authContext,
        requestId: randomUUID(),
        visible_requisition_ids: new Set([REQ]),
        ...over,
      };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of communicationsMigrations()) {
        await db.query(readFileSync(p, 'utf8'));
      }
      prisma = new CommunicationsPrismaService(url);
      await prisma.$connect();
      repo = new CommunicationsRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    beforeEach(() => {
      graph = new FakeGraph();
      consent = new FakeConsent();
      recipients = new FakeRecipients();
      pipelines = new FakePipelines();
      pipelines.requisitionId = REQ;
      pipelines.talentId = TALENT;
      // Bound-recruiter-only: the delegated resolver returns a token for the
      // bound recruiter and throws reauthorization-required for anyone else.
      const delegated = {
        async getUsableAccessToken(a: { recruiter_id: string; provider_identity_id?: string }): Promise<UsableToken> {
          if (a.recruiter_id !== RECRUITER) {
            throw new MicrosoftReauthRequiredError();
          }
          return { access_token: TOKEN, provider_identity_id: 'pi-1', ms_object_id: MS_OID };
        },
      };
      const config = {
        async resolveConnectionId(): Promise<string> {
          return CONN;
        },
        async resolveConfig(): Promise<{ clientId: string; clientSecret?: string; authorityTenant?: string }> {
          return { clientId: 'client-1', clientSecret: 'secret' };
        },
        nowSeconds(): number {
          return 1_000_000;
        },
        redirectUri(): string {
          return 'https://app/cb';
        },
      };
      svc = new MicrosoftEmailService(
        delegated as unknown as ConstructorParameters<typeof MicrosoftEmailService>[0],
        graph,
        repo,
        config as unknown as MicrosoftConfigResolver,
        consent,
        recipients,
        pipelines as unknown as ConstructorParameters<typeof MicrosoftEmailService>[6],
      );
    });

    async function countInteractions(): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationInteraction" WHERE tenant_id=$1`,
        [TENANT],
      );
      return r.rows[0].n as number;
    }

    it('consent denial creates NO email evidence (R17/R19)', async () => {
      const before = await countInteractions();
      consent.deny = true;
      await expect(svc.sendRecruiterEmail(baseArgs())).rejects.toBeInstanceOf(EmailConsentDeniedError);
      expect(await countInteractions()).toBe(before);
      expect(graph.sendCount).toBe(0); // never reached Graph
    });

    it('send uses ONLY the bound recruiter credential — an unbound recruiter cannot send', async () => {
      const before = await countInteractions();
      await expect(
        svc.sendRecruiterEmail(baseArgs({ recruiter_id: RECRUITER_UNBOUND })),
      ).rejects.toBeInstanceOf(MicrosoftReauthRequiredError);
      expect(await countInteractions()).toBe(before);
      expect(graph.sendCount).toBe(0);
    });

    it('a failed Graph send creates NO successful email evidence (R19)', async () => {
      const before = await countInteractions();
      graph.failSend = true;
      await expect(svc.sendRecruiterEmail(baseArgs())).rejects.toThrow();
      expect(await countInteractions()).toBe(before);
      expect(graph.sendCount).toBe(1); // attempted, but no evidence persisted
    });

    it('COMM-C4 — a Talent with no authoritative email fails closed BEFORE Graph and BEFORE evidence', async () => {
      const before = await countInteractions();
      recipients.email = null; // Talent has no email1
      await expect(svc.sendRecruiterEmail(baseArgs())).rejects.toBeInstanceOf(
        TalentEmailUnavailableError,
      );
      expect(graph.sendCount).toBe(0); // never reached Graph
      expect(await countInteractions()).toBe(before); // no interaction written
    });

    it('a successful send writes a provider-neutral CommunicationInteraction linked to Talent×Requisition(+Pipeline)', async () => {
      const args = baseArgs();
      const view = await svc.sendRecruiterEmail(args);
      expect(view.status).toBe('accepted');
      expect(view.idempotent_replay).toBe(false);

      const row = await db.query(
        `SELECT to_jsonb(t) AS j FROM communications."CommunicationInteraction" t WHERE id=$1`,
        [view.interaction_id],
      );
      const j = row.rows[0].j;
      expect(j.channel).toBe('email');
      expect(j.direction).toBe('outbound');
      expect(j.status).toBe('completed');
      // COMM-C4 — Graph received the AUTHORITATIVE recipient the backend
      // resolved from the Talent record (the client supplied no address), and
      // the persisted to_address equals that same authoritative email.
      expect(graph.lastToEmail).toBe(TALENT_EMAIL);
      expect(j.to_address).toBe(TALENT_EMAIL);
      expect(j.from_address).toBe('recruiter@contoso.example');
      // COMM-C4 — the FINAL reviewed subject/body are persisted as durable
      // evidence (previously discarded after Graph transmission).
      expect(j.subject).toBe('Hello');
      expect(j.body).toBe('Body');

      // No provider-specific identifier (Microsoft oid) or token leaks into the
      // evidence the C3 read will consume (R11/R20).
      const asText = JSON.stringify(j);
      expect(asText).not.toContain(MS_OID);
      expect(asText).not.toContain(TOKEN);

      const assoc = await db.query(
        `SELECT subject_type, subject_id, relation_type FROM communications."CommunicationAssociation" WHERE interaction_id=$1 ORDER BY subject_type`,
        [view.interaction_id],
      );
      const rows = assoc.rows as Array<{ subject_type: string; subject_id: string; relation_type: string }>;
      expect(rows).toContainEqual({ subject_type: 'talent_record', subject_id: TALENT, relation_type: 'subject' });
      expect(rows).toContainEqual({ subject_type: 'requisition', subject_id: REQ, relation_type: 'regarding' });
      expect(rows).toContainEqual({ subject_type: 'pipeline', subject_id: PIPELINE, relation_type: 'regarding' });
    });

    it('the returned API surface is token-free and safe (R3)', async () => {
      const view = await svc.sendRecruiterEmail(baseArgs());
      expect(() => assertNoTokenMaterial(view)).not.toThrow();
      expect(Object.keys(view).sort()).toEqual(
        ['idempotent_replay', 'interaction_id', 'requisition_id', 'status', 'talent_record_id'].sort(),
      );
    });

    it('idempotent retry with the same key does NOT duplicate evidence or re-send', async () => {
      const args = baseArgs();
      const first = await svc.sendRecruiterEmail(args);
      const beforeCount = await countInteractions();
      const second = await svc.sendRecruiterEmail(args); // same idempotency_key
      expect(second.interaction_id).toBe(first.interaction_id);
      expect(second.idempotent_replay).toBe(true);
      expect(await countInteractions()).toBe(beforeCount); // no new row
      expect(graph.sendCount).toBe(1); // second call did NOT re-send
    });

    it('C2B-5 — email evidence read: an accepted send → available + recorded_evidence=true, ZERO provider/identity fields', async () => {
      const args = baseArgs();
      await svc.sendRecruiterEmail(args);
      const reader = new VoiceEvidenceReaderAdapter(repo);
      const facts = await reader.readFacts(TENANT, args.talent_record_id, args.requisition_id);
      const email = facts.find((f) => f.channel === 'email');
      expect(email).toEqual({ channel: 'email', availability: 'available', recorded_evidence: true });
      // The fact the C3 evaluator consumes carries no Microsoft id or token.
      const asText = JSON.stringify(email);
      expect(asText).not.toContain(MS_OID);
      expect(asText).not.toContain(TOKEN);
      // Voice semantics preserved (no accepted voice call for this talent/req).
      const voice = facts.find((f) => f.channel === 'voice');
      expect(voice?.availability).toBe('available');
    });

    it('C2B-5 — no accepted send → recorded_evidence=false (email sent ≠ Talent responded)', async () => {
      const reader = new VoiceEvidenceReaderAdapter(repo);
      const facts = await reader.readFacts(TENANT, randomUUID(), randomUUID());
      const email = facts.find((f) => f.channel === 'email');
      expect(email).toEqual({ channel: 'email', availability: 'available', recorded_evidence: false });
    });

    // ---- COMM-C4 acceptance→CONTACT orchestration (parity with voice) ----

    it('accept + no_contact + pipeline scope → governed CONTACT advances to contacted', async () => {
      const view = await svc.sendRecruiterEmail(baseArgs({ authContext: authWithPipelineScope }));
      expect(view.status).toBe('accepted');
      expect(pipelines.contactEvidenceCalls).toHaveLength(1); // exactly one governed CONTACT
      expect(pipelines.contactEvidenceCalls[0]!.kind).toBe('communication_interaction');
      // the additive pipeline association is still written (evidence intact).
      const assoc = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationAssociation" WHERE interaction_id=$1 AND subject_type='pipeline'`,
        [view.interaction_id],
      );
      expect(assoc.rows[0].n).toBe(1);
    });

    it('accept WITHOUT pipeline:change-status → send succeeds, stage unchanged (no CONTACT attempt)', async () => {
      const view = await svc.sendRecruiterEmail(baseArgs()); // authContext scopes: []
      expect(view.status).toBe('accepted');
      expect(pipelines.findCalls).toHaveLength(0); // pipeline never even resolved
      expect(pipelines.contactEvidenceCalls).toHaveLength(0); // never advanced
    });

    it('a failed Graph send makes NO CONTACT attempt (trigger is acceptance only)', async () => {
      graph.failSend = true;
      await expect(
        svc.sendRecruiterEmail(baseArgs({ authContext: authWithPipelineScope })),
      ).rejects.toThrow();
      expect(pipelines.findCalls).toHaveLength(0);
      expect(pipelines.contactEvidenceCalls).toHaveLength(0);
    });

    it('an episode already past no_contact is NOT re-transitioned (no replay)', async () => {
      pipelines.status = 'contacted';
      const view = await svc.sendRecruiterEmail(baseArgs({ authContext: authWithPipelineScope }));
      expect(view.status).toBe('accepted');
      expect(pipelines.contactEvidenceCalls).toHaveLength(0);
    });

    it('a CONTACT failure is swallowed — email evidence stays durable and the send still reports accepted', async () => {
      pipelines.failApply = true;
      const before = await countInteractions();
      const view = await svc.sendRecruiterEmail(baseArgs({ authContext: authWithPipelineScope }));
      expect(view.status).toBe('accepted');
      expect(view.idempotent_replay).toBe(false);
      expect(await countInteractions()).toBe(before + 1); // evidence written and NOT rolled back
      expect(pipelines.contactEvidenceCalls).toHaveLength(1); // attempted, then swallowed
      expect(pipelines.contactEvidenceCalls[0]!.kind).toBe('communication_interaction');
    });

    it('CONTACT resolution is tenant/requisition/talent bound (not browser-authoritative); a mismatch does not advance', async () => {
      pipelines.requisitionId = randomUUID(); // the resolved pipeline is for a DIFFERENT requisition
      const view = await svc.sendRecruiterEmail(baseArgs({ authContext: authWithPipelineScope }));
      expect(view.status).toBe('accepted');
      expect(pipelines.findCalls[0]?.tenant_id).toBe(TENANT); // tenant-scoped resolution
      expect(pipelines.findCalls[0]?.visible).toEqual(new Set([REQ])); // visibility-scoped
      expect(pipelines.contactEvidenceCalls).toHaveLength(0); // binding mismatch → no transition
    });

    it('the orchestration ONLY records contact evidence (never talent_responded)', async () => {
      await svc.sendRecruiterEmail(baseArgs({ authContext: authWithPipelineScope }));
      // Every advance is a CONTACT-evidence call (communication_interaction provenance);
      // the email path never touches the response seam (the fake exposes no
      // recordResponseEvidence — a response advance would throw), so talent_responded
      // is structurally unreachable from an email send.
      expect(pipelines.contactEvidenceCalls.length).toBeGreaterThan(0);
      expect(pipelines.contactEvidenceCalls.every((e) => e.kind === 'communication_interaction')).toBe(true);
    });

    // ---- D-EMAIL-TPL-1 (ET-8) — descriptive template provenance ----
    // Provenance is metadata about the draft the recruiter reviewed; it is never a
    // source of sent-email truth (subject/body are) and is never re-resolved.

    async function provenanceOf(
      interactionId: string,
    ): Promise<{ template_key: string | null; template_id: string | null; subject: string | null; body: string | null }> {
      const r = await db.query(
        `SELECT template_key, template_id, subject, body FROM communications."CommunicationInteraction" WHERE id=$1`,
        [interactionId],
      );
      return r.rows[0];
    }

    it('ET-8: code-default draft → template_key set, template_id null (sentinel mapped); edited subject/body persisted', async () => {
      const view = await svc.sendRecruiterEmail(
        baseArgs({
          subject: 'Edited subject',
          body: 'Edited body',
          template_key: 'requisition-contact',
          template_id: 'system.requisition-contact.v1', // the code-default sentinel
        }),
      );
      const p = await provenanceOf(view.interaction_id);
      expect(p.template_key).toBe('requisition-contact');
      expect(p.template_id).toBeNull(); // default has no override row id
      expect(p.subject).toBe('Edited subject'); // final edited content remains the truth
      expect(p.body).toBe('Edited body');
    });

    it('ET-8: tenant-override draft → template_key set, template_id = the override row id', async () => {
      const overrideId = randomUUID();
      const view = await svc.sendRecruiterEmail(
        baseArgs({ template_key: 'requisition-contact', template_id: overrideId }),
      );
      const p = await provenanceOf(view.interaction_id);
      expect(p.template_key).toBe('requisition-contact');
      expect(p.template_id).toBe(overrideId);
    });

    it('ET-8: provenance is recorded from the REVIEWED draft verbatim, never re-resolved at send time', async () => {
      // An id that matches NO current effective template. A re-resolution at send
      // time would produce something else (or null); recording it verbatim proves
      // the send path never re-looks-up the template after the recruiter reviewed.
      const reviewedId = 'override-reviewed-not-current';
      const view = await svc.sendRecruiterEmail(
        baseArgs({ template_key: 'requisition-contact', template_id: reviewedId }),
      );
      expect((await provenanceOf(view.interaction_id)).template_id).toBe(reviewedId);
    });

    it('ET-8: a send with NO template provenance leaves both columns null (legacy/other paths — no regression)', async () => {
      const view = await svc.sendRecruiterEmail(baseArgs());
      const p = await provenanceOf(view.interaction_id);
      expect(p.template_key).toBeNull();
      expect(p.template_id).toBeNull();
    });
  },
);
