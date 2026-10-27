// The sender-variable form for a template (handoff §4.6 "Or start from a template"):
// one field per SENDER variable the backend lists, then **Use template**. The render is
// idempotent on one key per pick, reused when the sender retries. Moved here unchanged
// from the step-1 template sheet so the Add documents sheet and the Templates screen
// share it.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { isApiError } from '../../api/errors';
import { newIdempotencyKey } from '../../api/workspaceClient';
import { Button } from '../../components/Button';
import { ErrorText, TextField } from '../send/ui';
import type { SenderTemplate } from '../send/templates';
import { libraryRefusal } from './templatesModel';

export const TEMPLATE_USE_FAILED = 'The template couldn’t be used. Try again.';

/** The message for a failed "Use template": the server's reason when it gave one. */
export function templateUseError(e: unknown): string {
  if (isApiError(e) && (e.status === 403 || e.status === 404)) return libraryRefusal(e);
  return TEMPLATE_USE_FAILED;
}

export function TemplateValuesForm({
  template,
  onCreate,
  onCancel,
  cancelTitle = 'Cancel',
}: {
  readonly template: SenderTemplate;
  readonly onCreate: (values: Record<string, string>, idempotencyKey: string) => Promise<void>;
  readonly onCancel: () => void;
  readonly cancelTitle?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  // One key per pick, reused when the sender retries (the render is idempotent on it).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const create = useMutation({ mutationFn: () => onCreate(values, idempotencyKey) });
  return (
    <>
      {template.senderVariables.map((v) => (
        <TextField
          key={v.key}
          label={v.label}
          value={values[v.key] ?? ''}
          onChangeText={(x) => setValues((s) => ({ ...s, [v.key]: x }))}
        />
      ))}
      <ErrorText>{create.isError ? templateUseError(create.error) : null}</ErrorText>
      <Button title="Use template" busy={create.isPending} onPress={() => create.mutate()} />
      <Button title={cancelTitle} variant="text" onPress={onCancel} />
    </>
  );
}
