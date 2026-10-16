import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Dialog, InlineAlert, Input, Select, TextArea, hasScope, useSession } from '@aramo/fe-foundation';

import { listRequisitions } from '../requisitions/requisitions-api';
import { AttestCheckbox, Button, EmptyState, ErrorState, LoadingState, StatusPill, safeErrorMessage } from '../ui';
import type { PillTone } from '../ui/pills';

import {
  AiFindingReview,
  ConsentHint,
  InterviewPanel,
  MeetingPanel,
  QuestionPlanPanel,
  TranscriptPanel,
  provenanceLabel,
} from './ScreeningAssistPanels';
import {
  actionScreeningSuggestion,
  addScreeningFinding,
  addScreeningNote,
  addScreeningQuestion,
  checkScreeningTranscripts,
  confirmScreeningSession,
  createScreeningSession,
  editScreeningFinding,
  generateScreeningQuestions,
  getScreeningSession,
  listScreeningSessions,
  removeScreeningFinding,
  requestScreeningSuggestions,
  retryScreeningPublication,
  reviewScreeningFinding,
  scheduleScreeningMeeting,
  updateScreeningQuestion,
  voidScreeningSession,
  type ScreeningBasis,
  type ScreeningCitation,
  type ScreeningFinding,
  type ScreeningFindingInput,
  type ScreeningPublication,
  type ScreeningSession,
  type ScreeningSessionDetail,
  type ScreeningTranscriptCheckItem,
} from './technical-screening-api';
import './technical-screening.css';

// TIP-E2E INC-3 — Technical Screening (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §11, as
// amended by ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED A1-7). Route
// `talent/:talentId/screening`, entered from the Talent 360 header. The FE OWNS
// ONLY PRESENTATION STATE: every lifecycle rule (DRAFT-only edits, version CAS,
// consent, review-before-confirm, attestation, exactly-once publication) is
// enforced server-side; a 409 here means "someone changed it" and the view
// reloads. Copy is honest: AI output is a draft the recruiter accepts, edits or
// rejects; confirmed findings are recruiter-attested, never verification.

export const BASIS_LABEL: Record<ScreeningBasis, string> = {
  SELF_REPORTED: 'Self-reported by the talent',
  RECRUITER_OBSERVED: 'Observed in conversation',
  DEMONSTRATED: 'Observed by the recruiter (not independently verified)',
};

// Directive §5 — the honest trust-status vocabulary. "Corrected" is never shown.
export const TRUST_STATUS_LABEL: Record<string, string> = {
  VALID: 'Published',
  DISPUTED: 'Contested — under review',
  REVOKED: 'Withdrawn after dispute — not corrected',
  CONTRADICTED: 'Contradicted by other evidence',
  STALE: 'Stale',
};

const STALE_PENDING_MS = 10 * 60 * 1000;

const SESSION_TONE: Record<ScreeningSession['state'], PillTone> = {
  DRAFT: 'info',
  CONFIRMED: 'ok',
  VOIDED: 'neutral',
};

const isConflict = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 409;

