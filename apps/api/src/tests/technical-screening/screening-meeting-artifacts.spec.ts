import { MeetingArtifactError, MicrosoftReauthRequiredError } from '@aramo/microsoft-graph';
import { describe, expect, it, vi } from 'vitest';

import { TeamsMeetingTranscriptProvider } from '../../conversation-transcript/teams/teams-meeting-transcript.provider.js';
import { TeamsTranscriptParser } from '../../conversation-transcript/teams/teams-transcript.parser.js';
import { MeetingAssociationError } from '../../microsoft/meeting-association.validator.js';
import { MeetingArtifactsService } from '../../microsoft/meeting-artifacts.service.js';
import { MicrosoftMeetingArtifactsHttpAdapter } from '../../microsoft/microsoft-meeting-artifacts-http.adapter.js';
import {
  MicrosoftSchedulingService,
  type ScheduleMeetingArgs,
} from '../../microsoft/microsoft-scheduling.service.js';
import { ScreeningMeetingService } from '../../technical-screening/screening-meeting.service.js';

// TIP-E2E INC-3 A1-4/A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Parts E/F, §5,
// §10.1, R-C) — fakes only, no network, no real tenant:
//   - screening meetings reuse the existing scheduling path with the screening
//     association (Requisition optional, no live-pipeline check);
//   - Graph error semantics (transcript API disabled, speaker attribution off);
//   - capability / organizer / transcription-consent gates fail closed BEFORE
//     any Graph transcript call;
//   - recordAutomatically only under `recording` consent;
//   - honest capture-mode statuses.

