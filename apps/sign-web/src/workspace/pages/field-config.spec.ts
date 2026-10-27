import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@aramo/fe-foundation';

import { senderApi } from '../api';

import { DEFAULT_CONFIG, applyConfig, configFromWire, configToWire, groupSize, type ConfigurableField } from './field-config';
import { TYPES, V1_TYPES } from './PrepareEditor';

// M-A6 §2 — Name and Checkbox authoring in the sender editor: the tool set, the
// configuration on the PUT payload (never a value) and group consistency.

const box = (key: string, over: Partial<ConfigurableField> = {}): ConfigurableField => ({ key, signerId: 's1', type: 'CHECKBOX', required: true, ...DEFAULT_CONFIG, ...over });

afterEach(() => vi.restoreAllMocks());

describe('sender field tools (M-A6 §2.1)', () => {
  it('Name and Checkbox are authorable; Acknowledgement is not', () => {
    expect([...V1_TYPES].sort()).toEqual(['CHECKBOX', 'INITIALS', 'SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE', 'TEXT']);
    expect(V1_TYPES.has('ACKNOWLEDGEMENT')).toBe(false);
    expect(TYPES.SIGNER_NAME.label).toBe('Name');
    expect(TYPES.CHECKBOX).toMatchObject({ w: 14, h: 14 });
  });
});

describe('configToWire / configFromWire', () => {
  it('a name carries only name_mode (default SIGNER_PROFILE)', () => {
    expect(configToWire('SIGNER_NAME', DEFAULT_CONFIG)).toEqual({ name_mode: 'SIGNER_PROFILE' });
    expect(configToWire('SIGNER_NAME', { ...DEFAULT_CONFIG, nameMode: 'SIGNER_ENTERED', label: 'x' })).toEqual({ name_mode: 'SIGNER_ENTERED' });
  });

  it('a checkbox carries label and group settings; min only for SELECT_ANY groups', () => {
    expect(configToWire('CHECKBOX', DEFAULT_CONFIG)).toEqual({});
    expect(configToWire('CHECKBOX', { ...DEFAULT_CONFIG, label: ' I agree ', minSelected: 2 })).toEqual({ label: 'I agree' });
    expect(configToWire('CHECKBOX', { ...DEFAULT_CONFIG, groupKey: 'g', minSelected: 2 })).toEqual({ group_key: 'g', group_rule: 'SELECT_ANY', min_selected: 2 });
    expect(configToWire('CHECKBOX', { ...DEFAULT_CONFIG, groupKey: 'g', groupRule: 'SELECT_ONE', minSelected: 2 })).toEqual({ group_key: 'g', group_rule: 'SELECT_ONE' });
  });

  it('other types carry no configuration', () => {
    expect(configToWire('SIGNATURE', { ...DEFAULT_CONFIG, label: 'x', groupKey: 'g' })).toEqual({});
  });

  it('reads stored configuration back', () => {
    expect(configFromWire({ envelope_document_id: 'd', signer_id: 's', field_type: 'CHECKBOX', page_number: 0, x: 0, y: 0, width: 14, height: 14, required: true, label: 'A', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null })).toEqual({
      nameMode: 'SIGNER_PROFILE', label: 'A', groupKey: 'g', groupRule: 'SELECT_ONE', minSelected: null,
    });
  });
});

describe('applyConfig — check-box groups stay consistent', () => {
  it('changing a group rule, minimum or required applies to every box of that recipient group', () => {
    const fields = [box('a', { groupKey: 'g' }), box('b', { groupKey: 'g' }), box('c', { groupKey: 'g', signerId: 's2' }), box('d')];
    const next = applyConfig(fields, 'a', { groupRule: 'SELECT_ONE' });
    expect(next.map((f) => f.groupRule)).toEqual(['SELECT_ONE', 'SELECT_ONE', 'SELECT_ANY', 'SELECT_ANY']);
    const req = applyConfig(next, 'b', { required: false });
    expect(req.map((f) => f.required)).toEqual([false, false, true, true]);
  });

  it('joining an existing group adopts its settings; SELECT_ONE clears the minimum', () => {
    const fields = [box('a', { groupKey: 'g', minSelected: 2, required: false }), box('b')];
    const joined = applyConfig(fields, 'b', { groupKey: 'g' });
    expect(joined[1]).toMatchObject({ groupKey: 'g', minSelected: 2, required: false });
    const one = applyConfig(joined, 'a', { groupRule: 'SELECT_ONE' });
    expect(one.map((f) => f.minSelected)).toEqual([null, null]);
    expect(groupSize(one, one[0] as ConfigurableField)).toBe(2);
  });
});

describe('senderApi.fields — PUT payload', () => {
  it('sends the configuration and never a value', async () => {
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({} as never);
    await senderApi.fields('e1', [
      { envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNER_NAME', page_number: 0, x: 1, y: 1, width: 200, height: 22, required: true, name_mode: 'SIGNER_PROFILE' },
      { envelope_document_id: 'd1', signer_id: 's1', field_type: 'CHECKBOX', page_number: 0, x: 1, y: 40, width: 14, height: 14, required: true, label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null },
      { envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 80, width: 200, height: 40, required: true, filled: true },
    ]);
    const body = put.mock.calls[0]?.[1] as { fields: Record<string, unknown>[] };
    expect(body.fields[0]).toEqual({ envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNER_NAME', page_number: 0, x: 1, y: 1, width: 200, height: 22, required: true, name_mode: 'SIGNER_PROFILE' });
    expect(body.fields[1]).toMatchObject({ label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE' });
    expect(body.fields[1]).not.toHaveProperty('min_selected');
    for (const f of body.fields) expect(f).not.toHaveProperty('value');
    expect(body.fields[2]).not.toHaveProperty('filled');
  });

  it('sends an engine-only field back with its stored id, and an authored field without one', async () => {
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({} as never);
    await senderApi.fields('e1', [
      { id: 'f-ack', envelope_document_id: 'd1', signer_id: 's1', field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 10.123, y: 20.456, width: 300, height: 26, required: true, filled: false },
      { id: 'f-sig', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 80, width: 200, height: 40, required: true },
    ]);
    const body = put.mock.calls[0]?.[1] as { fields: Record<string, unknown>[] };
    expect(body.fields[0]).toEqual({ id: 'f-ack', envelope_document_id: 'd1', signer_id: 's1', field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 10.123, y: 20.456, width: 300, height: 26, required: true });
    expect(body.fields[1]).not.toHaveProperty('id');
  });
});
