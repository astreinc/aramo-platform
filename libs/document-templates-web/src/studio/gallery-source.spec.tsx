import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { TemplateDefaultPreview, TemplateLibraryItem, TemplateLibraryView } from '../document-templates-api';

import { GALLERY_STUDIO_READ_ONLY, galleryContentFromSample, galleryStudioDataSource } from './gallery-source';
import { TemplateStudio } from './TemplateStudio';

// TEMPLATE-STUDIO-1 S-2 (directive §2, §4.3; ADR-0034 D3) — the Org gallery's read-only
// Studio source: the current version only, the tenant-branded server render in Preview,
// no writes, no Versions / Compare, and the host's header action.

const RTR = 'd0c50005-0000-7000-8000-000000000001';

function item(over: Partial<TemplateLibraryItem>): TemplateLibraryItem {
  return {
    id: 'def-rtr', owner_scope: 'PLATFORM', document_type_id: RTR, name: 'Right to Represent', description: 'Aramo default RTR.',
    template_kind: 'GENERATED', status: 'ACTIVE', client_id: null, current_version_id: 'pv3', current_version_number: 3,
    updated_at: '2026-10-15T10:00:00.000Z', products: ['ATS'], withdraw_effective_at: null, configurable: true, ...over,
  };
}

const LIBRARY: TemplateLibraryView = {
  items: [item({}), item({ id: 'own-rtr', owner_scope: 'TENANT', name: 'Our RTR' })],
  document_types: [{ id: RTR, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true }],
};

const PREVIEW: TemplateDefaultPreview = {
  title: 'Right to Represent',
  html: '<h2>Authorization</h2><p>Represented by <span data-sample="organization.name">Acme Staffing</span> for <span data-sample="talent.full_name">Amina Diallo</span>.</p>',
  sample_values: [
    { key: 'organization.name', label: 'Organization name', value: 'Acme Staffing' },
    { key: 'talent.full_name', label: 'Full name', value: 'Amina Diallo' },
  ],
  template_id: 'def-rtr',
  version_id: 'pv3',
  version_number: 3,
  updated_at: '2026-10-15T10:00:00.000Z',
  letterhead: { organization_name: 'Acme Staffing', logo_available: false },
};

function source(previewFn = vi.fn().mockResolvedValue(PREVIEW), library: TemplateLibraryView = LIBRARY) {
  return { previewFn, ds: galleryStudioDataSource({ library: Promise.resolve(library), previewFn, galleryTo: '/org/document-templates/gallery', listHref: '/org/document-templates' }) };
}

