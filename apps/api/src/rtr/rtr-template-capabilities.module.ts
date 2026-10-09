import { Global, Module } from '@nestjs/common';
import { TEMPLATE_CAPABILITIES } from '@aramo/documents';

import { RtrTemplateCapabilities } from './rtr-template-capabilities.service.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — provides the RTR template-content capability (catalog +
// closed-binding validation + fixed-sample preview) under the generic TEMPLATE_CAPABILITIES
// token. @Global so the generic DocumentTemplatesController (declared in @aramo/documents'
// DocumentsModule) can resolve it by token without forRoot restructuring. The impl is pure
// (no repos/renderer), so this module has no further dependencies.
@Global()
@Module({
  providers: [RtrTemplateCapabilities, { provide: TEMPLATE_CAPABILITIES, useExisting: RtrTemplateCapabilities }],
  exports: [TEMPLATE_CAPABILITIES],
})
export class TemplateCapabilitiesModule {}
