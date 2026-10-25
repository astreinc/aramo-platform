import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, useOptionalToast } from '@aramo/fe-foundation';

import { Pill, SkeletonPanel } from '../components';
import { GovernanceRequestDialog } from '../components/GovernanceRequestDialog';

import {
  governanceApi,
  idempotencyKey,
  type PolicyList,
  type PolicyVersion,
  type Roster,
} from './governance-api';
import {
  activationDiff,
  clampUi,
  fmtDay,
  personName,
  policyPill,
  policyRows,
  STATE_LABEL,
  shortRequestId,
  NOT_SET,
  type PolicyRow,
} from './governance-model';
import { governanceErrorText } from './governance-errors';
import './governance.css';

// CCP-B5 (B5-P; handoff §5.6) — /commercial/policy. One ACTIVE version; DRAFT authoring by
// platform_owner or finance_admin (server-enforced, live role); activation and rollback
// are POLICY_ACTIVATE change requests (requested by finance_admin, TD-A3-5; chain
// Finance → Owner, Q1) — this screen never activates a version itself (PLATFORM-UX-1
// Amendment A1-2) — except the requester's own apply of an approved request (CCP-B5-R,
// TD-B5-1): "Apply activation" / "Retry apply" shows only when the server's
// `apply_actionable` hint is true; the server re-checks everything.

type Dlg = { version: PolicyVersion; rollback: boolean } | null;

