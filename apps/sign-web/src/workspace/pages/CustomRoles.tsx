import { useCallback, useEffect, useMemo, useState } from 'react';

import { errorMessage } from '../api';
import {
  BUILT_IN_ROLE_LABELS,
  PERMISSION_LABELS,
  customRolesApi,
  customRolesVisible,
  permissionLabel,
  type CustomRole,
  type CustomRoleList,
  type CustomRoleMember,
} from '../custom-roles-api';
import { Area, Btn, Check, Empty, ErrorBox, Field, Loading, TextIn } from '../ui';
import { useWorkspace } from '../workspace';

// Aramo Sign Feature-Parity §1.21 — Administration → Roles. Holders of sign:member:manage
// create organization-defined Sign roles from the existing Sign permissions, edit and delete
// them, and give them to members. Built-in roles (Sign Admin / Sender / Viewer, Tenant Owner /
// Admin) are shown read-only. A permission the administrator does not hold is shown but cannot
// be granted; the backend enforces every rule (availability, plan, anti-escalation, tenant).

interface Draft {
  id: string | null;
  name: string;
  description: string;
  scope_keys: string[];
}

const EMPTY: Draft = { id: null, name: '', description: '', scope_keys: [] };

export function CustomRolesPage() {
  const { ctx } = useWorkspace();
  if (!customRolesVisible(ctx)) {
    return (
      <div className="sg-page">
        <Empty title="Custom roles aren’t available">Custom roles are part of the Professional and Enterprise plans.</Empty>
      </div>
    );
  }
  return <CustomRolesAdmin />;
}

