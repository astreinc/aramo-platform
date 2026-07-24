import IntakeForm, { type IntakeField } from './IntakeForm.tsx';

// Contact form (PUB-5 PR-5b). Posts to POST /intake/contact.
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
    label: 'Email',
    type: 'email',
    required: true,
    maxLength: 254,
    autoComplete: 'email',
  },
  {
    name: 'message',
    label: 'Message',
    type: 'textarea',
    required: true,
    maxLength: 4000,
  },
];

export default function ContactForm(): React.JSX.Element {
  return (
    <IntakeForm
      action="/intake/contact"
      fields={FIELDS}
      submitLabel="Send message"
      successTitle="Message sent."
      successBody="Thanks for reaching out — we’ll get back to you soon."
    />
  );
}
