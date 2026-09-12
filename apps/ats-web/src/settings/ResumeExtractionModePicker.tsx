import { ApiError, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { Button, Card, CardHead, InlineAlert, RadioGroup, safeErrorMessage } from '../ui';

import { setTenantSetting } from './settings-api';
import type { ResumeExtractionMode } from './types';

// Tenant-level résumé extraction mode for Add Talent. Default is the
// deterministic (no-LLM) parser; a tenant opts into governed-LLM extraction
// here. This tenant opt-in is the SOLE gate for the LLM path — no per-talent
// consent is required for résumé extraction.
const OPTIONS = [
  { value: 'deterministic' as const, label: 'Deterministic parser (default)' },
  { value: 'governed_llm' as const, label: 'Governed AI extraction' },
];

interface Props {
  initialValue: ResumeExtractionMode;
  // Test seam — lets the test stub the backend call directly.
  saveFn?: typeof setTenantSetting;
}

export function ResumeExtractionModePicker({ initialValue, saveFn }: Props) {
  const save = saveFn ?? setTenantSetting;
  const toast = useToast();
  const [value, setValue] = useState<ResumeExtractionMode>(initialValue);
  const [savedValue, setSavedValue] = useState<ResumeExtractionMode>(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = value !== savedValue;

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await save('resume.extraction_mode', value);
      setSavedValue(result.value);
      toast.show('Résumé extraction mode saved');
    } catch (err: unknown) {
      setError(messageForError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title="Résumé extraction" />
      <p className="rc-muted-line rc-mt-8">
        How Add Talent reads an uploaded résumé. The deterministic parser extracts
        stated facts without AI. Governed AI extraction uses Aramo’s governed model
        surface to structure the résumé’s stated skills and work history into
        evidence — stated facts only, no scoring. Applies tenant-wide.
      </p>
      {error !== null && (
        <div className="rc-mt-8">
          <InlineAlert variant="error">{error}</InlineAlert>
        </div>
      )}
      <div className="rc-mt-8">
        <RadioGroup
          name="resume.extraction_mode"
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
          <span className="rc-muted-line" data-testid="resume-mode-saved-marker">
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
      return 'That isn’t a valid value. Allowed: deterministic, governed_llm.';
    }
    if (reason === 'missing_value' || reason === 'unknown_key') {
      return `Request rejected: ${reason}.`;
    }
    return safeErrorMessage(err, 'Something went wrong. Please try again.');
  }
  return 'Unexpected error. Please try again.';
}