export function TechnicalScreeningView() {
  const { talentId = '' } = useParams();
  const sessionState = useSession();
  const auth = sessionState.status === 'authenticated' ? sessionState.session : null;
  const canCreate = auth !== null && hasScope(auth, 'screening:create');
  const canEdit = auth !== null && hasScope(auth, 'screening:edit');
  const canConfirm = auth !== null && hasScope(auth, 'screening:confirm');
  const canSchedule = canEdit && auth !== null && hasScope(auth, 'communication:meeting:create');
  const canReadTranscript = auth !== null && hasScope(auth, 'screening:transcript:read');

  const [sessions, setSessions] = useState<ScreeningSession[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScreeningSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const { items } = await listScreeningSessions(talentId);
      setSessions(items);
      setSelectedId((cur) => cur ?? items[0]?.id ?? null);
    } catch (e) {
      setError(safeErrorMessage(e, 'We couldn’t load technical screenings for this talent.'));
    }
  }, [talentId]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await getScreeningSession(id));
    } catch (e) {
      setError(safeErrorMessage(e, 'We couldn’t load this screening.'));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  // Run a mutation; on success adopt the returned detail; on 409 reload.
  const mutate = async (op: () => Promise<ScreeningSessionDetail>, failure: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const next = await op();
      setDetail(next);
      setSessions((cur) => cur?.map((s) => (s.id === next.session.id ? next.session : s)) ?? cur);
      return true;
    } catch (e) {
      if (isConflict(e) && selectedId !== null) {
        setNotice('This screening changed since you opened it. It has been reloaded.');
        await loadDetail(selectedId);
      } else {
        setNotice(safeErrorMessage(e, failure));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A mutation whose response wraps the detail (meeting / transcript check).
  const mutateWith = async <T,>(
    op: () => Promise<T & { session: ScreeningSessionDetail }>,
    failure: string,
  ): Promise<T | null> => {
    let result: (T & { session: ScreeningSessionDetail }) | null = null;
    const ok = await mutate(async () => {
      result = await op();
      return result.session;
    }, failure);
    return ok ? result : null;
  };

  const [startOpen, setStartOpen] = useState(false);
  const start = async (requisitionId: string | null): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const created = await createScreeningSession(talentId, requisitionId);
      setSessions((cur) => [created, ...(cur ?? [])]);
      setSelectedId(created.id);
      return true;
    } catch (e) {
      setNotice(safeErrorMessage(e, 'We couldn’t start a screening.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error !== null) return <ErrorState message={error} onRetry={() => void loadList()} />;
  if (sessions === null) return <LoadingState label="Loading technical screenings…" />;

  return (
    <div className="ts-page">
      <div className="ts-head">
        <div>
          <Link to={`/talent/${talentId}`} className="ts-back">
            ← Back to talent
          </Link>
          <h1 className="ts-title">Technical screening</h1>
          <p className="ts-sub">
            Prepare questions, interview, and record what the talent said or showed. AI suggestions and drafts are
            yours to accept, edit or reject. Confirmed findings become recruiter-attested evidence — not independent
            verification.
          </p>
        </div>
        {canCreate && (
          <Button variant="primary" onClick={() => setStartOpen(true)} disabled={busy}>
            Start screening
          </Button>
        )}
      </div>
      {startOpen && (
        <StartDialog
          busy={busy}
          onClose={() => setStartOpen(false)}
          onStart={async (reqId) => {
            if (await start(reqId)) setStartOpen(false);
          }}
        />
      )}

      {notice !== null && <InlineAlert variant="error">{notice}</InlineAlert>}

      {sessions.length === 0 ? (
        <EmptyState
          title="No technical screenings yet"
          message={canCreate ? 'Start a screening to record findings.' : 'No screening has been recorded for this talent.'}
        />
      ) : (
        <div className="ts-body">
          <ul className="ts-list" aria-label="Screening sessions">
            {sessions.map((s) => (
              <li key={s.id}>
                <Button
                  unstyled
                  type="button"
                  className={`ts-list__item${s.id === selectedId ? ' ts-list__item--active' : ''}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span>{new Date(s.created_at).toLocaleDateString()}</span>
                  <StatusPill tone={SESSION_TONE[s.state]}>{stateLabel(s.state)}</StatusPill>
                </Button>
              </li>
            ))}
          </ul>
          <section className="ts-detail" aria-label="Screening detail">
            {detail === null ? (
              <LoadingState label="Loading screening…" />
            ) : (
              <SessionDetail
                detail={detail}
                busy={busy}
                canEdit={canEdit}
                canConfirm={canConfirm}
                canSchedule={canSchedule}
                canReadTranscript={canReadTranscript}
                onGenerate={(includeProfile) =>
                  mutate(() => generateScreeningQuestions(detail.session.id, includeProfile), 'We couldn’t generate questions.')
                }
                onAddQuestion={(text) => mutate(() => addScreeningQuestion(detail.session.id, text), 'We couldn’t add the question.')}
                onUpdateQuestion={(questionId, patch) =>
                  mutate(() => updateScreeningQuestion(detail.session.id, questionId, patch), 'We couldn’t update the question.')
                }
                onNote={(body) => mutate(() => addScreeningNote(detail.session.id, body), 'We couldn’t save the note.')}
                onSuggest={(noteId) =>
                  mutate(() => requestScreeningSuggestions(detail.session.id, noteId), 'We couldn’t get follow-up suggestions.')
                }
                onSuggestionAction={(suggestionId, action) =>
                  mutate(() => actionScreeningSuggestion(detail.session.id, suggestionId, action), 'We couldn’t record that.')
                }
                onSchedule={async (slot) => {
                  const r = await mutateWith<{ meeting: { join_url: string | null } }>(
                    () => scheduleScreeningMeeting(detail.session.id, slot),
                    'We couldn’t schedule the Teams meeting.',
                  );
                  return r === null ? null : r.meeting.join_url !== null ? 'invitation sent' : 'scheduled';
                }}
                onCheckTranscripts={async () => {
                  const r = await mutateWith<{ items: ScreeningTranscriptCheckItem[] }>(
                    () => checkScreeningTranscripts(detail.session.id),
                    'We couldn’t retrieve the Teams transcript.',
                  );
                  return r === null ? null : r.items;
                }}
                onReview={(findingId, outcome) =>
                  mutate(
                    () => reviewScreeningFinding(detail.session.id, findingId, detail.session.version, outcome),
                    'We couldn’t record your review.',
                  )
                }
                onAdd={(input) =>
                  mutate(() => addScreeningFinding(detail.session.id, detail.session.version, input), 'We couldn’t add the finding.')
                }
                onEdit={(findingId, input) =>
                  mutate(
                    () => editScreeningFinding(detail.session.id, findingId, detail.session.version, input),
                    'We couldn’t save the finding.',
                  )
                }
                onRemove={(findingId) =>
                  mutate(
                    () => removeScreeningFinding(detail.session.id, findingId, detail.session.version),
                    'We couldn’t remove the finding.',
                  )
                }
                onConfirm={() =>
                  mutate(
                    () => confirmScreeningSession(detail.session.id, detail.session.version, confirmableIds(detail.findings)),
                    'We couldn’t confirm this screening.',
                  )
                }
                onVoid={(reason) =>
                  mutate(() => voidScreeningSession(detail.session.id, detail.session.version, reason), 'We couldn’t void this screening.')
                }
                onRetry={() => mutate(() => retryScreeningPublication(detail.session.id), 'Publishing failed again. Try later.')}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

// A1 §B.2 — the confirmed set is every finding except rejected AI drafts.
export function confirmableIds(findings: ScreeningFinding[]): string[] {
  return findings.filter((f) => f.review_status !== 'REJECTED').map((f) => f.id);
}

const unreviewed = (findings: ScreeningFinding[]): number =>
  findings.filter((f) => f.origin === 'AI_DRAFTED' && f.review_status === 'DRAFT').length;

function stateLabel(s: ScreeningSession['state']): string {
  return s === 'DRAFT' ? 'Draft' : s === 'CONFIRMED' ? 'Confirmed' : 'Voided';
}

function SessionDetail(props: {
  detail: ScreeningSessionDetail;
  busy: boolean;
  canEdit: boolean;
  canConfirm: boolean;
  canSchedule: boolean;
  canReadTranscript: boolean;
  onGenerate: (includeProfile: boolean) => Promise<boolean>;
  onAddQuestion: (text: string) => Promise<boolean>;
  onUpdateQuestion: (questionId: string, patch: { text?: string; status?: 'PROPOSED' | 'SELECTED' | 'REMOVED' }) => Promise<boolean>;
  onNote: (body: string) => Promise<boolean>;
  onSuggest: (noteId: string) => Promise<boolean>;
  onSuggestionAction: (suggestionId: string, action: 'USED' | 'DISMISSED') => Promise<boolean>;
  onSchedule: (slot: { subject: string; start_date_time: string; end_date_time: string; time_zone: string }) => Promise<string | null>;
  onCheckTranscripts: () => Promise<ScreeningTranscriptCheckItem[] | null>;
  onReview: (findingId: string, outcome: 'CONFIRMED' | 'REJECTED') => Promise<boolean>;
  onAdd: (input: ScreeningFindingInput) => Promise<boolean>;
  onEdit: (findingId: string, input: ScreeningFindingInput) => Promise<boolean>;
  onRemove: (findingId: string) => Promise<boolean>;
  onConfirm: () => Promise<boolean>;
  onVoid: (reason: string | null) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}) {
  const { detail, busy } = props;
  const { session, findings, publications } = detail;
  const draft = session.state === 'DRAFT';
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const byFinding = new Map(publications.map((p) => [p.finding_id, p]));
  const hasPending = publications.some((p) => p.state === 'PENDING');
  const citationsBy = new Map<string, ScreeningCitation[]>();
  for (const c of detail.citations) citationsBy.set(c.finding_id, [...(citationsBy.get(c.finding_id) ?? []), c]);
  const pendingReview = unreviewed(findings);

  return (
    <>
      <div className="ts-detail__head">
        <StatusPill tone={SESSION_TONE[session.state]}>{stateLabel(session.state)}</StatusPill>
        <span className="ts-muted">Version {session.version}</span>
        {session.state === 'VOIDED' && session.void_reason !== null && (
          <span className="ts-muted">Reason: {session.void_reason}</span>
        )}
      </div>

      {draft && <ConsentHint />}
      <QuestionPlanPanel
        detail={detail}
        busy={busy}
        canEdit={props.canEdit}
        onGenerate={props.onGenerate}
        onAdd={props.onAddQuestion}
        onUpdate={props.onUpdateQuestion}
      />
      <MeetingPanel detail={detail} busy={busy} canSchedule={props.canSchedule} onSchedule={props.onSchedule} />
      <InterviewPanel
        detail={detail}
        busy={busy}
        canEdit={props.canEdit}
        onNote={props.onNote}
        onSuggest={props.onSuggest}
        onAction={props.onSuggestionAction}
      />
      <TranscriptPanel
        detail={detail}
        busy={busy}
        canCheck={props.canEdit && props.canReadTranscript}
        onCheck={props.onCheckTranscripts}
      />

      <h2 className="ts-panel__title">5 · Findings</h2>
      {pendingReview > 0 && draft && (
        <p className="ts-muted" role="status">
          {pendingReview} AI-drafted finding(s) await your review. Accept, edit or reject each before confirming.
        </p>
      )}

      {findings.length === 0 ? (
        <EmptyState message={draft ? 'Add the first finding.' : 'This screening has no findings.'} />
      ) : (
        <ol className="ts-findings">
          {findings.map((f) =>
            editing === f.id ? (
              <li key={f.id}>
                <FindingForm
                  initial={f}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (input) => {
                    if (await props.onEdit(f.id, input)) setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={f.id} className={`ts-finding${f.review_status === 'REJECTED' ? ' ts-finding--rejected' : ''}`}>
                <FindingCard finding={f} publication={byFinding.get(f.id)} />
                {f.origin === 'AI_DRAFTED' && (
                  <AiFindingReview
                    sessionId={session.id}
                    finding={f}
                    citations={citationsBy.get(f.id) ?? []}
                    busy={busy}
                    canEdit={props.canEdit}
                    canReadTranscript={props.canReadTranscript}
                    draft={draft}
                    onAccept={() => void props.onReview(f.id, 'CONFIRMED')}
                    onReject={() => void props.onReview(f.id, 'REJECTED')}
                    onEdit={() => setEditing(f.id)}
                  />
                )}
                {draft && props.canEdit && f.origin === 'RECRUITER_AUTHORED' && (
                  <div className="ts-finding__actions">
                    <Button variant="secondary" onClick={() => setEditing(f.id)} disabled={busy}>
                      Edit
                    </Button>
                    <Button variant="secondary" onClick={() => void props.onRemove(f.id)} disabled={busy}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ol>
      )}

      {draft && props.canEdit && editing === 'new' && (
        <FindingForm
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            if (await props.onAdd(input)) setEditing(null);
          }}
        />
      )}

      <div className="ts-detail__actions">
        {draft && props.canEdit && editing === null && (
          <Button variant="secondary" onClick={() => setEditing('new')} disabled={busy}>
            Add finding
          </Button>
        )}
        {draft && props.canConfirm && confirmableIds(findings).length > 0 && editing === null && (
          <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={busy || pendingReview > 0}>
            Review and confirm
          </Button>
        )}
        {draft && props.canEdit && (
          <Button variant="secondary" onClick={() => setVoidOpen(true)} disabled={busy}>
            Void
          </Button>
        )}
        {session.state === 'CONFIRMED' && hasPending && props.canConfirm && (
          <Button variant="secondary" onClick={() => void props.onRetry()} disabled={busy}>
            Retry publishing
          </Button>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          findings={findings.filter((f) => f.review_status !== 'REJECTED')}
          version={session.version}
          busy={busy}
          onClose={() => setConfirmOpen(false)}
          onConfirm={async () => {
            if (await props.onConfirm()) setConfirmOpen(false);
          }}
        />
      )}
      {voidOpen && (
        <VoidDialog
          busy={busy}
          onClose={() => setVoidOpen(false)}
          onVoid={async (reason) => {
            if (await props.onVoid(reason)) setVoidOpen(false);
          }}
        />
      )}
    </>
  );
}

export function publicationLabel(p: ScreeningPublication, now: number = Date.now()): { text: string; tone: PillTone } {
  if (p.state === 'CONFLICT') return { text: 'Publication conflict — operator action needed', tone: 'danger' };
  if (p.state === 'PENDING') {
    const stale = now - new Date(p.last_attempt_at ?? p.created_at).getTime() > STALE_PENDING_MS;
    return stale ? { text: 'Publishing delayed — retry', tone: 'warn' } : { text: 'Publishing…', tone: 'info' };
  }
  const label = p.trust_status !== null ? TRUST_STATUS_LABEL[p.trust_status] : undefined;
  return { text: label ?? 'Published', tone: p.trust_status === 'VALID' || p.trust_status === null ? 'ok' : 'warn' };
}

function FindingCard({ finding, publication }: { finding: ScreeningFinding; publication?: ScreeningPublication }) {
  const pub = publication !== undefined ? publicationLabel(publication) : null;
  return (
    <div className="ts-finding__body">
      <div className="ts-finding__top">
        <strong>{finding.skill_raw}</strong>
        <span className="ts-muted">{BASIS_LABEL[finding.basis]}</span>
        <StatusPill tone={finding.origin === 'AI_DRAFTED' ? (finding.review_status === 'REJECTED' ? 'neutral' : 'info') : 'neutral'}>
          {provenanceLabel(finding)}
        </StatusPill>
        {pub !== null && <StatusPill tone={pub.tone}>{pub.text}</StatusPill>}
      </div>
      <p className="ts-finding__text">{finding.observation_raw}</p>
      {finding.demonstration_raw !== null && (
        <p className="ts-finding__text">
          <span className="ts-muted">Observed activity: </span>
          {finding.demonstration_raw}
        </p>
      )}
      {finding.limitations_raw !== null && (
        <p className="ts-finding__text">
          <span className="ts-muted">Not covered: </span>
          {finding.limitations_raw}
        </p>
      )}
    </div>
  );
}

function FindingForm(props: {
  initial?: ScreeningFinding;
  busy: boolean;
  onSave: (input: ScreeningFindingInput) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [skill, setSkill] = useState(props.initial?.skill_raw ?? '');
  const [basis, setBasis] = useState<ScreeningBasis>(props.initial?.basis ?? 'RECRUITER_OBSERVED');
  const [observation, setObservation] = useState(props.initial?.observation_raw ?? '');
  const [demonstration, setDemonstration] = useState(props.initial?.demonstration_raw ?? '');
  const [limitations, setLimitations] = useState(props.initial?.limitations_raw ?? '');
  const valid =
    skill.trim() !== '' && observation.trim() !== '' && (basis !== 'DEMONSTRATED' || demonstration.trim() !== '');
  return (
    <form
      className="ts-form"
      aria-label={props.initial ? 'Edit finding' : 'New finding'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void props.onSave({
          skill_raw: skill.trim(),
          basis,
          observation_raw: observation.trim(),
          demonstration_raw: basis === 'DEMONSTRATED' ? demonstration.trim() : null,
          limitations_raw: limitations.trim() === '' ? null : limitations.trim(),
        });
      }}
    >
      <label className="ts-field">
        <span>Skill or topic</span>
        <Input value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="Skill or topic" maxLength={200} />
      </label>
      <label className="ts-field">
        <span>Basis</span>
        <Select value={basis} onChange={(e) => setBasis(e.target.value as ScreeningBasis)} aria-label="Basis">
          {(Object.keys(BASIS_LABEL) as ScreeningBasis[]).map((b) => (
            <option key={b} value={b}>
              {BASIS_LABEL[b]}
            </option>
          ))}
        </Select>
      </label>
      <label className="ts-field">
        <span>What was said or observed</span>
        <TextArea unstyled className="ts-textarea" rows={4} value={observation} onChange={(e) => setObservation(e.target.value)} aria-label="Observation" />
      </label>
      {basis === 'DEMONSTRATED' && (
        <label className="ts-field">
          <span>Activity you watched the talent perform</span>
          <TextArea unstyled className="ts-textarea" rows={3} value={demonstration} onChange={(e) => setDemonstration(e.target.value)} aria-label="Observed activity" />
        </label>
      )}
      <label className="ts-field">
        <span>Not covered or uncertain (optional)</span>
        <TextArea unstyled className="ts-textarea" rows={2} value={limitations} onChange={(e) => setLimitations(e.target.value)} aria-label="Limitations" />
      </label>
      <div className="ts-form__actions">
        <Button variant="primary" type="submit" disabled={!valid || props.busy}>
          Save finding
        </Button>
        <Button variant="secondary" type="button" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ConfirmDialog(props: {
  findings: ScreeningFinding[];
  version: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [attested, setAttested] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()} title="Confirm technical screening">
      <p className="ts-muted">
        You are confirming exactly these {props.findings.length} finding(s) (version {props.version}). Once confirmed they
        cannot be edited, and each is recorded as recruiter-attested evidence.
      </p>
      <ul className="ts-confirm-list">
        {props.findings.map((f) => (
          <li key={f.id}>
            <strong>{f.skill_raw}</strong> — {BASIS_LABEL[f.basis]}
          </li>
        ))}
      </ul>
      <AttestCheckbox checked={attested} onChange={setAttested}>
        I confirm these findings accurately record what was discussed or observed, including any AI drafts I accepted or
        edited. They are my record, not an independent verification.
      </AttestCheckbox>
      <div className="ts-form__actions">
        <Button variant="primary" onClick={() => void props.onConfirm()} disabled={!attested || props.busy}>
          {props.busy ? 'Confirming…' : 'Confirm findings'}
        </Button>
        <Button variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

function VoidDialog(props: { busy: boolean; onClose: () => void; onVoid: (reason: string | null) => void | Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()} title="Void this screening">
      <p className="ts-muted">A voided draft is kept for history and cannot be edited or confirmed.</p>
      <label className="ts-field">
        <span>Reason (optional)</span>
        <TextArea unstyled className="ts-textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Void reason" />
      </label>
      <div className="ts-form__actions">
        <Button variant="primary" onClick={() => void props.onVoid(reason.trim() === '' ? null : reason.trim())} disabled={props.busy}>
          Void screening
        </Button>
        <Button variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

// INC-3 A1 — start a screening, optionally for a requisition (it only tailors
// the generated questions; nothing is written to the pipeline).
function StartDialog(props: { busy: boolean; onClose: () => void; onStart: (requisitionId: string | null) => void | Promise<void> }) {
  const [reqs, setReqs] = useState<Array<{ id: string; title: string }> | null>(null);
  const [reqId, setReqId] = useState('');
  useEffect(() => {
    let cancelled = false;
    listRequisitions()
      .then((r) => !cancelled && setReqs(r.items.filter((x) => x.status === 'open').map((x) => ({ id: x.id, title: x.title }))))
      .catch(() => !cancelled && setReqs([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()} title="Start a technical screening">
      <label className="ts-field">
        <span>Requisition (optional — tailors the suggested questions)</span>
        <Select value={reqId} onChange={(e) => setReqId(e.target.value)} aria-label="Requisition" disabled={reqs === null}>
          <option value="">No requisition</option>
          {(reqs ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </Select>
      </label>
      <div className="ts-form__actions">
        <Button variant="primary" onClick={() => void props.onStart(reqId === '' ? null : reqId)} disabled={props.busy}>
          Start screening
        </Button>
        <Button variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
