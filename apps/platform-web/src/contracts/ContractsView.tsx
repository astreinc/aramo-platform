import { useCallback, useEffect, useState } from 'react';
import { Button, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import { ContractRequestDialog } from './ContractRequestDialog';
import {
  CONTRACT_REQUEST_SCOPE,
  contractRequestErrorText,
  contractsApi,
  type ContractDetail,
  type ContractSummary,
} from './contracts-api';
import { contractFacts, contractRowLine, contractTimeline, formatDay, personName, shortHash } from './contracts-format';
import './contracts.css';

// CCP-B4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B4; Charter L6) —
// Commercial › Contracts (`/commercial/contracts`, handoff §5.5; the pinned design
// Commercial Control Plane v1.0.dc.html:227-258). A record of what was agreed with
// its evidence, NOT a quoting tool: the list beside a detail panel (facts,
// negotiated terms, hashed documents, amendments timeline). "Record amendment…"
// and "End contract…" create governed change requests (SUBSCRIPTION_CHANGE with
// `contract_amendment`, SUBSCRIPTION_END with `contract_end`) and submit them for
// approval; nothing changes until the chain is signed and the request is applied.
//
// Gate (App.tsx): platform:subscription:read. The actions need
// platform:subscription:request (commercial_ops); without it they are disabled with
// the reason in their tooltip (handoff §2 "Read without change"). Contract
// invoicing is not enabled (PBD §10): the read model says so and nothing here
// offers it.

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/** The chain the server resolves for SUBSCRIPTION_CHANGE / _END (TD-A3-2: Finance only). */
const CHAIN = { label: 'Below threshold', steps: 'Finance', note: 'chain fixed by the active policy' };

export interface ContractsViewProps {
  readonly session: Session;
  /** Test seam: the clock for "in n days". */
  readonly now?: () => number;
}

export function ContractsView({ session, now = Date.now }: ContractsViewProps) {
  const toast = useOptionalToast();
  const canRequest = hasScope(session, CONTRACT_REQUEST_SCOPE);
  const [list, setList] = useState<Load<ContractSummary[]>>({ state: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Load<ContractDetail> | null>(null);
  const [dialog, setDialog] = useState<'amend' | 'end' | null>(null);

  useEffect(() => {
    let live = true;
    contractsApi
      .list()
      .then((r) => {
        if (!live) return;
        setList({ state: 'ready', data: r.contracts });
        setSelected((cur) => cur ?? r.contracts[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (live) setList({ state: 'error', message: e instanceof Error ? e.message : 'The contracts couldn’t be loaded.' });
      });
    return () => {
      live = false;
    };
  }, []);

  const loadDetail = useCallback((id: string) => {
    setDetail({ state: 'loading' });
    contractsApi
      .get(id)
      .then((d) => setDetail({ state: 'ready', data: d }))
      .catch((e: unknown) => setDetail({ state: 'error', message: e instanceof Error ? e.message : 'The contract couldn’t be loaded.' }));
  }, []);

  useEffect(() => {
    if (selected !== null) loadDetail(selected);
  }, [selected, loadDetail]);

  return (
    <div className="ccp-contracts-page">
      <div className="ccp-page-head">
        <h1>Contracts</h1>
        <p>Enterprise MANUAL subscriptions recorded with their evidence. This is a record of what was agreed, not a quoting tool; changes go through change requests.</p>
      </div>
      {list.state === 'loading' ? (
        <section className="ccp-card ccp-skeleton" aria-busy="true">
          <span className="ccp-sr-only" role="status">
            Loading contracts…
          </span>
          <span style={{ width: '40%' }} aria-hidden="true" />
          <span style={{ width: '85%' }} aria-hidden="true" />
        </section>
      ) : list.state === 'error' ? (
        <section className="ccp-card ccp-empty" role="alert">
          <b>Contracts couldn’t be loaded</b>
          <div className="ccp-empty__body">{list.message}</div>
        </section>
      ) : list.data.length === 0 ? (
        <section className="ccp-card ccp-empty">
          <b>No contracts recorded</b>
          <div className="ccp-empty__body">MANUAL subscriptions appear here once a contract is recorded.</div>
        </section>
      ) : (
        <div className="ccp-contracts">
          <section className="ccp-card ccp-contracts__list" aria-label="Contracts">
            {list.data.map((c) => (
              <Button key={c.id} unstyled className="ccp-ct-row" aria-pressed={c.id === selected} onClick={() => setSelected(c.id)}>
                <div className="ccp-ct-row__top">
                  <span className="ccp-ct-row__id">{c.contract_ref}</span>
                  <span className={`ccp-pill ccp-pill--${c.status === 'ACTIVE' ? 'ok' : 'muted'}`}>{c.status === 'ACTIVE' ? 'Active' : 'Ended'}</span>
                </div>
                <div className="ccp-ct-row__tenant">{c.tenant.name}</div>
                <div className="ccp-ct-row__sub">{contractRowLine(c)}</div>
              </Button>
            ))}
          </section>
          <section className="ccp-card ccp-contracts__detail" aria-live="polite">
            {detail === null || detail.state === 'loading' ? (
              <div className="ccp-skeleton ccp-skeleton--inline" aria-busy="true">
                <span className="ccp-sr-only" role="status">
                  Loading the contract…
                </span>
                <span style={{ width: '40%' }} aria-hidden="true" />
                <span style={{ width: '85%' }} aria-hidden="true" />
              </div>
            ) : detail.state === 'error' ? (
              <div role="alert" className="ccp-dlg__alert">
                {detail.message}
              </div>
            ) : (
              <ContractDetailPanel c={detail.data} now={now()} canRequest={canRequest} onAmend={() => setDialog('amend')} onEnd={() => setDialog('end')} />
            )}
          </section>
        </div>
      )}
      {dialog !== null && detail?.state === 'ready' ? (
        <ContractDialog
          kind={dialog}
          c={detail.data}
          onCancel={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            toast.show(`Change request ${id.slice(0, 8)} submitted for approval. The contract changes once every step is signed.`);
          }}
        />
      ) : null}
    </div>
  );
}

function ContractDetailPanel({ c, now, canRequest, onAmend, onEnd }: { c: ContractDetail; now: number; canRequest: boolean; onAmend: () => void; onEnd: () => void }) {
  const why = 'Needs the Commercial ops role.';
  const act = (label: string, cls: string, onClick: () => void) => (
    <Button
      unstyled
      className={cls}
      aria-disabled={canRequest ? undefined : 'true'}
      title={canRequest ? undefined : why}
      onClick={() => {
        if (canRequest) onClick();
      }}
    >
      {label}
    </Button>
  );
  return (
    <>
      <div className="ccp-ct-head">
        <div>
          <div className="ccp-ct-head__id">{c.contract_ref}</div>
          <h2>
            {c.tenant.name} · {c.subscription.plan.name}
          </h2>
        </div>
        {c.provenance === 'MIGRATION' ? <span className="ccp-badge">Migrated — provenance: migration</span> : null}
        <div className="ccp-ct-head__actions">
          {c.status === 'ACTIVE' ? (
            <>
              {act('Record amendment…', 'ccp-btn', onAmend)}
              {act('End contract…', 'ccp-btn ccp-btn--danger', onEnd)}
            </>
          ) : null}
        </div>
      </div>
      {!canRequest && c.status === 'ACTIVE' ? <span className="ccp-sr-only">Recording an amendment or ending a contract needs the Commercial ops role.</span> : null}
      <div className="ccp-facts">
        {contractFacts(c, now).map((f) => (
          <div key={f.k} className="ccp-fact">
            <div className="ccp-fact__k">{f.k}</div>
            <div className="ccp-fact__v">{f.v}</div>
            <div className="ccp-fact__s">{f.s}</div>
          </div>
        ))}
      </div>
      <h3 className="ccp-h3">Negotiated terms</h3>
      <ul className="ccp-terms">
        {c.terms.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      <h3 className="ccp-h3">Documents</h3>
      <div className="ccp-docs">
        <table>
          <thead>
            <tr>
              <th className="ccp-th">Document</th>
              <th className="ccp-th">Hash</th>
              <th className="ccp-th">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {c.documents.length === 0 ? (
              <tr className="ccp-docs__none">
                <td colSpan={3}>No documents recorded.</td>
              </tr>
            ) : (
              c.documents.map((d) => (
                <tr key={`${d.sha256}-${d.amendment_sequence ?? 0}`}>
                  <td>{d.name}</td>
                  <td className="ccp-mono" title={`sha256:${d.sha256}`}>
                    {shortHash(d.sha256)}
                  </td>
                  <td>
                    {personName(d.recorded_by)} · {formatDay(d.recorded_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <h3 className="ccp-h3 ccp-h3--tl">Amendments</h3>
      <ol className="ccp-tl">
        {contractTimeline(c).map((e) => (
          <li key={e.key}>
            <span className="ccp-tl__dot" aria-hidden="true" />
            <div>
              <div className="ccp-tl__top">
                <b>{e.title}</b>
                <span className="ccp-tl__at">{formatDay(e.at)}</span>
              </div>
              <div className="ccp-tl__body">{e.body}</div>
              <div className="ccp-tl__by">{e.by}</div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function ContractDialog({ kind, c, onCancel, onDone }: { kind: 'amend' | 'end'; c: ContractDetail; onCancel: () => void; onDone: (id: string) => void }) {
  const evidence = [
    { key: 'reason', label: 'Reason', kind: 'area' as const, placeholder: 'Why this change is needed' },
    { key: 'evidence', label: 'Evidence', kind: 'text' as const, placeholder: 'Document, ticket or call notes reference' },
  ];
  const run = async (fn: () => Promise<{ id: string }>) => {
    try {
      onDone((await fn()).id);
    } catch (e) {
      throw new Error(contractRequestErrorText(e));
    }
  };
  if (kind === 'amend') {
    return (
      <ContractRequestDialog
        title={`Record amendment · ${c.contract_ref}`}
        sub="Amendments are recorded with evidence and apply after approval."
        fields={[{ key: 'amendment', label: 'Amendment', kind: 'text', placeholder: 'e.g. Allowance raised to 30,000 envelopes per month' }, ...evidence]}
        diff={(v) => [{ field: 'Terms', before: 'Current terms', after: (v['amendment'] ?? '').trim() || '—' }]}
        chain={CHAIN}
        tone="terra"
        commitLabel="Submit for approval"
        onCancel={onCancel}
        onCommit={(v) => run(() => contractsApi.requestAmendment(c, { amendment: v['amendment'] ?? '', reason: v['reason'] ?? '', evidence: v['evidence'] ?? '' }))}
      />
    );
  }
  return (
    <ContractRequestDialog
      title={`End contract · ${c.contract_ref}`}
      sub={`Ends the MANUAL subscription for ${c.tenant.name} once approved. The product entitlement is not revoked by this request; a revoke is its own change request.`}
      fields={evidence}
      diff={() => [
        { field: `Contract ${c.contract_ref}`, before: 'Active', after: 'Ended' },
        { field: 'MANUAL subscription', before: 'Active', after: 'Ended' },
      ]}
      chain={CHAIN}
      typed={c.contract_ref}
      tone="danger"
      commitLabel="Submit for approval"
      onCancel={onCancel}
      onCommit={(v) => run(() => contractsApi.requestEnd(c, { reason: v['reason'] ?? '', evidence: v['evidence'] ?? '' }))}
    />
  );
}
