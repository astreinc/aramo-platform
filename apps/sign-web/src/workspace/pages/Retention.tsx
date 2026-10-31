import { useEffect, useState } from 'react';
import { Dialog } from '@aramo/fe-foundation';

import { PURGE_LEVELS, RETENTION_MAX_DAYS, errorMessage, purgeLevelLabel, senderApi, type PurgeLevel, type RetentionPolicy } from '../api';
import { Btn, ErrorBox, Field, Loading, Sel, TextIn, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// Retention and Purge directive (DocuSign parity) — Settings → Document retention.
// Keep forever is the default. An administrator may instead purge N days (1–9999) after an
// envelope is completed, declined or voided, at one of DocuSign's three levels. The backend
// decides who may edit (can_edit) and applies the setting; purged documents can't be recovered.
// A targeted purge (every envelope sent from or signed by one email address) is the
// administrator's tool for a single person's deletion request.

export function RetentionSection() {
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    senderApi
      .retentionPolicy()
      .then(setPolicy)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  if (error !== '' && policy === null) return <ErrorBox>{error}</ErrorBox>;
  if (policy === null) return <Loading />;
  return (
    <>
      <RetentionCard policy={policy} onSaved={setPolicy} />
      {policy.can_edit ? <TargetedPurgeCard /> : null}
    </>
  );
}

function RetentionCard({ policy, onSaved }: { policy: RetentionPolicy; onSaved: (p: RetentionPolicy) => void }) {
  const { toast } = useWorkspace();
  const [mode, setMode] = useState<'forever' | 'days'>(policy.retention_days === null ? 'forever' : 'days');
  const [days, setDays] = useState(policy.retention_days === null ? '' : String(policy.retention_days));
  const [level, setLevel] = useState<PurgeLevel>(policy.purge_level);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = mode === 'forever' ? null : Number(days);
  const daysValid = mode === 'forever' || (Number.isInteger(parsed) && parsed !== null && parsed >= 1 && parsed <= RETENTION_MAX_DAYS);
  const changed = parsed !== policy.retention_days || (mode === 'days' && level !== policy.purge_level);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await senderApi.setRetentionPolicy(parsed, level);
      onSaved(next);
      setConfirm(false);
      toast(next.retention_days === null ? 'Documents are kept until you delete them' : `Documents are purged ${next.retention_days} days after completion`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="retention-card">
      <div className="sg-card__head">
        Document retention
        {!policy.can_edit ? <span className="sg-card__end sg-tag sg-tag--grey">Read-only</span> : null}
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p className="sg-help" style={{ marginTop: 0 }}>
          Choose how long completed, declined and voided envelopes keep their documents. Purged envelopes wait 14 days in a purge queue, then their documents are
          deleted permanently.
        </p>
        <div className="sg-grid sg-grid--2">
          <Field label="Keep documents" htmlFor="ret-mode">
            <Sel id="ret-mode" value={mode} disabled={!policy.can_edit} onChange={(e) => setMode(e.target.value as 'forever' | 'days')}>
              <option value="forever">Until deleted (keep forever)</option>
              <option value="days">For a set number of days</option>
            </Sel>
          </Field>
          {mode === 'days' ? (
            <Field label="Days after completion, decline or void" htmlFor="ret-days" error={days !== '' && !daysValid ? `Enter a whole number from 1 to ${RETENTION_MAX_DAYS}.` : undefined}>
              <TextIn id="ret-days" inputMode="numeric" value={days} disabled={!policy.can_edit} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))} />
            </Field>
          ) : null}
        </div>
        {mode === 'days' ? (
          <Field label="What is purged" htmlFor="ret-level" help={PURGE_LEVELS.find((l) => l.key === level)?.help}>
            <Sel id="ret-level" value={level} disabled={!policy.can_edit} onChange={(e) => setLevel(e.target.value as PurgeLevel)}>
              {PURGE_LEVELS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Sel>
          </Field>
        ) : null}
        {policy.updated_at !== null ? <div className="sg-help">Last changed {fmtDate(policy.updated_at, true)}</div> : null}
        {policy.can_edit ? (
          <div>
            <Btn variant="primary" disabled={!changed || !daysValid || busy} onClick={() => setConfirm(true)} data-testid="retention-save">
              Save
            </Btn>
          </div>
        ) : (
          <p className="sg-help">Only an Aramo Sign administrator can change document retention.</p>
        )}
        {error !== '' && !confirm ? <ErrorBox>{error}</ErrorBox> : null}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={(o) => {
          setConfirm(o);
          if (!o) setError('');
        }}
        title="Change document retention?"
        description={
          parsed === null
            ? 'Documents will be kept until someone deletes them. Envelopes already in the purge queue stay queued until you cancel each purge.'
            : `This applies to every envelope that is already completed, declined or voided, not only new ones. Envelopes older than ${parsed} days are queued for purge at the next nightly run. Purged documents can't be recovered.`
        }
        size="sm"
        footer={
          <>
            <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
            <Btn variant={parsed === null ? 'primary' : 'danger'} disabled={busy} onClick={() => void save()} data-testid="retention-confirm">
              {parsed === null ? 'Keep forever' : `Purge after ${parsed} days`}
            </Btn>
          </>
        }
      >
        {parsed !== null ? (
          <div className="sg-muted" data-testid="retention-confirm-level">
            What is purged: {purgeLevelLabel(level)}
          </div>
        ) : null}
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      </Dialog>
    </section>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function TargetedPurgeCard() {
  const { toast } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<PurgeLevel>('DOCUMENTS_AND_METADATA_AND_REDACT');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const emailOk = EMAIL.test(email.trim());

  const close = () => {
    setOpen(false);
    setEmail('');
    setTyped('');
    setError('');
  };
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await senderApi.targetedPurge(email.trim(), level);
      toast(r.queued === 0 ? 'No completed, declined or voided envelopes matched that email address' : `${r.queued} envelope${r.queued === 1 ? '' : 's'} queued for purge`);
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="targeted-purge-card">
      <div className="sg-card__head">Purge envelopes for one person</div>
      <div className="sg-card__body">
        <p className="sg-help" style={{ marginTop: 0 }}>
          Queue every completed, declined or voided envelope sent from or signed by an email address, for example to answer a deletion request.
        </p>
        <Btn variant="danger" onClick={() => setOpen(true)} data-testid="targeted-purge-open">
          Purge envelopes…
        </Btn>
      </div>
      <Dialog
        open={open}
        onOpenChange={(o) => (o ? setOpen(true) : close())}
        title="Purge envelopes"
        description="Matching envelopes wait 14 days in the purge queue, then their data is deleted permanently. This can't be undone once the purge runs."
        size="sm"
        footer={
          <>
            <Btn onClick={close}>Cancel</Btn>
            <Btn variant="danger" disabled={!emailOk || typed !== 'PURGE' || busy} onClick={() => void run()} data-testid="targeted-purge-confirm">
              Queue purge
            </Btn>
          </>
        }
      >
        <div className="sg-grid" style={{ gap: 12 }}>
          <Field label="Email address" htmlFor="tp-email">
            <TextIn id="tp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="What is purged" htmlFor="tp-level" help={PURGE_LEVELS.find((l) => l.key === level)?.help}>
            <Sel id="tp-level" value={level} onChange={(e) => setLevel(e.target.value as PurgeLevel)}>
              {PURGE_LEVELS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Sel>
          </Field>
          <Field label="Type PURGE to confirm" htmlFor="tp-confirm">
            <TextIn id="tp-confirm" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </Field>
          {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
        </div>
      </Dialog>
    </section>
  );
}
