import { Injectable } from '@nestjs/common';
import { IdentityRepository } from '@aramo/identity';
import { type SenderContact, type SenderDirectoryPort } from '@aramo/esign';

// Aramo Sign launch — binds the E-Sign SenderDirectoryPort to the shared identity
// store. A contact is returned only for an ACTIVE user whose membership is in the
// envelope's tenant: an envelope can never leak a notification across tenants.
@Injectable()
export class IdentitySenderDirectoryAdapter implements SenderDirectoryPort {
  constructor(private readonly identity: IdentityRepository) {}

  async findSender(tenant_id: string, user_id: string): Promise<SenderContact | null> {
    const membership = await this.identity.findMembership({ user_id, tenant_id });
    if (membership === null) return null;
    const user = await this.identity.findUserById(user_id);
    if (user === null || !user.is_active) return null;
    return { email: user.email, name: user.display_name ?? user.email };
  }
}
