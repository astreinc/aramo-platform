import { useCallback, useEffect, useState } from 'react';
import { Button, useToast } from '@aramo/fe-foundation';

import {
  ConfirmDialog,
  FieldAck,
  FieldText,
  FieldTextArea,
  Pill,
  SkeletonPanel,
  daysAgo,
  formatDate,
  formatRelative,
  shortId,
  type PillSpec,
} from '../components';
import { platformApi, type TenantDomain, type TenantDomainClaim } from '../platform-api';

import { domainErrorCopy, type ErrorCopy } from './tenant-errors';
import { domainClaimPill, domainReasonLabel } from './tenant-labels';

// PLATFORM-UX-1 F-5 (handoff §6.3 Domain; amendment 13) — the tenant's email
// domain claim. Reads and writes both need platform:tenant:lifecycle:manage, so
// the tab is hidden without it (the caller gates). Actions go through the
// existing endpoints: promote, release, grant / revoke the shared-domain
// exception. The server (DomainClaimService) is authoritative.

export type DomainAction = 'promote' | 'release' | 'grant' | 'revoke';

const PROVISIONAL_DAYS = 30;

/** Which actions a claim offers (the design's canPromote / canRelease / canGrant / canRevoke). */
export function domainActions(claim: TenantDomainClaim): readonly DomainAction[] {
  const out: DomainAction[] = [];
  if (claim.claim === 'PROVISIONAL' || claim.claim === 'LAPSED') out.push('promote');
  if (!claim.exception && claim.claim !== 'RELEASED') out.push('grant');
  if (claim.exception) out.push('revoke');
  if (claim.claim !== 'RELEASED') out.push('release');
  return out;
}

/** Days left on a provisional claim (0 when expired) and the countdown bar width. */
export function provisionalCountdown(expiresAt: string, now: Date = new Date()): { daysLeft: number; pct: number } {
  const n = daysAgo(expiresAt, now) ?? 0;
  const daysLeft = Math.max(0, -n);
  return { daysLeft, pct: Math.max(0, Math.min(100, Math.round((daysLeft / PROVISIONAL_DAYS) * 100))) };
}

interface DomainValues {
  readonly evidence: string;
  readonly reason: string;
  readonly justification: string;
  readonly ack: boolean;
}
const EMPTY: DomainValues = { evidence: '', reason: '', justification: '', ack: false };

