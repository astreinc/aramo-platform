import { Global, Injectable, Module } from '@nestjs/common';
import { CompanyModule, CompanyRepository } from '@aramo/company';
import {
  COMPANY_CLIENT_CHECK_PORT,
  type CompanyClientCheckPort,
} from '@aramo/requisition';

// Company Party/Role (ADR-0032, R7) — the composition-root adapter for the
// requisition CompanyClientCheckPort. This is the ONLY place the requisition
// CLIENT-workflow guard is bound to @aramo/company; libs/requisition itself
// stays decoupled (depends only on the port interface). In-process DI seam —
// not a network connector, so no Pact/HTTP contract (the TS interface is the
// contract). Provided @Global so the requisition controller (in its own
// module) can inject the token.

@Injectable()
export class CompanyClientCheckAdapter implements CompanyClientCheckPort {
  constructor(private readonly companies: CompanyRepository) {}

  async isClientCompany(args: {
    readonly tenant_id: string;
    readonly company_id: string;
  }): Promise<boolean> {
    return this.companies.hasClientRelationship({
      tenant_id: args.tenant_id,
      company_id: args.company_id,
    });
  }
}

@Global()
@Module({
  imports: [CompanyModule],
  providers: [
    CompanyClientCheckAdapter,
    { provide: COMPANY_CLIENT_CHECK_PORT, useExisting: CompanyClientCheckAdapter },
  ],
  exports: [COMPANY_CLIENT_CHECK_PORT],
})
export class CompanyClientCheckModule {}
