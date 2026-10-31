import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Dialog } from '@aramo/fe-foundation';

import { PURGE_LEVELS, errorMessage, fetchSourcePdf, purgeLevelLabel, senderApi, sourceLabel, type EnvelopeDetail as Detail, type Evidence, type LedgerEvent, type PurgeLevel } from '../api';
import { Area, Avatar, Btn, COLORS, ErrorBox, Field, Icon, Loading, RecipientPill, Sel, StatusPill, TextIn, downloadBase64, eventDot, eventLabel, fmtDate, maskEmail, LinkBtn } from '../ui';
import { useWorkspace } from '../workspace';

// Envelope detail (read-only). Actions by state + permission: Send reminder
// (SENT / IN_PROGRESS), Void envelope (reason + confirmation; non-terminal),
// Download documents + certificate (COMPLETED). Signing links are never shown —
// they exist only in each signer's email. A DRAFT routes back to the wizard.

const TERMINAL = new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);
// Retention and Purge (DocuSign parity) — only completed, declined or voided envelopes are purged.
const PURGEABLE = new Set(['COMPLETED', 'DECLINED', 'VOIDED']);

export function EnvelopeDetail() {
  const { id = '' } = useParams();
  const { base, ctx, refreshCounts, toast } = useWorkspace();
  const [env, setEnv] = useState<Detail | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [voidError, setVoidError] = useState('');
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeLevel, setPurgeLevel] = useState<PurgeLevel>('DOCUMENTS');
  const [purgeTyped, setPurgeTyped] = useState('');
  const [actionError, setActionError] = useState('');

  const load = useCallback(() => {
    senderApi
      .detail(id)
      .then((d) => {
        setEnv(d);
        if (d.status === 'COMPLETED') {
          senderApi
            .evidence(id)
            .then(setEvidence)
            .catch(() => setEvidence(null));
        }
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    senderApi
      .events(id)
      .then((r) => setEvents(r.items))
      .catch(() => setEvents([]));
  }, [id]);
  useEffect(load, [load]);

  if (error !== '' && env === null)
    return (
      <div className="sg-page">
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  if (env === null) return <Loading />;
  // Sign Unified Product S-1 — lifecycle actions belong to the envelope's sender
  // or a Sign Admin / Owner (the backend enforces this; the UI only mirrors it).
  // S-3 — an envelope another application sent (e.g. an ATS RTR) is managed there.
  const fromOtherApp = sourceLabel(env.source_application);
  const canAct = fromOtherApp === null && ctx.can_send && (env.sender.id === ctx.user.id || ctx.permissions.manage_all === true);
  if (env.status === 'DRAFT' && canAct) return <Navigate to={`${base}/envelopes/${env.id}/edit?step=1`} replace />;

  const signed = env.recipients.filter((r) => r.status === 'SIGNED').length;
  // Retention and Purge — the backend enforces who may delete, purge or cancel a purge.
  const purge = env.purge ?? null;
  const purged = purge?.state === 'EXECUTED';
  const queued = purge?.state === 'QUEUED';
  const admin = ctx.permissions.manage_all === true;
  const canDelete = fromOtherApp === null && TERMINAL.has(env.status) && (canAct || admin);
  const canPurge = admin && PURGEABLE.has(env.status) && (purge === null || purge.state === 'DEQUEUED');
  const live = env.status === 'SENT' || env.status === 'IN_PROGRESS';

  const ordered = env.routing_mode === 'SEQUENTIAL';
  const next = ordered ? env.recipients.find((r) => r.id === env.next_signer_id) : undefined;

  // Multi-Signer M-3a — remind one signer, or (no id) everyone who may sign now.
  const remind = async (signer?: { id: string; name: string }) => {
    setBusy(true);
    try {
      setEnv(await senderApi.remind(env.id, signer?.id));
      toast(signer !== undefined ? `Reminder sent to ${signer.name}` : ordered ? 'Reminder sent to the signer whose turn it is' : 'Reminder sent to everyone who hasn’t signed yet');
      load();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const doVoid = async () => {
    setVoidError('');
    if (reason.trim() === '') {
      setVoidError('Enter a reason. Recipients see that the envelope was voided.');
      return;
    }
    setBusy(true);
    try {
      setEnv(await senderApi.void(env.id, reason.trim()));
      setVoidOpen(false);
      setReason('');
      refreshCounts();
      toast('Envelope voided');
      load();
    } catch (e) {
      setVoidError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    try {
      const b = await senderApi.executed(env.id);
      for (const d of b.documents) downloadBase64(d.executed_base64, `${d.title} (signed).pdf`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const certificate = async () => {
    setBusy(true);
    try {
      const b = await senderApi.executed(env.id);
      if (b.certificate === null) toast('The certificate is still being produced. Try again shortly.');
      else downloadBase64(b.certificate.certificate_base64, `${env.subject} — certificate.pdf`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const runAction = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
      toast(done);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const doDelete = () =>
    runAction(async () => {
      await senderApi.deleteEnvelope(env.id);
      setDeleteOpen(false);
      refreshCounts();
      navigate(`${base}/envelopes`);
    }, 'Moved to Deleted');
  const doPurge = () =>
    runAction(async () => {
      setEnv(await senderApi.queuePurge(env.id, purgeLevel));
      setPurgeOpen(false);
      setPurgeTyped('');
      load();
    }, 'Purge scheduled');
  const cancelPurge = () =>
    runAction(async () => {
      setEnv(await senderApi.dequeuePurge(env.id));
      load();
    }, 'Purge cancelled');
  const preview = async (docId: string) => {
    try {
      const bytes = await fetchSourcePdf(env.id, docId);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <div className="sg-page sg-page--wide">
      <Link className="sg-back" to={`${base}/envelopes`}>
        <Icon name="back" size={14} /> Envelopes
      </Link>
      <div className="sg-pagehead" style={{ marginBottom: 4 }}>
        <h1 className="sg-h1">
          {env.subject}
          {fromOtherApp !== null ? (
            <span className="sg-tag sg-tag--blue" style={{ marginLeft: 10, verticalAlign: 'middle' }} data-testid="envelope-source">
              {fromOtherApp}
            </span>
          ) : null}
        </h1>
        <StatusPill status={env.status} />
        <div className="sg-pagehead__end">
          {env.status === 'COMPLETED' && !purged ? (
            <>
              <Btn variant="primary" onClick={() => void download()} disabled={busy} data-testid="download-executed">
                Download documents
              </Btn>
              <Btn onClick={() => void certificate()} disabled={busy}>
                Download certificate
              </Btn>
            </>
          ) : null}
          {live && canAct ? (
            <Btn onClick={() => void remind()} disabled={busy} data-testid="send-reminder">
              Send reminder
            </Btn>
          ) : null}
          {!TERMINAL.has(env.status) && canAct ? (
            <Btn variant="danger" onClick={() => setVoidOpen(true)} disabled={busy} data-testid="void-envelope">
              Void envelope
            </Btn>
          ) : null}
          {canPurge ? (
            <Btn variant="danger" onClick={() => setPurgeOpen(true)} disabled={busy} data-testid="purge-envelope">
              Purge…
            </Btn>
          ) : null}
          {canDelete ? (
            <Btn onClick={() => setDeleteOpen(true)} disabled={busy} data-testid="delete-envelope">
              <Icon name="trash" size={14} /> Delete
            </Btn>
          ) : null}
        </div>
      </div>
      {purge !== null && purge.state !== 'DEQUEUED' ? (
        <div className={purged ? 'sg-note' : 'sg-note sg-note--warn'} style={{ marginBottom: 14 }} data-testid="purge-banner" role="status">
          {purged ? (
            <span>
              This envelope’s documents were purged on {fmtDate(purge.executed_at, true)} ({purgeLevelLabel(purge.level).toLowerCase()}). They can’t be downloaded or
              recovered. Its history remains.
            </span>
          ) : (
            <span>
              Purge scheduled: {purgeLevelLabel(purge.level).toLowerCase()} will be deleted permanently on {fmtDate(purge.due_at, true)}.
            </span>
          )}
          {queued && admin ? (
            <LinkBtn disabled={busy} onClick={() => void cancelPurge()} data-testid="cancel-purge" style={{ marginLeft: 'auto' }}>
              Cancel purge
            </LinkBtn>
          ) : null}
        </div>
      ) : null}
      {actionError !== '' && !deleteOpen && !purgeOpen ? <ErrorBox>{actionError}</ErrorBox> : null}
      <p className="sg-muted" style={{ marginTop: 0, marginBottom: 18 }}>
        <span className="sg-mono">{env.id.slice(0, 8)}</span> · sent by {env.sender.name ?? 'a sender'} · created {fmtDate(env.created_at)}
        {env.sent_at !== null ? ` · sent ${fmtDate(env.sent_at, true)}` : ''}
        {env.expires_at !== null && live ? ` · expires ${fmtDate(env.expires_at)}` : ''}
        {env.completed_at !== null ? ` · completed ${fmtDate(env.completed_at, true)}` : ''}
      </p>
      <div className="sg-grid sg-grid--main">
        <div className="sg-grid">
          <section className="sg-card">
            <div className="sg-card__head">
              Recipients
              <span className="sg-card__end sg-muted">
                {signed} of {env.recipients.length} signed
              </span>
            </div>
            {live && next !== undefined ? (
              <div className="sg-row__s" style={{ padding: '8px 16px' }} data-testid="next-signer">
                Signing in order · waiting for <strong>{next.name}</strong>
              </div>
            ) : null}
            {env.recipients.map((r, i) => (
              <div key={r.id} className="sg-row">
                <Avatar name={r.name} color={COLORS[i % COLORS.length]} />
                <div className="sg-row__main">
                  <div>
                    <strong>{r.name}</strong> <span className="sg-muted">· {r.email ?? 'No email'}</span>
                  </div>
                  <div className="sg-row__s">
                    {ordered ? `Signs ${i + 1} of ${env.recipients.length} · ` : ''}
                    {ordered && live && r.status !== 'SIGNED' && r.id !== env.next_signer_id ? 'Waiting for earlier signers · ' : ''}Needs to sign · Secure link
                    {r.signed_at !== null ? ` · signed ${fmtDate(r.signed_at, true)}` : ''}
                    {r.declined_at !== null ? ` · declined ${fmtDate(r.declined_at, true)}` : ''}
                  </div>
                  {r.decline_reason !== null ? <div className="sg-row__s">“{r.decline_reason}”</div> : null}
                </div>
                {canAct && live && r.can_remind === true ? (
                  <LinkBtn disabled={busy} onClick={() => void remind(r)} data-testid={`remind-${r.id}`}>
                    Remind
                  </LinkBtn>
                ) : null}
                <RecipientPill status={r.status} />
              </div>
            ))}
          </section>
          <section className="sg-card">
            <div className="sg-card__head">Documents</div>
            {env.documents.map((d) => (
              <div key={d.id} className="sg-docrow">
                <span className="sg-docicon" aria-hidden="true" />
                <div className="sg-row__main">
                  <div className="sg-row__t">{d.title}</div>
                  <div className="sg-row__s">
                    {d.field_count} field{d.field_count === 1 ? '' : 's'}
                  </div>
                </div>
                {purged ? (
                  <span className="sg-muted" data-testid="document-purged">
                    Purged
                  </span>
                ) : (
                  <Btn variant="ghost" size="sm" style={{ color: 'var(--accent)' }} onClick={() => void preview(d.id)}>
                    Preview
                  </Btn>
                )}
              </div>
            ))}
          </section>
          {env.status === 'COMPLETED' ? (
            <section className="sg-card sg-cert" data-testid="certificate-card">
              <div className="sg-card__head">
                Certificate of completion
                <span className="sg-card__end sg-mono sg-faint">{env.id.slice(0, 8)}</span>
              </div>
              <div className="sg-card__body">
                <div className="sg-muted" style={{ marginBottom: 10 }}>
                  Completed {fmtDate(env.completed_at, true)} · {env.documents.length} document{env.documents.length === 1 ? '' : 's'} · {env.recipients.length} signer
                  {env.recipients.length === 1 ? '' : 's'}
                </div>
                {env.recipients.map((r) => (
                  <div key={r.id} className="sg-settings-row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <strong>{r.name}</strong> <span className="sg-muted">{r.email === null ? 'No email' : maskEmail(r.email)}</span>
                      <div className="sg-muted" style={{ fontSize: 12.5 }}>
                        Signed {fmtDate(r.signed_at, true)} · Secure link
                      </div>
                    </div>
                  </div>
                ))}
                {evidence !== null ? (
                  <div className="sg-help" style={{ marginTop: 10 }}>
                    Event-chain hash <span className="sg-mono">{evidence.event_chain_hash.slice(0, 16)}…</span> · signed with {evidence.signature_algorithm}. The full certificate
                    is in the downloadable PDF.
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
        <div className="sg-grid">
          <section className="sg-card">
            <div className="sg-card__body">
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Settings</div>
              <div className="sg-grid" style={{ gridTemplateColumns: '120px 1fr', gap: 6 }}>
                <span className="sg-muted">Signing order</span>
                <span data-testid="routing-mode">{ordered ? 'In order' : 'Any order'}</span>
                <span className="sg-muted">Signing window</span>
                <span>{env.signing_window_days} days</span>
                <span className="sg-muted">Reminders</span>
                <span>Sent from this page</span>
              </div>
            </div>
          </section>
          <section className="sg-card">
            <div className="sg-card__head">
              Activity
              <Link className="sg-card__end" to={`${base}/envelopes/${env.id}/activity`}>
                Full timeline
              </Link>
            </div>
            {[...events]
              .reverse()
              .slice(0, 5)
              .map((e) => (
                <div key={e.id} className="sg-row" style={{ alignItems: 'flex-start' }}>
                  <span className="sg-swatch" style={{ background: eventDot(e.event_type), marginTop: 7 }} />
                  <div className="sg-row__main">
                    <div style={{ fontWeight: 600 }}>{eventLabel(e.event_type, e.detail)}</div>
                    <div className="sg-row__s">
                      {e.actor} · {fmtDate(e.occurred_at, true)}
                    </div>
                  </div>
                </div>
              ))}
          </section>
        </div>
      </div>
      <Dialog
        open={voidOpen}
        onOpenChange={(o) => {
          setVoidOpen(o);
          if (!o) setVoidError('');
        }}
        title="Void this envelope?"
        description="Recipients can no longer sign. This can’t be undone."
        size="sm"
        footer={
          <>
            <Btn onClick={() => setVoidOpen(false)}>Keep envelope</Btn>
            <Btn variant="danger" onClick={() => void doVoid()} disabled={busy} data-testid="confirm-void">
              Void envelope
            </Btn>
          </>
        }
      >
        <Field label="Reason (required)" htmlFor="void-reason">
          <Area id="void-reason" rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {voidError !== '' ? <ErrorBox>{voidError}</ErrorBox> : null}
      </Dialog>
      <Dialog
        open={deleteOpen}
        onOpenChange={(o) => {
          setDeleteOpen(o);
          if (!o) setActionError('');
        }}
        title="Delete this envelope?"
        description="It moves to Deleted and is hidden for your organization only. Recipients keep their copies. You can restore it until it is purged."
        size="sm"
        footer={
          <>
            <Btn onClick={() => setDeleteOpen(false)}>Cancel</Btn>
            <Btn variant="danger" onClick={() => void doDelete()} disabled={busy} data-testid="confirm-delete">
              Delete
            </Btn>
          </>
        }
      >
        {actionError !== '' ? <ErrorBox>{actionError}</ErrorBox> : null}
      </Dialog>
      <Dialog
        open={purgeOpen}
        onOpenChange={(o) => {
          setPurgeOpen(o);
          if (!o) {
            setActionError('');
            setPurgeTyped('');
          }
        }}
        title="Purge this envelope?"
        description="The envelope waits 14 days in the purge queue, then the chosen data is deleted permanently for everyone. You can cancel during those 14 days."
        size="sm"
        footer={
          <>
            <Btn onClick={() => setPurgeOpen(false)}>Cancel</Btn>
            <Btn variant="danger" onClick={() => void doPurge()} disabled={busy || purgeTyped !== 'PURGE'} data-testid="confirm-purge">
              Queue purge
            </Btn>
          </>
        }
      >
        <div className="sg-grid" style={{ gap: 12 }}>
          <Field label="What is purged" htmlFor="purge-level" help={PURGE_LEVELS.find((l) => l.key === purgeLevel)?.help}>
            <Sel id="purge-level" value={purgeLevel} onChange={(e) => setPurgeLevel(e.target.value as PurgeLevel)}>
              {PURGE_LEVELS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Sel>
          </Field>
          <Field label="Type PURGE to confirm" htmlFor="purge-confirm">
            <TextIn id="purge-confirm" value={purgeTyped} autoComplete="off" onChange={(e) => setPurgeTyped(e.target.value)} />
          </Field>
          {actionError !== '' ? <ErrorBox>{actionError}</ErrorBox> : null}
        </div>
      </Dialog>
    </div>
  );
}

export function EnvelopeActivity() {
  const { id = '' } = useParams();
  const { base } = useWorkspace();
  const [env, setEnv] = useState<Detail | null>(null);
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    senderApi
      .detail(id)
      .then(setEnv)
      .catch((e: unknown) => setError(errorMessage(e)));
    senderApi
      .events(id)
      .then((r) => setEvents(r.items))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id]);
  return (
    <div className="sg-page">
      <Link className="sg-back" to={`${base}/envelopes/${id}`}>
        <Icon name="back" size={14} /> {env?.subject ?? 'Envelope'}
      </Link>
      <h1 className="sg-h1" style={{ marginBottom: 14 }}>
        Activity
      </h1>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {events === null && error === '' ? <Loading /> : null}
      {events !== null ? <Timeline events={[...events].reverse()} /> : null}
    </div>
  );
}

export function Timeline({ events, envelopeLinks = false }: { events: LedgerEvent[]; envelopeLinks?: boolean }) {
  const { base } = useWorkspace();
  if (events.length === 0) return <div className="sg-card sg-empty">No activity yet.</div>;
  return (
    <section className="sg-card">
      {events.map((e) => (
        <div key={e.id} className="sg-row" style={{ alignItems: 'flex-start' }} data-testid="ledger-row">
          <span className="sg-mono sg-muted" style={{ width: 150, flex: 'none', fontSize: 12.5 }}>
            {fmtDate(e.occurred_at, true)}
          </span>
          <span className="sg-swatch" style={{ background: eventDot(e.event_type), marginTop: 7 }} />
          <div className="sg-row__main">
            <div style={{ fontWeight: 600 }}>{eventLabel(e.event_type, e.detail)}</div>
            <div className="sg-row__s">
              {e.actor}
              {envelopeLinks && e.envelope_id !== undefined ? (
                <>
                  {' · '}
                  <Link to={`${base}/envelopes/${e.envelope_id}`}>{e.envelope_subject}</Link>
                </>
              ) : null}
            </div>
          </div>
          <span className="sg-mono sg-faint" style={{ fontSize: 11.5 }} title="Ledger hash">
            {e.event_hash.slice(0, 4)}…{e.event_hash.slice(-2)}
          </span>
        </div>
      ))}
    </section>
  );
}
