export function Notice({ message, hint }: { message: string; hint?: string }) {
  return (
    <div role="alert" className="notice">
      <span>{message}</span>
      {hint ? <span className="notice-hint">{hint}</span> : null}
    </div>
  );
}
