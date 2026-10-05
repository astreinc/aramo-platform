import { describe, it, expect } from 'vitest';

import {
  CATEGORY_TEMPLATE_TOKENS,
  EMAIL_TEMPLATE_TOKENS,
  GENERAL_TALENT_CONTACT_TOKENS,
  TemplateValidationError,
  renderTemplate,
  validateTemplateTokens,
  validateTemplateTokensForCategory,
} from '../lib/email-template-renderer.js';

// D-EMAIL-TPL-1 (ET-3) — closed merge-field renderer. At the pin (130bfb65) this
// module did not exist, so every assertion below was unrunnable (the honest RED).

describe('validateTemplateTokens (ET-3) — save-time closed-allowlist gate', () => {
  it('REJECTS an unknown merge token (a bad template can never persist)', () => {
    expect(() => validateTemplateTokens('Hi {{talent.first_name}} {{talent.ssn}}')).toThrow(
      TemplateValidationError,
    );
    try {
      validateTemplateTokens('{{secret.value}} and {{requisition.title}}');
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateValidationError);
      expect((e as TemplateValidationError).unknownTokens).toContain('secret.value');
      expect((e as TemplateValidationError).unknownTokens).not.toContain('requisition.title');
    }
  });

  it('ACCEPTS a template whose every token is in the allowlist', () => {
    const text = EMAIL_TEMPLATE_TOKENS.map((t) => `{{${t}}}`).join(' ');
    expect(() => validateTemplateTokens(text)).not.toThrow();
  });

  it('rejects arbitrary-looking template syntax (no code execution surface)', () => {
    expect(() => validateTemplateTokens('{{constructor.constructor}}')).toThrow(TemplateValidationError);
    expect(() => validateTemplateTokens('{{ requisition.title.toString }}')).toThrow(TemplateValidationError);
  });
});

describe('validateTemplateTokensForCategory (COMM-RECRUITER-W1 §4B-cat) — category-specific binding fail-closed', () => {
  it('talent_general_contact ACCEPTS only talent.first_name / recruiter.display_name / company.name', () => {
    expect(GENERAL_TALENT_CONTACT_TOKENS).toEqual([
      'talent.first_name',
      'recruiter.display_name',
      'company.name',
    ]);
    expect(() =>
      validateTemplateTokensForCategory(
        'talent_general_contact',
        'Hi {{talent.first_name}}, — {{recruiter.display_name}} at {{company.name}}',
      ),
    ).not.toThrow();
  });

  it('talent_general_contact REJECTS a requisition-only token (fails closed, not empty render)', () => {
    try {
      validateTemplateTokensForCategory(
        'talent_general_contact',
        'Hi {{talent.first_name}} re {{requisition.title}}',
      );
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateValidationError);
      expect((e as TemplateValidationError).unknownTokens).toContain('requisition.title');
      expect((e as TemplateValidationError).unknownTokens).not.toContain('talent.first_name');
    }
  });

  it('requisition_initial_contact still ACCEPTS the full requisition token set', () => {
    const text = CATEGORY_TEMPLATE_TOKENS['requisition_initial_contact']
      .map((t) => `{{${t}}}`)
      .join(' ');
    expect(() => validateTemplateTokensForCategory('requisition_initial_contact', text)).not.toThrow();
  });

  it('an unknown category fails closed (no tokens allowed)', () => {
    expect(() => validateTemplateTokensForCategory('bogus_category', '{{talent.first_name}}')).toThrow(
      TemplateValidationError,
    );
  });
});

describe('renderTemplate (ET-3) — server-side substitution, no raw {{…}} survives', () => {
  it('substitutes resolved values and leaves NO raw token markup', () => {
    const { text, warnings } = renderTemplate('Re: {{requisition.title}} for {{talent.first_name}}', {
      'requisition.title': 'Senior RN',
      'talent.first_name': 'Alex',
    });
    expect(text).toBe('Re: Senior RN for Alex');
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(warnings).toEqual([]);
  });

  it('unresolved OPTIONAL value → empty substitution + closed-vocabulary warning (not a raw placeholder)', () => {
    const { text, warnings } = renderTemplate('Hi {{talent.first_name}}{{requisition.location}}', {
      'talent.first_name': 'Sam',
      'requisition.location': null,
    });
    expect(text).toBe('Hi Sam');
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(warnings).toContain('requisition_location_unavailable');
  });

  it('treats an empty-string value as unavailable (warning, empty substitution)', () => {
    const { text, warnings } = renderTemplate('{{company.name}}X', { 'company.name': '' });
    expect(text).toBe('X');
    expect(warnings).toContain('company_name_unavailable');
  });

  it('fails closed if an unknown token somehow reaches render (never emits raw markup)', () => {
    expect(() => renderTemplate('{{talent.ssn}}', {})).toThrow(TemplateValidationError);
  });
});
