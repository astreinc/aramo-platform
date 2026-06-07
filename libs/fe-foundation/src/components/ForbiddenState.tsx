interface ForbiddenStateProps {
  scope?: string;
}

export function ForbiddenState({ scope }: ForbiddenStateProps) {
  return (
    <section className="tc-forbidden" role="alert" aria-live="polite">
      <h2 className="tc-forbidden__title">You don't have permission</h2>
      <p className="tc-forbidden__description">
        {scope !== undefined
          ? `This page requires the ${scope} scope, which is not granted to your account.`
          : 'Your account is not granted the scope required to view this page.'}
      </p>
    </section>
  );
}
