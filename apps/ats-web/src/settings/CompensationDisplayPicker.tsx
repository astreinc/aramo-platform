import { ApiError, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { Button, Card, CardHead, InlineAlert, RadioGroup } from '../ui';

import { setTenantSetting } from './settings-api';
import type { CompensationDisplayDefault } from './types';

const OPTIONS = [
  { value: 'spread' as const, label: 'Rate spread (min / max)' },
  { value: 'markup' as const, label: 'Bill markup' },
  { value: 'both' as const, label: 'Both side-by-side' },
];

interface Props {
  initialValue: CompensationDisplayDefault;
  // Test seam — lets the test stub the backend call directly.
  saveFn?: typeof setTenantSetting;
}

export function CompensationDisplayPicker({ initialValue, saveFn }: Props) {
  const save = saveFn ?? setTenantSetting;
  const toast = useToast();
  const [value, setValue] = useState<CompensationDisplayDefault>(initialValue);
  const [savedValue, setSavedValue] =
    useState<CompensationDisplayDefault>(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = value !== savedValue;

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await save('compensation.display_default', value);
      setSavedValue(result.value);
      toast.show('Compensation display saved');
    } catch (err: unknown) {
      setError(messageForError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title="Compensation display" />
      <p className="rc-muted-line rc-mt-8">
        Default view for granted compensation fields. Display-only — does not
        change who can see what.
      </p>
      {error !== null && (
        <div className="rc-mt-8">
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      )}
      <div className="rc-mt-8">
        <RadioGroup
          name="compensation.display_default"
          value={value}
          options={OPTIONS}
          onValueChange={(next) => setValue(next)}
          disabled={saving}
        />
      </div>
      <div className="rc-formfoot">
        <Button onClick={onSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {!dirty && (
          <span className="rc-muted-line" data-testid="comp-saved-marker">
            Saved
          </span>
        )}
      </div>
    </Card>
  );
}

function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const reason = (err.details?.['reason'] as string | undefined) ?? null;
    if (reason === 'invalid_value') {
      return 'That isn’t a valid value. Allowed: spread, markup, both.';
    }
    if (reason === 'missing_value' || reason === 'unknown_key') {
      return `Request rejected: ${reason}.`;
    }
    return err.message;
  }
  return 'Unexpected error. Please try again.';
}
