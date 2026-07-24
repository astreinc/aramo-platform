import IntakeForm, { type IntakeField } from './IntakeForm.tsx';

// Request-a-workspace form (PUB-5 PR-5b). Posts to POST /intake/workspace-request.
const FIELDS: IntakeField[] = [
  {
    name: 'name',
    label: 'Your name',
    type: 'text',
    required: true,
    maxLength: 200,
    autoComplete: 'name',
  },
  {
    name: 'email',
    label: 'Work email',
    type: 'email',
    required: true,
    maxLength: 254,
    autoComplete: 'email',
  },
  {
    name: 'firm',
    label: 'Firm',
    type: 'text',
    required: true,
    maxLength: 200,
    autoComplete: 'organization',
  },
  {
    name: 'message',
    label: 'How your desk works today',
    type: 'textarea',
    required: false,
    maxLength: 4000,
  },
];

export default function WorkspaceRequestForm(): React.JSX.Element {
  return (
    <IntakeForm
      action="/intake/workspace-request"
      fields={FIELDS}
      submitLabel="Request a workspace"
      successTitle="Request received."
      successBody="Thanks — we’ll be in touch shortly to set up your workspace."
    />
  );
}
