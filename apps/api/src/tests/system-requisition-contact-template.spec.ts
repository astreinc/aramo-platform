import { describe, expect, it } from 'vitest';

import { SystemRequisitionContactTemplateService } from '../communications/system-requisition-contact-template.service.js';
import type { RequisitionContactContext } from '../communications/requisition-contact-template.port.js';

// COMM-C4 (RCE-1) — the governed deterministic template. Proves: resolved
// context reaches subject/body; NO raw {placeholder} survives hydration; the
// role-summary block is a source-preserving excerpt (DEC-1, never LLM) that
// omits cleanly when absent; unavailable fields degrade with bounded warnings.

const svc = new SystemRequisitionContactTemplateService();

function fullContext(over: Partial<RequisitionContactContext> = {}): RequisitionContactContext {
  return {
    talent_first_name: 'Omvignesh',
    requisition_title: 'Business Analyst - Multi-Family',
    requisition_reference: 'REQ-1000',
    location: 'McLean, VA',
    location_short: 'McLean, VA',
    work_arrangement: 'hybrid',
    engagement_type: 'contract',
    role_summary_source: 'Work with product owners in the multi-family domain.',
    recruiter_display_name: 'Purush Pichaimuthu',
    tenant_recruiting_company_name: 'Astre Consulting Services Inc',
    ...over,
  };
}

describe('SystemRequisitionContactTemplateService (COMM-C4 governed template)', () => {
  it('hydrates subject + body from resolved context; no raw placeholder survives', () => {
    const d = svc.resolveDefault(fullContext());
    // subject carries title + location + engagement label
    expect(d.subject).toBe('Business Analyst - Multi-Family — McLean, VA (Contract)');
    // body carries salutation, title, reference, location/engagement, role summary
    expect(d.body).toContain('Hi Omvignesh,');
    expect(d.body).toContain('Business Analyst - Multi-Family opportunity (REQ-1000)');
    expect(d.body).toContain('Location: McLean, VA — Hybrid');
    expect(d.body).toContain('Engagement: Contract');
    expect(d.body).toContain('About the opportunity:');
    expect(d.body).toContain('Purush Pichaimuthu');
    expect(d.body).toContain('Astre Consulting Services Inc');
    // NO raw placeholder tokens anywhere in the hydrated output.
    expect(d.subject).not.toMatch(/[{}]/);
    expect(d.body).not.toMatch(/[{}]/);
    expect(d.template_id).toBe('system.requisition-contact.v1');
    expect(d.template_version).toBe('1');
    expect(d.warnings).toEqual([]);
  });

  it('role-summary is a DETERMINISTIC source-preserving excerpt (cut on a sentence boundary, never mid-word)', () => {
    const s1 = 'First sentence about the role and its responsibilities. ';
    const s2 = 'Second sentence adding much more detail that pushes the total source length well beyond the excerpt cap so truncation must occur here. ';
    const s3 = 'Third sentence that must not appear because it is beyond the cap entirely and would exceed the bound.';
    const source = (s1 + s2 + s3).repeat(2);
    const d = svc.resolveDefault(fullContext({ role_summary_source: source }));
    const marker = 'About the opportunity:\n';
    const excerpt = d.body.slice(d.body.indexOf(marker) + marker.length).split('\n\n')[0]!;
    // Source-preserving: the excerpt is a verbatim prefix of the source.
    expect(source.startsWith(excerpt)).toBe(true);
    // Bounded and cut on a sentence boundary (ends with a period), not mid-word.
    expect(excerpt.length).toBeLessThanOrEqual(400);
    expect(excerpt.endsWith('.')).toBe(true);
    // Deterministic: same input → identical excerpt.
    expect(svc.resolveDefault(fullContext({ role_summary_source: source })).body).toBe(d.body);
  });

  it('a short role-summary source is used whole', () => {
    const short = 'A concise, authoritative role description.';
    const d = svc.resolveDefault(fullContext({ role_summary_source: short }));
    expect(d.body).toContain(`About the opportunity:\n${short}`);
  });

  it('omits the role-summary block cleanly when no authoritative source exists (+ warning)', () => {
    for (const src of [null, '', '   ']) {
      const d = svc.resolveDefault(fullContext({ role_summary_source: src }));
      expect(d.body).not.toContain('About the opportunity:');
      expect(d.warnings).toContain('role_summary_source_unavailable');
    }
  });

  it('degrades unavailable salutation / signature / location with bounded factual warnings', () => {
    const d = svc.resolveDefault(
      fullContext({
        talent_first_name: null,
        recruiter_display_name: null,
        tenant_recruiting_company_name: null,
        location: null,
        location_short: null,
        work_arrangement: null,
      }),
    );
    expect(d.body).toContain('Hi there,');
    expect(d.body).not.toContain('Location:');
    expect(d.warnings).toEqual(
      expect.arrayContaining([
        'talent_first_name_unavailable',
        'recruiter_display_name_unavailable',
        'tenant_recruiting_company_name_unavailable',
        'location_unavailable',
      ]),
    );
    // subject degrades to just the title when location/engagement are absent.
    expect(svc.resolveDefault(fullContext({ location_short: null, engagement_type: null })).subject).toBe(
      'Business Analyst - Multi-Family',
    );
    expect(d.subject).not.toMatch(/[{}]/);
    expect(d.body).not.toMatch(/[{}]/);
  });
});
