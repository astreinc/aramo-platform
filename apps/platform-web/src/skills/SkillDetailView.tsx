import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, Button, Input, Select, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import { Pill, SkeletonPanel, formatDate } from '../components';
import { useEntityCrumb } from '../shell/crumbs';

import {
  skillsApi,
  ALIAS_TYPES,
  type Skill,
  type SkillAlias,
  type SkillAliasType,
  type SkillRelationship,
  type SkillVersion,
} from './skills-api';
import {
  ALIAS_TYPE_LABEL,
  aliasTypeLabel,
  directionLabel,
  relationshipSourceLabel,
  relationshipTypeLabel,
  statusPill,
} from './skill-labels';
import { skillErrorMessage } from './skill-errors';
import { useSkillDirectory, type SkillDirectory } from './skill-directory';
import { SkillName } from './SkillName';
import {
  AddRelationshipDialog,
  EditSkillDialog,
  MergeSkillDialog,
  OverrideSkillDialog,
  ToggleSkillDialog,
} from './skill-dialogs';
import { SKILL_MANAGE_SCOPE } from './SkillsRegistryView';
import { SkillsViewOnly } from './skills-chrome';

type TabKey = 'overview' | 'aliases' | 'versions' | 'rels';
type DialogKind = 'edit' | 'override' | 'merge' | 'toggle' | 'addRel';

/**
 * A relationship row from THIS skill's point of view. The list holds edges in
 * either orientation; a directed edge where this skill is the target reads
 * "{other} {type} {this}". Direction always comes from the server's
 * `directionality`.
 */
export function relationshipView(rel: SkillRelationship, selfId: string) {
  const outgoing = rel.source_skill_id === selfId;
  const otherId = outgoing ? rel.target_skill_id : rel.source_skill_id;
  const selfFirst = outgoing || rel.directionality === 'SYMMETRIC';
  return {
    otherId,
    selfFirst,
    type: relationshipTypeLabel(rel.relationship_type),
    meta: `${directionLabel(rel.directionality)} · ${relationshipSourceLabel(rel.source)}`,
    ref: rel.source_ref ?? '—',
  };
}

