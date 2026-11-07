import { describe, expect, it, vi } from 'vitest';

import { recipientSenderLabel } from '../app/sender-label.js';

// Aramo-Sign-Mobile-Amendment-M-A13 (LOCKED) R-3 / #6 — a PERSONAL sender is shown by their
// own display name; the stored "<name> (Personal xxxxxxxx)" handle never reaches a recipient.

function identity(tenant: { name: string; display_name: string | null; kind?: string } | null, user: { display_name?: string | null } | null) {
  return { findTenantNameById: vi.fn(async () => tenant), findUserById: vi.fn(async () => user) };
}

describe('M-A13 R-3 — recipient sender label', () => {
  it('PERSONAL: the sender’s own display name, never the stored handle', async () => {
    const id = identity({ name: 'Jane Doe (Personal 88df9551)', display_name: null, kind: 'PERSONAL' }, { display_name: 'Jane Doe' });
    expect(await recipientSenderLabel(id, 't1', 'u1')).toBe('Jane Doe');
    expect(id.findUserById).toHaveBeenCalledWith('u1');
  });

  it('PERSONAL without a display name: no label (never the handle)', async () => {
    const id = identity({ name: 'Jane Doe (Personal 88df9551)', display_name: null, kind: 'PERSONAL' }, { display_name: '  ' });
    expect(await recipientSenderLabel(id, 't1', 'u1')).toBeNull();
    expect(await recipientSenderLabel(id, 't1', null)).toBeNull();
  });

  it('BUSINESS: the organization display name, else the workspace name (unchanged)', async () => {
    expect(await recipientSenderLabel(identity({ name: 'northwind', display_name: 'Northwind Staffing', kind: 'BUSINESS' }, null), 't1', 'u1')).toBe('Northwind Staffing');
    expect(await recipientSenderLabel(identity({ name: 'northwind', display_name: null }, null), 't1', 'u1')).toBe('northwind');
  });

  it('an unknown tenant or a failed lookup: no label', async () => {
    expect(await recipientSenderLabel(identity(null, null), 't1', 'u1')).toBeNull();
    const failing = { findTenantNameById: vi.fn(async () => { throw new Error('db'); }), findUserById: vi.fn() };
    expect(await recipientSenderLabel(failing, 't1', 'u1')).toBeNull();
  });
});