export function TenantDomainPanel({
  tenantId,
  tenantName,
  kind,
}: {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly kind: string;
}) {
  const toast = useToast();
  const [data, setData] = useState<TenantDomain | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<DomainAction | null>(null);
  const [values, setValues] = useState<DomainValues>(EMPTY);
  const [error, setError] = useState<ErrorCopy | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    setData(null);
    try {
      setData(await platformApi.getTenantDomain(tenantId));
    } catch {
      setFailed(true);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (a: DomainAction): void => {
    setValues(EMPTY);
    setError(null);
    setDialog(a);
  };

  const explainer = (
    <div className="pt-explain">
      One organization per email domain. A <b>Provisional</b> or <b>Authoritative</b> claim holds the domain, so people
      with that email domain can only join this tenant unless a shared-domain exception is granted.
    </div>
  );

  if (failed) {
    return (
      <>
        {explainer}
        <section className="pt-card pt-w900">
          <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
            <span>
              <b>Couldn’t load the domain claim.</b>
            </span>
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30 pt-panel-alert__action" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </section>
      </>
    );
  }
  if (data === null) {
    return (
      <>
        {explainer}
        <section className="pt-card pt-w900">
          <SkeletonPanel />
        </section>
      </>
    );
  }

  const claim = data.domain_claim;
  if (claim === null) {
    return (
      <>
        {explainer}
        <section className="pt-card pt-w900 pt-center">
          <b>No domain claim</b>
          <p className="pt-center__text">
            {kind === 'PERSONAL'
              ? 'Personal tenants don’t claim an email domain.'
              : 'This tenant doesn’t hold an email domain.'}
          </p>
        </section>
      </>
    );
  }

  const pill = domainClaimPill(claim.claim);
  const acts = domainActions(claim);
  const holds = claim.claim === 'PROVISIONAL' || claim.claim === 'AUTHORITATIVE';
  const countdown = claim.claim === 'PROVISIONAL' && claim.expires_at !== null ? provisionalCountdown(claim.expires_at) : null;

  const commit = async (): Promise<void> => {
    if (dialog === null) return;
    setBusy(true);
    setError(null);
    try {
      let next: TenantDomain;
      let message: string;
      if (dialog === 'promote') {
        next = await platformApi.promoteTenantDomain(tenantId, { evidence_ref: values.evidence.trim() });
        message = `${claim.domain} is now authoritative.`;
      } else if (dialog === 'release') {
        next = await platformApi.releaseTenantDomain(tenantId, { reason: values.reason.trim() });
        message = `${claim.domain} released.`;
      } else if (dialog === 'grant') {
        next = await platformApi.grantTenantDomainException(tenantId, {
          justification: values.justification.trim(),
          evidence_ref: values.evidence.trim(),
        });
        message = `Exception granted for ${claim.domain}.`;
      } else {
        next = await platformApi.revokeTenantDomainException(tenantId);
        message = 'Exception revoked.';
      }
      setData(next);
      setDialog(null);
      toast.show(message);
    } catch (e) {
      setError(domainErrorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<DomainValues>): void => {
    setValues((v) => ({ ...v, ...patch }));
    setError(null);
  };

  const cfg = dialog === null ? null : dialogConfig(dialog, claim, pill, tenantName);
  const canCommit =
    dialog === 'promote'
      ? values.evidence.trim() !== ''
      : dialog === 'release'
        ? values.reason.trim() !== '' && values.ack
        : dialog === 'grant'
          ? values.justification.trim() !== '' && values.evidence.trim() !== ''
          : true;

  return (
    <>
      {explainer}
      <section className="pt-card pt-w900 pt-pad20">
        <div className="pt-dhead__row">
          <span className="pt-domain">{claim.domain}</span>
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {holds ? <span className="pt-holds">Holds the domain</span> : null}
        </div>
        <dl className="pt-dl170 pt-dl-14">
          <dt>Reason</dt>
          <dd>{domainReasonLabel(claim.reason)}</dd>
          <dt>Shared-domain exception</dt>
          <dd>{claim.exception ? 'Granted' : 'None'}</dd>
        </dl>
        {countdown !== null && claim.expires_at !== null ? (
          <div className="pt-countdown">
            <div className="pt-countdown__row">
              <span>
                {countdown.daysLeft} days left of {PROVISIONAL_DAYS}
              </span>
              <span className="pt-countdown__exp">
                Expires {formatDate(claim.expires_at)} · {formatRelative(claim.expires_at)}
              </span>
            </div>
            <div className="pt-countdown__bar" aria-hidden="true">
              <div className="pt-countdown__fill" style={{ width: `${countdown.pct}%` }} />
            </div>
            <div className="pt-countdown__hint">Promote it with evidence before it lapses.</div>
          </div>
        ) : null}
        {acts.length > 0 ? (
          <div className="pt-domain-acts">
            {acts.includes('promote') ? (
              <Button unstyled className="pw-btn pw-btn--privileged pw-btn--34" onClick={() => open('promote')}>
                Promote to authoritative…
              </Button>
            ) : null}
            {acts.includes('grant') ? (
              <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34" onClick={() => open('grant')}>
                Grant shared-domain exception…
              </Button>
            ) : null}
            {acts.includes('revoke') ? (
              <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34" onClick={() => open('revoke')}>
                Revoke exception…
              </Button>
            ) : null}
            {acts.includes('release') ? (
              <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34 pt-release" onClick={() => open('release')}>
                Release domain…
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="pt-card pt-card--clip pt-w900 pt-mt16">
        <div className="pt-card__head--14 pt-card__head">
          <h2 className="pt-card__title">Exceptions history</h2>
        </div>
        {/* The design shows the header alone when there are no exceptions. */}
        {data.exceptions.length === 0 ? null : (
          <div className="pt-scroll">
            <table className="pt-table pt-min720">
              <thead>
                <tr>
                  <th className="pt-th pt-th--first20">Justification</th>
                  <th className="pt-th">Evidence</th>
                  <th className="pt-th">Granted</th>
                  <th className="pt-th pt-th--last">Revoked</th>
                </tr>
              </thead>
              <tbody>
                {data.exceptions.map((x) => (
                  <tr key={x.id}>
                    <td className="pt-td pt-td--first20 pt-td--just">
                      {x.justification}
                      <div className="pt-code-faint">{x.domain}</div>
                    </td>
                    <td className="pt-td pt-td--mono12">{x.evidence_ref}</td>
                    <td className="pt-td pt-td--125 pt-nowrap">
                      {formatDate(x.granted_at)} ·{' '}
                      <span className="pt-mono" title={x.granted_by_user_id}>
                        {shortId(x.granted_by_user_id)}
                      </span>
                    </td>
                    <td className="pt-td pt-td--last pt-td--125 pt-nowrap">
                      {x.revoked_at !== null ? (
                        <>
                          {formatDate(x.revoked_at)}
                          {x.revoked_by_user_id ? (
                            <>
                              {' · '}
                              <span className="pt-mono" title={x.revoked_by_user_id}>
                                {shortId(x.revoked_by_user_id)}
                              </span>
                            </>
                          ) : null}
                        </>
                      ) : (
                        'Active'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {cfg !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o && !busy) setDialog(null);
          }}
          title={cfg.title}
          from={cfg.from}
          to={cfg.to}
          consequence={cfg.consequence}
          commitLabel={cfg.commit}
          tone={cfg.tone}
          canCommit={canCommit}
          busy={busy}
          onCommit={() => void commit()}
          error={
            error ? (
              <>
                {error.message} <span className="pt-err-code pt-err-code--plain">{error.code}</span>
              </>
            ) : null
          }
        >
          {dialog === 'promote' ? (
            <FieldText
              label="Evidence reference"
              required
              maxLength={500}
              helper="A ticket, DNS record or document reference that proves ownership."
              value={values.evidence}
              onChange={(v) => set({ evidence: v })}
            />
          ) : null}
          {dialog === 'grant' ? (
            <>
              <FieldTextArea
                label="Justification"
                required
                max={2000}
                value={values.justification}
                onChange={(v) => set({ justification: v })}
              />
              <FieldText
                label="Evidence reference"
                required
                maxLength={500}
                value={values.evidence}
                onChange={(v) => set({ evidence: v })}
              />
            </>
          ) : null}
          {dialog === 'release' ? (
            <>
              <FieldTextArea label="Reason" required max={500} value={values.reason} onChange={(v) => set({ reason: v })} />
              <FieldAck
                label="I understand another organization could claim this domain."
                checked={values.ack}
                onChange={(c) => set({ ack: c })}
              />
            </>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function dialogConfig(
  action: DomainAction,
  claim: TenantDomainClaim,
  pill: PillSpec,
  tenantName: string,
): {
  title: string;
  from?: PillSpec;
  to?: PillSpec;
  consequence: string;
  commit: string;
  tone: 'privileged' | 'danger';
} {
  if (action === 'promote') {
    return {
      title: 'Promote to authoritative',
      from: pill,
      to: domainClaimPill('AUTHORITATIVE'),
      consequence: `The claim stops expiring. ${claim.domain} stays held by ${tenantName} until it is released.`,
      commit: 'Promote claim',
      tone: 'privileged',
    };
  }
  if (action === 'release') {
    return {
      title: `Release ${claim.domain}`,
      from: pill,
      to: domainClaimPill('RELEASED'),
      consequence:
        'The domain is no longer held. Another organization could then claim it. Release is the only way to reach Released and can’t be undone here.',
      commit: 'Release domain',
      tone: 'danger',
    };
  }
  if (action === 'grant') {
    return {
      title: 'Grant shared-domain exception',
      consequence: `Lets people with an @${claim.domain} email join a different organization as well. Use only for documented shared-domain arrangements.`,
      commit: 'Grant exception',
      tone: 'privileged',
    };
  }
  return {
    title: 'Revoke shared-domain exception',
    consequence: `New sign-ups from @${claim.domain} will again be limited to ${tenantName}. Existing members elsewhere are not removed.`,
    commit: 'Revoke exception',
    tone: 'privileged',
  };
}