// PLATFORM-UX-1 F-7 — Skill detail (handoff §9; directive R-9). Header: name,
// status pill, `id · normalized` in mono; actions Edit · Override… · Merge
// into… (terracotta outline) · Deactivate/Reactivate…; tabs Overview ·
// Aliases (n) · Versions (n) · Relationships (n). Every skill reference shows a
// NAME, resolved through the registry list. Without platform:skill:manage the
// view-only note replaces the actions and the add rows (never a silent hide).
export function SkillDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  const directory = useSkillDirectory();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [aliases, setAliases] = useState<SkillAlias[]>([]);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [relationships, setRelationships] = useState<SkillRelationship[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  useEntityCrumb(skill?.canonical_name);

  const refresh = useCallback(async () => {
    try {
      const [s, a, v, r] = await Promise.all([
        skillsApi.getSkill(id),
        skillsApi.listAliases(id),
        skillsApi.listVersions(id),
        skillsApi.listRelationships(id),
      ]);
      setSkill(s);
      setAliases(a.aliases);
      setVersions(v.versions);
      setRelationships(r.relationships);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'The skill could not be loaded.');
    }
  }, [id]);

  useEffect(() => {
    setSkill(null);
    setTab('overview');
    void refresh();
  }, [refresh]);

  const after = (message: string): void => {
    toast.show(message);
    void refresh();
    directory.reload();
  };

  if (loadError && !skill) {
    return (
      <div className="pw-sk">
        <div role="alert" className="pw-alert pw-alert--error">
          {loadError}
        </div>
      </div>
    );
  }
  if (!skill) {
    return (
      <div className="pw-sk">
        <div className="pw-sk-card">
          <div className="pw-sk-loading">
            <SkeletonPanel label="Loading skill…" />
          </div>
        </div>
      </div>
    );
  }

  const p = statusPill(skill.status);
  const active = skill.status === 'active';
  const tabs: ReadonlyArray<readonly [TabKey, string]> = [
    ['overview', 'Overview'],
    ['aliases', `Aliases (${aliases.length})`],
    ['versions', `Versions (${versions.length})`],
    ['rels', `Relationships (${relationships.length})`],
  ];
  const close = (o: boolean): void => {
    if (!o) setDialog(null);
  };

  return (
    <div className="pw-sk">
      <div className="pw-sk-dhead">
        <div>
          <div className="pw-sk-dhead__name">
            <h1 className="pw-sk-title">{skill.canonical_name}</h1>
            <Pill tone={p.tone}>{p.label}</Pill>
          </div>
          <div className="pw-sk-dhead__ids">
            {skill.id} · {skill.normalized_name}
          </div>
        </div>
        {canManage ? (
          <div className="pw-sk-actions">
            <Button unstyled className="pw-btn pw-btn--secondary pw-sk-btn36" onClick={() => setDialog('edit')}>
              Edit
            </Button>
            <Button unstyled className="pw-btn pw-btn--secondary pw-sk-btn36" onClick={() => setDialog('override')}>
              Override…
            </Button>
            <Button
              unstyled
              className="pw-btn pw-btn--secondary pw-sk-btn36 pw-sk-btn-merge"
              onClick={() => setDialog('merge')}
            >
              Merge into…
            </Button>
            <Button unstyled className="pw-btn pw-btn--secondary pw-sk-btn36" onClick={() => setDialog('toggle')}>
              {active ? 'Deactivate' : 'Reactivate'}…
            </Button>
          </div>
        ) : null}
      </div>
      {!canManage ? <SkillsViewOnly className="pw-sk-viewonly-detail" /> : null}

      <SkillTabs tabs={tabs} value={tab} onChange={setTab} />

      <div className="pw-sk-body" role="tabpanel" id={`pw-sk-panel-${tab}`} aria-labelledby={`pw-sk-tab-${tab}`}>
        {tab === 'overview' ? <OverviewTab skill={skill} directory={directory} /> : null}
        {tab === 'aliases' ? (
          <AliasesTab
            skill={skill}
            aliases={aliases}
            canManage={canManage}
            onChanged={(m) => after(m)}
            onError={(m) => toast.show(m)}
          />
        ) : null}
        {tab === 'versions' ? (
          <VersionsTab
            skill={skill}
            versions={versions}
            canManage={canManage}
            onChanged={(m) => after(m)}
            onError={(m) => toast.show(m)}
          />
        ) : null}
        {tab === 'rels' ? (
          <RelationshipsTab
            skill={skill}
            relationships={relationships}
            directory={directory}
            canManage={canManage}
            onAdd={() => setDialog('addRel')}
            onChanged={(m) => after(m)}
            onError={(m) => toast.show(m)}
          />
        ) : null}
      </div>

      {dialog === 'edit' ? (
        <EditSkillDialog open onOpenChange={close} skill={skill} onSaved={() => after('Skill updated.')} />
      ) : null}
      {dialog === 'override' ? (
        <OverrideSkillDialog open onOpenChange={close} skill={skill} onSaved={() => after('Override saved.')} />
      ) : null}
      {dialog === 'toggle' ? (
        <ToggleSkillDialog
          open
          onOpenChange={close}
          skill={skill}
          onDone={(nowActive) =>
            after(`${skill.canonical_name} ${nowActive ? 'reactivated' : 'deactivated'}.`)
          }
        />
      ) : null}
      {dialog === 'merge' ? (
        <MergeSkillDialog
          open
          onOpenChange={close}
          skill={skill}
          directory={directory}
          onMerged={(winnerId) => {
            toast.show(`${skill.canonical_name} merged into ${directory.nameOf(winnerId) ?? 'the winner'}.`);
            directory.reload();
            navigate(`/skills/${winnerId}`);
          }}
        />
      ) : null}
      {dialog === 'addRel' ? (
        <AddRelationshipDialog
          open
          onOpenChange={close}
          skill={skill}
          directory={directory}
          onAdded={() => after('Relationship added.')}
        />
      ) : null}
    </div>
  );
}