describe('galleryStudioDataSource (read-only Aramo default)', () => {
  it('converts the sample render back to stored variables', () => {
    expect(galleryContentFromSample(PREVIEW.html ?? '')).toBe(
      '<h2>Authorization</h2><p>Represented by <span data-field="organization.name"></span> for <span data-field="talent.full_name"></span>.</p>',
    );
  });

  it('load: the library item plus its CURRENT version only (D3)', async () => {
    const { ds } = source();
    const t = await ds.load('def-rtr');
    expect(t).toMatchObject({ id: 'def-rtr', name: 'Right to Represent', description: 'Aramo default RTR.', products: [], withdraw_effective_at: null });
    expect(t.current_version).toEqual({ id: 'pv3', version_number: 3 });
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0]).toMatchObject({ id: 'pv3', version_number: 3, status: 'ACTIVE', render_schema_version: 'rtr-html-v1' });
  });

  it('load refuses an id that is not a published Aramo default (a tenant template, or unknown)', async () => {
    await expect(source().ds.load('own-rtr')).rejects.toThrow('This Aramo default isn’t available.');
  });

  it('catalog: the preview’s variables, grouped by key prefix, plus the document types', async () => {
    const cat = await source().ds.catalog('def-rtr');
    expect(cat.variables.map((v) => [v.key, v.group_label, v.sample_value])).toEqual([
      ['organization.name', 'Organization', 'Acme Staffing'],
      ['talent.full_name', 'Talent', 'Amina Diallo'],
    ]);
    expect(cat.bindings.map((b) => b.key)).toEqual(['organization.name', 'talent.full_name']);
    expect(cat.documentTypes).toEqual([{ id: RTR, name: 'Right to Represent' }]);
  });

  it('one preview read is shared by load, catalog and previewCurrent', async () => {
    const { ds, previewFn } = source();
    await Promise.all([ds.load('def-rtr'), ds.catalog('def-rtr'), ds.previewCurrent?.('def-rtr')]);
    expect(previewFn).toHaveBeenCalledTimes(1);
    expect(previewFn).toHaveBeenCalledWith('def-rtr');
  });

  it('read only: no edit / approve / withdraw / tags; Versions, mode toggle and checks hidden; every write refuses', async () => {
    const { ds } = source();
    expect(ds.capabilities).toEqual({ canEdit: false, canApprove: false, canWithdraw: false, productTags: false, description: true, versions: false, modeToggle: false, checks: false });
    expect(ds.discardDraft).toBeUndefined();
    expect(ds.updateProperties).toBeUndefined();
    expect(ds.withdraw).toBeUndefined();
    const body = { render_schema_version: 'rtr-html-v1', field_schema: { render_schema_version: 'rtr-html-v1', title: 'x', html: '' } };
    await expect(ds.createDraft('def-rtr', body)).rejects.toThrow(GALLERY_STUDIO_READ_ONLY);
    await expect(ds.saveDraft('pv3', body)).rejects.toThrow(GALLERY_STUDIO_READ_ONLY);
    await expect(ds.preview('pv3')).rejects.toThrow(GALLERY_STUDIO_READ_ONLY);
    await expect(ds.approve('pv3')).rejects.toThrow(GALLERY_STUDIO_READ_ONLY);
  });
});

describe('TemplateStudio with the gallery source', () => {
  function renderStudio(previewFn = vi.fn().mockResolvedValue(PREVIEW)) {
    // A wide viewport: both panels open, the full breadcrumb.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    const { ds } = source(previewFn);
    render(
      <MemoryRouter>
        <TemplateStudio context="organization" dataSource={ds} templateId="def-rtr" actions={<button type="button">Adopt</button>} />
      </MemoryRouter>,
    );
  }

  it('opens in Preview with the branded server render; no edit, save, approve, Versions or Compare', async () => {
    renderStudio();
    const pages = await screen.findByRole('region', { name: 'Preview pages' });
    await waitFor(() => expect(pages).toHaveTextContent('Represented by Acme Staffing for Amina Diallo.'));
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve|Publish/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Compare/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Versions' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Outline' })).toBeInTheDocument();
    // The host's action sits in the top bar.
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Adopt' })).toBeInTheDocument();
    // The read-only bar and the gallery crumb.
    expect(screen.getByText(/Aramo default\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Template gallery' })).toHaveAttribute('href', '/org/document-templates/gallery');
  });

  it('acceptance §11 item 3: no Edit | Preview toggle, readiness pill or Checks tab (never editable)', async () => {
    renderStudio();
    await screen.findByRole('region', { name: 'Preview pages' });
    expect(screen.queryByRole('group', { name: 'Mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(screen.queryByTitle('Publishing checks')).toBeNull();
    expect(screen.queryByText(/before approval|ready to approve/i)).toBeNull();
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).queryByRole('tab', { name: /Checks/ })).toBeNull();
    expect(within(inspector).getByRole('tab', { name: 'Variables' })).toBeInTheDocument();
    expect(within(inspector).getByRole('tab', { name: 'Properties' })).toBeInTheDocument();
  });

  it('a variable card without Insert takes the wrapping read-only layout (label and key never overlap)', async () => {
    renderStudio();
    await screen.findByRole('region', { name: 'Preview pages' });
    const key = await screen.findByText('talent.full_name', { selector: '.pws-vcard__key' });
    const card = key.closest('.pws-vcard');
    expect(card).toHaveClass('pws-vcard--ro');
    expect(within(card as HTMLElement).queryByRole('button', { name: /Insert/ })).toBeNull();
  });

  it('a preview refusal shows in the Preview', async () => {
    renderStudio(vi.fn().mockRejectedValue(new Error('Preview unavailable')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable');
  });
});
