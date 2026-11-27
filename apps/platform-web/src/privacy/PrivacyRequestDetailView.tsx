import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, useOptionalToast, type Session } from '@aramo/fe-foundation';

import {
  ConfirmDialog,
  FieldTextArea,
  Pill,
  SkeletonPanel,
  Timeline,
  TypedConfirm,
  formatDate,
  formatTimestamp,
  typedConfirmMatches,
  type ConfirmTone,
  type TimelineEvent,
} from '../components';
import {
  platformApi,
  type PrivacyDeletionPreview,
  type PrivacyRequestDetail,
} from '../platform-api';
import { useEntityCrumb } from '../shell/crumbs';

import {
  ACTION_BUTTON,
  ACTOR_LABEL,
  CHANNEL_LABEL,
  NOTE_MAX,
  NOT_VERIFIED,
  SUBJECT_KIND_LABEL,
  TYPE_LABEL,
  availableActions,
  countRows,
  eventLabel,
  failureCount,
  isOverdue,
  isTerminal,
  label,
  lastFailure,
  pathLabel,
  privacyErrorText,
  statusPill,
  type PrivacyAction,
} from './privacy-model';
import { ExecutionBanner } from './PrivacyRequestsView';
import '../personal/personal.css';
import './privacy.css';

// PRIV-ADMIN-1 §1.3 — one privacy request: the facts, the inventory (counts at
// inventory time), the completion evidence (null = "not verified"), the impact
// preview of a deletion, the history, the contact (hidden until revealed) and
// every operator action, each behind a confirm dialog.

type DialogKind = PrivacyAction | 'reveal';

