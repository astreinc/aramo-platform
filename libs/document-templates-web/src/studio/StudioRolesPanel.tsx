import { Button, Input, Select, TextArea } from '@aramo/fe-foundation';

import type { StudioRoutingMode, StudioSigning, StudioSigningRole, StudioSigningRoleKind } from './data-source';

// Amendment M-A6 (LOCKED) §3.2 / §3.8 — the Studio's "Roles and routing" panel. A template
// may name its signing roles (stored in the version's field_schema.signing, frozen and
// fingerprinted with it): SIGNER roles each get a signature block at the end of the
// document in Aramo Sign (signature, printed name, date); CC roles receive a copy. The
// routing mode and an optional default subject / message prefill the envelope. The server
// validates everything (1–10 signing roles, 0–10 copy roles, labels of printable
// characters); this panel only shapes the value. Without roles, the template keeps the one
// fixed signature block, exactly as before.

export const MAX_SIGNER_ROLES = 10;
export const MAX_CC_ROLES = 10;
const LABEL_MAX = 60;
const SUBJECT_MAX = 200;
const MESSAGE_MAX = 1000;

/** A role_key from a label, unique among `taken` (lower snake case, ≤40, starts with a letter). */
export function roleKeyFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 32) || 'role';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

/** Renumber `order` 1..N in list order. */
export function renumberRoles(roles: readonly StudioSigningRole[]): StudioSigningRole[] {
  return roles.map((r, i) => ({ ...r, order: i + 1 }));
}

/** The signing (SIGNER) roles in signing order — one signature block each. */
export function signerRolesOf(signing: StudioSigning | null | undefined): StudioSigningRole[] {
  return (signing?.roles ?? []).filter((r) => r.kind === 'SIGNER').slice().sort((a, b) => a.order - b.order);
}

export function addRole(signing: StudioSigning | null | undefined, kind: StudioSigningRoleKind): StudioSigning {
  const roles = signing?.roles ?? [];
  const n = roles.filter((r) => r.kind === kind).length + 1;
  const label = kind === 'SIGNER' ? `Signer ${n}` : `Copy ${n}`;
  const role_key = roleKeyFor(label, new Set(roles.map((r) => r.role_key)));
  return { ...(signing ?? { routing_mode: 'PARALLEL' as const }), roles: renumberRoles([...roles, { role_key, label, kind, order: roles.length + 1 }]) };
}

export interface StudioRolesPanelProps {
  /** The draft's roles: undefined / null = none. */
  readonly signing: StudioSigning | null | undefined;
  readonly editable: boolean;
  readonly onChange: (next: StudioSigning | null) => void;
}

