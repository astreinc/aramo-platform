import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  Button,
  DataTable,
  InlineAlert,
  Tabs,
  hasScope,
  type Session,
  type TableColumn,
  type TabItem,
} from '@aramo/fe-foundation';

import {
  skillsApi,
  type Skill,
  type SkillAlias,
  type SkillRelationship,
  type SkillVersion,
} from './skills-api';
import { SkillStatusBadge } from './SkillStatusBadge';
import { SKILL_MANAGE_SCOPE } from './SkillsRegistryView';
import { AliasDialog, RelationshipDialog, SkillFormDialog, VersionDialog } from './skill-form-dialogs';
import { ConfirmDialog, MergeDialog, OverrideDialog } from './skill-action-dialogs';

type ActiveDialog =
  | { kind: 'edit' }
  | { kind: 'merge' }
  | { kind: 'override' }
  | { kind: 'deactivate' }
  | { kind: 'reactivate' }
  | { kind: 'addAlias' }
  | { kind: 'removeAlias'; alias: SkillAlias }
  | { kind: 'addVersion' }
  | { kind: 'updateVersion'; version: SkillVersion }
  | { kind: 'addRelationship' }
  | { kind: 'removeRelationship'; rel: SkillRelationship };

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

// SKILL-TAX-1F-C1 — the canonical Skill detail page. Overview + Aliases / Versions /
// Relationships tabs, each reading via the B3 detail-read endpoints. Manage-scope
// operators get the governance controls (edit / deactivate / reactivate / merge /
// override / alias± / version± / relationship±); read-only operators see every read
// surface and no mutation control. Every action reloads server truth on completion
// (conflict-refresh) so a stale registry view corrects itself.
export function SkillDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams();
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  const [skill, setSkill] = useState<Skill | null>(null);
  const [aliases, setAliases] = useState<SkillAlias[]>([]);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [relationships, setRelationships] = useState<SkillRelationship[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, a, v, r] = await Promise.all([
        skillsApi.getSkill(id),
        skillsApi.listAliases(id, { includeInactive: true }),
        skillsApi.listVersions(id),
        skillsApi.listRelationships(id),
      ]);
      setSkill(s);
      setAliases(a.aliases);
      setVersions(v.versions);
      setRelationships(r.relationships);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load skill.');
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = (): void => setDialog(null);
  const done = (): void => {
    close();
    void refresh();
  };

  if (error) return <div className="pw-page"><InlineAlert variant="error">{error}</InlineAlert></div>;
  if (!skill) return <div className="pw-page">Loading…</div>;

  const overview = (
    <div>
      {canManage ? (
        <div className="pw-actions">
          <Button variant="secondary" onClick={() => setDialog({ kind: 'edit' })}>Edit</Button>
          {skill.status === 'active' ? (
            <Button variant="secondary" onClick={() => setDialog({ kind: 'deactivate' })}>Deactivate</Button>
          ) : (
            <Button variant="secondary" onClick={() => setDialog({ kind: 'reactivate' })}>Reactivate</Button>
          )}
          <Button variant="secondary" onClick={() => setDialog({ kind: 'merge' })}>Merge…</Button>
          <Button variant="secondary" onClick={() => setDialog({ kind: 'override' })}>Override…</Button>
        </div>
      ) : (
        <span className="pw-audit__meta">Read-only (platform:skill:manage required to act).</span>
      )}
      <dl className="pw-facts">
        <dt>Skill ID</dt>
        <dd className="mono">{skill.id}</dd>
        <dt>Canonical name</dt>
        <dd>{skill.canonical_name}</dd>
        <dt>Normalized</dt>
        <dd className="mono">{skill.normalized_name}</dd>
        <dt>Description</dt>
        <dd>{skill.description ?? '—'}</dd>
        <dt>Status</dt>
        <dd><SkillStatusBadge status={skill.status} /></dd>
        {skill.merged_into_skill_id ? (
          <>
            <dt>Merged into</dt>
            <dd className="mono">{skill.merged_into_skill_id}</dd>
          </>
        ) : null}
        <dt>Created</dt>
        <dd>{fmt(skill.created_at)}</dd>
        <dt>Updated</dt>
        <dd>{fmt(skill.updated_at)}</dd>
      </dl>
    </div>
  );

  const aliasColumns: ReadonlyArray<TableColumn<SkillAlias>> = [
    { key: 'alias', header: 'Alias', render: (a) => a.alias },
    { key: 'normalized_alias', header: 'Normalized', render: (a) => <span className="mono">{a.normalized_alias}</span> },
    { key: 'alias_type', header: 'Type', render: (a) => a.alias_type },
    { key: 'status', header: 'Status', render: (a) => <SkillStatusBadge status={a.status} /> },
    ...(canManage
      ? [{
          key: 'actions',
          header: '',
          render: (a: SkillAlias) =>
            a.status === 'active' ? (
              <Button variant="ghost" onClick={() => setDialog({ kind: 'removeAlias', alias: a })}>Remove</Button>
            ) : null,
        }]
      : []),
  ];

  const aliasesTab = (
    <div>
      {canManage ? (
        <div className="pw-actions">
          <Button variant="secondary" onClick={() => setDialog({ kind: 'addAlias' })}>Add alias</Button>
        </div>
      ) : null}
      <DataTable columns={aliasColumns} rows={aliases} rowKey={(a) => a.id} rowMuted={(a) => a.status === 'inactive'} emptyMessage="No aliases." />
    </div>
  );

  const versionColumns: ReadonlyArray<TableColumn<SkillVersion>> = [
    { key: 'version', header: 'Version', render: (v) => v.version },
    { key: 'version_family', header: 'Family', render: (v) => v.version_family ?? '—' },
    { key: 'status', header: 'Status', render: (v) => <SkillStatusBadge status={v.status} /> },
    ...(canManage
      ? [{
          key: 'actions',
          header: '',
          render: (v: SkillVersion) => (
            <Button variant="ghost" onClick={() => setDialog({ kind: 'updateVersion', version: v })}>Update</Button>
          ),
        }]
      : []),
  ];

  const versionsTab = (
    <div>
      {canManage ? (
        <div className="pw-actions">
          <Button variant="secondary" onClick={() => setDialog({ kind: 'addVersion' })}>Add version</Button>
        </div>
      ) : null}
      <DataTable columns={versionColumns} rows={versions} rowKey={(v) => v.id} emptyMessage="No versions." />
    </div>
  );

  const relColumns: ReadonlyArray<TableColumn<SkillRelationship>> = [
    { key: 'relationship_type', header: 'Type', render: (r) => r.relationship_type },
    { key: 'directionality', header: 'Direction', render: (r) => r.directionality },
    {
      key: 'target',
      header: 'Endpoints',
      render: (r) => (
        <span className="mono">
          {r.source_skill_id.slice(0, 8)} → {r.target_skill_id.slice(0, 8)}
        </span>
      ),
    },
    { key: 'source', header: 'Source', render: (r) => r.source },
    ...(canManage
      ? [{
          key: 'actions',
          header: '',
          render: (r: SkillRelationship) => (
            <Button variant="ghost" onClick={() => setDialog({ kind: 'removeRelationship', rel: r })}>Remove</Button>
          ),
        }]
      : []),
  ];

  const relationshipsTab = (
    <div>
      {canManage ? (
        <div className="pw-actions">
          <Button variant="secondary" onClick={() => setDialog({ kind: 'addRelationship' })}>Add relationship</Button>
        </div>
      ) : null}
      <DataTable columns={relColumns} rows={relationships} rowKey={(r) => r.id} emptyMessage="No relationships." />
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'overview', label: 'Overview', content: overview },
    { id: 'aliases', label: `Aliases (${aliases.length})`, content: aliasesTab },
    { id: 'versions', label: `Versions (${versions.length})`, content: versionsTab },
    { id: 'relationships', label: `Relationships (${relationships.length})`, content: relationshipsTab },
  ];

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">{skill.canonical_name}</h1>
        <SkillStatusBadge status={skill.status} />
      </div>
      <Tabs items={tabs} ariaLabel="Skill detail" />

      {dialog?.kind === 'edit' ? (
        <SkillFormDialog mode="edit" skill={skill} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'merge' ? (
        <MergeDialog loser={skill} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'override' ? (
        <OverrideDialog skill={skill} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'deactivate' ? (
        <ConfirmDialog
          title="Deactivate skill"
          confirmLabel="Deactivate"
          body={<><strong>{skill.canonical_name}</strong> becomes unavailable for normal future canonicalization. Historical references remain identifiable; a durable re-reconcile is enqueued.</>}
          onConfirm={async () => { await skillsApi.deactivateSkill(skill.id); }}
          open
          onOpenChange={(o) => !o && close()}
          onDone={done}
        />
      ) : null}
      {dialog?.kind === 'reactivate' ? (
        <ConfirmDialog
          title="Reactivate skill"
          confirmLabel="Reactivate"
          body={<>Reactivate <strong>{skill.canonical_name}</strong> for normal canonicalization. A durable re-reconcile is enqueued.</>}
          onConfirm={async () => { await skillsApi.reactivateSkill(skill.id); }}
          open
          onOpenChange={(o) => !o && close()}
          onDone={done}
        />
      ) : null}
      {dialog?.kind === 'addAlias' ? (
        <AliasDialog skillId={skill.id} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'removeAlias' ? (
        <ConfirmDialog
          title="Remove alias"
          confirmLabel="Remove alias"
          body={<>Soft-remove the alias “{dialog.alias.alias}”. It becomes inactive but stays historically traceable.</>}
          onConfirm={async () => { await skillsApi.removeAlias(skill.id, dialog.alias.id); }}
          open
          onOpenChange={(o) => !o && close()}
          onDone={done}
        />
      ) : null}
      {dialog?.kind === 'addVersion' ? (
        <VersionDialog skillId={skill.id} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'updateVersion' ? (
        <VersionDialog skillId={skill.id} version={dialog.version} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'addRelationship' ? (
        <RelationshipDialog skillId={skill.id} open onOpenChange={(o) => !o && close()} onDone={done} />
      ) : null}
      {dialog?.kind === 'removeRelationship' ? (
        <ConfirmDialog
          title="Remove relationship"
          confirmLabel="Remove relationship"
          body={<>Soft-remove this {dialog.rel.relationship_type} edge. It becomes inactive but stays historically traceable.</>}
          onConfirm={async () => { await skillsApi.removeRelationship(skill.id, dialog.rel.id); }}
          open
          onOpenChange={(o) => !o && close()}
          onDone={done}
        />
      ) : null}
    </div>
  );
}