export function PrivacyRequestDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams<{ id: string }>();
  const toast = useOptionalToast();
  const [r, setR] = useState<PrivacyRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PrivacyDeletionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await platformApi.getPrivacyRequest(id);
      setR(d);
      if (d.request_type === 'DELETION' && !isTerminal(d.status)) {
        setPreviewError(null);
        try {
          setPreview(await platformApi.getPrivacyPreview(id));
        } catch (e) {
          setPreview(null);
          setPreviewError(privacyErrorText(e, 'The impact preview couldn’t be loaded.'));
        }
      } else {
        setPreview(null);
      }
    } catch (e) {
      setError(privacyErrorText(e, 'The request couldn’t be loaded. Try again.'));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEntityCrumb(r?.reference);

  if (r === null) {
    return (
      <div className="pw-sp pw-pr" data-testid="privacy-request-detail">
        <Link to="/privacy-requests" className="pw-pr-back">
          ← Privacy requests
        </Link>
        {error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pw-sp-gap">
            {error}
          </div>
        ) : (
          <SkeletonPanel />
        )}
      </div>
    );
  }

  const pill = statusPill(r.status);
  const attempts = failureCount(r);
  const failed = lastFailure(r);
  const actions = availableActions(r, session.sub);
  const inventoryRows = countRows(r.inventory);
  const evidenceRows = countRows(r.completion_evidence);

  const done = (message: string): void => {
    setDialog(null);
    toast.show(message);
    void load();
  };

  return (
    <div className="pw-sp pw-pr" data-testid="privacy-request-detail">
      <Link to="/privacy-requests" className="pw-pr-back">
        ← Privacy requests
      </Link>
      <div className="pw-sp-head">
        <h1 className="pw-sp-title pw-pr-mono">{r.reference}</h1>
        <div className="pw-pr-badges pw-pr-head-badges">
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {attempts >= 1 ? (
            <Pill tone="danger" dot={false}>
              Failing
            </Pill>
          ) : null}
          {isOverdue(r) ? (
            <Pill tone="danger" dot={false}>
              Overdue
            </Pill>
          ) : null}
        </div>
      </div>
      <ExecutionBanner enabled={r.execution_enabled} />
      {error !== null ? (
        <div role="alert" className="pw-alert pw-alert--error pw-sp-gap">
          {error}
        </div>
      ) : null}
      {attempts >= 1 ? (
        <div
          role="alert"
          className="pw-alert pw-alert--error pw-pr-banner"
          data-testid="privacy-failing"
        >
          Execution failed {attempts} {attempts === 1 ? 'time' : 'times'} since it started
          {failed !== null ? (
            <>
              {' '}
              (last error <span className="pw-pr-mono">{failed}</span>)
            </>
          ) : null}
          . It is retried automatically; you can return it to the queue.
        </div>
      ) : null}

      <div className="pw-pr-actions" role="group" aria-label="Actions">
        {actions.map((a) => (
          <Button
            key={a}
            unstyled
            className={
              a === 'execute' || a === 'deny' || a === 'cancel'
                ? 'pw-sp-rbtn pw-sp-rbtn--priv'
                : 'pw-sp-rbtn'
            }
            onClick={() => setDialog(a)}
          >
            {ACTION_BUTTON[a]}
          </Button>
        ))}
      </div>

      <section className="pw-sp-panel pw-pr-panel" aria-labelledby="pr-facts">
        <h2 id="pr-facts" className="pw-sp-h3">
          Request
        </h2>
        <dl className="pw-sp-facts">
          <Fact term="Type">{label(TYPE_LABEL, r.request_type)}</Fact>
          <Fact term="Subject kind">{label(SUBJECT_KIND_LABEL, r.subject_kind)}</Fact>
          <Fact term="Channel">{label(CHANNEL_LABEL, r.channel)}</Fact>
          <Fact term="Status">
            {pill.label} <span className="pw-pr-code">{r.status}</span>
            <div className="pw-sp-row__sub">Requester sees: {r.status_label}</div>
          </Fact>
          <Fact term="Received">{formatDate(r.created_at)}</Fact>
          <Fact term="Due">
            {formatDate(r.due_at)}
            {isOverdue(r) ? ' (overdue)' : ''}
          </Fact>
          <Fact term="Operator">
            {r.assigned_operator_id === null ? (
              '—'
            ) : r.assigned_operator_id === session.sub ? (
              'You'
            ) : (
              <Mono>{r.assigned_operator_id}</Mono>
            )}
          </Fact>
          <Fact term="Subject user">
            {r.subject_user_id === null ? '—' : <Mono>{r.subject_user_id}</Mono>}
          </Fact>
          <Fact term="Subject organization">
            {r.subject_tenant_id === null ? '—' : <Mono>{r.subject_tenant_id}</Mono>}
          </Fact>
          <Fact term="Referred to">
            {r.referred_tenant_id === null ? '—' : <Mono>{r.referred_tenant_id}</Mono>}
          </Fact>
          <Fact term="Outcome">
            {r.outcome_code === null ? '—' : <Mono>{r.outcome_code}</Mono>}
          </Fact>
          {r.outcome_text ? (
            <Fact term="Outcome note (shown to the requester)">{r.outcome_text}</Fact>
          ) : null}
          {r.completed_at ? <Fact term="Closed">{formatTimestamp(r.completed_at)}</Fact> : null}
          <Fact term="Contact">
            {contact !== null ? (
              <span data-testid="privacy-contact">{contact}</span>
            ) : r.contact_present ? (
              <span className="pw-pr-inline">
                <span className="pw-sp-row__sub">Hidden</span>
                <Button unstyled className="pw-sp-rbtn" onClick={() => setDialog('reveal')}>
                  Reveal contact…
                </Button>
              </span>
            ) : (
              'None on file'
            )}
          </Fact>
        </dl>
      </section>

      {r.request_type === 'DELETION' && !isTerminal(r.status) ? (
        <section
          className="pw-sp-panel pw-pr-panel"
          aria-labelledby="pr-preview"
          data-testid="privacy-preview"
        >
          <h2 id="pr-preview" className="pw-sp-h3">
            Impact preview <span className="pw-sp-h3__aside">read only, as of now</span>
          </h2>
          {preview !== null ? (
            <PreviewBody preview={preview} />
          ) : previewError !== null ? (
            <p className="pw-sp-row__sub">{previewError}</p>
          ) : (
            <SkeletonPanel />
          )}
        </section>
      ) : null}

      <section
        className="pw-sp-panel pw-pr-panel"
        aria-labelledby="pr-inventory"
        data-testid="privacy-inventory"
      >
        <h2 id="pr-inventory" className="pw-sp-h3">
          Inventory <span className="pw-sp-h3__aside">counts at inventory time</span>
        </h2>
        {inventoryRows.length === 0 ? (
          <p className="pw-sp-row__sub">No inventory yet.</p>
        ) : (
          <CountTable rows={inventoryRows} />
        )}
      </section>

      <section
        className="pw-sp-panel pw-pr-panel"
        aria-labelledby="pr-evidence"
        data-testid="privacy-evidence"
      >
        <h2 id="pr-evidence" className="pw-sp-h3">
          Completion evidence
        </h2>
        {evidenceRows.length === 0 ? (
          <p className="pw-sp-row__sub">No completion evidence.</p>
        ) : (
          <CountTable rows={evidenceRows} />
        )}
      </section>

      <section
        className="pw-sp-panel pw-pr-panel"
        aria-labelledby="pr-history"
        data-testid="privacy-history"
      >
        <h2 id="pr-history" className="pw-sp-h3">
          History
        </h2>
        {r.events.length === 0 ? (
          <p className="pw-sp-row__sub">No events.</p>
        ) : (
          <Timeline events={timeline(r)} />
        )}
      </section>

      {dialog !== null ? (
        <ActionDialog
          kind={dialog}
          request={r}
          preview={preview}
          onClose={() => setDialog(null)}
          onRevealed={(email) => {
            setContact(email);
            done('Contact revealed. The reveal is recorded.');
          }}
          onDone={done}
        />
      ) : null}
    </div>
  );
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="pw-sp-facts__row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="pw-pr-mono">{children}</span>;
}

