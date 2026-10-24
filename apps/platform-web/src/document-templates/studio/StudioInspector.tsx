import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input, TextArea } from '@aramo/fe-foundation';

import { Pill, type PillSpec } from '../../components/Pill';
import { TagInput } from '../../components/TagInput';
import { formatDate } from '../../components/format-date';
import type { PlatformTemplate, WithdrawalState } from '../document-templates-api';

import { checksLine, type Readiness } from './readiness';
import type { StudioDrag } from './use-studio-drag';
import { chipInfo, matchesQuery, type VariableCatalog } from './variables';

// PLATFORM-UX-1 F-9 (handoff §10.6) — the inspector: Variables · Properties · Checks.

export type RightTab = 'variables' | 'properties' | 'checks';

const NAME_MAX = 120;
const DESC_MAX = 500;

export interface PropertiesPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly products?: string[];
}

export interface StudioInspectorProps {
  readonly tab: RightTab;
  readonly onTab: (t: RightTab) => void;
  readonly catalog: VariableCatalog;
  readonly readiness: Readiness;
  readonly editable: boolean;
  readonly canManage: boolean;
  readonly onInsert: (key: string) => void;
  readonly drag: StudioDrag;
  readonly onFix: (key: string) => void;
  readonly template: PlatformTemplate;
  readonly docTypeName: string;
  readonly withdrawal: WithdrawalState;
  readonly onSaveProps: (patch: PropertiesPatch) => Promise<string | null>;
  readonly canWithdraw: boolean;
  readonly canCancelWithdrawal: boolean;
  readonly onWithdraw: () => void;
  readonly onCancelWithdrawal: () => void;
  readonly overlay: boolean;
}

export function withdrawalPill(state: WithdrawalState): PillSpec {
  if (state === 'PENDING') return { label: 'Pending', tone: 'warn' };
  if (state === 'IN_EFFECT') return { label: 'Withdrawn', tone: 'muted' };
  return { label: 'None', tone: 'ok' };
}

