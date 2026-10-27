// The form behind "Use" (Templates screen and the Add documents sheet): a template the
// backend lists WITH signing roles is bound role by role (RoleBindingForm, M-A6 §3.5);
// a template without roles keeps the sender-variable form and the single-signer path.
import type { RoleBindingRequest, SenderTemplate } from '../send/templates';
import { RoleBindingForm } from './RoleBindingForm';
import { usesRoleBinding } from './roleBindingModel';
import { TemplateValuesForm } from './TemplateValuesForm';

export function TemplateUseForm({
  template,
  onCreate,
  onCancel,
  onRolesChanged,
  cancelTitle,
}: {
  readonly template: SenderTemplate;
  /** `binding` is set only for a template with roles. */
  readonly onCreate: (
    values: Record<string, string>,
    idempotencyKey: string,
    binding?: RoleBindingRequest,
  ) => Promise<void>;
  readonly onCancel: () => void;
  readonly onRolesChanged: () => void;
  readonly cancelTitle?: string;
}) {
  if (usesRoleBinding(template) && template.signing) {
    return (
      <RoleBindingForm
        template={template}
        signing={template.signing}
        onCreate={onCreate}
        onCancel={onCancel}
        onRolesChanged={onRolesChanged}
        {...(cancelTitle ? { cancelTitle } : {})}
      />
    );
  }
  return (
    <TemplateValuesForm
      template={template}
      onCreate={(values, key) => onCreate(values, key)}
      onCancel={onCancel}
      {...(cancelTitle ? { cancelTitle } : {})}
    />
  );
}