function CountTable({ rows }: { readonly rows: ReturnType<typeof countRows> }) {
  return (
    <dl className="pw-sp-facts pw-pr-counts">
      {rows.map((c) => (
        <div key={c.key} className="pw-sp-facts__row">
          <dt>{c.label}</dt>
          <dd
            className={c.notVerified ? 'pw-pr-unverified' : 'pw-pr-mono'}
            data-testid={`count-${c.key}`}
          >
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewBody({ preview }: { readonly preview: PrivacyDeletionPreview }) {
  return (
    <dl className="pw-sp-facts">
      <div className="pw-sp-facts__row">
        <dt>Path</dt>
        <dd data-testid="privacy-preview-path">
          {pathLabel(preview.path)} <span className="pw-pr-code">{preview.path}</span>
        </dd>
      </div>
      <div className="pw-sp-facts__row">
        <dt>Reasons</dt>
        <dd>{preview.reasons.length === 0 ? 'None' : <CodeList codes={preview.reasons} />}</dd>
      </div>
      <div className="pw-sp-facts__row">
        <dt>Dependencies</dt>
        <dd>
          {preview.dependencies.length === 0 ? 'None' : <CodeList codes={preview.dependencies} />}
        </dd>
      </div>
    </dl>
  );
}

function CodeList({ codes }: { readonly codes: readonly string[] }) {
  return (
    <span className="pw-pr-codes">
      {codes.map((c) => (
        <span key={c} className="pw-pr-code">
          {c === 'unknown' ? `unknown (${NOT_VERIFIED})` : c}
        </span>
      ))}
    </span>
  );
}

function payloadNote(payload: Record<string, unknown>): ReactNode {
  const entries = Object.entries(payload);
  if (entries.length === 0) return null;
  return (
    <span className="pw-pr-payload">
      {entries.map(([k, v]) => (
        <span key={k}>
          <span className="pw-pr-code">{k}</span>{' '}
          {v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
        </span>
      ))}
    </span>
  );
}

function timeline(r: PrivacyRequestDetail): TimelineEvent[] {
  return [...r.events].reverse().map((e) => {
    const moved = e.from_status !== null && e.to_status !== null && e.from_status !== e.to_status;
    return {
      id: e.id,
      label: eventLabel(e.event_type),
      at: e.created_at,
      tone:
        e.event_type === 'EXECUTION_FAILED' || e.event_type === 'EXECUTION_GAVE_UP'
          ? 'danger'
          : moved
            ? statusPill(e.to_status ?? '').tone
            : 'faint',
      from: moved ? statusPill(e.from_status ?? '') : null,
      to: moved ? statusPill(e.to_status ?? '') : null,
      reason: { label: eventLabel(e.event_type), code: e.event_type },
      actor: { label: ACTOR_LABEL[e.actor_type] ?? e.actor_type, id: e.actor_id },
      note: payloadNote(e.payload),
    };
  });
}

interface DialogSpec {
  readonly title: string;
  readonly commit: string;
  readonly tone: ConfirmTone;
  readonly consequence: ReactNode;
  /** The note field's label; absent = no note. */
  readonly note?: string;
}

function spec(
  kind: DialogKind,
  r: PrivacyRequestDetail,
  preview: PrivacyDeletionPreview | null,
): DialogSpec {
  switch (kind) {
    case 'assign':
      return {
        title: 'Assign to me',
        commit: 'Assign to me',
        tone: 'normal',
        consequence: 'You become the operator responsible for this request.',
      };
    case 'validate':
      return {
        title: 'Record identity check',
        commit: 'Record identity check',
        tone: 'normal',
        consequence:
          'Records that you checked the requester’s identity. The request moves to Identity checked.',
        note: 'How identity was checked',
      };
    case 'inventory':
      return {
        title: 'Take inventory',
        commit: 'Take inventory',
        tone: 'normal',
        consequence:
          'Finds the Aramo Sign account for the contact email and records counts only. The request moves to In review.',
      };
    case 'refer':
      return {
        title: 'Refer to organization',
        commit: 'Refer',
        tone: 'privileged',
        consequence: (
          <>
            Refers the request to the requester’s own organization:{' '}
            <span className="pw-pr-mono">{r.subject_tenant_id ?? '—'}</span>. Aramo stays
            responsible.
          </>
        ),
        note: 'Note',
      };
    case 'execute':
      return {
        title: 'Execute deletion',
        commit: 'Execute deletion',
        tone: 'danger',
        consequence: (
          <>
            <span data-testid="execute-path">
              Path:{' '}
              <b>{preview !== null ? pathLabel(preview.path) : 'unknown (preview not loaded)'}</b>
            </span>
            . This can’t be undone.
            {preview !== null && preview.dependencies.length > 0 ? (
              <>
                {' '}
                Dependencies: <CodeList codes={preview.dependencies} />
              </>
            ) : null}
          </>
        ),
        note: 'Note',
      };
    case 'complete':
      return {
        title: 'Record outcome',
        commit: 'Record outcome',
        tone: 'privileged',
        consequence: 'Closes the request as completed. The note below is shown to the requester.',
        note: 'Outcome note (shown to the requester)',
      };
    case 'deny':
      return {
        title: 'Deny request',
        commit: 'Deny request',
        tone: 'danger',
        consequence: 'Closes the request as denied. The reason is shown to the requester.',
        note: 'Reason (shown to the requester)',
      };
    case 'cancel':
      return {
        title: 'Cancel request',
        commit: 'Cancel request',
        tone: 'danger',
        consequence: 'Closes the request as cancelled. The reason is shown to the requester.',
        note: 'Reason (shown to the requester)',
      };
    case 'note':
      return {
        title: 'Add note',
        commit: 'Add note',
        tone: 'normal',
        consequence: 'The note is kept in the history. It is never shown to the requester.',
        note: 'Note',
      };
    case 'returnToQueue':
      return {
        title: 'Return to queue',
        commit: 'Return to queue',
        tone: 'privileged',
        consequence: 'Stops the execution and returns the request to In review.',
        note: 'Note',
      };
    case 'reveal':
      return {
        title: 'Reveal contact',
        commit: 'Reveal contact',
        tone: 'privileged',
        consequence:
          'Shows the requester’s email address. The reveal is recorded in the history with your operator id.',
      };
  }
}

function ActionDialog({
  kind,
  request: r,
  preview,
  onClose,
  onRevealed,
  onDone,
}: {
  readonly kind: DialogKind;
  readonly request: PrivacyRequestDetail;
  readonly preview: PrivacyDeletionPreview | null;
  readonly onClose: () => void;
  readonly onRevealed: (email: string) => void;
  readonly onDone: (message: string) => void;
}) {
  const s = spec(kind, r, preview);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = { note: note.trim() };

  const noteOk = s.note === undefined || body.note.length > 0;
  const executeOk =
    kind !== 'execute' ||
    (preview !== null &&
      preview.path !== 'not_executable' &&
      typedConfirmMatches(typed, r.reference));

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      switch (kind) {
        case 'reveal': {
          const res = await platformApi.revealPrivacyContact(r.id);
          onRevealed(res.contact_email);
          return;
        }
        case 'assign':
          await platformApi.assignPrivacyRequest(r.id);
          break;
        case 'validate':
          await platformApi.validatePrivacyRequest(r.id, body);
          break;
        case 'inventory':
          await platformApi.inventoryPrivacyRequest(r.id);
          break;
        case 'refer':
          // §1.1: omitted = the subject's own organization (the only one allowed).
          await platformApi.referPrivacyRequest(r.id, body);
          break;
        case 'execute':
          await platformApi.executePrivacyRequest(r.id, body);
          break;
        case 'complete':
          await platformApi.completePrivacyRequest(r.id, body);
          break;
        case 'deny':
          await platformApi.denyPrivacyRequest(r.id, body);
          break;
        case 'cancel':
          await platformApi.cancelPrivacyRequest(r.id, body);
          break;
        case 'note':
          await platformApi.addPrivacyNote(r.id, body);
          break;
        case 'returnToQueue':
          await platformApi.returnPrivacyRequestToQueue(r.id, body);
          break;
      }
      onDone(`${s.title}: done.`);
    } catch (e) {
      setError(privacyErrorText(e, 'The action couldn’t be completed. Try again.'));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={s.title}
      consequence={s.consequence}
      error={error}
      commitLabel={s.commit}
      cancelLabel="Go back"
      tone={s.tone}
      canCommit={noteOk && executeOk}
      busy={busy}
      onCommit={() => void commit()}
    >
      {s.note !== undefined || kind === 'execute' ? (
        <>
          {s.note !== undefined ? (
            <FieldTextArea label={s.note} value={note} onChange={setNote} max={NOTE_MAX} />
          ) : null}
          {kind === 'execute' ? (
            <TypedConfirm
              label={`Type the reference ${r.reference} to confirm`}
              expected={r.reference}
              value={typed}
              onChange={setTyped}
            />
          ) : null}
        </>
      ) : undefined}
    </ConfirmDialog>
  );
}
