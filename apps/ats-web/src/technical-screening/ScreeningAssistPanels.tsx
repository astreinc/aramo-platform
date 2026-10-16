import { useEffect, useState } from 'react';
import { Checkbox, Input, TextArea } from '@aramo/fe-foundation';

import { llmProviderLabel } from '../integrations/integration-vocab';
import { Button, StatusPill } from '../ui';
import { codeLabel } from '../ui/code-label';
import type { PillTone } from '../ui/pills';

import {
  getScreeningCaptureModes,
  getScreeningCitationExcerpt,
  type CaptureModeStatus,
  type ScreeningAnalysis,
  type ScreeningCaptureModes,
  type ScreeningCitation,
  type ScreeningCitationExcerpt,
  type ScreeningFinding,
  type ScreeningQuestion,
  type ScreeningSessionDetail,
  type ScreeningTranscriptCheckItem,
} from './technical-screening-api';

// TIP-E2E INC-3 A1-7 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §1.1, §B.2–§B.4, R-C) —
// the AI-assisted screening workflow panels. Presentation only: every rule
// (consent, capability, organizer, DRAFT-only, CAS, review-before-confirm) is
// server-side. Copy is honest: AI output is a DRAFT the recruiter accepts,
// edits or rejects; unavailable capture modes are shown as unavailable; no
// external capture vendor is presented as live.

// ---- Prepare: the question plan -------------------------------------------

