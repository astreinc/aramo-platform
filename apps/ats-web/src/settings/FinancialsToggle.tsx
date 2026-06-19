import { ApiError, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { Card, CardHead, FormField, InlineAlert, Switch } from '../ui';

import { setTenantSetting } from './settings-api';

interface Props {
  initialValue: boolean;
  // Test seam.
  saveFn?: typeof setTenantSetting;
}

export function FinancialsToggle({ initialValue, saveFn }: Props) {
  const save = saveFn ?? setTenantSetting;
  const toast = useToast();
  const [enabled, setEnabled] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChange = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic
    setSaving(true);
    setError(null);
    try {
      await save('audit.financials_enabled', next);
      toast.show(
        next
          ? 'Financial-auditor grant enabled'
          : 'Financial-auditor grant disabled',
      );
    } catch (err: unknown) {
      setEnabled(previous); // rollback
      setError(messageForError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title="Financial-auditor grant" />
      <p className="rc-muted-line rc-mt-8">
        {'When enabled, tenant admins may grant the "Auditor with Financials" role, ' +
          'which includes see-all compensation visibility.'}
      </p>
      {error !== null && (
        <div className="rc-mt-8">
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      )}
      <div className="rc-mt-8">
        <FormField
          inline
          label={
            <label htmlFor="audit-financials-toggle">
              Enable financial-auditor grant
            </label>
          }
        >
          <Switch
            id="audit-financials-toggle"
            checked={enabled}
            onCheckedChange={onChange}
            disabled={saving}
            aria-label="Enable financial-auditor grant"
          />
        </FormField>
      </div>
    </Card>
  );
}

function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const reason = (err.details?.['reason'] as string | undefined) ?? null;
    if (reason === 'invalid_value') {
      return 'That isn’t a valid value.';
    }
    return err.message;
  }
  return 'Unexpected error. Please try again.';
}