function CustomRolesAdmin() {
  const { toast } = useWorkspace();
  const [data, setData] = useState<CustomRoleList | null>(null);
  const [members, setMembers] = useState<CustomRoleMember[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, m] = await Promise.all([customRolesApi.list(), customRolesApi.members()]);
      setData(list);
      setMembers(m.members);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const grantable = useMemo(() => new Set((data?.permissions ?? []).filter((p) => p.grantable).map((p) => p.key)), [data]);
  const canHandle = (role: CustomRole) => role.scope_keys.every((k) => grantable.has(k));

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      toast(done);
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (data === null || members === null) return error !== '' ? <ErrorBox>{error}</ErrorBox> : <Loading />;

  const save = async () => {
    if (draft === null) return;
    const input = { name: draft.name.trim(), description: draft.description.trim() === '' ? null : draft.description.trim(), scope_keys: draft.scope_keys };
    const ok = await run(() => (draft.id === null ? customRolesApi.create(input) : customRolesApi.update(draft.id, input)), draft.id === null ? 'Role created' : 'Role updated');
    if (ok) setDraft(null);
  };

  return (
    <div className="sg-page" data-testid="custom-roles">
      <div className="sg-page__head">
        <div>
          <h1 className="sg-h1">Roles</h1>
          <p className="sg-lede">Create roles from Aramo Sign permissions and give them to members. You can only grant permissions you have yourself.</p>
        </div>
        {draft === null ? (
          <Btn variant="primary" onClick={() => setDraft({ ...EMPTY })} data-testid="custom-role-new">
            New role
          </Btn>
        ) : null}
      </div>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {draft !== null ? <RoleEditor draft={draft} setDraft={setDraft} permissions={data.permissions} busy={busy} onSave={save} onCancel={() => setDraft(null)} /> : null}

      <section className="sg-card" data-testid="custom-role-list">
        <div className="sg-card__head">Custom roles</div>
        <div className="sg-card__body">
          {data.roles.length === 0 ? (
            <p className="sg-help">No custom roles yet.</p>
          ) : (
            <ul className="sg-list">
              {data.roles.map((r) => (
                <li key={r.id} className="sg-list__row" data-testid={`custom-role-${r.id}`}>
                  <div style={{ flex: 1 }}>
                    <strong>{r.name}</strong>
                    {r.description !== null ? <div className="sg-help">{r.description}</div> : null}
                    <div className="sg-help">
                      {r.scope_keys.map(permissionLabel).join(' · ')} — {r.member_count === 1 ? '1 member' : `${r.member_count} members`}
                    </div>
                  </div>
                  <Btn size="sm" disabled={busy || !canHandle(r)} onClick={() => setDraft({ id: r.id, name: r.name, description: r.description ?? '', scope_keys: [...r.scope_keys] })}>
                    Edit
                  </Btn>
                  <Btn
                    size="sm"
                    variant="danger"
                    disabled={busy || !canHandle(r) || r.member_count > 0}
                    title={r.member_count > 0 ? 'Remove this role from every member before deleting it' : undefined}
                    onClick={() => void run(() => customRolesApi.remove(r.id), 'Role deleted')}
                    data-testid={`custom-role-delete-${r.id}`}
                  >
                    Delete
                  </Btn>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="sg-card" data-testid="custom-role-members">
        <div className="sg-card__head">Members</div>
        <div className="sg-card__body">
          {members.length === 0 ? (
            <p className="sg-help">No active members.</p>
          ) : (
            <table className="sg-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Built-in roles</th>
                  {data.roles.map((r) => (
                    <th key={r.id}>{r.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.display_name ?? m.email ?? m.user_id}</td>
                    <td>{m.role_keys.map((k) => BUILT_IN_ROLE_LABELS[k] ?? k).join(', ') || '—'}</td>
                    {data.roles.map((r) => {
                      const has = m.custom_role_ids.includes(r.id);
                      return (
                        <td key={r.id}>
                          <Check
                            aria-label={`${r.name} for ${m.display_name ?? m.email ?? m.user_id}`}
                            checked={has}
                            disabled={busy || !canHandle(r)}
                            onChange={() =>
                              void run(
                                () => (has ? customRolesApi.unassign(r.id, m.user_id) : customRolesApi.assign(r.id, m.user_id)),
                                has ? `Removed ${r.name}` : `Gave ${r.name}`,
                              )
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function RoleEditor({
  draft,
  setDraft,
  permissions,
  busy,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  permissions: CustomRoleList['permissions'];
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const toggle = (key: string) =>
    setDraft({ ...draft, scope_keys: draft.scope_keys.includes(key) ? draft.scope_keys.filter((k) => k !== key) : [...draft.scope_keys, key] });
  const valid = draft.name.trim().length > 0 && draft.name.trim().length <= 60 && draft.scope_keys.length > 0;
  return (
    <section className="sg-card" data-testid="custom-role-editor">
      <div className="sg-card__head">{draft.id === null ? 'New role' : 'Edit role'}</div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <Field label="Name" htmlFor="cr-name">
          <TextIn id="cr-name" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Description (optional)" htmlFor="cr-desc">
          <Area id="cr-desc" maxLength={500} rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <fieldset className="sg-grid" style={{ gap: 6, border: 0, padding: 0 }}>
          <legend className="sg-label">Permissions</legend>
          {permissions.map((p) => (
            <label key={p.key} className="sg-check" title={p.grantable ? undefined : 'You don’t have this permission, so you can’t grant it'}>
              <Check
                checked={draft.scope_keys.includes(p.key)}
                disabled={!p.grantable && !draft.scope_keys.includes(p.key)}
                onChange={() => toggle(p.key)}
                data-testid={`cr-perm-${p.key}`}
              />
              <span>
                {permissionLabel(p.key)}
                <span className="sg-help"> — {PERMISSION_LABELS[p.key]?.help ?? ''}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="primary" disabled={busy || !valid} onClick={onSave} data-testid="custom-role-save">
            {draft.id === null ? 'Create role' : 'Save changes'}
          </Btn>
          <Btn disabled={busy} onClick={onCancel}>
            Cancel
          </Btn>
        </div>
      </div>
    </section>
  );
}