export function PolicyView() {
  const toast = useOptionalToast();
  const [data, setData] = useState<PolicyList | null>(null);
  const [people, setPeople] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const d = await governanceApi.listPolicyVersions();
      setData(d);
      setError(null);
    } catch (e) {
      setError(governanceErrorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    governanceApi.listOperators().then(setPeople, () => setPeople(null));
  }, [load]);

  const versions = data?.versions ?? [];
  const active = versions.find((v) => v.status === 'ACTIVE');
  const current =
    versions.find((v) => v.id === sel) ??
    versions.find((v) => v.status === 'DRAFT') ??
    active ??
    versions[0];
  const canAuthor = data?.caller.can_author === true;
  const canRequest = data?.caller.can_request_activation === true;
  const open = data?.open_request ?? null;
  const nameOf = useMemo(() => {
    const map = new Map(
      (people?.operators ?? []).map((o) => [o.user_id, personName(o, o.user_id)]),
    );
    return (id: string | null): string => (id === null ? 'system' : (map.get(id) ?? id));
  }, [people]);

  const saveField = async (v: PolicyVersion, row: PolicyRow, raw: string): Promise<void> => {
    // CCP-FIX1: an optional setting left blank stays unset (the server never defaults it).
    if (row.field.optional === true && raw.trim() === '') return;
    const ui = clampUi(row.field, raw);
    const value = row.field.fromUi(ui);
    if (v.content === null || v.content[row.field.key] === value) return;
    setEditError(null);
    try {
      const out = await governanceApi.updatePolicyDraft(v.id, {
        content: { [row.field.key]: value },
      });
      setData((d) =>
        d === null
          ? d
          : { ...d, versions: d.versions.map((x) => (x.id === v.id ? out.version : x)) },
      );
    } catch (e) {
      setEditError(governanceErrorText(e));
      void load();
    }
  };

  const createDraft = async (from: PolicyVersion): Promise<void> => {
    try {
      const out = await governanceApi.createPolicyDraft({ source_version_id: from.id });
      await load();
      setSel(out.version.id);
    } catch (e) {
      toast.show(governanceErrorText(e));
    }
  };

  if (error !== null && data === null) {
    return (
      <div className="pw-gov" data-testid="commercial-policy">
        <PolicyHead />
        <div role="alert" className="pw-alert pw-alert--error">
          {error}
        </div>
      </div>
    );
  }

  const editable = current?.status === 'DRAFT' && canAuthor && current.open_request === null;
  // CCP-FIX1: the draft editor also lists the optional apply deadline, so it can be set.
  const rows = current === undefined ? [] : policyRows(current, active, { includeOptional: editable });
  const changedCount = rows.filter((r) => r.changed).length;
  const why = !canRequest
    ? 'Needs the Finance admin role.'
    : open !== null
      ? 'An activation request is already open.'
      : '';
  const actions =
    current === undefined
      ? []
      : actionsFor(current, versions, canAuthor, canRequest, open !== null);
  const latest = current?.latest_request ?? null;
  const hint =
    open !== null
      ? `Open request ${shortRequestId(open.id)} · ${(STATE_LABEL[open.state] ?? open.state).toLowerCase()}`
      : latest !== null && latest.state === 'APPLY_EXPIRED'
        ? `Request ${shortRequestId(latest.id)} · apply expired, request activation again`
        : latest !== null && latest.state === 'APPLIED' && latest.applied_at !== null
          ? `Request ${shortRequestId(latest.id)} · applied ${fmtDay(latest.applied_at)}`
          : current?.status === 'DRAFT'
            ? `${changedCount} setting(s) differ from v${active?.version_number ?? '?'}`
            : '';
  const applyable = current?.open_request ?? null;

  const applyActivation = async (id: string): Promise<void> => {
    setBusy(true);
    setEditError(null);
    try {
      await governanceApi.applyChange(id);
      toast.show(`${shortRequestId(id)} applied`);
    } catch (e) {
      setEditError(governanceErrorText(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <div className="pw-gov" data-testid="commercial-policy">
      <PolicyHead />
      {data !== null && !canAuthor ? (
        <div className="pw-gov-note" role="note">
          <b>View only.</b> You can view policy versions. Drafting and requesting activation needs
          the <b>Platform owner</b> or <b>Finance admin</b> role.
        </div>
      ) : null}
      <div className="pw-gov-grid pw-gov-grid--policy">
        <section className="pw-gov-card" aria-labelledby="pw-pol-versions">
          <div className="pw-gov-card__head">
            <h2 id="pw-pol-versions" className="pw-gov-card__title">
              Versions
            </h2>
          </div>
          {data === null ? (
            <SkeletonPanel lines={['60%', '85%', '70%']} label="Loading policy versions…" />
          ) : (
            versions.map((v) => {
              const on = v.id === current?.id;
              const p = policyPill(v.status);
              return (
                <Button
                  key={v.id}
                  unstyled
                  className={on ? 'pw-pol-ver pw-pol-ver--on' : 'pw-pol-ver'}
                  aria-pressed={on}
                  onClick={() => setSel(v.id)}
                >
                  <span className="pw-pol-ver__v">v{v.version_number}</span>
                  <span className="pw-pol-ver__note">{v.note ?? ''}</span>
                  <Pill tone={p.tone}>{p.label}</Pill>
                  <span />
                  <span className="pw-pol-ver__meta">
                    {/* One text node, as in the design (split runs shape differently). */}
                    {`Created ${fmtDay(v.created_at)} by ${nameOf(v.created_by)}${v.activated_at !== null ? ` · activated ${fmtDay(v.activated_at)}` : ''}${v.retired_at !== null ? ` · retired ${fmtDay(v.retired_at)}` : ''}`}
                  </span>
                  <span />
                </Button>
              );
            })
          )}
        </section>
        <section className="pw-gov-card" aria-labelledby="pw-pol-detail">
          <div className="pw-gov-card__head pw-gov-card__head--row">
            <h2 id="pw-pol-detail" className="pw-gov-card__title">
              Policy {current === undefined ? '' : `v${current.version_number}`}
            </h2>
            {current !== undefined ? (
              <Pill tone={policyPill(current.status).tone}>{policyPill(current.status).label}</Pill>
            ) : null}
            <span className="pw-gov-card__aside">
              {current === undefined
                ? ''
                : current.status === 'ACTIVE'
                  ? 'This is the active version'
                  : `Compared with active v${active?.version_number ?? '?'}`}
            </span>
          </div>
          <div className="pw-gov-scroll">
            <table className="pw-gov-table pw-pol-table">
              <thead>
                <tr>
                  <th className="pw-pol-table__mark" aria-label="Changed" />
                  <th>Setting</th>
                  <th>Active</th>
                  <th>This version</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.field.key}
                    className={r.changed ? 'pw-pol-row pw-pol-row--changed' : 'pw-pol-row'}
                  >
                    <td className="pw-pol-row__mark">
                      {r.changed ? '~' : ''}
                      {r.changed ? <span className="pw-sr-only"> changed</span> : null}
                    </td>
                    <td>
                      <div className="pw-pol-row__label">{r.field.label}</div>
                      <div className="pw-pol-row__help">{r.field.help}</div>
                    </td>
                    <td className="pw-pol-row__active">{r.active}</td>
                    <td className="pw-pol-row__mine">
                      {editable && current !== undefined ? (
                        <Input
                          unstyled
                          className="pw-pol-input"
                          type="number"
                          min={r.field.min}
                          max={r.field.max}
                          aria-label={r.field.label}
                          defaultValue={r.declared ? String(r.raw) : ''}
                          placeholder={r.declared ? undefined : NOT_SET}
                          key={`${current.id}:${current.content_checksum}:${r.field.key}`}
                          onBlur={(e) => void saveField(current, r, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        r.mine
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editError !== null ? (
            <div role="alert" className="pw-alert pw-alert--error pw-pol-error">
              {editError}
            </div>
          ) : null}
          <div className="pw-gov-actions">
            {applyable !== null && applyable.apply_actionable ? (
              <Button
                unstyled
                className="pw-gov-btn pw-gov-btn--privileged"
                disabled={busy}
                onClick={() => void applyActivation(applyable.id)}
              >
                {applyable.state === 'APPLY_FAILED' ? 'Retry apply' : 'Apply activation'}
              </Button>
            ) : null}
            {actions.map((a) => (
              <Button
                key={a.label}
                unstyled
                className={`pw-gov-btn pw-gov-btn--${a.tone}${a.disabled ? ' pw-gov-btn--dim' : ''}`}
                disabled={a.disabled}
                title={
                  a.disabled
                    ? a.kind === 'request'
                      ? why
                      : 'Needs the Platform owner or Finance admin role.'
                    : undefined
                }
                onClick={() => {
                  if (current === undefined) return;
                  if (a.kind === 'draft') void createDraft(current);
                  else setDlg({ version: current, rollback: a.kind === 'rollback' });
                }}
              >
                {a.label}
              </Button>
            ))}
            <span className="pw-gov-actions__hint">{hint}</span>
          </div>
        </section>
      </div>
      {dlg !== null && active !== undefined ? (
        <ActivationDialog
          version={dlg.version}
          active={active}
          rollback={dlg.rollback}
          busy={busy}
          onClose={() => setDlg(null)}
          onSubmit={async (reason) => {
            setBusy(true);
            try {
              const cr = await governanceApi.requestChange({
                action_type: 'POLICY_ACTIVATE',
                payload: {
                  policy_version_id: dlg.version.id,
                  target_content_checksum: dlg.version.content_checksum,
                },
                reason,
                idempotency_key: idempotencyKey('policy-activate'),
              });
              setDlg(null);
              toast.show(`${shortRequestId(cr.id)} submitted · Finance → Owner`);
              await load();
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function PolicyHead() {
  return (
    <div className="pw-gov-head">
      <h1 className="pw-gov-title">Commercial policy</h1>
      <p className="pw-gov-intro">
        Thresholds and windows that decide which approval chain a request gets. Exactly one version
        is active. Activating or rolling back a version is itself a change request, and existing
        requests keep the chain they were created with.
      </p>
    </div>
  );
}

interface PolicyAction {
  readonly kind: 'request' | 'rollback' | 'draft';
  readonly label: string;
  readonly tone: 'privileged' | 'secondary';
  readonly disabled: boolean;
}

/** Handoff §5.6 actions: Draft → Request activation; Retired → Request rollback; Active with no draft → Create draft. */
function actionsFor(
  v: PolicyVersion,
  all: readonly PolicyVersion[],
  canAuthor: boolean,
  canRequest: boolean,
  openRequest: boolean,
): PolicyAction[] {
  if (v.status === 'DRAFT')
    return [
      {
        kind: 'request',
        label: 'Request activation…',
        tone: 'privileged',
        disabled: !canRequest || openRequest,
      },
    ];
  if (v.status === 'RETIRED')
    return [
      {
        kind: 'rollback',
        label: `Request rollback to v${v.version_number}…`,
        tone: 'secondary',
        disabled: !canRequest || openRequest,
      },
    ];
  if (all.some((x) => x.status === 'DRAFT')) return [];
  return [
    {
      kind: 'draft',
      label: `Create draft from v${v.version_number}`,
      tone: 'secondary',
      disabled: !canAuthor,
    },
  ];
}

function ActivationDialog({
  version,
  active,
  rollback,
  busy,
  onClose,
  onSubmit,
}: {
  readonly version: PolicyVersion;
  readonly active: PolicyVersion;
  readonly rollback: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ok = reason.trim() !== '' && evidence.trim() !== '';
  return (
    <GovernanceRequestDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={
        rollback
          ? `Request rollback to policy v${version.version_number}`
          : `Request activation · policy v${version.version_number}`
      }
      sub={`v${version.version_number} becomes the active policy once approved; v${active.version_number} is retired. Requests already open keep the chain they were created with.`}
      reason={reason}
      onReason={setReason}
      evidence={evidence}
      onEvidence={setEvidence}
      diff={activationDiff(version, active)}
      chain={{
        label: 'Policy change',
        steps: 'Finance → Owner',
        policy: `v${active.version_number}`,
        ttl: `${active.content?.approval_expiry_hours ?? '?'} h`,
      }}
      error={error}
      commitLabel="Submit for approval"
      tone="privileged"
      canCommit={ok}
      busy={busy}
      onCommit={() => {
        setError(null);
        onSubmit(`${reason.trim()}\n\nEvidence: ${evidence.trim()}`).catch((e: unknown) =>
          setError(governanceErrorText(e)),
        );
      }}
    />
  );
}
