import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AramoError } from '@aramo/common';
import type { CompanyBillingContactValidator } from '@aramo/company';
import { ContactRepository, type ContactOwnerValidator } from '@aramo/contact';
import { IdentityService } from '@aramo/identity';
import type { RequisitionHiringManagerValidator } from '@aramo/requisition';
import type { TaskContactOwnerValidator } from '@aramo/task';

// CONTACTS-1 (SD-6 / HM-1 / V-3) — the composition-root adapters that bind the
// lib-defined contact-link ports to @aramo/contact and @aramo/identity. These
// are the ONLY places requisition, company and task cross into the contact
// library: each lib depends on its own port interface only, so no new nx edge
// is created. In-process DI seams (not network connectors) — the TypeScript
// interfaces are the contract.

// Requisition hiring manager (Requisition.contact_id) — a live contact at the
// requisition's company. Refusals come from ContactRepository.assertLinkable:
// not in tenant / other company → VALIDATION_ERROR 422, deleted → CONTACT_DELETED 422.
@Injectable()
export class RequisitionHiringManagerAdapter implements RequisitionHiringManagerValidator {
  constructor(private readonly contacts: ContactRepository) {}

  async assertLinkable(args: {
    readonly tenant_id: string;
    readonly contact_id: string;
    readonly company_id: string;
    readonly requestId: string;
  }): Promise<void> {
    await this.contacts.assertLinkable({
      tenant_id: args.tenant_id,
      id: args.contact_id,
      company_id: args.company_id,
      requestId: args.requestId,
      field: 'contact_id',
    });
  }
}

// Company billing contact (Company.billing_contact_id) — a live contact at that
// company. CompanyRepository injects this port, and ContactRepository itself
// depends on CompanyRepository, so a constructor-injected ContactRepository
// would form a provider cycle (CompanyRepository → adapter → ContactRepository
// → CompanyRepository). The adapter therefore resolves ContactRepository
// lazily, at call time, from the application container.
@Injectable()
export class CompanyBillingContactAdapter implements CompanyBillingContactValidator {
  private contacts: ContactRepository | undefined;

  constructor(private readonly moduleRef: ModuleRef) {}

  async assertLinkable(args: {
    tenant_id: string;
    contact_id: string;
    company_id: string;
    requestId: string;
  }): Promise<void> {
    const contacts: ContactRepository | undefined =
      this.contacts ?? this.moduleRef.get(ContactRepository, { strict: false });
    if (contacts === undefined) {
      throw new Error('ContactRepository is not available to the billing-contact validator');
    }
    this.contacts = contacts;
    await contacts.assertLinkable({
      tenant_id: args.tenant_id,
      id: args.contact_id,
      company_id: args.company_id,
      requestId: args.requestId,
      field: 'billing_contact_id',
    });
  }
}

// Task owner (owner_type 'contact') — a live contact in the tenant. No company
// constraint: a task's contact owner is not tied to a company field. Bound into
// TaskModule's own scope via TaskModule.forRoot (the TASK_* port precedent), so
// apps/api threads ContactModule into that scope.
@Injectable()
export class TaskContactOwnerAdapter implements TaskContactOwnerValidator {
  constructor(private readonly contacts: ContactRepository) {}

  async assertLinkable(args: {
    tenant_id: string;
    contact_id: string;
    requestId: string;
  }): Promise<void> {
    await this.contacts.assertLinkable({
      tenant_id: args.tenant_id,
      id: args.contact_id,
      requestId: args.requestId,
      field: 'owner_id',
    });
  }
}

// Contact owner (Contact.owner_id, V-3) — an ACTIVE member of the tenant. Reads
// identity's assignable-users roster (the InterviewerValidator precedent); a
// cross-tenant id never appears in THIS tenant's roster, so it is refused too.
@Injectable()
export class ContactOwnerAdapter implements ContactOwnerValidator {
  constructor(private readonly identity: IdentityService) {}

  async assertAssignable(args: {
    tenant_id: string;
    user_id: string;
    requestId: string;
    field: string;
  }): Promise<void> {
    const activeMembers = await this.identity.listAssignableTenantUsers(args.tenant_id);
    if (activeMembers.some((u) => u.user_id === args.user_id)) return;
    throw new AramoError(
      'VALIDATION_ERROR',
      'The selected owner is not an active user of this tenant',
      422,
      {
        requestId: args.requestId,
        details: { field: args.field, reason: 'owner_not_assignable', user_id: args.user_id },
      },
    );
  }
}