const TENANT = 't-1';
const RECRUITER = 'r-1';
const OTHER = 'r-2';
const TALENT = 'tal-1';
const SESSION_ID = 's-1';
const INTERACTION = 'int-1';
const ARTIFACT_SCOPE = 'openid OnlineMeetings.ReadWrite Calendars.ReadWrite OnlineMeetingTranscript.Read.All';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
describe('MicrosoftMeetingArtifactsHttpAdapter — Graph semantics (§10.1)', () => {
  it('maps 403 GraphAccessToTranscriptsDisabled to transcripts_disabled and other 403s to forbidden', async () => {
    const disabled = new MicrosoftMeetingArtifactsHttpAdapter(async () =>
      json(403, { error: { code: 'GraphAccessToTranscriptsDisabled' } }),
    );
    await expect(disabled.listTranscripts({ accessToken: 'tok', onlineMeetingId: 'm' })).rejects.toMatchObject({
      kind: 'transcripts_disabled',
    });
    const forbidden = new MicrosoftMeetingArtifactsHttpAdapter(async () => json(403, { error: { code: 'Forbidden' } }));
    await expect(forbidden.listTranscripts({ accessToken: 'tok', onlineMeetingId: 'm' })).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('falls back to the unattributed format through the Accept header when speaker attribution is off', async () => {
    const accepts: Array<string | undefined> = [];
    const adapter = new MicrosoftMeetingArtifactsHttpAdapter(async (_url, init) => {
      const accept = (init?.headers as Record<string, string>)['accept'];
      accepts.push(accept);
      return accept === 'text/vtt'
        ? json(403, { error: { code: 'SpeakerAttributionNotAllowed' } })
        : new Response('00:00:01.000 --> 00:00:02.000\nhello', { status: 200 });
    });
    const content = await adapter.getTranscriptContent({ accessToken: 'tok', onlineMeetingId: 'm', transcriptId: 'x' });
    expect(accepts).toEqual(['text/vtt', 'application/vnd.microsoft.graph.transcript+text']);
    expect(content).toMatchObject({ speaker_attributed: false, content_type: 'application/vnd.microsoft.graph.transcript+text' });
  });

  it('resolves the online meeting by an encoded JoinWebUrl filter on the /me (delegated) resource', async () => {
    const urls: string[] = [];
    const adapter = new MicrosoftMeetingArtifactsHttpAdapter(async (url) => {
      urls.push(String(url));
      return json(200, { value: [{ id: 'MSo1' }] });
    });
    const ref = await adapter.findOnlineMeetingByJoinUrl({ accessToken: 'tok', joinUrl: "https://teams/l/meetup-join/a'b" });
    expect(ref).toEqual({ online_meeting_id: 'MSo1' });
    expect(urls[0]).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/onlineMeetings\?\$filter=/);
    expect(decodeURIComponent(urls[0]!.split('$filter=')[1]!)).toBe("JoinWebUrl eq 'https://teams/l/meetup-join/a''b'");
  });
});

// ---------------------------------------------------------------------------
function artifactsService(opts: { scope?: string; tokenError?: Error; organizer?: string | null } = {}) {
  const delegated = {
    getUsableAccessToken: vi.fn(async () => {
      if (opts.tokenError !== undefined) throw opts.tokenError;
      return { access_token: 'tok', granted_scope: opts.scope ?? ARTIFACT_SCOPE };
    }),
  };
  const config = {
    resolveConnectionId: vi.fn().mockResolvedValue('conn-1'),
    resolveConfig: vi.fn().mockResolvedValue({ clientId: 'c', clientSecret: 's', authorityTenant: 'a' }),
    nowSeconds: () => 1,
  };
  const repo = {
    findScheduledMeeting: vi.fn().mockResolvedValue(
      opts.organizer === null ? null : { id: INTERACTION, join_reference: 'https://teams/join', initiated_by_id: opts.organizer ?? RECRUITER },
    ),
    findOnlineMeetingId: vi.fn().mockResolvedValue(null),
    setOnlineMeetingId: vi.fn().mockResolvedValue(undefined),
  };
  const port = {
    findOnlineMeetingByJoinUrl: vi.fn().mockResolvedValue({ online_meeting_id: 'MSo1' }),
    setRecordAutomatically: vi.fn().mockResolvedValue(undefined),
    listTranscripts: vi.fn().mockResolvedValue([{ transcript_id: 'tr-1', created_date_time: '2026-11-01T10:31:00Z' }]),
    getTranscriptContent: vi.fn().mockResolvedValue({ body: 'WEBVTT', content_type: 'text/vtt', speaker_attributed: true }),
  };
  const svc = new MeetingArtifactsService(delegated as never, config as never, repo as never, port as never);
  return { svc, repo, port, delegated };
}

describe('MeetingArtifactsService — capability, organizer, recording consent', () => {
  it('reports granted / not_granted / reauth_required honestly', async () => {
    expect(await artifactsService().svc.capabilityStatus(TENANT, RECRUITER)).toBe('granted');
    expect(await artifactsService({ scope: 'openid Calendars.ReadWrite' }).svc.capabilityStatus(TENANT, RECRUITER)).toBe('not_granted');
    expect(
      await artifactsService({ tokenError: new MicrosoftReauthRequiredError() }).svc.capabilityStatus(TENANT, RECRUITER),
    ).toBe('reauth_required');
  });

  it('sets recordAutomatically ONLY when recording consent allows it', async () => {
    const denied = artifactsService();
    const r1 = await denied.svc.prepareScreeningMeeting({ tenant_id: TENANT, organizer_id: RECRUITER, interaction_id: INTERACTION, recording_allowed: false });
    expect(r1).toEqual({ status: 'prepared', record_automatically: false });
    expect(denied.port.setRecordAutomatically).not.toHaveBeenCalled();
    expect(denied.repo.setOnlineMeetingId).toHaveBeenCalledWith(TENANT, INTERACTION, 'MSo1');

    const allowed = artifactsService();
    const r2 = await allowed.svc.prepareScreeningMeeting({ tenant_id: TENANT, organizer_id: RECRUITER, interaction_id: INTERACTION, recording_allowed: true });
    expect(r2).toEqual({ status: 'prepared', record_automatically: true });
    expect(allowed.port.setRecordAutomatically).toHaveBeenCalledOnce();
  });

  it('does nothing on Graph when the capability is not granted', async () => {
    const { svc, port } = artifactsService({ scope: 'openid' });
    expect(
      await svc.prepareScreeningMeeting({ tenant_id: TENANT, organizer_id: RECRUITER, interaction_id: INTERACTION, recording_allowed: true }),
    ).toEqual({ status: 'not_granted', record_automatically: false });
    expect(port.findOnlineMeetingByJoinUrl).not.toHaveBeenCalled();
  });

  it('listTranscriptRefs: non-organizer 403, capability missing 409, tenant transcript access off 409 with reason', async () => {
    const a = artifactsService();
    await expect(
      a.svc.listTranscriptRefs({ tenant_id: TENANT, organizer_id: RECRUITER, acting_recruiter_id: OTHER, interaction_id: INTERACTION, requestId: 'rq' }),
    ).rejects.toMatchObject({ code: 'MICROSOFT_MEETING_NOT_ORGANIZER', statusCode: 403 });
    expect(a.delegated.getUsableAccessToken).not.toHaveBeenCalled();

    const b = artifactsService({ scope: 'openid' });
    await expect(
      b.svc.listTranscriptRefs({ tenant_id: TENANT, organizer_id: RECRUITER, acting_recruiter_id: RECRUITER, interaction_id: INTERACTION, requestId: 'rq' }),
    ).rejects.toMatchObject({ code: 'MEETING_ARTIFACT_ACCESS_UNAVAILABLE', statusCode: 409, context: { details: { reason: 'meeting_artifacts_not_granted' } } });
    expect(b.port.listTranscripts).not.toHaveBeenCalled();

    const c = artifactsService();
    c.port.listTranscripts.mockRejectedValue(new MeetingArtifactError('transcripts_disabled', 403, 'off'));
    await expect(
      c.svc.listTranscriptRefs({ tenant_id: TENANT, organizer_id: RECRUITER, acting_recruiter_id: RECRUITER, interaction_id: INTERACTION, requestId: 'rq' }),
    ).rejects.toMatchObject({ code: 'MEETING_ARTIFACT_ACCESS_UNAVAILABLE', context: { details: { reason: 'graph_transcript_access_disabled' } } });
  });

  it('fetchTranscriptContentAsOrganizer always uses the ORGANIZER token, never the caller', async () => {
    const { svc, delegated } = artifactsService({ organizer: OTHER });
    await svc.fetchTranscriptContentAsOrganizer({ tenant_id: TENANT, interaction_id: INTERACTION, online_meeting_id: 'MSo1', transcript_id: 'tr-1' });
    expect(delegated.getUsableAccessToken).toHaveBeenCalledWith(expect.objectContaining({ recruiter_id: OTHER }));
  });
});

// ---------------------------------------------------------------------------
describe('Teams transcript parser + B3 provider (A1-5, CI-B5M)', () => {
  it('parses WEBVTT voice tags into speaker-labelled timed segments', () => {
    const vtt = [
      'WEBVTT',
      '',
      'a1/12-0',
      '00:00:01.000 --> 00:00:04.500',
      '<v Ada Recruiter>Tell me about your Kubernetes work.</v>',
      '',
      'a1/13-0',
      '00:00:05.000 --> 00:01:02.250',
      '<v Talent Person>I ran three production clusters.</v>',
    ].join('\n');
    const parsed = new TeamsTranscriptParser().parse(Buffer.from(vtt));
    expect(parsed.segments).toEqual([
      { provider_segment_id: 'a1/12-0', speaker_label: 'Ada Recruiter', start_ms: 1000, end_ms: 4500, text: 'Tell me about your Kubernetes work.' },
      { provider_segment_id: 'a1/13-0', speaker_label: 'Talent Person', start_ms: 5000, end_ms: 62250, text: 'I ran three production clusters.' },
    ]);
  });

  it('never invents speakers for the unattributed format, and refuses an empty transcript', () => {
    const parsed = new TeamsTranscriptParser().parse(Buffer.from('00:00:01.000 --> 00:00:02.000 hello there\n'));
    expect(parsed.segments).toEqual([{ start_ms: 1000, end_ms: 2000, text: 'hello there' }]);
    expect(() => new TeamsTranscriptParser().parse(Buffer.from('WEBVTT\n\n'))).toThrow();
  });

  it('acquires through the organizer path into the artifact store; Graph refusals are terminal, throttling retryable', async () => {
    const store = { putSource: vi.fn().mockResolvedValue({ ref: 'ref-1', sha256: 'f'.repeat(64) }) };
    const artifacts = {
      fetchTranscriptContentAsOrganizer: vi.fn().mockResolvedValue({ body: 'WEBVTT', content_type: 'text/vtt', speaker_attributed: true }),
    };
    const provider = new TeamsMeetingTranscriptProvider(artifacts as never, store as never);
    expect(provider.getCapabilities().live_transcript_stream).toBe(false);
    const ok = await provider.acquireTranscript({ tenant_id: TENANT, provider_key: 'microsoft_teams', provider_transcript_id: 'tr-1', provider_resource_ref: `${INTERACTION}:MSo1` });
    expect(ok).toMatchObject({ kind: 'acquired', result: { source_artifact_ref: 'ref-1', speaker_attribution_supported: true, recording_dependency: 'not_required' } });
    expect(artifacts.fetchTranscriptContentAsOrganizer).toHaveBeenCalledWith({ tenant_id: TENANT, interaction_id: INTERACTION, online_meeting_id: 'MSo1', transcript_id: 'tr-1' });

    artifacts.fetchTranscriptContentAsOrganizer.mockRejectedValueOnce(new MeetingArtifactError('transcripts_disabled', 403, 'off'));
    expect(await provider.acquireTranscript({ tenant_id: TENANT, provider_key: 'microsoft_teams', provider_transcript_id: 'tr-1', provider_resource_ref: `${INTERACTION}:MSo1` }))
      .toEqual({ kind: 'terminal_failure', error_code: 'TEAMS_TRANSCRIPT_ACCESS_UNAVAILABLE' });
    artifacts.fetchTranscriptContentAsOrganizer.mockRejectedValueOnce(new MeetingArtifactError('throttled', 429, 'slow'));
    expect((await provider.acquireTranscript({ tenant_id: TENANT, provider_key: 'microsoft_teams', provider_transcript_id: 'tr-1', provider_resource_ref: `${INTERACTION}:MSo1` })).kind)
      .toBe('retryable_failure');
    expect(await provider.acquireTranscript({ tenant_id: TENANT, provider_key: 'microsoft_teams', provider_transcript_id: 'tr-1', provider_resource_ref: 'garbage' }))
      .toEqual({ kind: 'terminal_failure', error_code: 'TEAMS_TRANSCRIPT_INVALID_IDENTITY' });
  });
});

// ---------------------------------------------------------------------------
describe('MicrosoftSchedulingService — screening association (A1 Part F)', () => {
  function scheduling() {
    const repo = {
      claimSchedulingOperation: vi.fn().mockResolvedValue({ outcome: 'created', op: { id: 'op-1', transaction_id: 'idem-1', interaction_id: null } }),
      markOperation: vi.fn().mockResolvedValue(undefined),
      createScheduledMeeting: vi.fn().mockResolvedValue({ id: INTERACTION, tenant_id: TENANT, status: 'scheduled', version: 0, provider_event_id: 'evt-1', join_reference: 'j', initiated_by_id: RECRUITER, started_at: new Date(), ended_at: new Date() }),
      writeAudit: vi.fn().mockResolvedValue(undefined),
    };
    const validator = {
      assertTenantOwnership: vi.fn().mockResolvedValue(undefined),
      assertRecruitingAssociation: vi.fn().mockResolvedValue(undefined),
      assertScreeningAssociation: vi.fn().mockResolvedValue(undefined),
    };
    const calendar = { createCalendarEvent: vi.fn().mockResolvedValue({ provider_event_id: 'evt-1', join_url: 'https://teams/join', start_date_time: 's', end_date_time: 'e' }) };
    const consent = { assertInvitationAllowed: vi.fn().mockResolvedValue(undefined) };
    const svc = new MicrosoftSchedulingService(
      { getUsableAccessToken: vi.fn().mockResolvedValue({ access_token: 'tok' }) } as never,
      calendar as never,
      { getMe: vi.fn().mockResolvedValue({ user_principal_name: 'r@x.com' }) } as never,
      repo as never,
      { resolveConnectionId: vi.fn().mockResolvedValue('conn-1'), resolveConfig: vi.fn().mockResolvedValue({}), nowSeconds: () => 1 } as never,
      validator as never,
      consent as never,
      { findContactByIds: vi.fn().mockResolvedValue(new Map([[TALENT, { email: 'tal@x.com' }]])) } as never,
    );
    return { svc, repo, validator, consent, calendar };
  }
  const args: ScheduleMeetingArgs = {
    tenant_id: TENANT, recruiter_id: RECRUITER, talent_record_id: TALENT, requisition_id: null, screening_session_id: SESSION_ID,
    subject: 'Technical screening', start_date_time: '2026-11-01T10:00:00', end_date_time: '2026-11-01T10:30:00',
    time_zone: 'UTC', idempotency_key: 'idem-12345', authContext: {} as never, requestId: 'rq',
  };

  it('uses the screening association (no live-pipeline check), keeps contacting consent, and records the session', async () => {
    const { svc, repo, validator, consent } = scheduling();
    await svc.scheduleMeeting(args);
    expect(validator.assertScreeningAssociation).toHaveBeenCalledWith(expect.objectContaining({ talent_record_id: TALENT, requisition_id: null }));
    expect(validator.assertRecruitingAssociation).not.toHaveBeenCalled();
    expect(consent.assertInvitationAllowed).toHaveBeenCalled();
    expect(repo.createScheduledMeeting).toHaveBeenCalledWith(expect.objectContaining({ screening_session_id: SESSION_ID }));
  });

  it('a non-screening meeting still requires a Requisition (no widening of the recruiting path)', async () => {
    const { svc, calendar } = scheduling();
    const plain: ScheduleMeetingArgs = { ...args };
    delete plain.screening_session_id;
    await expect(svc.scheduleMeeting(plain)).rejects.toBeInstanceOf(MeetingAssociationError);
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('ScreeningMeetingService — composition gates (A1-4/A1-5, §5, R-C)', () => {
  const auth = { tenant_id: TENANT, sub: RECRUITER } as never;
  const draft = { id: SESSION_ID, tenant_id: TENANT, talent_record_id: TALENT, requisition_id: null, interaction_id: null, state: 'DRAFT', version: 0 } as never;
  const linked = { ...(draft as object), interaction_id: INTERACTION } as never;

  function composition(opts: { consent?: Record<string, boolean>; organizer?: string | null; capability?: string } = {}) {
    const screening = { linkMeeting: vi.fn().mockResolvedValue(linked), linkTranscript: vi.fn().mockResolvedValue({ linked: true }) };
    const scheduling = { scheduleMeeting: vi.fn().mockResolvedValue({ interaction_id: INTERACTION, join_url: 'https://teams/join', idempotent_replay: false }) };
    const artifacts = {
      prepareScreeningMeeting: vi.fn().mockResolvedValue({ status: 'prepared', record_automatically: false }),
      capabilityStatus: vi.fn().mockResolvedValue(opts.capability ?? 'granted'),
      organizerOf: vi.fn().mockResolvedValue(opts.organizer === undefined ? RECRUITER : opts.organizer),
      listTranscriptRefs: vi.fn().mockResolvedValue({ online_meeting_id: 'MSo1', transcripts: [{ transcript_id: 'tr-1', created_date_time: null }] }),
    };
    const transcripts = {
      registerTranscriptAvailability: vi.fn().mockResolvedValue({ id: 'ct-1', state: 'source_available' }),
      acquire: vi.fn().mockResolvedValue({ id: 'ct-1', state: 'source_ready' }),
    };
    const normalization = { normalize: vi.fn().mockResolvedValue({ id: 'ct-1', state: 'normalized' }) };
    const consent = {
      isOperationAllowed: vi.fn(async (_t: string, _r: string, op: string) => opts.consent?.[op] ?? true),
    };
    const analysis = { scheduleScreening: vi.fn().mockResolvedValue({ scheduled: false, reason: 'disabled' }) };
    const svc = new ScreeningMeetingService(
      screening as never, scheduling as never, artifacts as never, transcripts as never, normalization as never, consent as never, analysis as never,
    );
    return { svc, screening, scheduling, artifacts, transcripts, normalization, consent, analysis };
  }
  const body = { subject: 'Screen', start_date_time: '2026-11-01T10:00:00Z', end_date_time: '2026-11-01T10:30:00Z', time_zone: 'UTC', idempotency_key: 'idem-12345' };

  it('schedules with the session association, links the meeting, and passes recording consent to preparation', async () => {
    const c = composition({ consent: { recording: false } });
    const r = await c.svc.schedule({ auth, session: draft, body, requestId: 'rq' });
    expect(c.scheduling.scheduleMeeting).toHaveBeenCalledWith(expect.objectContaining({ screening_session_id: SESSION_ID, requisition_id: null, talent_record_id: TALENT, recruiter_id: RECRUITER }));
    expect(c.screening.linkMeeting).toHaveBeenCalledWith(expect.objectContaining({ interaction_id: INTERACTION }));
    expect(c.artifacts.prepareScreeningMeeting).toHaveBeenCalledWith(expect.objectContaining({ recording_allowed: false }));
    expect(r).toMatchObject({ interaction_id: INTERACTION, artifact_preparation: 'prepared', record_automatically: false });
  });

  it('refuses a second meeting BEFORE any Outlook side effect, and validates input', async () => {
    const c = composition();
    await expect(c.svc.schedule({ auth, session: linked, body, requestId: 'rq' })).rejects.toMatchObject({ statusCode: 422, context: { details: { reason: 'meeting_already_linked' } } });
    await expect(c.svc.schedule({ auth, session: draft, body: { ...body, start_date_time: 'tomorrow' }, requestId: 'rq' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(c.scheduling.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('capture modes are honest: notes always, Teams by capability, live provider never (no approved vendor)', async () => {
    expect(await composition({ capability: 'not_granted' }).svc.captureModes(auth)).toEqual({
      recruiter_notes: { status: 'available' },
      teams_post_meeting: { status: 'not_granted' },
      live_external_provider: { status: 'no_approved_provider' },
    });
    expect((await composition().svc.captureModes(auth)).teams_post_meeting.status).toBe('available');
  });

  it('transcript check: non-organizer 403 and missing transcription consent 403 — both before any Graph call', async () => {
    const notOrganizer = composition({ organizer: OTHER });
    await expect(notOrganizer.svc.checkTranscripts({ auth, session: linked, requestId: 'rq' })).rejects.toMatchObject({ code: 'MICROSOFT_MEETING_NOT_ORGANIZER' });
    expect(notOrganizer.artifacts.listTranscriptRefs).not.toHaveBeenCalled();

    const noConsent = composition({ consent: { transcription: false } });
    await expect(noConsent.svc.checkTranscripts({ auth, session: linked, requestId: 'rq' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'transcription_not_authorized' } },
    });
    expect(noConsent.artifacts.listTranscriptRefs).not.toHaveBeenCalled();
    expect(noConsent.transcripts.registerTranscriptAvailability).not.toHaveBeenCalled();

    const noMeeting = composition();
    await expect(noMeeting.svc.checkTranscripts({ auth, session: draft, requestId: 'rq' })).rejects.toMatchObject({ context: { details: { reason: 'no_meeting_linked' } } });
  });

  it('transcript check: register → authorized acquire → normalize → link, keyed to the meeting interaction', async () => {
    const c = composition();
    const r = await c.svc.checkTranscripts({ auth, session: linked, requestId: 'rq' });
    expect(c.transcripts.registerTranscriptAvailability).toHaveBeenCalledWith(expect.objectContaining({
      interaction_id: INTERACTION, provider_key: 'microsoft_teams', provider_transcript_id: 'tr-1', provider_resource_ref: `${INTERACTION}:MSo1`,
    }));
    expect(c.transcripts.acquire).toHaveBeenCalledWith(expect.objectContaining({ authorization: { transcription_authorized: true } }));
    expect(c.normalization.normalize).toHaveBeenCalledWith({ tenant_id: TENANT, transcript_id: 'ct-1', source_format: 'microsoft_teams_transcript' });
    expect(c.screening.linkTranscript).toHaveBeenCalledWith(expect.objectContaining({ conversation_transcript_id: 'ct-1', source: 'TEAMS_GRAPH' }));
    // A1-5 — the CI screening profile is scheduled for the linked transcript;
    // with CI processing dark (the default) the status says so honestly.
    expect(c.analysis.scheduleScreening).toHaveBeenCalledWith(expect.objectContaining({
      conversation_transcript_id: 'ct-1', screening_session_id: SESSION_ID, requisition_id: null,
    }));
    expect(r.items).toEqual([{ conversation_transcript_id: 'ct-1', provider_transcript_id: 'tr-1', state: 'normalized', linked: true, analysis: 'disabled' }]);
  });

  it('a transcript that fails acquisition is reported, not linked', async () => {
    const c = composition();
    c.transcripts.acquire.mockResolvedValue({ id: 'ct-1', state: 'failed_terminal' });
    const r = await c.svc.checkTranscripts({ auth, session: linked, requestId: 'rq' });
    expect(c.normalization.normalize).not.toHaveBeenCalled();
    expect(c.screening.linkTranscript).not.toHaveBeenCalled();
    expect(c.analysis.scheduleScreening).not.toHaveBeenCalled();
    expect(r.items[0]).toMatchObject({ state: 'failed_terminal', linked: false, analysis: null });
  });
});
