import { describe, expect, it } from 'vitest';

import { rtrTemplateErrorMessage } from './rtr-binding-messages';

const err = (code: string, details?: Record<string, unknown>) => Object.assign(new Error('x'), { code, details });

describe('rtrTemplateErrorMessage — names the actual missing fact', () => {
  it('maps each binding key to where it is fixed', () => {
    expect(rtrTemplateErrorMessage(err('RTR_TEMPLATE_BINDING_MISSING', { binding_key: 'recruiting_company.name' }))).toMatch(/legal name isn’t set.*Tenant profile/);
    expect(rtrTemplateErrorMessage(err('RTR_TEMPLATE_BINDING_MISSING', { binding_key: 'talent.desired_pay_rate' }))).toMatch(/desired pay rate/);
    expect(rtrTemplateErrorMessage(err('RTR_TEMPLATE_BINDING_MISSING', { binding_key: 'requisition.description' }))).toMatch(/job description/);
  });
  it('unknown key / resolver gaps fall back to a neutral admin message; template not approved stays distinct', () => {
    expect(rtrTemplateErrorMessage(err('RTR_TEMPLATE_BINDING_MISSING', { binding_key: 'x.y' }))).toMatch(/template’s fields/);
    expect(rtrTemplateErrorMessage(err('RTR_TEMPLATE_BINDING_MISSING', { reason: 'binding_resolver_missing', binding_key: 'client.name' }))).toMatch(/template’s fields/);
    expect(rtrTemplateErrorMessage(err('RTR_TEMPLATE_NOT_CONFIGURED'))).toMatch(/approved a Right to Represent template/);
    expect(rtrTemplateErrorMessage(err('SOMETHING_ELSE'))).toBeNull();
  });
});