export function StudioRolesPanel({ signing, editable, onChange }: StudioRolesPanelProps) {
  const roles = (signing?.roles ?? []).slice().sort((a, b) => a.order - b.order);
  const signers = roles.filter((r) => r.kind === 'SIGNER').length;
  const copies = roles.length - signers;
  const set = (patch: Partial<StudioSigning>): void => {
    if (signing == null) return;
    onChange({ ...signing, ...patch });
  };
  const setRoles = (next: readonly StudioSigningRole[]): void => {
    if (next.length === 0) onChange(null);
    else set({ roles: renumberRoles(next) });
  };
  const move = (i: number, by: -1 | 1): void => {
    const j = i + by;
    if (j < 0 || j >= roles.length) return;
    const next = roles.slice();
    const a = next[i] as StudioSigningRole;
    next[i] = next[j] as StudioSigningRole;
    next[j] = a;
    setRoles(next);
  };

  if (signing == null || roles.length === 0) {
    return (
      <section aria-label="Roles and routing" className="pws-roles" data-testid="studio-roles">
        <h3 className="pws-roles__h">Roles and routing</h3>
        <p className="pws-roles__note" data-testid="studio-roles-none">
          No signing roles. The document ends with one signature block (signature, printed name, date signed).
        </p>
        {editable ? (
          <Button unstyled className="pws-btn26" data-testid="studio-roles-add-first" onClick={() => onChange(addRole(null, 'SIGNER'))}>
            Add signing roles
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label="Roles and routing" className="pws-roles" data-testid="studio-roles">
      <h3 className="pws-roles__h">Roles and routing</h3>
      <p className="pws-roles__note">
        In Aramo Sign, each signing role gets its own signature block at the end of the document. Copy roles receive the document.
      </p>
      <ol className="pws-roles__list">
        {roles.map((r, i) => (
          <li key={r.role_key} className="pws-roles__row" data-testid={`studio-role-${r.role_key}`}>
            <span className="pws-roles__n" aria-hidden="true">
              {i + 1}
            </span>
            {editable ? (
              <>
                <Input
                  unstyled
                  className="pws-in pws-in--32 pws-roles__label"
                  aria-label={`Role ${i + 1} name`}
                  value={r.label}
                  maxLength={LABEL_MAX}
                  onChange={(e) => setRoles(roles.map((x) => (x.role_key === r.role_key ? { ...x, label: e.target.value } : x)))}
                />
                <Select
                  unstyled
                  className="pws-in pws-in--32 pws-roles__kind"
                  aria-label={`Role ${i + 1} kind`}
                  value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value as StudioSigningRoleKind;
                    if (kind === r.kind) return;
                    if (kind === 'SIGNER' && signers >= MAX_SIGNER_ROLES) return;
                    if (kind === 'CC' && (copies >= MAX_CC_ROLES || signers <= 1)) return;
                    setRoles(roles.map((x) => (x.role_key === r.role_key ? { ...x, kind } : x)));
                  }}
                >
                  <option value="SIGNER">Signs</option>
                  <option value="CC">Receives a copy</option>
                </Select>
                <span className="pws-roles__acts">
                  <Button unstyled className="pws-zbtn" aria-label={`Move ${r.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </Button>
                  <Button unstyled className="pws-zbtn" aria-label={`Move ${r.label} down`} disabled={i === roles.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </Button>
                  <Button
                    unstyled
                    className="pws-zbtn"
                    aria-label={`Remove ${r.label}`}
                    disabled={r.kind === 'SIGNER' && signers <= 1 && roles.length > 1}
                    onClick={() => setRoles(roles.filter((x) => x.role_key !== r.role_key))}
                  >
                    ×
                  </Button>
                </span>
              </>
            ) : (
              <span className="pws-roles__ro">
                {r.label} · {r.kind === 'SIGNER' ? 'Signs' : 'Receives a copy'}
              </span>
            )}
          </li>
        ))}
      </ol>
      {editable ? (
        <div className="pws-roles__adds">
          <Button unstyled className="pws-btn26" data-testid="studio-roles-add-signer" disabled={signers >= MAX_SIGNER_ROLES} onClick={() => onChange(addRole(signing, 'SIGNER'))}>
            Add signer
          </Button>
          <Button unstyled className="pws-btn26" data-testid="studio-roles-add-cc" disabled={copies >= MAX_CC_ROLES} onClick={() => onChange(addRole(signing, 'CC'))}>
            Add copy recipient
          </Button>
        </div>
      ) : null}
      <label className="pws-roles__field">
        <span>Signing order</span>
        <Select
          unstyled
          className="pws-in pws-in--32"
          aria-label="Signing order"
          disabled={!editable}
          value={signing.routing_mode}
          onChange={(e) => set({ routing_mode: e.target.value as StudioRoutingMode })}
        >
          <option value="PARALLEL">Sign in any order</option>
          <option value="SEQUENTIAL">Sign in the order above</option>
        </Select>
      </label>
      <label className="pws-roles__field">
        <span>Default subject</span>
        <Input
          unstyled
          className="pws-in pws-in--32"
          aria-label="Default subject"
          disabled={!editable}
          maxLength={SUBJECT_MAX}
          value={signing.default_subject ?? ''}
          onChange={(e) => {
            const { default_subject: _s, ...rest } = signing;
            void _s;
            onChange(e.target.value === '' ? rest : { ...rest, default_subject: e.target.value });
          }}
        />
      </label>
      <label className="pws-roles__field">
        <span>Default message</span>
        <TextArea
          unstyled
          className="pws-in pws-roles__msg"
          aria-label="Default message"
          disabled={!editable}
          maxLength={MESSAGE_MAX}
          rows={3}
          value={signing.default_message ?? ''}
          onChange={(e) => {
            const { default_message: _m, ...rest } = signing;
            void _m;
            onChange(e.target.value === '' ? rest : { ...rest, default_message: e.target.value });
          }}
        />
      </label>
      {editable ? (
        <Button unstyled className="pws-btn26 pws-roles__clear" data-testid="studio-roles-remove" onClick={() => onChange(null)}>
          Remove roles
        </Button>
      ) : null}
    </section>
  );
}

/** M-A6 §3.8 — the per-role signature blocks as the document ends with them in Aramo Sign. */
export function SignatureBlocksPreview({ roles }: { readonly roles: readonly Pick<StudioSigningRole, 'role_key' | 'label'>[] }) {
  if (roles.length === 0) return null;
  return (
    <div className="pws-sigblocks" data-testid="studio-signature-blocks" aria-label="Signature blocks">
      {roles.map((r) => (
        <div key={r.role_key} className="pws-sigblock" data-testid={`studio-sigblock-${r.role_key}`}>
          <div className="pws-sigblock__role">{r.label}</div>
          <div className="pws-sigblock__cols">
            {['Signature', 'Printed name', 'Date signed'].map((c) => (
              <div key={c} className="pws-sigblock__col">
                <div className="pws-sigblock__rule" />
                <div className="pws-sigblock__l">{c}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
