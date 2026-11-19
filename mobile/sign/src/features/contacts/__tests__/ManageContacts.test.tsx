// UAT SND-24 — Manage contacts lists saved contacts only, and says why the recipient list
// shows more people (recent recipients come from envelopes and have no contact to edit).
import { render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MANAGE_CONTACTS_NOTE, ManageContacts } from '../ContactsSheet';

jest.setTimeout(30_000);

function wrap(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('ManageContacts', () => {
  it('shows each saved contact with Edit and the note about recent recipients', () => {
    render(
      wrap(
        <ManageContacts
          contacts={[{ id: 'c1', name: 'Raju', email: 'raju@x.test', organization: null, source: 'saved' }]}
          online
          onEdit={jest.fn()}
          onDelete={jest.fn(async () => undefined)}
          onBack={jest.fn()}
        />,
      ),
    );
    expect(screen.getByText('Raju')).toBeTruthy();
    expect(screen.getByLabelText('Edit Raju')).toBeTruthy();
    expect(screen.getByTestId('manage-contacts-note')).toHaveTextContent(MANAGE_CONTACTS_NOTE);
  });
});
