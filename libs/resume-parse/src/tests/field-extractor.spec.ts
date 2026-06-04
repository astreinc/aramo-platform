import { describe, expect, it } from 'vitest';

import {
  extractFields,
  meetsMinimalIdentity,
} from '../lib/heuristics/field-extractor.js';

// A8-3b — heuristic field-extractor unit tests. Pure-function tests
// against text strings -- no parse-library invocation, no IO.
//
// The minimal-identity assertion is the key invariant the service uses
// to determine parse_status: a name AND a contact channel.

describe('A8-3b — field-extractor heuristics', () => {
  describe('extractFields — happy path (full résumé)', () => {
    const SAMPLE_FULL = `
Jane Smith
jane.smith@example.com
(555) 234-5678
123 Main St
Springfield, IL 62701
https://janesmith.dev

Skills
TypeScript, React, Node.js, PostgreSQL, AWS

Experience
Acme Corp 2022-Present
  Senior Software Engineer
`;

    it('extracts name (first + last)', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.first_name).toBe('Jane');
      expect(out.last_name).toBe('Smith');
    });

    it('extracts primary email (email1)', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.email1).toBe('jane.smith@example.com');
    });

    it('extracts primary phone (phone_cell) in canonical XXX-XXX-XXXX shape', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.phone_cell).toBe('555-234-5678');
    });

    it('extracts zip code', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.zip).toBe('62701');
    });

    it('extracts US state', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.state).toBe('IL');
    });

    it('extracts skills section content (joined)', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.key_skills).toContain('TypeScript');
      expect(out.key_skills).toContain('PostgreSQL');
    });

    it('extracts current employer (truncated before date)', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.current_employer).toBe('Acme Corp');
    });

    it('extracts personal website (URL not matching email domain)', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(out.web_site).toBe('https://janesmith.dev');
    });

    it('full sample meets minimal identity', () => {
      const out = extractFields(SAMPLE_FULL);
      expect(meetsMinimalIdentity(out)).toBe(true);
    });
  });

  describe('extractFields — partial / sparse résumé', () => {
    it('email-only text returns email but not name -> partial', () => {
      const out = extractFields('lone@example.com\n');
      expect(out.email1).toBe('lone@example.com');
      expect(out.first_name).toBeUndefined();
      expect(meetsMinimalIdentity(out)).toBe(false);
    });

    it('name + phone (no email) meets minimal identity', () => {
      const out = extractFields('Bob Builder\n555-987-6543\n');
      expect(out.first_name).toBe('Bob');
      expect(out.last_name).toBe('Builder');
      expect(out.phone_cell).toBe('555-987-6543');
      expect(meetsMinimalIdentity(out)).toBe(true);
    });

    it('blank text returns empty prefill -> not minimal', () => {
      const out = extractFields('');
      expect(out).toEqual({});
      expect(meetsMinimalIdentity(out)).toBe(false);
    });
  });

  describe('extractFields — multi-value channels', () => {
    it('captures up to two emails (email1, email2)', () => {
      const text = 'a@ex.com\nb@ex.com\nc@ex.com\n';
      const out = extractFields(text);
      expect(out.email1).toBe('a@ex.com');
      expect(out.email2).toBe('b@ex.com');
    });

    it('captures up to three phones (cell, home, work)', () => {
      const text = 'Alice Wonder\n555-111-2222\n555-333-4444\n555-555-6666\n';
      const out = extractFields(text);
      expect(out.phone_cell).toBe('555-111-2222');
      expect(out.phone_home).toBe('555-333-4444');
      expect(out.phone_work).toBe('555-555-6666');
    });

    it('does NOT pick the email domain URL as web_site', () => {
      const text = 'Jane Test\njane@acme.com\nhttps://acme.com\nhttps://janetest.io\n';
      const out = extractFields(text);
      // acme.com is the email domain -- skipped. janetest.io is the
      // first non-email-domain URL -> selected.
      expect(out.web_site).toBe('https://janetest.io');
    });
  });

  describe('extractFields — false-positive defences', () => {
    it('does NOT mistake a date for a phone', () => {
      const out = extractFields('Alice Smith\nDate of birth: 1990\nalice@ex.com\n');
      expect(out.phone_cell).toBeUndefined();
    });

    it('does NOT pick the email line as the name', () => {
      const out = extractFields('Bob Builder\nbob@example.com\n');
      expect(out.first_name).toBe('Bob');
    });

    it('returns absent (NOT empty string) for unparseable fields', () => {
      const out = extractFields('Joe Q. Public\njoe@ex.com\n');
      expect(out.zip).toBeUndefined();
      expect(out.state).toBeUndefined();
      expect(out.key_skills).toBeUndefined();
      // type-level: each property is missing, not present-with-empty-string.
      expect(Object.prototype.hasOwnProperty.call(out, 'zip')).toBe(false);
    });
  });
});
