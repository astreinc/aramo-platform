import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommunicationsPrismaService, CommunicationsRepository } from '@aramo/communications';
import {
  MicrosoftReauthRequiredError,
  assertNoTokenMaterial,
  type MicrosoftGraphPort,
  type UsableToken,
} from '@aramo/microsoft-graph';
import type { AuthContextType } from '@aramo/auth';

import { MicrosoftEmailService } from '../microsoft/microsoft-email.service.js';
import { EmailConsentDeniedError, type EmailConsentGate } from '../microsoft/email-consent-gate.port.js';
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
  async getMe(): Promise<{ ms_object_id: string; ms_tenant_id: string; user_principal_name: string; display_name: string }> {
    return { ms_object_id: MS_OID, ms_tenant_id: 'ms-tid', user_principal_name: 'recruiter@contoso.example', display_name: 'R' };
  }
  async sendMail(): Promise<void> {
    this.sendCount += 1;
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

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-C2B recruiter email send — real Postgres 17 (C2B-4)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: CommunicationsPrismaService;
    let repo: CommunicationsRepository;
    let graph: FakeGraph;
    let consent: FakeConsent;
    let svc: MicrosoftEmailService;

    const TENANT = randomUUID();
    const CONN = randomUUID();
    const RECRUITER = randomUUID();
    const RECRUITER_UNBOUND = randomUUID();
    const TALENT = randomUUID();
    const REQ = randomUUID();
    const PIPELINE = randomUUID();

    const authContext = { sub: RECRUITER, tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;

    function baseArgs(over: Record<string, unknown> = {}) {
      return {
        tenant_id: TENANT,
        recruiter_id: RECRUITER,
        connection_id: CONN,
        talent_record_id: TALENT,
        requisition_id: REQ,
        pipeline_id: PIPELINE,
        to_email: 'talent@example.test',
        subject: 'Hello',
        body: 'Body',
        idempotency_key: randomUUID(),
        authContext,
        requestId: randomUUID(),
        ...over,
      };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
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
      expect(j.to_address).toBe('talent@example.test');
      expect(j.from_address).toBe('recruiter@contoso.example');

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

    it('the email service performs NO Pipeline state mutation (evidence only)', async () => {
      // Structural: the service depends on no pipeline writer/port and never
      // transitions pipeline state — it only writes interaction + associations.
      // (There is no pipeline schema in this harness, so any mutation would throw.)
      const args = baseArgs();
      const view = await svc.sendRecruiterEmail(args);
      const assoc = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationAssociation" WHERE interaction_id=$1 AND subject_type='pipeline'`,
        [view.interaction_id],
      );
      // The pipeline linkage is an ADDITIVE association (regarding), not a state change.
      expect(assoc.rows[0].n).toBe(1);
    });
  },
);
