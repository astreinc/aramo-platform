import { Button, Dialog, FormField, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useMemo, useState, type FormEvent } from 'react';

import { messageForSiteError } from './error-messages';
import { createSite, updateSite } from './sites-api';
import type { SiteView } from './types';
import { descendantIds } from './tree';

// Settings Rebuild Directive 4 — create / edit a branch (site).
//
// Create POSTs; edit PATCHes only the changed fields. The parent picker is a
// native select over the tenant's ACTIVE branches, excluding the branch being
// edited and its descendants (a client-side cycle guard mirroring the server's
// authoritative refusal).

interface Props {
  readonly mode: 'create' | 'edit';
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sites: readonly SiteView[];
  readonly site?: SiteView;
  readonly onSaved: (site: SiteView) => void;
  // Test seams.
  readonly createFn?: typeof createSite;
  readonly updateFn?: typeof updateSite;
}

export function SiteDialog({
  mode,
  open,
  onOpenChange,
  sites,
  site,
  onSaved,
  createFn = createSite,
  updateFn = updateSite,
}: Props) {
  const toast = useToast();
  const [name, setName] = useState(site?.name ?? '');
  const [parentId, setParentId] = useState<string>(site?.parent_site_id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Eligible parents: active branches, excluding self + the self subtree.
  const parentOptions = useMemo(() => {
    const excluded =
      mode === 'edit' && site !== undefined
        ? new Set<string>([site.id, ...descendantIds(site.id, sites)])
        : new Set<string>();
    return sites
      .filter((s) => s.is_active && !excluded.has(s.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sites, site, mode]);

  const reset = () => {
    setName(site?.name ?? '');
    setParentId(site?.parent_site_id ?? '');
    setError('');
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (saving || name.trim().length === 0) return;
    setSaving(true);
    setError('');
    try {
      const parent_site_id = parentId === '' ? null : parentId;
      let result: SiteView;
      if (mode === 'create') {
        result = await createFn({ name: name.trim(), parent_site_id });
        toast.show('Branch created');
      } else if (site !== undefined) {
        const patch: { name?: string; parent_site_id?: string | null } = {};
        if (name.trim() !== site.name) patch.name = name.trim();
        if (parent_site_id !== site.parent_site_id) {
          patch.parent_site_id = parent_site_id;
        }
        result = await updateFn(site.id, patch);
        toast.show('Branch saved');
      } else {
        return;
      }
      onSaved(result);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForSiteError(err));
    } finally {
      setSaving(false);
    }
  };

  const submittable = !saving && name.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={mode === 'create' ? 'Add branch' : 'Edit branch'}
      description="A branch (site) is a sub-tenant partition — headquarters, a regional office, a distributed pod. Branches can nest into a hierarchy."
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={(ev) => onSubmit(ev)}
            disabled={!submittable}
            data-testid="site-dialog-submit"
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Add branch' : 'Save'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} aria-label="Branch form" data-testid="site-dialog-form">
        {error !== '' && <InlineAlert variant="error">{error}</InlineAlert>}
        <FormField label="Branch name">
          <input
            className="rc-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="London HQ"
            data-testid="site-name-input"
            autoFocus
          />
        </FormField>
        <FormField label="Parent branch (optional)">
          <select
            className="rc-input"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            data-testid="site-parent-select"
          >
            <option value="">— None (top-level branch) —</option>
            {parentOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FormField>
      </form>
    </Dialog>
  );
}
