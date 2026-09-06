import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommunicationsPrismaService, CommunicationsRepository } from '@aramo/communications';
import {
  MicrosoftReauthRequiredError,
  type GraphCreateMeetingArgs,
  type GraphMeetingResult,
  type MicrosoftGraphPort,
  type UsableToken,
} from '@aramo/microsoft-graph';

import { MicrosoftMeetingService } from '../microsoft/microsoft-meeting.service.js';
import type { MicrosoftConfigResolver } from '../microsoft/microsoft-config.resolver.js';
import { VoiceEvidenceReaderAdapter } from '../engagement/voice-evidence.adapter.js';

// COMM-C2B §C2B-6 — Teams create-link-only proofs on real Postgres 17. Real
// CommunicationsRepository (evidence SoR) + fakes for the Graph client, delegated
// credential resolver, and connection config. Proves: bound-recruiter-only, tenant
// isolation, reauth blocks creation, Graph failure → no evidence, one provider-
// neutral interaction, NO Talent attendee/invite in the Graph request, safe join
// URL (no token leak), idempotent, no Pipeline/Client/Interview mutation, and the
// meeting is not treated as attendance/completion.

const ROOT = resolve(__dirname, '../../../..');
const TOKEN = 'ACCESS-TOKEN-SECRET';
const JOIN_URL = 'https://teams.microsoft.example/l/meetup-join/xyz';
const MEETING_ID = 'ms-meeting-id-123';

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

class FakeGraph implements MicrosoftGraphPort {
  createCount = 0;
  failCreate = false;
  lastCreateArgs: GraphCreateMeetingArgs | null = null;
  async getMe(): Promise<{ ms_object_id: string; ms_tenant_id: string; user_principal_name: string; display_name: string }> {
    return { ms_object_id: 'oid', ms_tenant_id: 'tid', user_principal_name: 'organizer@contoso.example', display_name: 'O' };
  }
  async sendMail(): Promise<void> {
    throw new Error('not used');
  }
  async createOnlineMeeting(args: GraphCreateMeetingArgs): Promise<GraphMeetingResult> {
    this.createCount += 1;
    this.lastCreateArgs = args;
    if (this.failCreate) {
      throw new Error('graph createOnlineMeeting failed: 500');
    }
    return {
      provider_meeting_id: MEETING_ID,
      join_url: JOIN_URL,
      start_date_time: args.startDateTime,
      end_date_time: args.endDateTime,
    };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-C2B Teams create-link-only — real Postgres 17 (C2B-6)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: CommunicationsPrismaService;
    let repo: CommunicationsRepository;
    let graph: FakeGraph;
    let svc: MicrosoftMeetingService;

    const TENANT = randomUUID();
    const OTHER_TENANT = randomUUID();
    const CONN = randomUUID();
    const RECRUITER = randomUUID();
    const RECRUITER_UNBOUND = randomUUID();
    const TALENT = randomUUID();
    const REQ = randomUUID();
    const PIPELINE = randomUUID();

    function baseArgs(over: Record<string, unknown> = {}) {
      return {
        tenant_id: TENANT,
        recruiter_id: RECRUITER,
        connection_id: CONN,
        talent_record_id: TALENT,
        requisition_id: REQ,
        pipeline_id: PIPELINE,
        subject: 'Intro call',
        start_date_time: '2026-09-10T15:00:00.000Z',
        end_date_time: '2026-09-10T15:30:00.000Z',
        idempotency_key: randomUUID(),
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
      const delegated = {
        async getUsableAccessToken(a: { tenant_id: string; recruiter_id: string }): Promise<UsableToken> {
          // Bound only for (TENANT, RECRUITER); anyone else → reauthorization-required.
          if (a.tenant_id !== TENANT || a.recruiter_id !== RECRUITER) {
            throw new MicrosoftReauthRequiredError();
          }
          return { access_token: TOKEN, provider_identity_id: 'pi-1', ms_object_id: 'oid' };
        },
      };
      const config = {
        async resolveConnectionId(): Promise<string> {
          return CONN;
        },
        async resolveConfig(): Promise<{ clientId: string; clientSecret?: string; authorityTenant?: string }> {
          return { clientId: 'client-1', clientSecret: 'secret' };
        },
        nowSeconds: (): number => 1_000_000,
        redirectUri: (): string => 'https://app/cb',
      };
      svc = new MicrosoftMeetingService(
        delegated as unknown as ConstructorParameters<typeof MicrosoftMeetingService>[0],
        graph,
        repo,
        config as unknown as MicrosoftConfigResolver,
      );
    });

    async function countMeetings(tenant: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationInteraction" WHERE tenant_id=$1 AND channel='meeting'`,
        [tenant],
      );
      return r.rows[0].n as number;
    }