export function StudioInspector(props: StudioInspectorProps) {
  const { tab, readiness } = props;
  const badge = readiness.fails + readiness.warns;
  return (
    <aside aria-label="Inspector" className={`pws-right${props.overlay ? ' pws-right--overlay' : ''}`}>
      <div className="pws-panel-tabs">
        <div role="tablist" aria-label="Inspector" className="pws-seg pws-seg--fill">
          {(
            [
              ['variables', 'Variables'],
              ['properties', 'Properties'],
              ['checks', 'Checks'],
            ] as const
          ).map(([k, l]) => (
            <Button key={k} unstyled role="tab" aria-selected={tab === k} className={`pws-seg__item${tab === k ? ' pws-seg__item--on' : ''}`} onClick={() => props.onTab(k)}>
              {l}
              {k === 'checks' && badge > 0 ? (
                <span className="pws-badge" aria-label={`${badge} open`}>
                  {badge}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      </div>
      <div className="pws-right__body" role="tabpanel">
        {tab === 'variables' ? <VariablesTab {...props} /> : null}
        {tab === 'properties' ? <PropertiesTab {...props} /> : null}
        {tab === 'checks' ? (
          <>
            <div className="pws-checks__line">{checksLine(readiness)}</div>
            <ol className="pws-checks">
              {readiness.items.map((i) => {
                const st = i.ok ? 'ok' : i.severity === 'warn' ? 'warn' : 'fail';
                return (
                  <li key={i.id} className="pws-check">
                    <span aria-hidden="true" className={`pws-check__ic pws-check__ic--${st}`}>
                      {i.ok ? '✓' : i.severity === 'warn' ? '!' : '×'}
                    </span>
                    <span className="pws-check__body">
                      <span className="pws-sr">{i.ok ? 'Passed: ' : i.severity === 'warn' ? 'Warning: ' : 'Failing: '}</span>
                      <span className="pws-check__l">{i.label}</span>
                      {!i.ok ? <span className="pws-check__d">{i.detail}</span> : null}
                      {i.fixKey !== undefined && props.canManage ? (
                        <Button unstyled className="pws-btn26 pws-check__fix" onClick={() => props.onFix(i.fixKey as string)}>
                          Remove from draft
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="pws-checks__note">Publish unlocks when every required check passes. Saving the draft again resets the preview check.</p>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function VariablesTab({ catalog, readiness, editable, onInsert, drag }: StudioInspectorProps) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string>('ALL');
  const unknown = Array.from(readiness.used.keys()).filter((k) => chipInfo(catalog, k).state === 'unknown');
  const groups = catalog.groups.filter((g) => group === 'ALL' || g === group);
  const list = groups
    .map((g) => ({ g, items: catalog.list.filter((v) => v.group === g && matchesQuery(v, q)) }))
    .filter((x) => x.items.length > 0);
  return (
    <>
      <Input unstyled className="pws-in pws-in--36 pws-vars__q" value={q} placeholder="Search variables" aria-label="Search variables" onChange={(e) => setQ(e.target.value)} />
      <div className="pws-vars__groups" role="group" aria-label="Variable group">
        {['ALL', ...catalog.groups].map((g) => (
          <Button key={g} unstyled aria-pressed={group === g} className={`pws-chipbtn${group === g ? ' pws-chipbtn--on' : ''}`} onClick={() => setGroup(g)}>
            {g === 'ALL' ? 'All' : g}
          </Button>
        ))}
      </div>
      {unknown.length > 0 ? (
        <div className="pws-vars__unknown" role="alert">
          Unknown in this draft:{' '}
          {unknown.map((k) => (
            <span key={k} className="pws-mono">
              {k}{' '}
            </span>
          ))}
          · see Checks.
        </div>
      ) : null}
      {list.map((gr) => (
        <div key={gr.g} className="pws-vars__group">
          <div className="pws-vars__gl">{gr.g}</div>
          {gr.items.map((v) => {
            const used = readiness.used.get(v.key) ?? 0;
            const canIns = editable && v.insertable;
            return (
              <div
                key={v.key}
                className="pws-vcard"
                draggable={canIns}
                onDragStart={(e) => drag.start(e, { kind: 'var', key: v.key })}
                onDragEnd={drag.end}
              >
                <span className="pws-vcard__label">
                  {v.label}
                  {!v.active ? <span className="pws-vcard__inactive"> INACTIVE</span> : null}
                </span>
                {canIns ? (
                  <Button
                    unstyled
                    className="pws-vcard__ins"
                    title="Insert at cursor"
                    aria-label={`Insert ${v.label}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onInsert(v.key);
                    }}
                  >
                    Insert
                  </Button>
                ) : null}
                <span className="pws-vcard__key">{v.key}</span>
                <span className="pws-vcard__meta">
                  {v.type !== '' ? <span>{v.type}</span> : null}
                  {v.sample !== '' ? (
                    <span>
                      e.g. <span className="pws-vcard__sample">{v.sample}</span>
                    </span>
                  ) : null}
                  {used > 0 ? <span className="pws-vcard__used">{used}× in draft</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {list.length === 0 ? <div className="pws-vars__none">No variables match.</div> : null}
      <Link to="/template-variables" className="pws-vars__manage">
        Manage template variables ↗
      </Link>
    </>
  );
}

function PropertiesTab(props: StudioInspectorProps) {
  const { template, canManage, withdrawal } = props;
  const [name, setName] = useState(template.name);
  const [desc, setDesc] = useState(template.description ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(template.name);
    setDesc(template.description ?? '');
  }, [template.name, template.description]);

  const save = async (patch: PropertiesPatch): Promise<void> => {
    setError(await props.onSaveProps(patch));
  };
  const wd = withdrawalPill(withdrawal);
  const wdLine =
    withdrawal === 'NONE'
      ? 'Available to tenants'
      : withdrawal === 'PENDING'
        ? `Withdrawal pending · ${formatDate(template.withdraw_effective_at)}`
        : `Withdrawn ${formatDate(template.withdraw_effective_at)}`;

  return (
    <div className="pws-props">
      <label className="pws-props__field">
        <span className="pws-props__l">Name</span>
        <Input
          unstyled
          className="pws-in pws-in--36"
          value={name}
          disabled={!canManage}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
          onBlur={() => {
            const v = name.trim();
            if (v === template.name) return;
            if (v === '') {
              setError('Name is required.');
              setName(template.name);
              return;
            }
            void save({ name: v });
          }}
        />
        <span className="pws-props__count">
          {name.length} / {NAME_MAX}
        </span>
      </label>
      <label className="pws-props__field">
        <span className="pws-props__l">Description</span>
        <TextArea
          unstyled
          className="pws-in pws-in--area"
          rows={3}
          value={desc}
          disabled={!canManage}
          onChange={(e) => setDesc(e.target.value.slice(0, DESC_MAX))}
          onBlur={() => {
            const v = desc.trim();
            if (v === (template.description ?? '')) return;
            void save({ description: v === '' ? null : v });
          }}
        />
        <span className="pws-props__count">
          {desc.length} / {DESC_MAX}
        </span>
      </label>
      {canManage ? (
        <TagInput label="Product tags" tags={template.products} onChange={(products) => void save({ products })} />
      ) : (
        <div className="pws-props__field">
          <span className="pws-props__l">Product tags</span>
          <span className="pws-tags">
            {template.products.map((p) => (
              <span key={p} className="pws-tag">
                {p}
              </span>
            ))}
          </span>
        </div>
      )}
      {error !== null ? (
        <div role="alert" className="pw-alert pw-alert--error">
          {error}
        </div>
      ) : null}
      <dl className="pws-props__dl">
        <dt>Document type</dt>
        <dd>
          {props.docTypeName} <span className="pws-faint">· set at creation</span>
        </dd>
        <dt>Kind</dt>
        <dd>Generated</dd>
        <dt>Template ID</dt>
        <dd className="pws-mono pws-props__id">{template.id}</dd>
        <dt>Created</dt>
        <dd>{formatDate(template.created_at)}</dd>
        <dt>Updated</dt>
        <dd>{formatDate(template.updated_at)}</dd>
      </dl>
      <div className="pws-wdbox">
        <div className="pws-wdbox__head">
          <b>Withdrawal</b>
          <span className="pws-pill20">
            <Pill tone={wd.tone} dot={false}>
              {wd.label}
            </Pill>
          </span>
        </div>
        <div className="pws-wdbox__line">{wdLine}</div>
        {props.canWithdraw || props.canCancelWithdrawal ? (
          <div className="pws-wdbox__acts">
            {props.canWithdraw ? (
              <Button unstyled className="pws-btn30 pws-btn30--terra" onClick={props.onWithdraw}>
                Withdraw…
              </Button>
            ) : null}
            {props.canCancelWithdrawal ? (
              <Button unstyled className="pws-btn30" onClick={props.onCancelWithdrawal}>
                Cancel withdrawal…
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
