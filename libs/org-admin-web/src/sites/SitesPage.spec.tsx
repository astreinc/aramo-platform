import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stubFetch } from '../tests/fetch-stub';

import { peopleBySite, SITES_COLUMNS, SitesPage } from './SitesPage';

// ORG-UX-1 §8.5 / handoff §6.5 — Sites: Site · People · Parent site (no Code, G5).

const SITES = {
  items: [
    { id: 's-hq', name: 'Headquarters', is_active: true, parent_site_id: null, created_at: '', updated_at: '' },
    { id: 's-dal', name: 'Dallas', is_active: true, parent_site_id: 's-hq', created_at: '', updated_at: '' },
  ],
};
const user = (id: string, site_id: string | null) => ({ user_id: id, email: `${id}@a.test`, display_name: id, is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id, role_keys: [] });
const USERS = { items: [user('u1', 's-hq'), user('u2', 's-hq'), user('u3', 's-dal'), user('u4', null)] };

function renderPage() {
  return render(
    <ToastProvider>
      <SitesPage />
    </ToastProvider>,
  );
}

describe('SitesPage', () => {
  it('counts people per site from users.site_id', () => {
    const m = peopleBySite(USERS.items);
    expect(m.get('s-hq')).toBe(2);
    expect(m.get('s-dal')).toBe(1);
    expect(m.size).toBe(2);
  });

  it('renders Site · People · Parent site and no Code column', async () => {
    stubFetch(({ url }) => {
      if (url.startsWith('/v1/tenant/sites')) return { body: SITES };
      if (url.startsWith('/v1/tenant/users')) return { body: USERS };
      return undefined;
    });
    renderPage();
    expect(await screen.findByText('Dallas')).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Site', 'People', 'Parent site']);
    expect(SITES_COLUMNS).toBe('minmax(220px,1.6fr) 110px minmax(160px,1fr)');
    await waitFor(() => expect(screen.getByTestId('site-people-s-hq')).toHaveTextContent('2'));
    expect(screen.getByTestId('site-people-s-dal')).toHaveTextContent('1');
    expect(within(screen.getByTestId('site-row-s-dal')).getByText('Headquarters')).toBeInTheDocument();
    expect(within(screen.getByTestId('site-row-s-hq')).getByText('—')).toBeInTheDocument();
  });

  it('shows "—" for People when the roster cannot be read (never an invented 0)', async () => {
    stubFetch(({ url }) => {
      if (url.startsWith('/v1/tenant/sites')) return { body: SITES };
      if (url.startsWith('/v1/tenant/users')) return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'no' } } };
      return undefined;
    });
    renderPage();
    await screen.findByText('Dallas');
    await waitFor(() => expect(screen.getByTestId('site-people-s-hq')).toHaveTextContent('—'));
  });

  it('Add site: disabled until a name is entered, no Code field, posts name + parent', async () => {
    const calls = stubFetch(({ url, method }) => {
      if (url.startsWith('/v1/tenant/sites') && method === 'POST')
        return { status: 201, body: { id: 's-new', name: 'Austin', is_active: true, parent_site_id: 's-hq', created_at: '', updated_at: '' } };
      if (url.startsWith('/v1/tenant/sites')) return { body: SITES };
      if (url.startsWith('/v1/tenant/users')) return { body: USERS };
      return undefined;
    });
    renderPage();
    await screen.findByText('Dallas');
    fireEvent.click(screen.getByTestId('site-add'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Code')).toBeNull();
    const submit = within(dialog).getByTestId('site-add-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('site-name'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('site-name'), { target: { value: 'Austin' } });
    fireEvent.change(within(dialog).getByTestId('site-parent'), { target: { value: 's-hq' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ name: 'Austin', parent_site_id: 's-hq' });
    expect(await screen.findByText('Site “Austin” added')).toBeInTheDocument();
  });

  it('Add site surfaces a refusal as role="alert" in the modal', async () => {
    stubFetch(({ url, method }) => {
      if (url.startsWith('/v1/tenant/sites') && method === 'POST')
        return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'dup', details: { reason: 'name_taken' } } } };
      if (url.startsWith('/v1/tenant/sites')) return { body: SITES };
      if (url.startsWith('/v1/tenant/users')) return { body: USERS };
      return undefined;
    });
    renderPage();
    await screen.findByText('Dallas');
    fireEvent.click(screen.getByTestId('site-add'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('site-name'), { target: { value: 'Dallas' } });
    fireEvent.click(within(dialog).getByTestId('site-add-submit'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A site with this name already exists in this tenant.');
  });
});