export function QuestionPlanPanel(props: {
  detail: ScreeningSessionDetail;
  busy: boolean;
  canEdit: boolean;
  onGenerate: (includeTalentProfile: boolean) => Promise<boolean>;
  onAdd: (text: string) => Promise<boolean>;
  onUpdate: (questionId: string, patch: { text?: string; status?: ScreeningQuestion['status'] }) => Promise<boolean>;
}) {
  const { detail, busy, canEdit } = props;
  const draft = detail.session.state === 'DRAFT';
  const [useProfile, setUseProfile] = useState(true);
  const [own, setOwn] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const visible = detail.questions.filter((q) => q.status !== 'REMOVED');
  const lastPlan = [...detail.generations].reverse().find((g) => g.kind === 'QUESTION_PLAN');

  return (
    <section className="ts-panel" aria-label="Question plan">
      <h2 className="ts-panel__title">1 · Prepare questions</h2>
      <p className="ts-muted">
        Generate technical questions from the {detail.session.requisition_id !== null ? 'requisition and ' : ''}talent context,
        then edit, remove or select the ones you will ask. AI-generated questions are suggestions until you select them.
      </p>
      {draft && canEdit && (
        <div className="ts-form__actions">
          <label className="ts-check">
            <Checkbox checked={useProfile} onChange={(e) => setUseProfile(e.target.checked)} />
            <span>Include the talent profile (requires the talent’s AI processing consent)</span>
          </label>
          <Button variant="secondary" onClick={() => void props.onGenerate(useProfile)} disabled={busy}>
            {detail.questions.some((q) => q.origin === 'AI_GENERATED') ? 'Regenerate questions' : 'Generate questions'}
          </Button>
        </div>
      )}
      {lastPlan !== undefined && (
        <p className="ts-muted">
          Last generated with {llmProviderLabel(lastPlan.provider)} · {lastPlan.model}
          {lastPlan.used_talent_profile ? ' · talent profile used' : ' · requisition context only'}
        </p>
      )}
      {visible.length === 0 ? (
        <p className="ts-muted">No questions yet.</p>
      ) : (
        <ol className="ts-questions">
          {visible.map((q) => (
            <li key={q.id} className="ts-question">
              {editing === q.id ? (
                <div className="ts-form__actions">
                  <Input value={text} onChange={(e) => setText(e.target.value)} aria-label="Question text" maxLength={1000} />
                  <Button
                    variant="primary"
                    disabled={busy || text.trim() === ''}
                    onClick={async () => {
                      if (await props.onUpdate(q.id, { text: text.trim() })) setEditing(null);
                    }}
                  >
                    Save
                  </Button>
                  <Button variant="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <span className="ts-question__text">{q.text}</span>
                  <span className="ts-question__meta">
                    <StatusPill tone={q.origin === 'AI_GENERATED' ? 'info' : 'neutral'}>
                      {q.origin === 'AI_GENERATED' ? (q.edited ? 'AI-generated · edited' : 'AI-generated') : 'Your question'}
                    </StatusPill>
                    {q.status === 'SELECTED' && <StatusPill tone="ok">Selected</StatusPill>}
                  </span>
                  {draft && canEdit && (
                    <span className="ts-form__actions">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void props.onUpdate(q.id, { status: q.status === 'SELECTED' ? 'PROPOSED' : 'SELECTED' })}
                      >
                        {q.status === 'SELECTED' ? 'Deselect' : 'Select'}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setEditing(q.id);
                          setText(q.text);
                        }}
                      >
                        Edit
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => void props.onUpdate(q.id, { status: 'REMOVED' })}>
                        Remove
                      </Button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {draft && canEdit && (
        <form
          className="ts-form__actions"
          onSubmit={async (e) => {
            e.preventDefault();
            if (own.trim() !== '' && (await props.onAdd(own.trim()))) setOwn('');
          }}
        >
          <Input value={own} onChange={(e) => setOwn(e.target.value)} aria-label="Add your own question" placeholder="Add your own question" maxLength={1000} />
          <Button variant="secondary" type="submit" disabled={busy || own.trim() === ''}>
            Add question
          </Button>
        </form>
      )}
    </section>
  );
}

// ---- Schedule: the Teams meeting + honest capture modes -------------------

export const CAPTURE_STATUS_LABEL: Record<CaptureModeStatus, { text: string; tone: PillTone }> = {
  available: { text: 'Available', tone: 'ok' },
  not_granted: { text: 'Not enabled — meeting transcripts not authorized for your Microsoft account', tone: 'neutral' },
  not_connected: { text: 'Unavailable — Microsoft 365 not connected', tone: 'neutral' },
  reauth_required: { text: 'Reconnect Microsoft 365 to use transcripts', tone: 'warn' },
  no_approved_provider: { text: 'Not available — no approved live capture provider', tone: 'neutral' },
};

// The honest per-session capture picture: four independent states. A requested
// recording is a request (Teams policy decides), never proof of a recording;
// a linked transcript is not attendance or completion proof.
export const RECORDING_LABEL: Record<ScreeningCaptureModes['recording']['status'], { text: string; tone: PillTone }> = {
  not_applicable: { text: 'No meeting scheduled', tone: 'neutral' },
  requested: { text: 'Automatic recording requested — Teams policy decides whether it records', tone: 'info' },
  not_requested: { text: 'Not requested (recording consent or meeting-artifact access absent)', tone: 'neutral' },
};

export function CaptureModes({ sessionId, refreshKey }: { sessionId: string; refreshKey?: string }) {
  const [modes, setModes] = useState<ScreeningCaptureModes | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getScreeningCaptureModes(sessionId)
      .then((m) => !cancelled && setModes(m))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);
  if (failed) return <p className="ts-muted">Capture modes could not be loaded.</p>;
  if (modes === null) return <p className="ts-muted">Checking capture modes…</p>;
  const pill = (text: string, tone: PillTone) => <StatusPill tone={tone}>{text}</StatusPill>;
  const teams = CAPTURE_STATUS_LABEL[modes.teams_post_meeting.status];
  const transcript =
    modes.transcript.status === 'linked'
      ? pill(`${modes.transcript.count} transcript(s) linked`, 'ok')
      : modes.teams_post_meeting.status === 'available'
        ? pill(modes.meeting.status === 'scheduled' ? 'None yet — available after the meeting' : 'None — no meeting scheduled', 'neutral')
        : pill(teams.text, teams.tone);
  return (
    <ul className="ts-modes" aria-label="Capture modes">
      <li>
        <span>Teams meeting</span>{' '}
        {modes.meeting.status === 'scheduled' ? pill('Scheduled', 'ok') : pill('Not scheduled', 'neutral')}
      </li>
      <li>
        <span>Recording</span> {pill(RECORDING_LABEL[modes.recording.status].text, RECORDING_LABEL[modes.recording.status].tone)}
      </li>
      <li>
        <span>Teams transcript (after the meeting)</span> {transcript}
      </li>
      <li>
        <span>Recruiter notes</span> {pill(CAPTURE_STATUS_LABEL[modes.recruiter_notes.status].text, CAPTURE_STATUS_LABEL[modes.recruiter_notes.status].tone)}
      </li>
      <li>
        <span>Live transcript suggestions</span>{' '}
        {pill(CAPTURE_STATUS_LABEL[modes.live_external_provider.status].text, CAPTURE_STATUS_LABEL[modes.live_external_provider.status].tone)}
      </li>
    </ul>
  );
}

export function MeetingPanel(props: {
  detail: ScreeningSessionDetail;
  busy: boolean;
  canSchedule: boolean;
  onSchedule: (slot: { subject: string; start_date_time: string; end_date_time: string; time_zone: string }) => Promise<string | null>;
}) {
  const { detail, busy } = props;
  const draft = detail.session.state === 'DRAFT';
  const [subject, setSubject] = useState('Technical screening');
  const [start, setStart] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [scheduled, setScheduled] = useState<string | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const valid = subject.trim() !== '' && start !== '' && Number(minutes) > 0;

  return (
    <section className="ts-panel" aria-label="Interview meeting">
      <h2 className="ts-panel__title">2 · Schedule the Teams interview</h2>
      {detail.session.interaction_id !== null ? (
        <p className="ts-muted">A Teams meeting is linked to this screening{scheduled !== null ? ` (${scheduled})` : ''}.</p>
      ) : draft && props.canSchedule ? (
        <form
          className="ts-form"
          aria-label="Schedule meeting"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid) return;
            const startDate = new Date(start);
            const endDate = new Date(startDate.getTime() + Number(minutes) * 60_000);
            const note = await props.onSchedule({
              subject: subject.trim(),
              start_date_time: startDate.toISOString(),
              end_date_time: endDate.toISOString(),
              time_zone: timeZone,
            });
            if (note !== null) setScheduled(note);
          }}
        >
          <label className="ts-field">
            <span>Subject</span>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Meeting subject" maxLength={1024} />
          </label>
          <label className="ts-field">
            <span>Start</span>
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Meeting start" />
          </label>
          <label className="ts-field">
            <span>Duration (minutes)</span>
            <Input type="number" min={5} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Meeting duration" />
          </label>
          <div className="ts-form__actions">
            <Button variant="primary" type="submit" disabled={!valid || busy}>
              Schedule Teams meeting
            </Button>
            <span className="ts-muted">Uses your connected Microsoft 365 calendar; the invitation follows contact consent.</span>
          </div>
        </form>
      ) : (
        <p className="ts-muted">No meeting linked.</p>
      )}
      <CaptureModes
        sessionId={detail.session.id}
        refreshKey={`${detail.session.interaction_id ?? ''}:${detail.transcripts.length}:${detail.session.version}`}
      />
    </section>
  );
}

// ---- Interview: checklist, notes, follow-up suggestions -------------------

export function InterviewPanel(props: {
  detail: ScreeningSessionDetail;
  busy: boolean;
  canEdit: boolean;
  onNote: (body: string) => Promise<boolean>;
  onSuggest: (noteId: string) => Promise<boolean>;
  onAction: (suggestionId: string, action: 'USED' | 'DISMISSED') => Promise<boolean>;
}) {
  const { detail, busy, canEdit } = props;
  const draft = detail.session.state === 'DRAFT';
  const selected = detail.questions.filter((q) => q.status === 'SELECTED');
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  return (
    <section className="ts-panel" aria-label="Interview">
      <h2 className="ts-panel__title">3 · Interview</h2>
      {selected.length === 0 ? (
        <p className="ts-muted">Select questions above to build your checklist.</p>
      ) : (
        <ul className="ts-checklist" aria-label="Question checklist">
          {selected.map((q) => (
            <li key={q.id}>
              <label className="ts-check">
                <Checkbox
                  checked={asked.has(q.id)}
                  onChange={() =>
                    setAsked((cur) => {
                      const next = new Set(cur);
                      if (next.has(q.id)) next.delete(q.id);
                      else next.add(q.id);
                      return next;
                    })
                  }
                />
                <span>{q.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {draft && canEdit && (
        <form
          className="ts-form"
          aria-label="Interview note"
          onSubmit={async (e) => {
            e.preventDefault();
            if (note.trim() !== '' && (await props.onNote(note.trim()))) setNote('');
          }}
        >
          <TextArea unstyled className="ts-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Interview note" placeholder="What did the talent say?" />
          <div className="ts-form__actions">
            <Button variant="secondary" type="submit" disabled={busy || note.trim() === ''}>
              Add note
            </Button>
          </div>
        </form>
      )}
      {detail.notes.length > 0 && (
        <ul className="ts-notes" aria-label="Interview notes">
          {detail.notes.map((n) => {
            const suggestions = detail.suggestions.filter(
              (s) => s.trigger_kind === 'NOTE' && (s.trigger_ref as { note_id?: string } | null)?.note_id === n.id,
            );
            return (
              <li key={n.id} className="ts-note">
                <p className="ts-finding__text">{n.body}</p>
                {draft && canEdit && suggestions.length === 0 && (
                  <Button variant="secondary" disabled={busy} onClick={() => void props.onSuggest(n.id)}>
                    Suggest follow-up questions
                  </Button>
                )}
                {suggestions.length > 0 && (
                  <ul className="ts-suggestions" aria-label="AI follow-up suggestions">
                    {suggestions.map((s) => (
                      <li key={s.id}>
                        <StatusPill tone="info">AI suggestion</StatusPill> <span>{s.text}</span>{' '}
                        {s.action === null && draft && canEdit ? (
                          <>
                            <Button variant="secondary" disabled={busy} onClick={() => void props.onAction(s.id, 'USED')}>
                              Use
                            </Button>
                            <Button variant="secondary" disabled={busy} onClick={() => void props.onAction(s.id, 'DISMISSED')}>
                              Dismiss
                            </Button>
                          </>
                        ) : (
                          s.action !== null && <span className="ts-muted">{s.action === 'USED' ? 'Used' : 'Dismissed'}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- Transcript + AI-drafted findings ---------------------------------------

export const ANALYSIS_LABEL: Record<string, string> = {
  queued: 'AI drafting queued',
  processing: 'AI drafting in progress',
  completed: 'AI drafts ready for review',
  failed_retryable: 'AI drafting will retry',
  intervention_required: 'AI drafting needs attention',
  failed_terminal: 'AI drafting failed',
  blocked_not_authorized: 'Not drafted — AI processing consent missing',
};

// Run error codes with a recruiter-meaningful explanation.
export const ANALYSIS_ERROR_LABEL: Record<string, string> = {
  SCREENING_CONTEXT_CHANGED: 'Not drafted — the question plan or notes changed after the transcript was linked; check the transcript again',
  SCREENING_SESSION_NOT_DRAFT: 'Not drafted — the screening was already confirmed or voided',
};

export const SCHEDULE_LABEL: Record<string, string> = {
  queued: 'AI drafting queued',
  disabled: 'AI drafting from transcripts is not enabled for this environment',
  config_invalid: 'AI drafting is not configured',
  transcript_not_ready: 'Transcript not ready yet',
  session_unavailable: 'Not drafted — the screening is no longer a draft',
};

// libs/conversation-transcript TRANSCRIPT_STATES — why a checked transcript is not usable yet.
export const TRANSCRIPT_STATE_LABELS: Readonly<Record<string, string>> = {
  waiting_for_source: 'Waiting for the transcript',
  source_available: 'Transcript available',
  acquiring: 'Retrieving',
  source_ready: 'Retrieved',
  expired: 'Expired',
  failed_retryable: 'Retrieval failed, will retry',
  intervention_required: 'Needs attention',
  failed_terminal: 'Retrieval failed',
  normalizing: 'Processing',
  normalized: 'Processed',
  normalization_failed_retryable: 'Processing failed, will retry',
  normalization_intervention_required: 'Processing needs attention',
  normalization_failed_terminal: 'Processing failed',
};

export function TranscriptPanel(props: {
  detail: ScreeningSessionDetail;
  busy: boolean;
  canCheck: boolean;
  onCheck: () => Promise<ScreeningTranscriptCheckItem[] | null>;
}) {
  const { detail, busy } = props;
  const [checked, setChecked] = useState<ScreeningTranscriptCheckItem[] | null>(null);
  const draft = detail.session.state === 'DRAFT';
  const byTranscript = new Map<string, ScreeningAnalysis>(detail.analyses.map((a) => [a.conversation_transcript_id, a]));

  return (
    <section className="ts-panel" aria-label="Meeting transcript">
      <h2 className="ts-panel__title">4 · Transcript and AI drafts</h2>
      <p className="ts-muted">
        Teams transcripts are available only after the meeting, for meetings you organized, when your organization has
        enabled transcript access and the talent has consented to transcription.
      </p>
      {draft && props.canCheck && detail.session.interaction_id !== null && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            const items = await props.onCheck();
            if (items !== null) setChecked(items);
          }}
        >
          Check for the Teams transcript
        </Button>
      )}
      {checked !== null && checked.length === 0 && <p className="ts-muted">No transcript is available yet.</p>}
      {checked !== null &&
        checked.map((c) => (
          <p key={c.conversation_transcript_id} className="ts-muted">
            Transcript {c.linked ? 'linked' : `not usable (${codeLabel(TRANSCRIPT_STATE_LABELS, c.state).toLowerCase()})`}
            {c.analysis !== null ? ` · ${codeLabel(SCHEDULE_LABEL, c.analysis)}` : ''}
          </p>
        ))}
      {detail.transcripts.length > 0 && (
        <ul className="ts-modes" aria-label="Linked transcripts">
          {detail.transcripts.map((t) => {
            const a = byTranscript.get(t.conversation_transcript_id);
            return (
              <li key={t.conversation_transcript_id}>
                <span>Teams transcript · {new Date(t.created_at).toLocaleString()}</span>{' '}
                <StatusPill tone={a?.status === 'completed' ? 'ok' : 'neutral'}>
                  {a === undefined
                    ? 'No AI drafting'
                    : (a.last_error_code !== null ? ANALYSIS_ERROR_LABEL[a.last_error_code] : undefined) ?? ANALYSIS_LABEL[a.status] ?? a.status}
                </StatusPill>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The provenance line of a finding: who authored it and what it rests on.
export function provenanceLabel(f: ScreeningFinding): string {
  const source =
    f.evidence_source === 'MEETING_TRANSCRIPT' ? 'from the meeting transcript' : f.evidence_source === 'RECRUITER_NOTES' ? 'from your notes' : 'recruiter observation';
  if (f.origin === 'RECRUITER_AUTHORED') return `Your finding · ${source}`;
  const review =
    f.review_status === 'EDITED' ? 'edited by you' : f.review_status === 'CONFIRMED' ? 'accepted by you' : f.review_status === 'REJECTED' ? 'rejected' : 'awaiting your review';
  return `AI-drafted · ${source} · ${review}`;
}

export function AiFindingReview(props: {
  sessionId: string;
  finding: ScreeningFinding;
  citations: ScreeningCitation[];
  busy: boolean;
  canEdit: boolean;
  canReadTranscript: boolean;
  draft: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  const { finding: f } = props;
  const [showOriginal, setShowOriginal] = useState(false);
  const [excerpts, setExcerpts] = useState<Record<string, ScreeningCitationExcerpt | 'error'>>({});
  const pending = f.origin === 'AI_DRAFTED' && f.review_status === 'DRAFT';

  return (
    <div className="ts-ai-review">
      {f.origin === 'AI_DRAFTED' && f.review_status === 'EDITED' && f.ai_original !== null && (
        <Button unstyled type="button" className="ts-link" onClick={() => setShowOriginal((v) => !v)}>
          {showOriginal ? 'Hide AI original' : 'Show AI original'}
        </Button>
      )}
      {showOriginal && f.ai_original !== null && (
        <p className="ts-finding__text ts-original">
          <span className="ts-muted">AI original: </span>
          {f.ai_original.observation_raw}
        </p>
      )}
      {props.citations.length > 0 && (
        <ul className="ts-citations" aria-label="Transcript citations">
          {props.citations.map((c) => {
            const ex = excerpts[c.id];
            return (
              <li key={c.id}>
                {props.canReadTranscript ? (
                  ex === undefined ? (
                    <Button
                      unstyled
                      type="button"
                      className="ts-link"
                      onClick={() =>
                        void getScreeningCitationExcerpt(props.sessionId, c.id)
                          .then((x) => setExcerpts((cur) => ({ ...cur, [c.id]: x })))
                          .catch(() => setExcerpts((cur) => ({ ...cur, [c.id]: 'error' })))
                      }
                    >
                      View cited transcript excerpt
                    </Button>
                  ) : ex === 'error' ? (
                    <span className="ts-muted">The transcript is no longer available (deleted under the retention rule or unavailable).</span>
                  ) : (
                    <blockquote className="ts-excerpt">“{ex.excerpt}”</blockquote>
                  )
                ) : (
                  <span className="ts-muted">Transcript citation (you do not have transcript access)</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pending && props.draft && props.canEdit && (
        <div className="ts-finding__actions">
          <Button variant="primary" disabled={props.busy} onClick={props.onAccept}>
            Accept as drafted
          </Button>
          <Button variant="secondary" disabled={props.busy} onClick={props.onEdit}>
            Edit
          </Button>
          <Button variant="secondary" disabled={props.busy} onClick={props.onReject}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

export function ConsentHint() {
  return (
    <p className="ts-muted ts-hint">
      AI assistance uses your organization’s configured AI provider. Talent content is sent only with the talent’s AI
      processing consent, and personal identifiers are removed before sending.
    </p>
  );
}
