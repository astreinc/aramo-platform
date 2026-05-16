import type { Session } from '../auth/session';

interface LandingPageProps {
  session: Session;
}

export function LandingPage({ session }: LandingPageProps) {
  return (
    <section className="aramo-landing">
      <h1>Welcome to tenant {session.tenant_id}.</h1>
      <p>Aramo Tenant Console is ready.</p>
    </section>
  );
}
