import { Banner } from "@astryxdesign/core/Banner";

/** Astryx Banner has no role, so the alert role stays on this wrapper. */
export function Notice({ message, hint }: { message: string; hint?: string }) {
  return (
    <div role="alert" className="notice">
      <Banner status="error" title={message} description={hint ? <span className="notice-hint">{hint}</span> : undefined} />
    </div>
  );
}
