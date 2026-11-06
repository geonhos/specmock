import { useState } from "react";
import { ApiError, api } from "../api";
import { Notice } from "../components/Notice";
import { kindLabel } from "../format";
import { suggestSystemName } from "../name";
import { pathFor } from "../route";

export function Register({ go, onRegistered }: { go: (path: string) => void; onRegistered: () => void }) {
  const [origin, setOrigin] = useState("");
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [kind, setKind] = useState<string | null>(null);

  const changeOrigin = (v: string) => { setOrigin(v); if (!edited) setName(suggestSystemName(v)); };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = (await api.ingest(name.trim(), [origin.trim()])) as { inputs?: { kind: string }[] };
      setKind(r.inputs?.[0]?.kind ?? null);
      onRegistered();
      go(pathFor("analyze", name.trim()));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
    } finally { setBusy(false); }
  };
  const ready = origin.trim() !== "" && name.trim() !== "" && !busy;
  const why = busy ? "등록하는 중이에요" : origin.trim() === "" ? "스펙 경로 또는 URL을 입력하면 등록할 수 있어요" : name.trim() === "" ? "시스템 이름을 입력하면 등록할 수 있어요" : null;
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
      <label className="field">
        <span>스펙 경로 또는 URL</span>
        <input value={origin} onChange={(e) => changeOrigin(e.target.value)} placeholder="/path/to/openapi.yaml 또는 https://…" autoFocus />
      </label>
      <label className="field">
        <span>시스템 이름</span>
        <input value={name} onChange={(e) => { setName(e.target.value); setEdited(true); }} />
      </label>
      {error ? <Notice message={error.message} hint={error.hint} /> : null}
      {kind ? <p className="format">형식: {kindLabel(kind)}</p> : null}
      <div className="action-row">
        <button type="submit" className="btn-primary" disabled={!ready} aria-describedby={ready ? undefined : "register-why"}>등록</button>
        {ready || !why ? null : <span id="register-why" className="muted">{why}</span>}
      </div>
    </form>
  );
}