// ---- Tabs (role=tablist; ←/→ move between tabs) ------------------------------
function SkillTabs({
  tabs,
  value,
  onChange,
}: {
  readonly tabs: ReadonlyArray<readonly [TabKey, string]>;
  readonly value: TabKey;
  readonly onChange: (t: TabKey) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    const entry = tabs[next];
    if (entry) onChange(entry[0]);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label="Skill detail" className="pw-sk-tabs">
      {tabs.map(([k, label], i) => (
        <Button
          key={k}
          unstyled
          ref={(el: HTMLButtonElement | null) => {
            refs.current[i] = el;
          }}
          role="tab"
          id={`pw-sk-tab-${k}`}
          aria-selected={value === k}
          aria-controls={`pw-sk-panel-${k}`}
          tabIndex={value === k ? 0 : -1}
          className="pw-sk-tab"
          onClick={() => onChange(k)}
          onKeyDown={(e: KeyboardEvent) => onKey(e, i)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

// ---- Overview ----------------------------------------------------------------
function OverviewTab({ skill, directory }: { readonly skill: Skill; readonly directory: SkillDirectory }) {
  const rows: Array<readonly [string, ReactNode]> = [
    ['Canonical name', skill.canonical_name],
    ['Normalized name', skill.normalized_name],
    ['Skill ID', skill.id],
    ['Status', skill.status === 'active' ? 'Active' : 'Inactive'],
    ['Updated', formatDate(skill.updated_at)],
  ];
  if (skill.description) rows.splice(2, 0, ['Description', skill.description]);
  if (skill.merged_into_skill_id) {
    const winner = skill.merged_into_skill_id;
    rows.push([
      'Merged into',
      <Link key="m" to={`/skills/${winner}`}>
        <SkillName id={winner} directory={directory} />
      </Link>,
    ]);
  }
  return (
    <section className="pw-sk-card pw-sk-card--open">
      <dl className="pw-sk-facts">
        {rows.map(([k, v]) => (
          <div key={k} className="pw-sk-fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface MutatingTabProps {
  readonly skill: Skill;
  readonly canManage: boolean;
  readonly onChanged: (message: string) => void;
  readonly onError: (message: string) => void;
}

// ---- Aliases (inline add of surface + type; remove) ---------------------------
function AliasesTab({ skill, aliases, canManage, onChanged, onError }: MutatingTabProps & { readonly aliases: readonly SkillAlias[] }) {
  const [surface, setSurface] = useState('');
  const [type, setType] = useState<SkillAliasType>('COMMON_NAME');
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    const v = surface.trim();
    if (v.length === 0 || busy) return;
    setBusy(true);
    try {
      await skillsApi.addAlias(skill.id, { alias: v, alias_type: type });
      setSurface('');
      onChanged('Alias added.');
    } catch (e) {
      onError(skillErrorMessage(e, 'The alias could not be added.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (a: SkillAlias): Promise<void> => {
    try {
      await skillsApi.removeAlias(skill.id, a.id);
      onChanged(`Alias “${a.alias}” removed.`);
    } catch (e) {
      onError(skillErrorMessage(e, 'The alias could not be removed.'));
    }
  };

  return (
    <section className="pw-sk-card">
      {canManage ? (
        <div className="pw-sk-addrow">
          <Input
            unstyled
            className="pw-input pw-sk-grow"
            placeholder="Surface form"
            aria-label="Surface form"
            value={surface}
            onChange={(e) => setSurface(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
          <Select
            unstyled
            className="pw-select"
            aria-label="Alias type"
            value={type}
            onChange={(e) => setType(e.target.value as SkillAliasType)}
          >
            {ALIAS_TYPES.map((t) => (
              <option key={t} value={t}>
                {ALIAS_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
          <Button
            unstyled
            className="pw-btn pw-btn--normal pw-sk-btn36 pw-sk-btn36--pad14"
            aria-busy={busy || undefined}
            onClick={() => void add()}
          >
            Add alias
          </Button>
        </div>
      ) : null}
      {aliases.map((a) => (
        <div key={a.id} className="pw-sk-item">
          <b className="pw-sk-item__name">{a.alias}</b>
          <span className="pw-sk-item__sub">{aliasTypeLabel(a.alias_type)}</span>
          <span className="pw-sk-code">{a.alias_type}</span>
          {canManage ? (
            <Button
              unstyled
              className="pw-btn pw-btn--secondary pw-sk-btn28"
              aria-label={`Remove alias ${a.alias}`}
              onClick={() => void remove(a)}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ))}
      {aliases.length === 0 ? <div className="pw-sk-none">No aliases yet.</div> : null}
    </section>
  );
}

// ---- Versions (inline add; Active ⇄ Inactive) ---------------------------------
function VersionsTab({
  skill,
  versions,
  canManage,
  onChanged,
  onError,
}: MutatingTabProps & { readonly versions: readonly SkillVersion[] }) {
  const [version, setVersion] = useState('');
  const [family, setFamily] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    const v = version.trim();
    if (v.length === 0 || busy) return;
    setBusy(true);
    try {
      const f = family.trim();
      await skillsApi.addVersion(skill.id, { version: v, version_family: f.length > 0 ? f : null });
      setVersion('');
      setFamily('');
      onChanged('Version added.');
    } catch (e) {
      onError(skillErrorMessage(e, 'The version could not be added.'));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (v: SkillVersion): Promise<void> => {
    const next = v.status === 'active' ? 'inactive' : 'active';
    try {
      await skillsApi.updateVersion(skill.id, v.id, { status: next });
      onChanged(`Version ${v.version} is now ${next === 'active' ? 'Active' : 'Inactive'}.`);
    } catch (e) {
      onError(skillErrorMessage(e, 'The version status could not be changed.'));
    }
  };

  return (
    <section className="pw-sk-card">
      {canManage ? (
        <div className="pw-sk-addrow">
          <Input
            unstyled
            className="pw-input pw-input--mono pw-sk-version"
            placeholder="Version"
            aria-label="Version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
          <Input
            unstyled
            className="pw-input pw-sk-grow pw-sk-grow--140"
            placeholder="Family"
            aria-label="Family"
            value={family}
            onChange={(e) => setFamily(e.target.value)}
          />
          <Button
            unstyled
            className="pw-btn pw-btn--normal pw-sk-btn36 pw-sk-btn36--pad14"
            aria-busy={busy || undefined}
            onClick={() => void add()}
          >
            Add version
          </Button>
        </div>
      ) : null}
      {versions.map((v) => {
        const p = statusPill(v.status);
        return (
          <div key={v.id} className="pw-sk-item">
            <b className="pw-sk-item__name--mono">{v.version}</b>
            <span className="pw-sk-item__sub">{v.version_family ?? '—'}</span>
            <Pill tone={p.tone}>{p.label}</Pill>
            {canManage ? (
              <Button
                unstyled
                className="pw-btn pw-btn--secondary pw-sk-btn28"
                aria-label={`Change status of version ${v.version}`}
                onClick={() => void toggle(v)}
              >
                Change status
              </Button>
            ) : null}
          </div>
        );
      })}
      {versions.length === 0 ? <div className="pw-sk-none">No versions tracked.</div> : null}
    </section>
  );
}

// ---- Relationships (dialog add; names, never ids) -----------------------------
function RelationshipsTab({
  skill,
  relationships,
  directory,
  canManage,
  onAdd,
  onChanged,
  onError,
}: MutatingTabProps & {
  readonly relationships: readonly SkillRelationship[];
  readonly directory: SkillDirectory;
  readonly onAdd: () => void;
}) {
  const remove = async (r: SkillRelationship): Promise<void> => {
    try {
      await skillsApi.removeRelationship(skill.id, r.id);
      onChanged('Relationship removed.');
    } catch (e) {
      onError(skillErrorMessage(e, 'The relationship could not be removed.'));
    }
  };
  return (
    <section className="pw-sk-card">
      {canManage ? (
        <div className="pw-sk-addbar">
          <Button unstyled className="pw-btn pw-btn--normal pw-btn--34" onClick={onAdd}>
            + Add relationship
          </Button>
        </div>
      ) : null}
      {relationships.map((r) => {
        const v = relationshipView(r, skill.id);
        const other = (
          <Link className="pw-sk-item__link" to={`/skills/${v.otherId}`}>
            <SkillName id={v.otherId} directory={directory} />
          </Link>
        );
        return (
          <div key={r.id} className="pw-sk-item pw-sk-item--wrap">
            <span className="pw-sk-item__text">
              {v.selfFirst ? skill.canonical_name : other} <span className="pw-sk-item__muted">{v.type}</span>{' '}
              {v.selfFirst ? other : skill.canonical_name}
            </span>
            <span className="pw-sk-item__meta">{v.meta}</span>
            <span className="pw-sk-code">{v.ref}</span>
            {canManage ? (
              <Button
                unstyled
                className="pw-btn pw-btn--secondary pw-sk-btn28"
                aria-label="Remove relationship"
                onClick={() => void remove(r)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        );
      })}
      {relationships.length === 0 ? <div className="pw-sk-none">No relationships.</div> : null}
    </section>
  );
}