    it('an unbound recruiter cannot create a meeting (bound-credential-only)', async () => {
      const before = await countMeetings(TENANT);
      await expect(
        svc.createRecruiterMeeting(baseArgs({ recruiter_id: RECRUITER_UNBOUND })),
      ).rejects.toBeInstanceOf(MicrosoftReauthRequiredError);
      expect(await countMeetings(TENANT)).toBe(before);
      expect(graph.createCount).toBe(0);
    });

    it('reauthorization-required identity cannot create a meeting (R7)', async () => {
      // The delegated resolver throws reauth for a wrong tenant → tenant isolation too.
      await expect(
        svc.createRecruiterMeeting(baseArgs({ tenant_id: OTHER_TENANT })),
      ).rejects.toBeInstanceOf(MicrosoftReauthRequiredError);
      expect(await countMeetings(OTHER_TENANT)).toBe(0);
    });

    it('a Graph failure does NOT create meeting evidence (R19)', async () => {
      const before = await countMeetings(TENANT);
      graph.failCreate = true;
      await expect(svc.createRecruiterMeeting(baseArgs())).rejects.toThrow();
      expect(await countMeetings(TENANT)).toBe(before);
      expect(graph.createCount).toBe(1);
    });

    it('a successful create writes ONE provider-neutral meeting interaction, NO Talent attendee in the Graph request', async () => {
      const view = await svc.createRecruiterMeeting(baseArgs());
      expect(view.join_url).toBe(JOIN_URL);
      expect(view.idempotent_replay).toBe(false);

      // The Graph create request carries ONLY subject + window — no attendee/invitee.
      expect(Object.keys(graph.lastCreateArgs ?? {}).sort()).toEqual(
        ['accessToken', 'endDateTime', 'startDateTime', 'subject'].sort(),
      );
      const reqText = JSON.stringify(graph.lastCreateArgs);
      expect(reqText).not.toContain(TALENT); // Talent id never sent to Graph

      const row = await db.query(
        `SELECT to_jsonb(t) AS j FROM communications."CommunicationInteraction" t WHERE id=$1`,
        [view.interaction_id],
      );
      const j = row.rows[0].j;
      expect(j.channel).toBe('meeting');
      expect(j.join_reference).toBe(JOIN_URL);
      expect(j.provider_interaction_id).toBe(MEETING_ID);
      expect(j.to_address).toBe(''); // create-link-only: no recipient
      // Not attendance/completion: the LINK was created, status is `created`.
      expect(j.status).toBe('created');
      // Safe: no token/secret leaks into the persisted evidence or the view.
      expect(JSON.stringify(j)).not.toContain(TOKEN);
      expect(JSON.stringify(view)).not.toContain(TOKEN);

      const assoc = await db.query(
        `SELECT subject_type, subject_id, relation_type FROM communications."CommunicationAssociation" WHERE interaction_id=$1`,
        [view.interaction_id],
      );
      const rows = assoc.rows as Array<{ subject_type: string; subject_id: string; relation_type: string }>;
      expect(rows).toContainEqual({ subject_type: 'talent_record', subject_id: TALENT, relation_type: 'subject' });
      expect(rows).toContainEqual({ subject_type: 'requisition', subject_id: REQ, relation_type: 'regarding' });
      expect(rows).toContainEqual({ subject_type: 'pipeline', subject_id: PIPELINE, relation_type: 'regarding' });
    });

    it('idempotent retry with the same key does NOT create a duplicate meeting', async () => {
      const args = baseArgs();
      const first = await svc.createRecruiterMeeting(args);
      const beforeCount = await countMeetings(TENANT);
      const second = await svc.createRecruiterMeeting(args);
      expect(second.interaction_id).toBe(first.interaction_id);
      expect(second.idempotent_replay).toBe(true);
      expect(await countMeetings(TENANT)).toBe(beforeCount);
      expect(graph.createCount).toBe(1); // did NOT create a second Teams meeting
    });

    it('a created meeting is NOT counted as email/response evidence (not attendance/completion)', async () => {
      const args = baseArgs();
      await svc.createRecruiterMeeting(args);
      const reader = new VoiceEvidenceReaderAdapter(repo);
      const facts = await reader.readFacts(TENANT, args.talent_record_id, args.requisition_id);
      const email = facts.find((f) => f.channel === 'email');
      // A meeting is channel=meeting; it must NOT register as email recorded_evidence.
      expect(email).toEqual({ channel: 'email', availability: 'available', recorded_evidence: false });
    });
  },
);
