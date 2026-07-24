// DI tokens. All injected dependencies are addressed by explicit @Inject(TOKEN)
// so the graph resolves without relying on emitted design:paramtypes metadata.
export const INTAKE_SES_CLIENT = Symbol('INTAKE_SES_CLIENT');
