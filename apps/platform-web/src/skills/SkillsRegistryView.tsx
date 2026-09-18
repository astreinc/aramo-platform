import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  Button,
  DataTable,
  InlineAlert,
  hasScope,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import { skillsApi, type Skill } from './skills-api';
import { SkillStatusBadge } from './SkillStatusBadge';
import { SkillFormDialog } from './skill-form-dialogs';

export const SKILL_READ_SCOPE = 'platform:skill:read';
export const SKILL_MANAGE_SCOPE = 'platform:skill:manage';

const COLUMNS: ReadonlyArray<TableColumn<Skill>> = [
  {
    key: 'canonical_name',
    header: 'Canonical name',
    render: (s) => (
      <Link className="rc-link-strong" to={`/skills/${s.id}`}>
        <span className="rc-ent__nm">{s.canonical_name}</span>
      </Link>
    ),
  },
  { key: 'normalized_name', header: 'Normalized', render: (s) => <span className="mono">{s.normalized_name}</span> },
  { key: 'status', header: 'Status', render: (s) => <SkillStatusBadge status={s.status} /> },
];

// SKILL-TAX-1F-C1 — the canonical Skill registry list. GET /platform/skills is an
// unpaginated list (no cursor), so filtering (include-inactive + name search) is
// client-side. Create is manage-gated; the rest of the registry lives on the detail
// page. Read-only operators see the list but no Create control.
export function SkillsRegistryView({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (inactive: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await skillsApi.listSkills({ includeInactive: inactive });
      setSkills(res.skills);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load skills.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(includeInactive);
  }, [includeInactive, load]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length === 0) return skills;
    return skills.filter(
      (s) => s.canonical_name.toLowerCase().includes(needle) || s.normalized_name.includes(needle),
    );
  }, [skills, q]);

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Skills</h1>
        {canManage ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create skill
          </Button>
        ) : null}
      </div>

      <div className="pw-toolbar">
        <input
          aria-label="Search canonical or normalized name"
          className="tc-input"
          placeholder="Search name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          <span>Include inactive</span>
        </label>
      </div>

      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(s) => s.id}
        rowMuted={(s) => s.status === 'inactive'}
        onRowClick={(s) => navigate(`/skills/${s.id}`)}
        emptyMessage={loading ? 'Loading…' : 'No skills match.'}
      />

      {creating ? (
        <SkillFormDialog
          mode="create"
          open={creating}
          onOpenChange={setCreating}
          onDone={(created) => {
            setCreating(false);
            if (created) navigate(`/skills/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
